import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import {
  nesDiscoveryDomainEnvelope,
  parseNesDiscoveryDomainBitmap,
} from "./nesCodeDiscoveryDomainFacts.js";
import type {
  Graph,
  Reference,
  Analysis,
  Origin,
} from "./nesCodeDiscoveryRelativeValidationTypes.js";
import { validateNesDiscoveryRelativeReads } from "./nesCodeDiscoveryRelativeReadValidation.js";

type Issue = (path: (string | number)[], message: string) => void;
const sameIndices = (values: number[]): boolean =>
  values.every((value, offset) => offset === 0 || values[offset - 1]! < value);
const snapshotCell = (
  graph: Graph,
  snapshot: (number | null)[],
  offset: number,
) => {
  const page = snapshot[offset >> 5];
  return page == null
    ? undefined
    : graph.relative_stack_pages[page]?.cells.find(
        (cell) => cell.offset === (offset & 31),
      );
};

const poolRef = (
  value: number,
  length: number,
  path: (string | number)[],
  issue: Issue,
) => {
  if (value >= length)
    issue(path, "Reference is outside its owning relative-stack pool.");
};
const validSnapshot = (
  graph: Graph,
  values: (number | null)[],
  path: (string | number)[],
  issue: Issue,
) => {
  values.forEach((value, offset) => {
    if (value !== null)
      poolRef(
        value,
        graph.relative_stack_pages.length,
        [...path, offset],
        issue,
      );
  });
};
const validatePages = (graph: Graph, issue: Issue) => {
  for (const [position, page] of graph.relative_stack_pages.entries()) {
    const path = ["relative_stack_pages", position];
    if (page.index !== position)
      issue([...path, "index"], "Pool identity must equal its array position.");
    if (!sameIndices(page.cells.map((cell) => cell.offset)))
      issue(
        [...path, "cells"],
        "Relative page slots must be unique and increasing.",
      );
    for (const [offset, cell] of page.cells.entries()) {
      if (!sameIndices(cell.writer_witness_indices))
        issue(
          [...path, "cells", offset, "writer_witness_indices"],
          "Relative writers must be unique and increasing.",
        );
      for (const writer of cell.writer_witness_indices)
        poolRef(
          writer,
          graph.relative_stack_write_witnesses.length,
          [...path, "cells", offset, "writer_witness_indices"],
          issue,
        );
      const domain = graph.byte_domains[cell.domain_index],
        actual =
          domain === undefined
            ? null
            : parseNesDiscoveryDomainBitmap(domain.bitmap_hex);
      let supported = 0n;
      for (const writer of cell.writer_witness_indices) {
        const witness = graph.relative_stack_write_witnesses[writer],
          source =
            witness === undefined
              ? undefined
              : graph.byte_domains[witness.domain_index],
          bitmap =
            source === undefined
              ? null
              : parseNesDiscoveryDomainBitmap(source.bitmap_hex);
        if (bitmap !== null) supported |= bitmap;
      }
      if (
        actual === null ||
        actual !== supported ||
        !isDeepStrictEqual(nesDiscoveryDomainEnvelope(actual), cell.value)
      )
        issue(
          [...path, "cells", offset, "value"],
          "Relative cells retain the exact union of their actual write domains and its common-bit projection.",
        );
    }
  }
};
const validateOrigins = (graph: Graph, issue: Issue) => {
  for (const [position, item] of graph.data_references.entries()) {
    for (const [originIndex, origin] of item.relative_stack_origins.entries()) {
      const path = [
        "data_references",
        position,
        "relative_stack_origins",
        originIndex,
      ];
      if (!originCoordinatesMatch(graph, item, origin))
        issue(
          [...path, "offset"],
          "Relative origins must retain the instruction's current-SP coordinate without selecting an unknown physical SP.",
        );
      if (
        (item.kind !== "read" &&
          item.kind !== "write" &&
          item.kind !== "pointer") ||
        item.file_offsets.length !== 0 ||
        (item.address !== null &&
          ((item.address & 2047) < 256 ||
            (item.address & 2047) >= 512 ||
            item.address >= 0x2000))
      )
        issue(
          path,
          "Relative-stack origins require a real stack read or write, without ROM offsets.",
        );
      if (!sameIndices(origin.writer_witness_indices))
        issue(
          [...path, "writer_witness_indices"],
          "Relative writers must be unique and increasing.",
        );
      const nodes = new Set<number>();
      for (const writer of origin.writer_witness_indices) {
        poolRef(
          writer,
          graph.relative_stack_write_witnesses.length,
          [...path, "writer_witness_indices"],
          issue,
        );
        const witness = graph.relative_stack_write_witnesses[writer];
        if (witness !== undefined) nodes.add(witness.node_index);
      }
      if (
        !isDeepStrictEqual(
          [...nodes].sort((a, b) => a - b),
          origin.writer_nodes,
        )
      )
        issue(
          [...path, "writer_nodes"],
          "Relative writer nodes must derive from their own witness pool.",
        );
    }
  }
};
const originCoordinatesMatch = (
  graph: Graph,
  item: Reference,
  origin: Origin,
): boolean => {
  const analysis = graph.analyses[item.analysis_index],
    mnemonic = graph.nodes[item.node_index]?.mnemonic;
  if (analysis === undefined) return false;
  if (
    item.kind === "write" &&
    (mnemonic === "PHA" || mnemonic === "PHP" || mnemonic === "JSR")
  )
    return origin.offset === 0;
  if (
    item.kind === "read" &&
    (mnemonic === "PLA" || mnemonic === "PLP" || mnemonic === "RTS")
  )
    return origin.offset === 0;
  return (
    analysis.cpu_in.sp !== null &&
    item.address !== null &&
    origin.offset === (((item.address & 255) - analysis.cpu_in.sp) & 255)
  );
};
const indexReferences = (graph: Graph) => {
  const writes = new Map<string, Reference[]>(),
    reads = new Map<number, Reference[]>();
  for (const item of graph.data_references) {
    if (item.kind === "write") {
      const key = `${item.node_index}:${item.analysis_index}`;
      const retained = writes.get(key) ?? [];
      retained.push(item);
      writes.set(key, retained);
    }
    if (item.kind === "read") {
      const retained = reads.get(item.analysis_index) ?? [];
      retained.push(item);
      reads.set(item.analysis_index, retained);
    }
  }
  return { writes, reads };
};
const validateWitnesses = (
  graph: Graph,
  writes: Map<string, Reference[]>,
  issue: Issue,
) => {
  for (const [
    position,
    witness,
  ] of graph.relative_stack_write_witnesses.entries()) {
    const path = ["relative_stack_write_witnesses", position];
    const source = graph.byte_domains[witness.domain_index],
      bitmap =
        source === undefined
          ? null
          : parseNesDiscoveryDomainBitmap(source.bitmap_hex);
    if (
      bitmap === null ||
      !isDeepStrictEqual(nesDiscoveryDomainEnvelope(bitmap), witness.value)
    )
      issue(
        path,
        "A relative write retains its actual exact byte domain and common-bit projection.",
      );
    if (witness.index !== position)
      issue([...path, "index"], "Pool identity must equal its array position.");
    poolRef(
      witness.node_index,
      graph.nodes.length,
      [...path, "node_index"],
      issue,
    );
    for (const [offset, analysis] of witness.analysis_indices.entries()) {
      poolRef(
        analysis,
        graph.analyses.length,
        [...path, "analysis_indices", offset],
        issue,
      );
      if (
        graph.analyses[analysis]?.node_index !== witness.node_index ||
        !(writes.get(`${witness.node_index}:${analysis}`) ?? []).some(
          (item) =>
            isDeepStrictEqual(item.value, witness.value) &&
            item.relative_stack_origins.some(
              (origin) =>
                origin.offset === witness.offset &&
                origin.writer_witness_indices.includes(witness.index),
            ),
        )
      )
        issue(
          [...path, "analysis_indices", offset],
          "Relative witness must retain an actual write from its supporting analysis.",
        );
    }
  }
};
const relativeMatches = (
  graph: Graph,
  analysis: Analysis | undefined,
  read: Reference | undefined,
  offset: number,
) => {
  if (analysis === undefined || read === undefined) return false;
  const cell = snapshotCell(graph, analysis.relative_stack_in, offset),
    source =
      cell === undefined ? undefined : graph.byte_domains[cell.domain_index],
    domain =
      source === undefined
        ? null
        : parseNesDiscoveryDomainBitmap(source.bitmap_hex);
  if (domain === null || typeof read.value !== "number") return false;
  return (
    read.relative_stack_origins.some(
      (origin) =>
        origin.offset === 0 &&
        isDeepStrictEqual(
          origin.writer_witness_indices,
          cell?.writer_witness_indices,
        ),
    ) &&
    (read.address === null
      ? domain === 1n << BigInt(read.value)
      : (domain & (1n << BigInt(read.value))) !== 0n)
  );
};
const readMatches = (
  graph: Graph,
  analysis: Analysis | undefined,
  read: Reference | undefined,
  offset: number,
) => {
  if (
    analysis === undefined ||
    read === undefined ||
    typeof read.value !== "number"
  )
    return false;
  const value = read.value;
  const expected =
    analysis.cpu_in.sp === null
      ? null
      : 256 | ((analysis.cpu_in.sp + offset) & 255);
  if (read.address !== expected) return false;
  if (relativeMatches(graph, analysis, read, offset)) return true;
  return (
    expected !== null &&
    read.ram_origins.some(
      (origin) =>
        origin.ram_address === expected &&
        graph.byte_domains[origin.domain_index] !== undefined &&
        parseNesDiscoveryDomainBitmap(
          graph.byte_domains[origin.domain_index]!.bitmap_hex,
        ) ===
          1n << BigInt(value) &&
        origin.writer_witness_indices.every((index) => {
          const witness = graph.write_witnesses[index];
          return witness?.address === expected;
        }),
    )
  );
};
const validateSummaries = (
  graph: Graph,
  reads: Map<number, Reference[]>,
  issue: Issue,
) => {
  for (const [position, summary] of graph.return_summaries.entries()) {
    const path = ["return_summaries", position];
    validSnapshot(
      graph,
      summary.relative_stack_out,
      [...path, "relative_stack_out"],
      issue,
    );
    const analysis = graph.analyses[summary.return_analysis_index];
    if (
      analysis !== undefined &&
      !isDeepStrictEqual(
        analysis.relative_stack_out,
        summary.relative_stack_out,
      )
    )
      issue(
        [...path, "relative_stack_out"],
        "Return summary must retain its exact exit stack snapshot.",
      );
    if (summary.return_proof !== "relative-bytes") continue;
    const references = reads.get(summary.return_analysis_index) ?? [];
    const low = references[0],
      high = references[1];
    if (
      analysis === undefined ||
      (analysis.cpu_in.sp === null
        ? analysis.cpu_out.sp !== null
        : analysis.cpu_out.sp !== ((analysis.cpu_in.sp + 2) & 255)) ||
      references.length !== 2 ||
      references.some(
        (item) => item.node_index !== summary.return_node_index,
      ) ||
      !readMatches(graph, analysis, low, 1) ||
      !readMatches(graph, analysis, high, 2) ||
      (!relativeMatches(graph, analysis, low, 1) &&
        !relativeMatches(graph, analysis, high, 2)) ||
      typeof low?.value !== "number" ||
      typeof high?.value !== "number" ||
      (((low.value | (high.value << 8)) + 1) & 65535) !== summary.stack_target
    )
      issue(
        [...path, "stack_target"],
        "A relative return requires two actual relative stack reads and their entry snapshot, without an invented physical SP.",
      );
  }
};
/** Relative byte evidence has its own namespace and never invents a physical address. */
export const validateNesDiscoveryRelativeStack = (
  graph: Graph,
  ctx: z.RefinementCtx,
): void => {
  const issue: Issue = (path, message) =>
    ctx.addIssue({ code: "custom", path, message });
  const { writes, reads } = indexReferences(graph);
  validatePages(graph, issue);
  validateOrigins(graph, issue);
  validateNesDiscoveryRelativeReads(graph, reads, issue);
  validateWitnesses(graph, writes, issue);
  graph.invocations.forEach((item, index) =>
    validSnapshot(
      graph,
      item.relative_stack_in,
      ["invocations", index, "relative_stack_in"],
      issue,
    ),
  );
  graph.analyses.forEach((item, index) => {
    validSnapshot(
      graph,
      item.relative_stack_in,
      ["analyses", index, "relative_stack_in"],
      issue,
    );
    validSnapshot(
      graph,
      item.relative_stack_out,
      ["analyses", index, "relative_stack_out"],
      issue,
    );
  });
  validateSummaries(graph, reads, issue);
};
