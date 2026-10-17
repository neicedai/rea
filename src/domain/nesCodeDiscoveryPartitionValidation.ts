import type { z } from "zod";
import type { NesCpuState } from "./nesCodeTrace.js";
import type { NesByteValue } from "./nesByteValue.js";
import { nesCpuByte } from "./nesCpuRegister.js";
import { nesRegisterEquals } from "./nesCodeDiscoveryRegisterRelations.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import type {
  nesDiscoveryPartitionSchema,
  nesDiscoveryRefinementSchema,
  nesDiscoveryPendingRefinementSchema,
} from "./nesCodeDiscoveryPartitionSchemas.js";

type Partition = z.infer<typeof nesDiscoveryPartitionSchema>;
type Refinement = z.infer<typeof nesDiscoveryRefinementSchema>;
type Analysis = {
  index: number;
  node_index: number;
  partition_index: number;
  cpu_in: NesCpuState;
  cpu_out: NesCpuState;
  register_relations_in: number;
  register_relations_out: number;
  refinement: Refinement | null;
};
type Graph = {
  partitions: Partition[];
  nodes: {
    invocation_index: number;
    context_index: number;
    address: number;
    addressing_mode: string;
  }[];
  analyses: Analysis[];
  invocations: { cpu_in: NesCpuState; register_relations: number }[];
  continuations: { caller_partition_index: number }[];
  return_summaries: {
    partition_index: number;
    cpu_out: NesCpuState;
    register_relations: number;
  }[];
  edges: {
    from: number;
    analysis_index: number;
    kind: string;
    resolution: string;
    target_invocation_index: number | null;
    target_partition_index: number | null;
    continuation_index: number | null;
    summary_index: number | null;
  }[];
  roots: { invocation_index: number | null; partition_index: number | null }[];
  frontiers: { partition_index: number | null }[];
  pending: { partition_index: number }[];
  pending_refinements: z.infer<typeof nesDiscoveryPendingRefinementSchema>[];
};
type Issue = (path: (string | number)[], message: string) => void;
const accepts = (proof: NesByteValue, value: number): boolean =>
  proof === null ||
  (typeof proof === "number"
    ? value === proof
    : (value & proof.mask) === proof.value);
const key = (selection: Partition["selections"][number]): string =>
  `${selection.node_index}:${selection.register}`;
const selectionKey = (selection: Partition["selections"][number]): string =>
  `${key(selection)}:${selection.value}`;
const validRelations = (
  cpu: NesCpuState,
  relations: number,
  path: (string | number)[],
  issue: Issue,
): void => {
  for (const register of ["a", "x", "y", "sp"] as const) {
    let mask = 0,
      bits = 0;
    for (const member of nesRegisterEquals(relations, register)) {
      const value = nesCpuByte(cpu, member),
        proof = typeof value === "number" ? { mask: 255, value } : value;
      if (proof === null) continue;
      if (((bits ^ proof.value) & mask & proof.mask) !== 0) {
        issue(
          path,
          "Must-equal register byte constraints cannot contradict one another.",
        );
        break;
      }
      mask |= proof.mask;
      bits |= proof.value;
    }
  }
};
const validateRefinement = (
  analysis: Analysis,
  graph: Graph,
  issue: Issue,
): void => {
  const refinement = analysis.refinement;
  if (refinement === null) return;
  const path = ["analyses", analysis.index, "refinement"],
    node = graph.nodes[analysis.node_index];
  const register =
    node?.addressing_mode === "aby" ||
    node?.addressing_mode === "zpy" ||
    node?.addressing_mode === "izy"
      ? "y"
      : ["abx", "zpx", "izx"].includes(node?.addressing_mode ?? "")
        ? "x"
        : null;
  if (
    register !== refinement.register ||
    !accepts(refinement.source_value, refinement.value)
  )
    issue(
      path,
      "A refinement must select a compatible byte for this indexed addressing mode.",
    );
  const equals = nesRegisterEquals(
    analysis.register_relations_in,
    refinement.register,
  );
  if (
    JSON.stringify(equals) !== JSON.stringify(refinement.equal_registers) ||
    equals.some(
      (member) => nesCpuByte(analysis.cpu_in, member) !== refinement.value,
    )
  )
    issue(
      path,
      "The selected byte must condition exactly its proven must-equal register group.",
    );
  if (
    !graph.partitions[analysis.partition_index]?.selections.some(
      (selection) =>
        selection.node_index === analysis.node_index &&
        selection.register === refinement.register &&
        selection.value === refinement.value,
    )
  )
    issue(
      path,
      "The analysis partition must preserve its indexed-byte selection.",
    );
};
const mergedSelections = (
  caller: Partition,
  callee: Partition,
): Partition["selections"] => {
  const values = new Map(
    caller.selections.map((selection) => [key(selection), selection]),
  );
  for (const selection of callee.selections)
    values.set(key(selection), selection);
  return [...values.values()].sort(
    (left, right) =>
      left.node_index - right.node_index ||
      compareUnicodeCodePoints(left.register, right.register),
  );
};

type Ref = (value: number | null, path: (string | number)[]) => void;

const validateAnalyses = (
  graph: Graph,
  ref: Ref,
  issue: Issue,
): Set<string> => {
  const support = new Set<string>();
  for (const analysis of graph.analyses) {
    ref(analysis.partition_index, [
      "analyses",
      analysis.index,
      "partition_index",
    ]);
    validateRefinement(analysis, graph, issue);
    validRelations(
      analysis.cpu_in,
      analysis.register_relations_in,
      ["analyses", analysis.index, "register_relations_in"],
      issue,
    );
    validRelations(
      analysis.cpu_out,
      analysis.register_relations_out,
      ["analyses", analysis.index, "register_relations_out"],
      issue,
    );
    if (analysis.refinement !== null)
      support.add(
        selectionKey({
          node_index: analysis.node_index,
          ...analysis.refinement,
        }),
      );
  }
  return support;
};

const validatePartitions = (
  graph: Graph,
  support: Set<string>,
  issue: Issue,
): void => {
  const identities = new Set<string>();
  for (const [position, partition] of graph.partitions.entries()) {
    const path = ["partitions", position],
      sites = new Set<string>();
    if (
      partition.index !== position ||
      (position === 0 && partition.selections.length !== 0)
    )
      issue(
        path,
        "Partition zero is empty and every pool identity equals its position.",
      );
    let previous: Partition["selections"][number] | undefined;
    for (const [offset, selection] of partition.selections.entries()) {
      if (
        selection.node_index >= graph.nodes.length ||
        sites.has(key(selection)) ||
        (previous !== undefined &&
          (previous.node_index > selection.node_index ||
            (previous.node_index === selection.node_index &&
              previous.register >= selection.register)))
      )
        issue(
          [...path, "selections", offset],
          "Selections must reference unique indexed sites in canonical order.",
        );
      if (!support.has(selectionKey(selection)))
        issue(
          [...path, "selections", offset],
          "Each retained selection requires an actual refined instruction analysis.",
        );
      sites.add(key(selection));
      previous = selection;
    }
    const identity = JSON.stringify(partition.selections);
    if (identities.has(identity))
      issue(path, "Equal selection maps must share one partition identity.");
    identities.add(identity);
  }
};

const validateCallFacts = (graph: Graph, ref: Ref, issue: Issue): void => {
  for (const [position, invocation] of graph.invocations.entries())
    validRelations(
      invocation.cpu_in,
      invocation.register_relations,
      ["invocations", position, "register_relations"],
      issue,
    );
  for (const [position, binding] of graph.continuations.entries())
    ref(binding.caller_partition_index, [
      "continuations",
      position,
      "caller_partition_index",
    ]);
  for (const [position, summary] of graph.return_summaries.entries()) {
    ref(summary.partition_index, [
      "return_summaries",
      position,
      "partition_index",
    ]);
    validRelations(
      summary.cpu_out,
      summary.register_relations,
      ["return_summaries", position, "register_relations"],
      issue,
    );
  }
};

const returnPartitionMatches = (
  graph: Graph,
  edge: Graph["edges"][number],
  cache: Map<string, boolean>,
): boolean => {
  if (edge.continuation_index === null || edge.summary_index === null)
    return true;
  const callerIndex =
      graph.continuations[edge.continuation_index]?.caller_partition_index ??
      -1,
    calleeIndex =
      graph.return_summaries[edge.summary_index]?.partition_index ?? -1,
    caller = graph.partitions[callerIndex],
    callee = graph.partitions[calleeIndex],
    target = graph.partitions[edge.target_partition_index ?? -1];
  if (caller === undefined || callee === undefined || target === undefined)
    return true;
  const identity = `${callerIndex}:${calleeIndex}:${target.index}`;
  let valid = cache.get(identity);
  if (valid === undefined) {
    valid =
      JSON.stringify(target.selections) ===
      JSON.stringify(mergedSelections(caller, callee));
    cache.set(identity, valid);
  }
  return valid;
};
const validateEdges = (graph: Graph, ref: Ref, issue: Issue): void => {
  const returns = new Map<string, boolean>();
  for (const [position, edge] of graph.edges.entries()) {
    ref(edge.target_partition_index, [
      "edges",
      position,
      "target_partition_index",
    ]);
    if (edge.resolution !== "resolved") continue;
    const analysis = graph.analyses[edge.analysis_index];
    if (edge.kind === "return") {
      if (!returnPartitionMatches(graph, edge, returns))
        issue(
          ["edges", position],
          "A matched return must compose the caller and exact callee-exit selections.",
        );
    } else if (edge.kind === "call") {
      if (edge.target_partition_index !== 0)
        issue(
          ["edges", position],
          "A callee starts with the empty local partition.",
        );
    } else if (
      analysis !== undefined &&
      (edge.target_partition_index !== analysis.partition_index ||
        edge.target_invocation_index !==
          graph.nodes[edge.from]?.invocation_index)
    )
      issue(
        ["edges", position],
        "Ordinary control flow must preserve its invocation and conditional selection partition.",
      );
  }
};

const validatePending = (graph: Graph, ref: Ref, issue: Issue): void => {
  for (const [position, root] of graph.roots.entries())
    if (root.partition_index !== (root.invocation_index === null ? null : 0))
      issue(
        ["roots", position, "partition_index"],
        "An admitted root starts in the empty partition.",
      );
  for (const [name, records] of [
    ["frontiers", graph.frontiers],
    ["pending", graph.pending],
  ] as const)
    for (const [position, record] of records.entries())
      ref(record.partition_index, [name, position, "partition_index"]);
  for (const [position, pending] of graph.pending_refinements.entries()) {
    const path = ["pending_refinements", position],
      node = graph.nodes[pending.node_index];
    ref(pending.partition_index, [...path, "partition_index"]);
    if (
      node === undefined ||
      node.invocation_index !== pending.invocation_index ||
      node.context_index !== pending.context_index ||
      node.address !== pending.address ||
      !accepts(pending.source_value, pending.next_value)
    )
      issue(
        path,
        "A pending index cursor must retain its source node, owning state and next compatible byte.",
      );
  }
};

/** Selection identity stays separate from analysis evidence and recursive call history. */
export const validateNesDiscoveryPartitions = (
  graph: Graph,
  ctx: z.RefinementCtx,
): void => {
  const issue: Issue = (path, message) =>
    ctx.addIssue({ code: "custom", path, message });
  const ref: Ref = (value, path) => {
    if (value !== null && value >= graph.partitions.length)
      issue(path, "Partition reference is outside its owning pool.");
  };
  validatePartitions(graph, validateAnalyses(graph, ref, issue), issue);
  validateCallFacts(graph, ref, issue);
  validateEdges(graph, ref, issue);
  validatePending(graph, ref, issue);
};
