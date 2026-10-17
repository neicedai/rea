import type { NesRomMetadata } from "./nes.js";
import type { decodeNesDiscoveryNode } from "./nesCodeDiscoveryDecode.js";
import type { NesDiscoveryGraph } from "./nesCodeDiscoveryGraph.js";
import type { NesDiscoveryEvidence } from "./nesCodeDiscoveryEvidence.js";
import type { NesDiscoveryRelativeEvidence } from "./nesCodeDiscoveryRelativeEvidence.js";
import type { NesDiscoveryValueEvidence } from "./nesCodeDiscoveryValueEvidence.js";
import type { NesDiscoveryConditionEvidence } from "./nesCodeDiscoveryConditionEvidence.js";
import type { NesDiscoveryValueBudget } from "./nesCodeDiscoveryValueBudget.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import {
  cloneNesDiscoveryState,
  joinNesDiscoveryCpu,
  normalizeNesDiscoveryDomains,
  type NesDiscoveryWork as Work,
  type NesDiscoveryState,
} from "./nesCodeDiscoveryState.js";
import { NesCodeDiscoveryMemory } from "./nesCodeDiscoveryMemory.js";
import { transferNesDiscoveryInstruction } from "./nesCodeDiscoveryTransfer.js";
import { transferNesDiscoveryDomains } from "./nesCodeDiscoveryDomainTransfer.js";
import { nes6502BranchCondition } from "./nes6502Branches.js";
import { nesDiscoveryFrameProof } from "./nesCodeDiscoveryFrame.js";
import type { NesDiscoveryRefinement } from "./nesCodeDiscoveryPartitions.js";
/** Immutable analyses retain conditional facts independently of shared node envelopes. */
export class NesDiscoveryAnalysis {
  private readonly analyzedNodes = new Set<number>();
  constructor(
    readonly source: {
      header: NesRomMetadata;
      prg: Uint8Array;
      graph: NesDiscoveryGraph;
      evidence: NesDiscoveryEvidence;
      relativeEvidence: NesDiscoveryRelativeEvidence;
      domainEvidence: NesDiscoveryDomainEvidence;
      valueEvidence: NesDiscoveryValueEvidence;
      conditionEvidence: NesDiscoveryConditionEvidence;
      budget: NesDiscoveryValueBudget;
    },
  ) {}
  private capture(state: NesDiscoveryState) {
    const { budget, domainEvidence, valueEvidence, relativeEvidence } =
      this.source;
    if (
      !budget.reserve(
        domainEvidence.inlineCost(state.flag_predicates, state.values),
      )
    )
      return null;
    return {
      cpu: structuredClone(state.cpu),
      value_snapshot: valueEvidence.snapshot(state.values, state.ram),
      frame: nesDiscoveryFrameProof(state.frame),
      relative_stack: relativeEvidence.snapshot(state.relative_stack),
      register_domains: domainEvidence.snapshot(state.register_domains),
      flag_predicates: domainEvidence.predicates(
        state.flag_predicates,
        state.values,
      ),
      register_relations: state.register_relations,
    };
  }
  analyze(
    item: Work,
    decoded: NonNullable<ReturnType<typeof decodeNesDiscoveryNode>>,
    refinement: NesDiscoveryRefinement | null = null,
  ) {
    const { node, bytes, opcode } = decoded,
      state = cloneNesDiscoveryState(item.state);
    normalizeNesDiscoveryDomains(state);
    const before = cloneNesDiscoveryState(state),
      analysis_index = this.source.graph.analyses.length,
      input = this.capture(state);
    if (input === null) return null;
    const memory = new NesCodeDiscoveryMemory(
      {
        header: this.source.header,
        prg: this.source.prg,
        evidence: this.source.evidence,
        relativeEvidence: this.source.relativeEvidence,
        analysisIndex: analysis_index,
        domainEvidence: this.source.domainEvidence,
        conditionEvidence: this.source.conditionEvidence,
      },
      structuredClone(this.source.graph.contexts[item.context_index]!.state),
      state,
      node.index,
    );
    memory.prepareInstruction(opcode, before);
    const successors = transferNesDiscoveryInstruction(
      memory,
      opcode,
      bytes,
      item.address,
    );
    if (nes6502BranchCondition(opcode.mnemonic) === null) {
      transferNesDiscoveryDomains({
        memory,
        before,
        opcode,
        bytes,
        evidence: this.source.domainEvidence,
      });
      for (const next of successors) next.state = cloneNesDiscoveryState(state);
    }
    const output = this.capture(state);
    if (
      output === null ||
      this.source.budget.failed ||
      !this.commit({
        item,
        node,
        analysis_index,
        refinement,
        input,
        output,
        memory,
      })
    )
      return null;
    return { node, analysis_index, successors, frontiers: memory.frontiers };
  }
  private commit(source: {
    item: Work;
    node: NesDiscoveryGraph["nodes"][number];
    analysis_index: number;
    refinement: NesDiscoveryRefinement | null;
    input: NonNullable<ReturnType<NesDiscoveryAnalysis["capture"]>>;
    output: NonNullable<ReturnType<NesDiscoveryAnalysis["capture"]>>;
    memory: NesCodeDiscoveryMemory;
  }): boolean {
    const { item, node, analysis_index, refinement, input, output, memory } =
        source,
      { graph, budget } = this.source;
    const referenceRecords = memory.references.reduce(
      (n, reference) =>
        n +
        1 +
        reference.ram_origins.reduce(
          (m, origin) =>
            m +
            1 +
            origin.writer_nodes.length +
            origin.writer_witness_indices.length +
            origin.condition_witness_indices.length,
          0,
        ) +
        reference.relative_stack_origins.reduce(
          (m, origin) =>
            m +
            1 +
            origin.writer_nodes.length +
            origin.writer_witness_indices.length,
          0,
        ),
      0,
    );
    if (!budget.reserve(referenceRecords)) return false;
    budget.append(graph.analyses, {
      index: analysis_index,
      node_index: node.index,
      invocation_index: item.invocation_index,
      partition_index: memory.state.partition_index,
      refinement,
      register_relations_in: input.register_relations,
      register_relations_out: output.register_relations,
      frame_in: input.frame,
      frame_out: output.frame,
      relative_stack_in: input.relative_stack,
      relative_stack_out: output.relative_stack,
      cpu_in: input.cpu,
      cpu_out: output.cpu,
      value_snapshot_in: input.value_snapshot,
      value_snapshot_out: output.value_snapshot,
      register_domains_in: input.register_domains,
      register_domains_out: output.register_domains,
      flag_predicates_in: input.flag_predicates,
      flag_predicates_out: output.flag_predicates,
    });
    const priorIn = node.cpu_in,
      priorOut = node.cpu_out;
    budget.record(() => {
      node.cpu_in = priorIn;
      node.cpu_out = priorOut;
    });
    if (this.analyzedNodes.has(node.index)) {
      node.cpu_in = structuredClone(priorIn);
      node.cpu_out = structuredClone(priorOut);
      joinNesDiscoveryCpu(node.cpu_in, input.cpu);
      joinNesDiscoveryCpu(node.cpu_out, output.cpu);
    } else {
      budget.add(this.analyzedNodes, node.index);
      node.cpu_in = structuredClone(input.cpu);
      node.cpu_out = structuredClone(output.cpu);
    }
    for (const reference of memory.references)
      budget.append(graph.data_references, {
        index: graph.data_references.length,
        analysis_index,
        ...reference,
      });
    return true;
  }
}
