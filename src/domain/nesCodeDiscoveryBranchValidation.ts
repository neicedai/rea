import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { NesCpuState } from "./nesCodeTrace.js";
import { decodeNes6502Opcode } from "./nes6502Opcodes.js";
import {
  nes6502BranchCondition,
  nes6502BranchTarget,
} from "./nes6502Branches.js";
import type {
  NesDiscoveryDomainSnapshot,
  NesDiscoveryPredicateSnapshot,
} from "./nesCodeDiscoveryDomainFacts.js";
import {
  createNesDiscoveryValueFactDecoder,
  conditionNesDiscoveryValueFacts,
  equalNesDiscoveryValueFacts,
  nesDiscoveryValueFact,
  type NesDiscoveryValueFactPools,
  type NesDiscoveryDecodedValueFacts,
} from "./nesCodeDiscoveryValueFacts.js";

type Node = {
  index: number;
  context_index: number;
  invocation_index: number;
  address: number;
  bytes_hex: string;
  mnemonic: string;
  addressing_mode: string;
};
type Analysis = {
  index: number;
  node_index: number;
  partition_index: number;
  cpu_in: NesCpuState;
  cpu_out: NesCpuState;
  frame_in: unknown;
  frame_out: unknown;
  relative_stack_in: (number | null)[];
  relative_stack_out: (number | null)[];
  register_relations_in: number;
  register_relations_out: number;
  register_domains_in: NesDiscoveryDomainSnapshot;
  register_domains_out: NesDiscoveryDomainSnapshot;
  flag_predicates_in: NesDiscoveryPredicateSnapshot;
  flag_predicates_out: NesDiscoveryPredicateSnapshot;
  value_snapshot_in: number;
  value_snapshot_out: number;
};
type Edge = {
  from: number;
  analysis_index: number;
  kind: string;
  condition: { flag: "c" | "z" | "n" | "v"; value: boolean } | null;
  register_domains: NesDiscoveryDomainSnapshot | null;
  flag_predicates: NesDiscoveryPredicateSnapshot | null;
  value_snapshot: number | null;
  target_address: number | null;
  target_context_index: number | null;
  target_invocation_index: number | null;
  target_partition_index: number | null;
};
type Graph = NesDiscoveryValueFactPools & {
  nodes: Node[];
  analyses: Analysis[];
  edges: Edge[];
};
type Issue = (path: (string | number)[], message: string) => void;
const isBranch = (kind: string) =>
  kind === "branch-taken" || kind === "branch-not-taken";

const sourceCondition = (node: Node, issue: Issue) => {
  const opcode = decodeNes6502Opcode(
    Number.parseInt(node.bytes_hex.slice(0, 2), 16),
  );
  const condition = nes6502BranchCondition(opcode?.mnemonic ?? "");
  if (condition === null) {
    if (nes6502BranchCondition(node.mnemonic) !== null)
      issue(
        ["nodes", node.index],
        "A branch mnemonic requires its original branch opcode bytes.",
      );
    return null;
  }
  if (
    node.mnemonic !== opcode?.mnemonic ||
    node.addressing_mode !== "rel" ||
    node.bytes_hex.length !== 4
  )
    issue(
      ["nodes", node.index],
      "A branch must retain its original two-byte relative instruction.",
    );
  return condition;
};
const validateAnalysis = (analysis: Analysis, issue: Issue) => {
  if (
    !isDeepStrictEqual(analysis.cpu_in, analysis.cpu_out) ||
    !isDeepStrictEqual(analysis.frame_in, analysis.frame_out) ||
    analysis.value_snapshot_in !== analysis.value_snapshot_out ||
    !isDeepStrictEqual(
      analysis.relative_stack_in,
      analysis.relative_stack_out,
    ) ||
    analysis.register_relations_in !== analysis.register_relations_out ||
    !isDeepStrictEqual(
      analysis.register_domains_in,
      analysis.register_domains_out,
    ) ||
    !isDeepStrictEqual(
      analysis.flag_predicates_in,
      analysis.flag_predicates_out,
    )
  )
    issue(
      ["analyses", analysis.index],
      "A branch analysis retains unconditioned instruction effects; its cloned successors own the edge-local flag choices.",
    );
};
const validateEdge = (
  edge: Edge,
  position: number,
  {
    node,
    analysis,
    graph,
    decode,
  }: {
    node: Node;
    analysis: Analysis;
    graph: Graph;
    decode: ReturnType<typeof createNesDiscoveryValueFactDecoder>;
  },
  issue: Issue,
) => {
  const condition = nes6502BranchCondition(node.mnemonic);
  if (condition === null) return;
  const needed =
    edge.kind === "branch-taken" ? condition.expected : !condition.expected;
  if (
    edge.condition?.flag !== condition.flag ||
    edge.condition.value !== needed ||
    (analysis.cpu_in[condition.flag] !== null &&
      analysis.cpu_in[condition.flag] !== needed)
  )
    issue(
      ["edges", position, "condition"],
      "The branch condition must agree with its opcode, edge kind and specific source analysis.",
    );
  const domains = decode(analysis.value_snapshot_in),
    expected =
      domains === null
        ? null
        : conditionNesDiscoveryValueFacts(
            domains,
            analysis.flag_predicates_in,
            condition.flag,
            needed,
          ),
    retained =
      edge.value_snapshot === null ? null : decode(edge.value_snapshot);
  if (
    expected === null ||
    retained === null ||
    !equalNesDiscoveryValueFacts(expected, retained) ||
    !isDeepStrictEqual(edge.flag_predicates, analysis.flag_predicates_out)
  )
    issue(
      ["edges", position],
      "A branch successor must retain exactly its predicate-filtered byte domains and live source predicates.",
    );
  if (retained !== null)
    validateDomainProjection(edge, { graph, facts: retained }, position, issue);
  const next = (node.address + 2) & 65535;
  const target =
    edge.kind === "branch-taken"
      ? nes6502BranchTarget(next, Number.parseInt(node.bytes_hex.slice(2), 16))
      : next;
  if (
    edge.target_address !== target ||
    edge.target_context_index !== node.context_index ||
    edge.target_invocation_index !== node.invocation_index ||
    edge.target_partition_index !== analysis.partition_index
  )
    issue(
      ["edges", position],
      "A branch preserves its invocation, mapper context and partition, with the original signed-relative target.",
    );
};
const validateDomainProjection = (
  edge: Edge,
  { graph, facts }: { graph: Graph; facts: NesDiscoveryDecodedValueFacts },
  position: number,
  issue: Issue,
) => {
  for (const [variable, register] of (
    ["a", "x", "y", "sp"] as const
  ).entries()) {
    const index = edge.register_domains?.[register],
      domain = index === undefined ? undefined : graph.byte_domains[index];
    if (
      domain?.bitmap_hex !==
      nesDiscoveryValueFact(facts, variable)
        .bitmap.toString(16)
        .padStart(64, "0")
    )
      issue(
        ["edges", position, "register_domains"],
        "Branch CPU domain fields must project their conditioned current values.",
      );
  }
};

/** Cross-pool branch feasibility is a runtime semantic check, not a JSON Schema claim. */
export const validateNesDiscoveryBranches = (
  graph: Graph,
  ctx: z.RefinementCtx,
): void => {
  const issue: Issue = (path, message) =>
    ctx.addIssue({ code: "custom", path, message });
  const decode = createNesDiscoveryValueFactDecoder(graph);
  const conditions = graph.nodes.map((node) => sourceCondition(node, issue));
  const byAnalysis = new Map<number, Edge[]>();
  for (const [position, edge] of graph.edges.entries()) {
    const node = graph.nodes[edge.from],
      analysis = graph.analyses[edge.analysis_index];
    const branch = isBranch(edge.kind);
    if (!branch) {
      if (
        edge.condition !== null ||
        edge.register_domains !== null ||
        edge.flag_predicates !== null ||
        edge.value_snapshot !== null ||
        conditions[edge.from] != null
      )
        issue(
          ["edges", position],
          "Only branch edges carry a condition; branch instructions require branch edge kinds.",
        );
      continue;
    }
    if (
      node === undefined ||
      analysis === undefined ||
      conditions[edge.from] == null
    ) {
      issue(
        ["edges", position],
        "A branch edge requires its original branch instruction and analysis.",
      );
      continue;
    }
    validateEdge(edge, position, { node, analysis, graph, decode }, issue);
    const edges = byAnalysis.get(edge.analysis_index) ?? [];
    edges.push(edge);
    byAnalysis.set(edge.analysis_index, edges);
  }
  for (const analysis of graph.analyses) {
    const condition = conditions[analysis.node_index];
    if (condition == null) continue;
    validateAnalysis(analysis, issue);
    const value = analysis.cpu_in[condition.flag],
      domains = decode(analysis.value_snapshot_in),
      expected = [false, true]
        .filter((taken) => {
          const selected = taken ? condition.expected : !condition.expected;
          return (
            (value === null || value === selected) &&
            domains !== null &&
            conditionNesDiscoveryValueFacts(
              domains,
              analysis.flag_predicates_in,
              condition.flag,
              selected,
            ) !== null
          );
        })
        .map((taken) => (taken ? "branch-taken" : "branch-not-taken"));
    const retained = (byAnalysis.get(analysis.index) ?? [])
      .map((edge) => edge.kind)
      .sort();
    if (!isDeepStrictEqual(retained, expected.sort()))
      issue(
        ["analyses", analysis.index],
        "Each branch analysis retains exactly its flag-compatible successors, including both conditions when their targets coincide.",
      );
  }
};
