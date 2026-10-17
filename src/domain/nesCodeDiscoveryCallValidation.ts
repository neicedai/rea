import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { NesByteValue } from "./nesByteValue.js";
import type {
  NesDiscoveryValueFactPools,
  NesDiscoveryConditionWitnessFact,
} from "./nesCodeDiscoveryValueFacts.js";
import type { NesDiscoveryDomainSnapshot } from "./nesCodeDiscoveryDomainFacts.js";
import {
  validateNesDiscoveryRamSnapshot,
  validateNesDiscoveryRamEvidence,
} from "./nesCodeDiscoveryRamValidation.js";
import type {
  nesDiscoveryInvocationSchema,
  nesDiscoveryContinuationSchema,
  nesDiscoveryReturnSummarySchema,
  nesDiscoveryWriteWitnessSchema,
  nesDiscoveryRamPageSchema,
} from "./nesCodeDiscoveryCalls.js";

type Invocation = z.infer<typeof nesDiscoveryInvocationSchema>;
type Continuation = z.infer<typeof nesDiscoveryContinuationSchema>;
type Summary = z.infer<typeof nesDiscoveryReturnSummarySchema>;
type Witness = z.infer<typeof nesDiscoveryWriteWitnessSchema>;
type RamPage = z.infer<typeof nesDiscoveryRamPageSchema>;
type Node = {
  index: number;
  invocation_index: number;
  context_index: number;
  address: number;
  mnemonic: string;
  bytes_hex: string;
};
type Analysis = {
  index: number;
  node_index: number;
  invocation_index: number;
  partition_index: number;
  cpu_in: Summary["cpu_out"];
  cpu_out: Summary["cpu_out"];
  register_relations_out: number;
  frame_out: Summary["frame"];
  value_snapshot_in: number;
  value_snapshot_out: number;
  register_domains_in: NesDiscoveryDomainSnapshot;
};
type Edge = {
  from: number;
  analysis_index: number;
  kind: string;
  resolution: string;
  target_address: number | null;
  target_context_index: number | null;
  target_invocation_index: number | null;
  continuation_index: number | null;
  summary_index: number | null;
  to: number | null;
};
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
type CallGraph = NesDiscoveryValueFactPools & {
  contexts: unknown[];
  invocations: Invocation[];
  continuations: Continuation[];
  return_summaries: Summary[];
  write_witnesses: Witness[];
  ram_pages: RamPage[];
  condition_witnesses: NesDiscoveryConditionWitnessFact[];
  nodes: Node[];
  analyses: Analysis[];
  edges: Edge[];
  data_references: Reference[];
  roots: {
    invocation_index: number | null;
    context_index: number | null;
    target_address: number | null;
    node_index: number | null;
  }[];
  frontiers: { invocation_index: number | null; from: number | null }[];
  pending: {
    invocation_index: number;
    context_index: number;
    address: number;
  }[];
  pending_returns: {
    continuation_index: number;
    next_summary_offset: number;
  }[];
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
const validateContinuations = (graph: CallGraph, issue: Issue) => {
  for (const [position, binding] of graph.continuations.entries()) {
    const path = ["continuations", position];
    poolRef(
      binding.caller_invocation_index,
      graph.invocations.length,
      [...path, "caller_invocation_index"],
      issue,
    );
    poolRef(
      binding.callee_invocation_index,
      graph.invocations.length,
      [...path, "callee_invocation_index"],
      issue,
    );
    poolRef(
      binding.call_node_index,
      graph.nodes.length,
      [...path, "call_node_index"],
      issue,
    );
    const node = graph.nodes[binding.call_node_index];
    if (
      node !== undefined &&
      (node.mnemonic !== "JSR" ||
        node.invocation_index !== binding.caller_invocation_index ||
        ((node.address + 3) & 65535) !== binding.return_address)
    )
      issue(
        path,
        "Continuation must bind its caller's JSR and the corresponding return address.",
      );
    for (const [
      offset,
      analysisIndex,
    ] of binding.call_analysis_indices.entries()) {
      poolRef(
        analysisIndex,
        graph.analyses.length,
        [...path, "call_analysis_indices", offset],
        issue,
      );
      const analysis = graph.analyses[analysisIndex];
      if (
        analysis !== undefined &&
        (analysis.node_index !== binding.call_node_index ||
          analysis.partition_index !== binding.caller_partition_index ||
          analysis.invocation_index !== binding.caller_invocation_index)
      )
        issue(
          [...path, "call_analysis_indices", offset],
          "Call witness must belong to this caller and JSR node.",
        );
    }
  }
};
const physicalReturnMatches = (
  summary: Summary,
  analysis: Analysis | undefined,
  references: Reference[],
  witnesses: Witness[],
): boolean => {
  const sp = summary.cpu_out.sp;
  if (
    sp === null ||
    analysis === undefined ||
    analysis.cpu_in.sp !== ((sp - 2) & 255)
  )
    return false;
  const reads = references;
  if (reads.length !== 2) return false;
  const backed = (read: Reference | undefined) =>
    read !== undefined &&
    typeof read.value === "number" &&
    read.ram_origins.some(
      (origin) =>
        origin.ram_address === read.address &&
        origin.writer_witness_indices.every((index) => {
          const witness = witnesses[index];
          return witness?.address === read.address;
        }),
    );
  const low = reads[0],
    high = reads[1];
  return (
    low?.node_index === summary.return_node_index &&
    high?.node_index === summary.return_node_index &&
    backed(low) &&
    backed(high) &&
    low?.address === (256 | ((sp - 1) & 255)) &&
    high?.address === (256 | sp) &&
    typeof low.value === "number" &&
    typeof high.value === "number" &&
    (((low.value | (high.value << 8)) + 1) & 65535) === summary.stack_target
  );
};
const summaryAnalysisMatches = (summary: Summary, analysis: Analysis) =>
  analysis.node_index === summary.return_node_index &&
  analysis.partition_index === summary.partition_index &&
  analysis.register_relations_out === summary.register_relations &&
  analysis.invocation_index === summary.invocation_index &&
  isDeepStrictEqual(analysis.cpu_out, summary.cpu_out) &&
  isDeepStrictEqual(analysis.frame_out, summary.frame);
const validateSummaries = (graph: CallGraph, issue: Issue) => {
  const reads = new Map<number, Reference[]>();
  for (const reference of graph.data_references) {
    if (reference.kind !== "read") continue;
    const retained = reads.get(reference.analysis_index);
    if (retained === undefined)
      reads.set(reference.analysis_index, [reference]);
    else retained.push(reference);
  }
  for (const [position, summary] of graph.return_summaries.entries()) {
    const path = ["return_summaries", position];
    for (const [name, value, length] of [
      ["invocation_index", summary.invocation_index, graph.invocations.length],
      ["context_index", summary.context_index, graph.contexts.length],
      ["return_node_index", summary.return_node_index, graph.nodes.length],
      [
        "return_analysis_index",
        summary.return_analysis_index,
        graph.analyses.length,
      ],
    ] as const)
      poolRef(value, length, [...path, name], issue);
    const node = graph.nodes[summary.return_node_index],
      analysis = graph.analyses[summary.return_analysis_index];
    if (
      node !== undefined &&
      (node.mnemonic !== "RTS" ||
        node.invocation_index !== summary.invocation_index ||
        node.context_index !== summary.context_index)
    )
      issue(
        path,
        "Return summary must retain its invocation's RTS and post-return mapper context.",
      );
    if (analysis !== undefined && !summaryAnalysisMatches(summary, analysis))
      issue(
        path,
        "Return summary must preserve its specific exit analysis and complete CPU/frame facts.",
      );
    if (summary.frame.kind === "root")
      issue([...path, "frame"], "A root has no matched-call return frame.");
    if (summary.return_proof === "physical-bytes") {
      if (
        !physicalReturnMatches(
          summary,
          analysis,
          reads.get(summary.return_analysis_index) ?? [],
          graph.write_witnesses,
        )
      )
        issue(
          [...path, "stack_target"],
          "A physical return requires its current stack pointer and two actual stack-byte reads.",
        );
    } else if (
      summary.return_proof === "opaque-token" &&
      (summary.frame.kind !== "opaque" ||
        !summary.frame.intact ||
        summary.frame.relative_sp !== 2)
    )
      issue(
        [...path, "frame"],
        "A return without physical bytes requires an intact balanced opaque token.",
      );
    validateNesDiscoveryRamSnapshot(
      summary.ram_out,
      graph,
      [...path, "ram_out"],
      issue,
    );
  }
};
const validateMatchedReturn = (
  graph: CallGraph,
  edge: Edge,
  path: (string | number)[],
  issue: Issue,
) => {
  if (edge.continuation_index === null || edge.summary_index === null) return;
  const binding = graph.continuations[edge.continuation_index],
    summary = graph.return_summaries[edge.summary_index];
  if (edge.kind !== "return" || edge.resolution !== "resolved")
    issue(
      path,
      "Matched-return witnesses belong only to resolved return edges.",
    );
  if (
    binding !== undefined &&
    summary !== undefined &&
    (binding.callee_invocation_index !== summary.invocation_index ||
      edge.from !== summary.return_node_index ||
      edge.analysis_index !== summary.return_analysis_index ||
      edge.target_invocation_index !== binding.caller_invocation_index ||
      edge.target_context_index !== summary.context_index ||
      edge.target_address !== binding.return_address ||
      (summary.stack_target !== null &&
        summary.stack_target !== binding.return_address))
  )
    issue(
      path,
      "Matched return must preserve its exact caller, callee, exit state and return address.",
    );
};
const validateEdges = (graph: CallGraph, issue: Issue) => {
  for (const [position, edge] of graph.edges.entries()) {
    const path = ["edges", position];
    poolRef(
      edge.target_invocation_index,
      graph.invocations.length,
      [...path, "target_invocation_index"],
      issue,
    );
    poolRef(
      edge.continuation_index,
      graph.continuations.length,
      [...path, "continuation_index"],
      issue,
    );
    poolRef(
      edge.summary_index,
      graph.return_summaries.length,
      [...path, "summary_index"],
      issue,
    );
    if (
      edge.to !== null &&
      graph.nodes[edge.to]?.invocation_index !== edge.target_invocation_index
    )
      issue(
        [...path, "to"],
        "Edge target must preserve its invocation identity.",
      );
    if ((edge.continuation_index === null) !== (edge.summary_index === null))
      issue(
        path,
        "A matched return requires both continuation and summary witnesses.",
      );
    if (
      edge.kind === "return" &&
      edge.resolution === "resolved" &&
      (edge.continuation_index === null || edge.summary_index === null)
    )
      issue(
        path,
        "A resolved return requires its matched continuation and exit summary.",
      );
    validateMatchedReturn(graph, edge, path, issue);
  }
};
const validatePoolOwnership = (graph: CallGraph, issue: Issue) => {
  for (const [name, pool] of [
    ["invocations", graph.invocations],
    ["continuations", graph.continuations],
    ["return_summaries", graph.return_summaries],
    ["write_witnesses", graph.write_witnesses],
    ["ram_pages", graph.ram_pages],
  ] as const)
    for (const [position, item] of pool.entries())
      if (item.index !== position)
        issue(
          [name, position, "index"],
          "Pool identity must equal its array position.",
        );
  for (const [position, invocation] of graph.invocations.entries()) {
    poolRef(
      invocation.entry_context_index,
      graph.contexts.length,
      ["invocations", position, "entry_context_index"],
      issue,
    );
    validateNesDiscoveryRamSnapshot(
      invocation.ram_in,
      graph,
      ["invocations", position, "ram_in"],
      issue,
    );
  }
};
const validateLocationInvocations = (graph: CallGraph, issue: Issue) => {
  for (const [position, node] of graph.nodes.entries())
    poolRef(
      node.invocation_index,
      graph.invocations.length,
      ["nodes", position, "invocation_index"],
      issue,
    );
  for (const [position, analysis] of graph.analyses.entries()) {
    poolRef(
      analysis.invocation_index,
      graph.invocations.length,
      ["analyses", position, "invocation_index"],
      issue,
    );
    if (
      graph.nodes[analysis.node_index]?.invocation_index !==
      analysis.invocation_index
    )
      issue(
        ["analyses", position, "invocation_index"],
        "Analysis must retain its node's invocation.",
      );
  }
  for (const [position, root] of graph.roots.entries()) {
    poolRef(
      root.invocation_index,
      graph.invocations.length,
      ["roots", position, "invocation_index"],
      issue,
    );
    if (
      root.node_index !== null &&
      graph.nodes[root.node_index]?.invocation_index !== root.invocation_index
    )
      issue(
        ["roots", position, "node_index"],
        "Root must retain its invocation's entry node.",
      );
  }
  for (const [position, item] of graph.pending.entries())
    poolRef(
      item.invocation_index,
      graph.invocations.length,
      ["pending", position, "invocation_index"],
      issue,
    );
  for (const [position, item] of graph.frontiers.entries())
    poolRef(
      item.invocation_index,
      graph.invocations.length,
      ["frontiers", position, "invocation_index"],
      issue,
    );
};
const validatePendingReturns = (graph: CallGraph, issue: Issue) => {
  const summaryCounts = new Map<number, number>();
  for (const summary of graph.return_summaries)
    summaryCounts.set(
      summary.invocation_index,
      (summaryCounts.get(summary.invocation_index) ?? 0) + 1,
    );
  for (const [position, item] of graph.pending_returns.entries()) {
    poolRef(
      item.continuation_index,
      graph.continuations.length,
      ["pending_returns", position, "continuation_index"],
      issue,
    );
    const binding = graph.continuations[item.continuation_index];
    if (
      binding !== undefined &&
      item.next_summary_offset >=
        (summaryCounts.get(binding.callee_invocation_index) ?? 0)
    )
      issue(
        ["pending_returns", position, "next_summary_offset"],
        "Pending return cursor must identify an undelivered callee summary.",
      );
  }
};
/** Cross-pool ownership belongs to the wire contract, independently of the solver. */
export const validateNesDiscoveryCalls = (
  graph: CallGraph,
  ctx: z.RefinementCtx,
): void => {
  const issue: Issue = (path, message) =>
    ctx.addIssue({ code: "custom", path, message });
  validatePoolOwnership(graph, issue);
  validateLocationInvocations(graph, issue);
  validatePendingReturns(graph, issue);
  validateContinuations(graph, issue);
  validateSummaries(graph, issue);
  validateEdges(graph, issue);
  validateNesDiscoveryRamEvidence(graph, issue);
};
