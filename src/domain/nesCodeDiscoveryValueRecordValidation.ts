import type { z } from "zod";
import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import type { NesDiscoveryPredicateSnapshot } from "./nesCodeDiscoveryDomainFacts.js";

type Graph = Extract<NesCodeDiscovery, { status: "derived" }>;
const inlineSnapshotRecords = (predicates: NesDiscoveryPredicateSnapshot) => {
  // One CPU-domain object and four references; one flag map and three slots.
  let count = 9;
  for (const flag of ["c", "z", "n"] as const) {
    const predicate = predicates[flag];
    if (predicate !== null)
      count +=
        1 +
        predicate.registers.length +
        predicate.source_witness_indices.length;
  }
  return count;
};
const witnessRecords = (
  pool: readonly { analysis_indices: readonly number[] }[],
) =>
  pool.reduce(
    (count, witness) => count + 1 + witness.analysis_indices.length,
    0,
  );
const memoryPageRecords = (
  pool: readonly {
    cells: readonly { writer_witness_indices: readonly number[] }[];
  }[],
) =>
  pool.reduce(
    (count, page) =>
      count +
      1 +
      page.cells.reduce(
        (cells, cell) => cells + 1 + cell.writer_witness_indices.length,
        0,
      ),
    0,
  );

/** Recompute retained representation expansion independently of admission code. */
export const validateNesDiscoveryValueRecords = (
  graph: Graph,
  ctx: z.RefinementCtx,
): void => {
  let count =
    graph.byte_domains.length +
    witnessRecords(graph.flag_predicate_sources) +
    witnessRecords(graph.write_witnesses) +
    witnessRecords(graph.relative_stack_write_witnesses) +
    witnessRecords(graph.condition_witnesses) +
    memoryPageRecords(graph.ram_pages) +
    memoryPageRecords(graph.relative_stack_pages);
  for (const page of graph.value_pages)
    count +=
      1 +
      page.entries.reduce(
        (entries, entry) =>
          entries + 1 + entry.condition_witness_indices.length,
        0,
      );
  for (const snapshot of graph.value_snapshots)
    count += 1 + snapshot.pages.length + snapshot.ram_pages.length;
  for (const analysis of graph.analyses)
    count +=
      inlineSnapshotRecords(analysis.flag_predicates_in) +
      inlineSnapshotRecords(analysis.flag_predicates_out);
  for (const invocation of graph.invocations)
    count += inlineSnapshotRecords(invocation.flag_predicates);
  for (const summary of graph.return_summaries)
    count += inlineSnapshotRecords(summary.flag_predicates);
  for (const edge of graph.edges)
    if (edge.flag_predicates !== null)
      count += inlineSnapshotRecords(edge.flag_predicates);
  for (const reference of graph.data_references) {
    count++;
    for (const origin of reference.ram_origins)
      count +=
        1 +
        origin.writer_nodes.length +
        origin.writer_witness_indices.length +
        origin.condition_witness_indices.length;
    for (const origin of reference.relative_stack_origins)
      count +=
        1 + origin.writer_nodes.length + origin.writer_witness_indices.length;
  }
  if (count !== graph.value_state_records)
    ctx.addIssue({
      code: "custom",
      path: ["value_state_records"],
      message:
        "Value capacity accounting must equal all retained records and expanded reference memberships; interned pools are counted once.",
    });
};
