import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import type {
  DiscoverNesCodeInput,
  NesCodeDiscovery,
} from "./nesCodeDiscovery.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import { admitNesCodeDiscovery } from "./nesCodeDiscoveryAdmission.js";
import { seedNesDiscoveryRoots } from "./nesCodeDiscoveryRoots.js";
import {
  cloneNesDiscoveryState,
  joinNesDiscoveryState,
  type NesDiscoveryState,
  type NesDiscoveryWork as Work,
} from "./nesCodeDiscoveryState.js";
import type { NesDiscoverySuccessor } from "./nesCodeDiscoveryTransfer.js";
import {
  initialNesDiscoveryGraph,
  prepareNesDiscoveryEdgeSource,
  appendNesDiscoveryContext,
  appendNesDiscoveryFrontier,
  finishNesDiscoveryGraph,
  nesDiscoveryWorkKey as workKey,
  type NesDiscoveryGraph as Graph,
} from "./nesCodeDiscoveryGraph.js";
import { decodeNesDiscoveryNode } from "./nesCodeDiscoveryDecode.js";

import { NesDiscoveryEvidence } from "./nesCodeDiscoveryEvidence.js";
import { NesDiscoveryRelativeEvidence } from "./nesCodeDiscoveryRelativeEvidence.js";
import { NesDiscoveryValueEvidence } from "./nesCodeDiscoveryValueEvidence.js";
import { NesDiscoveryConditionEvidence } from "./nesCodeDiscoveryConditionEvidence.js";
import { NesDiscoveryValueBudget } from "./nesCodeDiscoveryValueBudget.js";
import { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import { NesDiscoveryTabulation } from "./nesCodeDiscoveryTabulation.js";
import {
  NesDiscoveryPartitions,
  type NesDiscoveryRefinement,
} from "./nesCodeDiscoveryPartitions.js";
import { NesDiscoveryAnalysis } from "./nesCodeDiscoveryAnalysis.js";

class Discovery {
  readonly graph = initialNesDiscoveryGraph();
  readonly states = new Map<string, Work>();
  private readonly contextIndices = new Map<string, number>();
  private readonly nodeIndices = new Map<string, number>();
  private readonly queued = new Set<string>();
  private readonly work: Work[] = [];
  private head = 0;
  readonly budget: NesDiscoveryValueBudget;
  readonly evidence: NesDiscoveryEvidence;
  readonly relativeEvidence: NesDiscoveryRelativeEvidence;
  readonly domainEvidence: NesDiscoveryDomainEvidence;
  readonly valueEvidence: NesDiscoveryValueEvidence;
  readonly conditionEvidence: NesDiscoveryConditionEvidence;
  readonly calls: NesDiscoveryTabulation;
  readonly partitions: NesDiscoveryPartitions;
  readonly analysis: NesDiscoveryAnalysis;
  constructor(
    readonly header: NesRomMetadata,
    readonly prg: Uint8Array,
    readonly input: DiscoverNesCodeInput,
    readonly signal?: AbortSignal,
  ) {
    this.budget = new NesDiscoveryValueBudget(
      this.graph,
      input.max_value_state_records,
    );
    this.domainEvidence = new NesDiscoveryDomainEvidence(
      this.graph,
      this.budget,
    );
    this.evidence = new NesDiscoveryEvidence(
      this.graph,
      this.domainEvidence,
      this.budget,
    );
    this.relativeEvidence = new NesDiscoveryRelativeEvidence(
      this.graph,
      this.domainEvidence,
      this.budget,
    );
    this.conditionEvidence = new NesDiscoveryConditionEvidence(
      this.graph,
      this.budget,
    );
    this.valueEvidence = new NesDiscoveryValueEvidence(
      this.graph,
      this.domainEvidence,
      this.evidence,
      this.budget,
    );
    this.analysis = new NesDiscoveryAnalysis({
      header,
      prg,
      graph: this.graph,
      evidence: this.evidence,
      relativeEvidence: this.relativeEvidence,
      domainEvidence: this.domainEvidence,
      valueEvidence: this.valueEvidence,
      conditionEvidence: this.conditionEvidence,
      budget: this.budget,
    });
    this.partitions = new NesDiscoveryPartitions(this.graph, input, {
      evidence: this.domainEvidence,
      conditions: this.conditionEvidence,
      budget: this.budget,
    });
    this.calls = new NesDiscoveryTabulation(
      this.graph,
      input,
      {
        physical: this.evidence,
        relative: this.relativeEvidence,
        domains: this.domainEvidence,
        values: this.valueEvidence,
        budget: this.budget,
      },
      {
        enqueue: (invocation, context, address, state) =>
          this.enqueue(invocation, context, address, state),
        budget: (reason) => {
          this.graph.termination = reason;
        },
        mergePartitions: (caller, callee) =>
          this.partitions.merge(caller, callee),
      },
    );
  }
  private context(state: NesMapperState): number | null {
    const key = JSON.stringify(state),
      existing = this.contextIndices.get(key);
    if (existing !== undefined) return existing;
    if (this.graph.contexts.length >= this.input.max_contexts) {
      this.graph.termination = "context-budget";
      return null;
    }
    const before = this.graph.contexts.length,
      views = this.graph.nes_prg_views.length;
    this.budget.record(() => {
      this.graph.contexts.length = before;
      this.graph.nes_prg_views.length = views;
    });
    const index = appendNesDiscoveryContext(this.graph, this.header, state);
    this.budget.mapSet(this.contextIndices, key, index);
    return index;
  }
  private enqueue(
    invocation_index: number,
    context_index: number,
    address: number,
    state: NesDiscoveryState,
  ): boolean {
    const key = workKey(
        invocation_index,
        context_index,
        address,
        state.partition_index,
      ),
      existing = this.states.get(key);
    const candidate =
      existing === undefined
        ? cloneNesDiscoveryState(state)
        : cloneNesDiscoveryState(existing.state);
    if (existing !== undefined && !joinNesDiscoveryState(candidate, state))
      return true;
    this.valueEvidence.snapshot(candidate.values, candidate.ram);
    if (this.budget.failed) return false;
    const item = existing ?? {
      invocation_index,
      context_index,
      address,
      state: candidate,
    };
    if (existing !== undefined) {
      const prior = existing.state;
      this.budget.record(() => {
        existing.state = prior;
      });
      existing.state = candidate;
    }
    this.budget.mapSet(this.states, key, item);
    if (!this.queued.has(key)) {
      this.budget.add(this.queued, key);
      this.budget.append(this.work, item);
    }
    return true;
  }

  private successor(
    node: Graph["nodes"][number],
    analysis_index: number,
    next: NesDiscoverySuccessor,
  ): void {
    const base = prepareNesDiscoveryEdgeSource(
      {
        graph: this.graph,
        domains: this.domainEvidence,
        values: this.valueEvidence,
        budget: this.budget,
      },
      node,
      analysis_index,
      next,
    );
    if (base === null) return;
    if (this.returnSuccessor(node, analysis_index, next)) return;
    if (next.address === null) {
      const reason = next.reason ?? "unknown-control-target";
      this.graph.edges.push({
        ...base,
        target_address: null,
        target_context_index: node.context_index,
        target_invocation_index: node.invocation_index,
        to: null,
        resolution: "unresolved",
        reason,
      });
      appendNesDiscoveryFrontier(
        this.graph,
        {
          context_index: node.context_index,
          partition_index: next.state.partition_index,
          address: null,
          from: node.index,
        },
        reason,
      );
      return;
    }
    const context = this.context(next.mapper);
    if (context === null) {
      this.graph.edges.push({
        ...base,
        target_address: next.address,
        target_context_index: null,
        target_invocation_index: node.invocation_index,
        to: null,
        resolution: "unresolved",
        reason: "context-budget",
      });
      appendNesDiscoveryFrontier(
        this.graph,
        {
          context_index: node.context_index,
          partition_index: next.state.partition_index,
          address: next.address,
          from: node.index,
        },
        "context-budget",
      );
      return;
    }
    if (next.kind === "call") {
      this.callSuccessor(node, analysis_index, context, next);
      return;
    }
    this.graph.edges.push({
      ...base,
      target_address: next.address,
      target_context_index: context,
      target_invocation_index: node.invocation_index,
      to: null,
      resolution: "resolved",
      reason: null,
    });
    this.enqueue(node.invocation_index, context, next.address, next.state);
  }
  private returnSuccessor(
    node: Graph["nodes"][number],
    analysis_index: number,
    next: NesDiscoverySuccessor,
  ): boolean {
    if (
      next.kind !== "return" ||
      next.return_proof === undefined ||
      next.reason !== null ||
      this.graph.invocations[node.invocation_index]!.frame.kind === "root"
    )
      return false;
    const context = this.context(next.mapper);
    if (context !== null)
      this.calls.publish(node, analysis_index, context, next);
    else
      appendNesDiscoveryFrontier(
        this.graph,
        {
          context_index: node.context_index,
          partition_index: next.state.partition_index,
          address: node.address,
          from: node.index,
        },
        "context-budget",
      );
    return true;
  }
  private callSuccessor(
    node: Graph["nodes"][number],
    analysis_index: number,
    context: number,
    next: NesDiscoverySuccessor,
  ): void {
    const address = next.address;
    if (address === null) return;
    const called = this.calls.call(node, analysis_index, context, next);
    if (called.reason !== null || called.invocation === null)
      appendNesDiscoveryFrontier(
        this.graph,
        {
          context_index: context,
          invocation_index: called.invocation,
          partition_index: called.invocation === null ? null : 0,
          address,
          from: node.index,
        },
        called.reason ?? "invocation-budget",
      );
  }

  private analyze(
    item: Work,
    decoded: NonNullable<ReturnType<typeof decodeNesDiscoveryNode>>,
    refinement: NesDiscoveryRefinement | null = null,
  ): boolean {
    const checkpoint = this.budget.begin(),
      edgeLength = this.graph.edges.length,
      frontierLength = this.graph.frontiers.length;
    this.budget.record(() => {
      this.graph.edges.length = edgeLength;
      this.graph.frontiers.length = frontierLength;
    });
    const result = this.analysis.analyze(item, decoded, refinement);
    if (result !== null) {
      const { node, analysis_index, successors, frontiers } = result;
      for (const reason of frontiers)
        appendNesDiscoveryFrontier(
          this.graph,
          {
            context_index: item.context_index,
            partition_index: item.state.partition_index,
            address: item.address,
            from: node.index,
          },
          reason,
          { bytes_hex: node.bytes_hex, file_offsets: node.file_offsets },
        );
      for (const next of successors) this.successor(node, analysis_index, next);
    }
    if (this.budget.failed) {
      this.budget.rollback(checkpoint);
      this.budget.failed = true;
      this.graph.termination = "value-state-budget";
      return false;
    }
    this.budget.commit();
    return true;
  }

  async run(): Promise<Graph> {
    await seedNesDiscoveryRoots(this.header, this.prg, this.input, {
      graph: this.graph,
      signal: this.signal,
      context: (state) => this.context(state),
      calls: this.calls,
      budget: this.budget,
    });
    while (
      !this.budget.failed &&
      (this.head < this.work.length ||
        this.calls.hasReturns() ||
        this.partitions.hasWork())
    ) {
      this.signal?.throwIfAborted();
      if (this.graph.work_items_processed >= this.input.max_work_items) {
        this.graph.termination = "work-item-budget";
        break;
      }
      if (this.graph.work_items_processed % 128 === 0) {
        await scheduler.yield();
        this.signal?.throwIfAborted();
      }
      if (this.calls.hasReturns()) {
        this.graph.work_items_processed++;
        if (!this.calls.deliverReturn()) break;
        continue;
      }
      if (this.partitions.hasWork()) {
        this.graph.work_items_processed++;
        if (
          !this.partitions.runNext((item, decoded, refinement) =>
            this.analyze(item, decoded, refinement),
          )
        )
          break;
        continue;
      }
      const item = this.work[this.head++]!;
      this.queued.delete(
        workKey(
          item.invocation_index,
          item.context_index,
          item.address,
          item.state.partition_index,
        ),
      );
      this.graph.work_items_processed++;
      const decoded = decodeNesDiscoveryNode(
        {
          header: this.header,
          prg: this.prg,
          graph: this.graph,
          input: this.input,
          nodeIndices: this.nodeIndices,
        },
        item,
      );
      if (decoded === null) {
        if (this.graph.termination === "node-budget") {
          this.head--;
          this.queued.add(
            workKey(
              item.invocation_index,
              item.context_index,
              item.address,
              item.state.partition_index,
            ),
          );
          break;
        }
        continue;
      }
      if (
        !this.partitions.begin(item, decoded) &&
        !this.analyze(item, decoded)
      ) {
        this.head--;
        this.queued.add(
          workKey(
            item.invocation_index,
            item.context_index,
            item.address,
            item.state.partition_index,
          ),
        );
        break;
      }
    }
    return this.finish();
  }
  private finish(): Graph {
    if (this.budget.failed) this.graph.termination = "value-state-budget";
    this.graph.pending_returns = this.calls.pending();
    this.graph.pending_refinements = this.partitions.pending();
    finishNesDiscoveryGraph(
      this.header,
      this.graph,
      this.nodeIndices,
      [...this.queued]
        .map((key) => this.states.get(key)!)
        .map(({ invocation_index, context_index, address, state }) => ({
          invocation_index,
          context_index,
          address,
          partition_index: state.partition_index,
        })),
    );
    return this.graph;
  }
}

/** A finite rooted abstract-state worklist, separate from conditional trace replay. */
export const discoverNesCode = async (
  header: NesRomMetadata,
  prg: Uint8Array,
  input: DiscoverNesCodeInput,
  { signal }: { signal?: AbortSignal | undefined } = {},
): Promise<NesCodeDiscovery> => {
  const failure = await admitNesCodeDiscovery(header, prg, input, signal);
  if (failure !== null) return failure;
  return new Discovery(header, prg, input, signal).run();
};
