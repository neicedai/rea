import { isDeepStrictEqual } from "node:util";
import {
  nesDiscoveryDomainEnvelope,
  parseNesDiscoveryDomainBitmap,
} from "./nesCodeDiscoveryDomainFacts.js";
import {
  createNesDiscoveryValueFactDecoder,
  nesDiscoveryValueFact,
  type NesDiscoveryDecodedValueFacts,
} from "./nesCodeDiscoveryValueFacts.js";
import type {
  Graph,
  Reference,
  Analysis,
  Origin,
} from "./nesCodeDiscoveryRelativeValidationTypes.js";
type Issue = (path: (string | number)[], message: string) => void;
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

const inputStackOffset = (mnemonic: string, ordinal: number, offset: number) =>
  mnemonic === "RTS"
    ? ordinal + 1
    : mnemonic === "PLA" || mnemonic === "PLP"
      ? 1
      : offset;
const readSourceMatches = (
  source: {
    reference: Reference;
    analysis: Analysis;
    origin: Origin;
    ordinal: number;
  },
  validation: {
    graph: Graph;
    facts: NesDiscoveryDecodedValueFacts | null | undefined;
    bitmap: (index: number) => bigint | null;
  },
): boolean => {
  const { reference, analysis, origin, ordinal } = source,
    { graph, facts, bitmap } = validation,
    mnemonic = graph.nodes[reference.node_index]?.mnemonic ?? "",
    offset = inputStackOffset(mnemonic, ordinal, origin.offset),
    cell = snapshotCell(graph, analysis.relative_stack_in, offset),
    relative = cell === undefined ? null : bitmap(cell.domain_index),
    address = reference.address,
    physical =
      address === null
        ? (1n << 256n) - 1n
        : facts == null
          ? null
          : nesDiscoveryValueFact(facts, 4 + (address & 2047)).bitmap,
    domain =
      relative === null || physical === null ? null : relative & physical;
  return (
    domain !== null &&
    domain !== 0n &&
    isDeepStrictEqual(
      origin.writer_witness_indices,
      cell?.writer_witness_indices,
    ) &&
    isDeepStrictEqual(reference.value, nesDiscoveryDomainEnvelope(domain)) &&
    (address === null ||
      reference.ram_origins.some(
        (ram) =>
          ram.ram_address === (address & 2047) &&
          bitmap(ram.domain_index) === domain,
      ))
  );
};
/** Pop coordinates change during the instruction; physical input values remain paired. */
export const validateNesDiscoveryRelativeReads = (
  graph: Graph,
  reads: Map<number, Reference[]>,
  issue: Issue,
) => {
  const decode = createNesDiscoveryValueFactDecoder(graph);
  const domains = new Map<number, bigint | null>(),
    snapshots = new Map<number, NesDiscoveryDecodedValueFacts | null>(),
    ordinals = new Map<Reference, number>();
  for (const references of reads.values())
    references.forEach((reference, ordinal) =>
      ordinals.set(reference, ordinal),
    );
  const bitmap = (index: number) => {
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
  };
  for (const [position, reference] of graph.data_references.entries()) {
    if (reference.kind !== "read" && reference.kind !== "pointer") continue;
    const analysis = graph.analyses[reference.analysis_index];
    if (analysis === undefined) continue;
    if (!snapshots.has(analysis.value_snapshot_in))
      snapshots.set(
        analysis.value_snapshot_in,
        decode(analysis.value_snapshot_in),
      );
    const facts = snapshots.get(analysis.value_snapshot_in);
    for (const [
      originIndex,
      origin,
    ] of reference.relative_stack_origins.entries()) {
      if (
        !readSourceMatches(
          {
            reference,
            analysis,
            origin,
            ordinal: ordinals.get(reference) ?? 0,
          },
          { graph, facts, bitmap },
        )
      )
        issue(
          ["data_references", position, "relative_stack_origins", originIndex],
          "A relative read retains its exact input cell and actual writers, intersected with the physical RAM value when its address is known.",
        );
    }
  }
};
