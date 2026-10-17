import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import type { NesDiscoveryValueEvidence } from "./nesCodeDiscoveryValueEvidence.js";
import type { NesDiscoveryValueBudget } from "./nesCodeDiscoveryValueBudget.js";
import type { NesDiscoverySuccessor } from "./nesCodeDiscoveryTransfer.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import { nesCodeDiscoveryCoverage } from "./nesCodeDiscoveryCoverage.js";
export type NesDiscoveryGraph = Extract<
  NesCodeDiscovery,
  { status: "derived" }
>;
type Graph = NesDiscoveryGraph;
export const nesDiscoveryLocationKey = (
  invocation: number,
  context: number,
  address: number,
): string => `${invocation}:${context}:${address}`;
export const nesDiscoveryWorkKey = (
  invocation: number,
  context: number,
  address: number,
  partition: number,
): string =>
  `${nesDiscoveryLocationKey(invocation, context, address)}:${partition}`;
export const initialNesDiscoveryGraph = (): Graph => ({
  status: "derived",
  termination: "worklist-exhausted",
  contexts: [],
  partitions: [{ index: 0, selections: [] }],
  pending_refinements: [],
  invocations: [],
  continuations: [],
  return_summaries: [],
  ram_pages: [],
  write_witnesses: [],
  relative_stack_pages: [],
  relative_stack_write_witnesses: [],
  value_state_records: 0,
  value_pages: [],
  value_snapshots: [],
  condition_witnesses: [],
  byte_domains: [],
  flag_predicate_sources: [],
  pending_returns: [],
  roots: [],
  nodes: [],
  analyses: [],
  edges: [],
  data_references: [],
  frontiers: [],
  pending: [],
  coverage: {
    prg_bytes: 0,
    decoded_bytes: 0,
    referenced_bytes: 0,
    overlap_bytes: 0,
    unclassified_bytes: 0,
    intervals: [],
  },
  work_items_processed: 0,
  nes_prg_views: [],
});
export const finishNesDiscoveryGraph = (
  header: NesRomMetadata,
  graph: Graph,
  nodeIndices: Map<string, number>,
  pending: Graph["pending"],
): void => {
  const queued = new Set(
    pending.map((item) =>
      nesDiscoveryLocationKey(
        item.invocation_index,
        item.context_index,
        item.address,
      ),
    ),
  );
  for (const root of graph.roots)
    if (
      root.context_index !== null &&
      root.invocation_index !== null &&
      root.target_address !== null
    ) {
      root.node_index =
        nodeIndices.get(
          nesDiscoveryLocationKey(
            root.invocation_index,
            root.context_index,
            root.target_address,
          ),
        ) ?? null;
      if (root.node_index === null && root.reason === null)
        root.reason = queued.has(
          nesDiscoveryLocationKey(
            root.invocation_index,
            root.context_index,
            root.target_address,
          ),
        )
          ? graph.termination
          : "undecoded-root";
    }
  for (const edge of graph.edges)
    if (
      edge.resolution !== "unresolved" &&
      edge.target_context_index !== null &&
      edge.target_invocation_index !== null &&
      edge.target_address !== null
    )
      edge.to =
        nodeIndices.get(
          nesDiscoveryLocationKey(
            edge.target_invocation_index,
            edge.target_context_index,
            edge.target_address,
          ),
        ) ?? null;
  graph.pending = pending;
  graph.coverage = nesCodeDiscoveryCoverage(header, graph);
};

export const appendNesDiscoveryContext = (
  graph: Graph,
  header: NesRomMetadata,
  state: NesMapperState,
): number => {
  const index = graph.contexts.length,
    mapping = mapperMapping(header, state);
  graph.contexts.push({ index, state: structuredClone(state), mapping });
  if (
    mapping.prg_view !== null &&
    !graph.nes_prg_views.some(
      (view) => JSON.stringify(view) === JSON.stringify(mapping.prg_view),
    )
  )
    graph.nes_prg_views.push(mapping.prg_view);
  return index;
};

export const appendNesDiscoveryFrontier = (
  graph: Graph,
  location: {
    context_index: number;
    invocation_index?: number | null;
    partition_index?: number | null;
    address: number | null;
    from: number | null;
  },
  reason: string,
  source: { bytes_hex: string; file_offsets: (number | null)[] } = {
    bytes_hex: "",
    file_offsets: [],
  },
): void => {
  graph.frontiers.push({
    ...location,
    partition_index: location.partition_index ?? null,
    invocation_index:
      location.invocation_index ??
      (location.from === null
        ? null
        : graph.nodes[location.from]!.invocation_index),
    reason,
    ...source,
  });
};

export const prepareNesDiscoveryEdgeSource = (
  owner: {
    graph: Graph;
    domains: NesDiscoveryDomainEvidence;
    values: NesDiscoveryValueEvidence;
    budget: NesDiscoveryValueBudget;
  },
  node: Graph["nodes"][number],
  analysis_index: number,
  next: NesDiscoverySuccessor,
) => {
  if (
    next.condition !== null &&
    !owner.budget.reserve(
      owner.domains.inlineCost(next.state.flag_predicates, next.state.values),
    )
  )
    return null;
  return {
    index: owner.graph.edges.length,
    from: node.index,
    analysis_index,
    condition: next.condition,
    value_snapshot:
      next.condition === null
        ? null
        : owner.values.snapshot(next.state.values, next.state.ram),
    register_domains:
      next.condition === null
        ? null
        : owner.domains.snapshot(next.state.register_domains),
    flag_predicates:
      next.condition === null
        ? null
        : owner.domains.predicates(
            next.state.flag_predicates,
            next.state.values,
          ),
    target_partition_index: next.state.partition_index,
    kind:
      next.kind === "return" &&
      next.return_proof !== undefined &&
      next.return_proof !== "opaque-token" &&
      owner.graph.invocations[node.invocation_index]!.frame.kind === "root"
        ? ("stack-jump" as const)
        : next.kind,
    continuation_index: null,
    summary_index: null,
  };
};
