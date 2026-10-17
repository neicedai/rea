import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { NesByteValue } from "./nesByteValue.js";
import {
  nesDiscoveryDomainEnvelope,
  parseNesDiscoveryDomainBitmap,
  type NesDiscoveryDomainSnapshot,
} from "./nesCodeDiscoveryDomainFacts.js";
import {
  createNesDiscoveryValueFactDecoder,
  nesDiscoveryValueFact,
  type NesDiscoveryValueFactPools,
  type NesDiscoveryDecodedValueFacts,
  type NesDiscoveryConditionWitnessFact,
} from "./nesCodeDiscoveryValueFacts.js";
import type {
  nesDiscoveryWriteWitnessSchema,
  nesDiscoveryRamPageSchema,
} from "./nesCodeDiscoveryCalls.js";
type Witness = z.infer<typeof nesDiscoveryWriteWitnessSchema>;
type RamPage = z.infer<typeof nesDiscoveryRamPageSchema>;
type Reference = {
  node_index: number;
  analysis_index: number;
  kind: string;
  address: number | null;
  value: NesByteValue;
  relative_stack_origins: { offset: number }[];
  ram_origins: {
    ram_address: number;
    writer_nodes: number[];
    writer_witness_indices: number[];
    domain_index: number;
    initial_unwritten_possible: boolean;
    unknown_write_possible: boolean;
    condition_witness_indices: number[];
  }[];
};
type RamGraph = NesDiscoveryValueFactPools & {
  nodes: { mnemonic: string }[];
  analyses: {
    node_index: number;
    value_snapshot_in: number;
    value_snapshot_out: number;
    register_domains_in: NesDiscoveryDomainSnapshot;
  }[];
  write_witnesses: Witness[];
  ram_pages: RamPage[];
  data_references: Reference[];
  condition_witnesses: NesDiscoveryConditionWitnessFact[];
};
type Issue = (path: (string | number)[], message: string) => void;
const poolRef = (
  value: number | null,
  length: number,
  path: (string | number)[],
  issue: Issue,
) => {
  if (value !== null && value >= length)
    issue(path, "Reference is outside its owning pool.");
};
export const validateNesDiscoveryRamSnapshot = (
  snapshot: (number | null)[],
  graph: RamGraph,
  path: (string | number)[],
  issue: Issue,
) => {
  for (const [physicalPage, pageIndex] of snapshot.entries()) {
    if (pageIndex === null) continue;
    poolRef(pageIndex, graph.ram_pages.length, [...path, physicalPage], issue);
    for (const cell of graph.ram_pages[pageIndex]?.cells ?? [])
      for (const writer of cell.writer_witness_indices) {
        const witness = graph.write_witnesses[writer];
        if (
          witness !== undefined &&
          witness.address !== physicalPage * 32 + cell.offset
        )
          issue(
            [...path, physicalPage],
            "RAM page placement must preserve the writer's canonical physical address.",
          );
      }
  }
};
type Validation = {
  graph: RamGraph;
  issue: Issue;
  bitmap: (index: number) => bigint | null;
  values: (index: number) => NesDiscoveryDecodedValueFacts | null;
};
const ordered = (values: readonly number[]): boolean =>
  values.every((value, offset) => offset === 0 || values[offset - 1]! < value);
const sourceRegister = (mnemonic: string): "a" | "x" | "y" | null =>
  mnemonic === "STA" || mnemonic === "PHA"
    ? "a"
    : mnemonic === "STX"
      ? "x"
      : mnemonic === "STY"
        ? "y"
        : null;
const indexWrites = (references: readonly Reference[]) => {
  const writes = new Map<string, Reference[]>();
  for (const reference of references) {
    if (
      (reference.kind !== "write" && reference.kind !== "mapper-write") ||
      reference.address === null ||
      reference.address >= 0x2000
    )
      continue;
    const key = `${reference.node_index}:${reference.analysis_index}`,
      retained = writes.get(key) ?? [];
    retained.push(reference);
    writes.set(key, retained);
  }
  return writes;
};
const validateWriteSupport = (
  witness: Witness,
  analysisIndex: number,
  writes: Map<string, Reference[]>,
  validation: Validation,
): boolean => {
  const { graph, bitmap } = validation,
    analysis = graph.analyses[analysisIndex];
  if (analysis?.node_index !== witness.node_index) return false;
  const register = sourceRegister(
    graph.nodes[witness.node_index]?.mnemonic ?? "",
  );
  if (
    register !== null &&
    bitmap(analysis.register_domains_in[register]) !==
      bitmap(witness.domain_index)
  )
    return false;
  return (writes.get(`${witness.node_index}:${analysisIndex}`) ?? []).some(
    (reference) =>
      reference.address !== null &&
      (reference.address & 2047) === witness.address &&
      isDeepStrictEqual(reference.value, witness.value),
  );
};
const validateWitnesses = (validation: Validation) => {
  const { graph, issue, bitmap } = validation,
    writes = indexWrites(graph.data_references),
    identities = new Set<string>();
  for (const [position, witness] of graph.write_witnesses.entries()) {
    const path = ["write_witnesses", position],
      domain = bitmap(witness.domain_index),
      identity = JSON.stringify([
        witness.node_index,
        witness.address,
        witness.domain_index,
      ]);
    if (
      domain === null ||
      domain === 0n ||
      !isDeepStrictEqual(witness.value, nesDiscoveryDomainEnvelope(domain))
    )
      issue(
        path,
        "An actual write retains its exact write-time domain and original common-bit value.",
      );
    if (
      witness.index !== position ||
      identities.has(identity) ||
      !ordered(witness.analysis_indices)
    )
      issue(
        path,
        "Actual writer identities and supporting analyses must be unique and canonical.",
      );
    identities.add(identity);
    poolRef(
      witness.node_index,
      graph.nodes.length,
      [...path, "node_index"],
      issue,
    );
    for (const [offset, analysis] of witness.analysis_indices.entries())
      if (!validateWriteSupport(witness, analysis, writes, validation))
        issue(
          [...path, "analysis_indices", offset],
          "A writer must retain its actual write and source register domain from this analysis, without later conditional rewriting.",
        );
  }
};
const validatePages = ({ graph, issue }: Validation) => {
  const identities = new Set<string>();
  for (const [position, page] of graph.ram_pages.entries()) {
    const path = ["ram_pages", position],
      key = JSON.stringify(page.cells);
    if (
      page.index !== position ||
      identities.has(key) ||
      !ordered(page.cells.map((cell) => cell.offset))
    )
      issue(
        path,
        "RAM pages require unique identities and ordered physical slots.",
      );
    identities.add(key);
    for (const [offset, cell] of page.cells.entries()) {
      if (!ordered(cell.writer_witness_indices))
        issue(
          [...path, "cells", offset],
          "Actual writer alternatives must be ordered and unique.",
        );
      if (
        !cell.initial_unwritten_possible &&
        !cell.unknown_write_possible &&
        cell.writer_witness_indices.length === 0
      )
        issue(
          [...path, "cells", offset],
          "A RAM byte requires an actual writer, an initial byte or an explicitly unlocated write alternative.",
        );
      for (const writer of cell.writer_witness_indices)
        poolRef(
          writer,
          graph.write_witnesses.length,
          [...path, "cells", offset, "writer_witness_indices"],
          issue,
        );
    }
  }
};
const sourceCell = (
  graph: RamGraph,
  snapshotIndex: number,
  address: number,
) => {
  const pageIndex =
    graph.value_snapshots[snapshotIndex]?.ram_pages[address >> 5];
  return pageIndex == null
    ? undefined
    : graph.ram_pages[pageIndex]?.cells.find(
        (cell) => cell.offset === (address & 31),
      );
};
const validateReadWriters = (
  origin: Reference["ram_origins"][number],
  path: (string | number)[],
  { graph, issue }: Validation,
) => {
  const nodes = new Set<number>();
  if (
    !ordered(origin.writer_witness_indices) ||
    !ordered(origin.condition_witness_indices)
  )
    issue(
      path,
      "Read writer alternatives and conditional proofs must be unique and ordered.",
    );
  for (const [offset, index] of origin.writer_witness_indices.entries()) {
    const witness = graph.write_witnesses[index];
    poolRef(
      index,
      graph.write_witnesses.length,
      [...path, "writer_witness_indices", offset],
      issue,
    );
    if (witness !== undefined) {
      nodes.add(witness.node_index);
      if (witness.address !== origin.ram_address)
        issue(
          path,
          "A RAM origin must retain its writer's canonical physical address.",
        );
    }
  }
  if (
    !isDeepStrictEqual(
      [...nodes].sort((a, b) => a - b),
      origin.writer_nodes,
    )
  )
    issue(
      [...path, "writer_nodes"],
      "Writer nodes derive only from retained actual write witnesses.",
    );
};
const stackConditionMatches = (
  witness: NesDiscoveryConditionWitnessFact | undefined,
  reference: Reference,
  domains: { before: bigint; read: bigint },
  validation: Validation,
): boolean =>
  witness?.kind === "stack-alias" &&
  reference.address !== null &&
  witness.variable === (reference.address & 2047) + 4 &&
  witness.node_index === reference.node_index &&
  witness.analysis_indices.includes(reference.analysis_index) &&
  validation.bitmap(witness.source_domain_index) === domains.before &&
  validation.bitmap(witness.result_domain_index) === domains.read &&
  reference.relative_stack_origins.some(
    (origin) => origin.offset === witness.relative_offset,
  );

const validateReadDomain = (
  reference: Reference,
  origin: Reference["ram_origins"][number],
  path: (string | number)[],
  validation: Validation,
) => {
  const { graph, bitmap, values, issue } = validation,
    analysis = graph.analyses[reference.analysis_index],
    facts = analysis === undefined ? null : values(analysis.value_snapshot_in),
    readDomain = bitmap(origin.domain_index);
  if (facts === null || readDomain === null || readDomain === 0n) {
    issue(
      path,
      "A RAM read requires its owning input value snapshot and a nonempty exact domain.",
    );
    return;
  }
  const subject = nesDiscoveryValueFact(facts, 4 + origin.ram_address),
    leader = nesDiscoveryValueFact(facts, subject.leader),
    inherited = leader.conditions;
  let expected = [...inherited];
  if (readDomain !== subject.bitmap) {
    const aliases = origin.condition_witness_indices.filter((index) =>
      stackConditionMatches(
        graph.condition_witnesses[index],
        reference,
        { before: subject.bitmap, read: readDomain },
        validation,
      ),
    );
    if (aliases.length !== 1) {
      issue(
        path,
        "A read-time narrowing requires its actual physical-relative stack alias proof.",
      );
      return;
    }
    expected = [
      ...new Set([
        ...inherited.filter((index) => {
          const witness = graph.condition_witnesses[index],
            domain =
              witness === undefined
                ? null
                : bitmap(witness.result_domain_index);
          return domain !== null && (domain & readDomain) !== 0n;
        }),
        aliases[0]!,
      ]),
    ].sort((a, b) => a - b);
  }
  if (
    !isDeepStrictEqual(origin.condition_witness_indices, expected) ||
    !isDeepStrictEqual(reference.value, nesDiscoveryDomainEnvelope(readDomain))
  )
    issue(
      path,
      "A RAM read preserves its input value domain and leader proofs; only an actual physical-relative stack alias can add a read-time condition. Later instruction writes are not read sources.",
    );
};
const validateReadOrigin = (
  reference: Reference,
  origin: Reference["ram_origins"][number],
  path: (string | number)[],
  validation: Validation,
) => {
  const { graph, issue } = validation;
  if (
    (reference.kind !== "read" && reference.kind !== "pointer") ||
    reference.address === null ||
    reference.address >= 0x2000 ||
    (reference.address & 2047) !== origin.ram_address
  )
    issue(
      path,
      "A RAM read retains its logical address and canonical physical byte.",
    );
  for (const condition of origin.condition_witness_indices)
    poolRef(
      condition,
      graph.condition_witnesses.length,
      [...path, "condition_witness_indices"],
      issue,
    );
  const analysis = graph.analyses[reference.analysis_index],
    cell =
      analysis === undefined
        ? undefined
        : sourceCell(graph, analysis.value_snapshot_in, origin.ram_address);
  if (
    !isDeepStrictEqual(
      origin.writer_witness_indices,
      cell?.writer_witness_indices ?? [],
    ) ||
    origin.initial_unwritten_possible !==
      (cell?.initial_unwritten_possible ?? true) ||
    origin.unknown_write_possible !== (cell?.unknown_write_possible ?? false)
  )
    issue(
      path,
      "A RAM read preserves actual writers, initial bytes and possible unlocated writes from its input snapshot.",
    );
  validateReadDomain(reference, origin, path, validation);
  validateReadWriters(origin, path, validation);
};
/** Actual writer provenance and current conditional values have separate owners. */
export const validateNesDiscoveryRamEvidence = (
  graph: RamGraph,
  issue: Issue,
) => {
  const decode = createNesDiscoveryValueFactDecoder(graph);
  const domains = new Map<number, bigint | null>(),
    snapshots = new Map<number, NesDiscoveryDecodedValueFacts | null>();
  const validation: Validation = {
    graph,
    issue,
    bitmap(index) {
      if (!domains.has(index)) {
        const domain = graph.byte_domains[index];
        domains.set(
          index,
          domain === undefined
            ? null
            : parseNesDiscoveryDomainBitmap(domain.bitmap_hex),
        );
      }
      return domains.get(index)!;
    },
    values(index) {
      if (!snapshots.has(index)) snapshots.set(index, decode(index));
      return snapshots.get(index)!;
    },
  };
  validateWitnesses(validation);
  validatePages(validation);
  for (const [position, reference] of graph.data_references.entries())
    for (const [offset, origin] of reference.ram_origins.entries())
      validateReadOrigin(
        reference,
        origin,
        ["data_references", position, "ram_origins", offset],
        validation,
      );
};
