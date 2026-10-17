import type {
  DiscoverNesCodeInput,
  NesCodeDiscovery,
} from "./nesCodeDiscovery.js";
import { NesDiscoveryEvidence } from "./nesCodeDiscoveryEvidence.js";
import {
  cloneNesDiscoveryState,
  joinNesDiscoveryState,
  type NesDiscoveryState,
} from "./nesCodeDiscoveryState.js";
import {
  nesDiscoveryFrame,
  nesDiscoveryFrameProof,
  cloneNesDiscoveryFrame,
  returnNesDiscoveryFrame,
  type NesDiscoveryFrame,
} from "./nesCodeDiscoveryFrame.js";
import { relativeStackValueKey } from "./nesCodeDiscoveryRelativeStack.js";
import type { NesDiscoveryRelativeEvidence } from "./nesCodeDiscoveryRelativeEvidence.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import { nesDiscoveryValuesKey } from "./nesCodeDiscoveryValues.js";
import type { NesDiscoveryValueEvidence } from "./nesCodeDiscoveryValueEvidence.js";
import type { NesDiscoveryValueBudget } from "./nesCodeDiscoveryValueBudget.js";
import { nesDiscoveryPredicateKey } from "./nesCodeDiscoveryPredicates.js";
import type { NesDiscoverySuccessor } from "./nesCodeDiscoveryTransfer.js";

type Graph = Extract<NesCodeDiscovery, { status: "derived" }>;
type Node = Graph["nodes"][number];
type Entry = {
  state: NesDiscoveryState;
  context_index: number;
  address: number;
};
type Summary = {
  state: NesDiscoveryState;
  target: number | null;
  index: number;
};
type Binding = { frame: NesDiscoveryFrame; cursor: number; index: number };
type Hooks = {
  enqueue: (
    invocation: number,
    context: number,
    address: number,
    state: NesDiscoveryState,
  ) => boolean;
  budget: (
    reason: "invocation-budget" | "continuation-budget" | "value-state-budget",
  ) => void;
  mergePartitions: (caller: number, callee: number) => number | null;
};

/** Invocation values select summaries; finite write witnesses only widen entry provenance. */
export class NesDiscoveryTabulation {
  private readonly entryKeys = new Map<string, number>();
  private readonly entries: Entry[] = [];
  private readonly bindingKeys = new Map<string, number>();
  private readonly bindings: Binding[] = [];
  private readonly subscribers = new Map<number, number[]>();
  private readonly summaries = new Map<number, Summary[]>();
  private readonly queued = new Set<number>();
  private readonly jobs: number[] = [];
  private head = 0;
  constructor(
    readonly graph: Graph,
    readonly input: DiscoverNesCodeInput,
    readonly evidence: {
      physical: NesDiscoveryEvidence;
      relative: NesDiscoveryRelativeEvidence;
      domains: NesDiscoveryDomainEvidence;
      values: NesDiscoveryValueEvidence;
      budget: NesDiscoveryValueBudget;
    },
    readonly hooks: Hooks,
  ) {}
  invocation(
    context_index: number,
    address: number,
    state: NesDiscoveryState,
  ): number | null {
    const result = this.evidence.budget.run(() =>
      this.prepareInvocation(context_index, address, state),
    );
    if (!result.ok) {
      this.hooks.budget("value-state-budget");
      return null;
    }
    return result.value;
  }
  private prepareInvocation(
    context_index: number,
    address: number,
    state: NesDiscoveryState,
  ): number | null {
    const key = JSON.stringify([
      context_index,
      address,
      [
        state.cpu.c,
        state.cpu.z,
        state.cpu.i,
        state.cpu.d,
        state.cpu.v,
        state.cpu.n,
      ],
      nesDiscoveryValuesKey(state.values),
      relativeStackValueKey(state.relative_stack),
      nesDiscoveryPredicateKey(state.flag_predicates),
      state.frame.kind,
      state.frame.entry_sp,
    ]);
    const prior = this.entryKeys.get(key);
    if (prior !== undefined) {
      const entry = this.entries[prior]!;
      const previous = entry.state,
        candidate = cloneNesDiscoveryState(previous);
      if (joinNesDiscoveryState(candidate, state)) {
        if (
          !this.evidence.budget.reserve(
            this.evidence.domains.inlineCost(
              candidate.flag_predicates,
              candidate.values,
            ) -
              this.evidence.domains.wireCost(
                this.graph.invocations[prior]!.flag_predicates,
              ),
          )
        )
          return null;
        const priorInvocation = structuredClone(this.graph.invocations[prior]!);
        this.evidence.budget.record(() => {
          entry.state = previous;
          this.graph.invocations[prior] = priorInvocation;
        });
        entry.state = candidate;
        this.graph.invocations[prior]!.ram_in = this.evidence.physical.snapshot(
          entry.state.ram,
          entry.state.values,
        );
        this.graph.invocations[prior]!.relative_stack_in =
          this.evidence.relative.snapshot(entry.state.relative_stack);
        this.graph.invocations[prior]!.register_domains =
          this.evidence.domains.snapshot(entry.state.register_domains);
        this.graph.invocations[prior]!.value_snapshot =
          this.evidence.values.snapshot(entry.state.values, entry.state.ram);
        this.graph.invocations[prior]!.flag_predicates =
          this.evidence.domains.predicates(
            entry.state.flag_predicates,
            entry.state.values,
          );
        this.hooks.enqueue(prior, context_index, address, entry.state);
      }
      return prior;
    }
    if (this.entries.length >= this.input.max_invocations) {
      this.hooks.budget("invocation-budget");
      return null;
    }
    if (
      !this.evidence.budget.reserve(
        this.evidence.domains.inlineCost(state.flag_predicates, state.values),
      )
    )
      return null;
    const index = this.entries.length,
      entry = { state: cloneNesDiscoveryState(state), context_index, address };
    this.evidence.budget.append(this.entries, entry);
    this.evidence.budget.mapSet(this.entryKeys, key, index);
    this.evidence.budget.append(this.graph.invocations, {
      index,
      entry_address: address,
      entry_context_index: context_index,
      value_snapshot: this.evidence.values.snapshot(state.values, state.ram),
      cpu_in: structuredClone(state.cpu),
      ram_in: this.evidence.physical.snapshot(state.ram, state.values),
      relative_stack_in: this.evidence.relative.snapshot(state.relative_stack),
      frame: nesDiscoveryFrameProof(state.frame),
      register_relations: state.register_relations,
      register_domains: this.evidence.domains.snapshot(state.register_domains),
      flag_predicates: this.evidence.domains.predicates(
        state.flag_predicates,
        state.values,
      ),
    });
    this.hooks.enqueue(index, context_index, address, entry.state);
    return index;
  }
  call(
    node: Node,
    analysis: number,
    context: number,
    next: NesDiscoverySuccessor,
  ) {
    const result = this.prepareCall(node, analysis, context, next),
      base = {
        index: this.graph.edges.length,
        from: node.index,
        analysis_index: analysis,
        kind: next.kind,
        condition: next.condition,
        register_domains: null,
        flag_predicates: null,
        value_snapshot: null,
        target_partition_index: 0,
        continuation_index: null,
        summary_index: null,
        target_address: next.address!,
        target_context_index: context,
        target_invocation_index: result.invocation,
        to: null,
      };
    if (result.reason === null && result.invocation !== null)
      this.evidence.budget.append(this.graph.edges, {
        ...base,
        target_invocation_index: result.invocation,
        resolution: "resolved",
        reason: null,
      });
    else
      this.evidence.budget.append(this.graph.edges, {
        ...base,
        resolution: "unresolved",
        reason: result.reason ?? "invocation-budget",
      });
    return result;
  }
  private prepareCall(
    node: Node,
    analysis: number,
    context: number,
    next: NesDiscoverySuccessor,
  ): {
    invocation: number | null;
    continuation: number | null;
    reason: string | null;
  } {
    const entry = cloneNesDiscoveryState(next.state),
      frame = cloneNesDiscoveryFrame(entry.frame);
    entry.partition_index = 0;
    entry.frame = nesDiscoveryFrame(
      entry.cpu.sp === null ? "opaque" : "physical",
      entry.cpu.sp,
    );
    const invocation = this.invocation(context, next.address!, entry);
    if (invocation === null)
      return {
        invocation: null,
        continuation: null,
        reason: "invocation-budget",
      };
    const return_address = (node.address + node.file_offsets.length) & 65535;
    const key = JSON.stringify([
        node.invocation_index,
        next.state.partition_index,
        node.index,
        invocation,
        return_address,
        nesDiscoveryFrameProof(frame),
      ]),
      prior = this.bindingKeys.get(key);
    if (prior !== undefined) {
      const priorBinding = this.graph.continuations[prior]!;
      if (!priorBinding.call_analysis_indices.includes(analysis))
        this.evidence.budget.append(
          priorBinding.call_analysis_indices,
          analysis,
        );
      return { invocation, continuation: prior, reason: null };
    }
    if (this.bindings.length >= this.input.max_continuations) {
      this.hooks.budget("continuation-budget");
      return { invocation, continuation: null, reason: "continuation-budget" };
    }
    const index = this.bindings.length;
    this.evidence.budget.append(this.bindings, { frame, cursor: 0, index });
    this.evidence.budget.mapSet(this.bindingKeys, key, index);
    this.evidence.budget.append(this.graph.continuations, {
      index,
      caller_invocation_index: node.invocation_index,
      caller_partition_index: next.state.partition_index,
      callee_invocation_index: invocation,
      call_node_index: node.index,
      call_analysis_indices: [analysis],
      return_address,
    });
    const subscribers = this.subscribers.get(invocation) ?? [];
    this.evidence.budget.append(subscribers, index);
    this.evidence.budget.mapSet(this.subscribers, invocation, subscribers);
    this.queue(index);
    return { invocation, continuation: index, reason: null };
  }
  publish(
    node: Node,
    analysis: number,
    context_index: number,
    next: NesDiscoverySuccessor,
  ): number {
    if (
      !this.evidence.budget.reserve(
        this.evidence.domains.inlineCost(
          next.state.flag_predicates,
          next.state.values,
        ),
      )
    )
      return 0;
    const index = this.graph.return_summaries.length,
      state = cloneNesDiscoveryState(next.state);
    if (
      next.return_proof === undefined ||
      (next.return_proof !== "opaque-token" && next.address === null)
    )
      throw new Error("A return summary requires a complete stack proof");
    const proof =
      next.return_proof === "opaque-token"
        ? { return_proof: "opaque-token" as const, stack_target: null }
        : next.return_proof === "physical-bytes"
          ? {
              return_proof: "physical-bytes" as const,
              stack_target: next.address!,
            }
          : {
              return_proof: "relative-bytes" as const,
              stack_target: next.address!,
            };
    this.evidence.budget.append(this.graph.return_summaries, {
      index,
      invocation_index: node.invocation_index,
      partition_index: state.partition_index,
      register_relations: state.register_relations,
      return_node_index: node.index,
      return_analysis_index: analysis,
      context_index,
      ...proof,
      value_snapshot: this.evidence.values.snapshot(state.values, state.ram),
      cpu_out: structuredClone(state.cpu),
      ram_out: this.evidence.physical.snapshot(state.ram, state.values),
      relative_stack_out: this.evidence.relative.snapshot(state.relative_stack),
      register_domains: this.evidence.domains.snapshot(state.register_domains),
      flag_predicates: this.evidence.domains.predicates(
        state.flag_predicates,
        state.values,
      ),
      frame: nesDiscoveryFrameProof(state.frame),
    });
    const summaries = this.summaries.get(node.invocation_index) ?? [];
    this.evidence.budget.append(summaries, {
      state,
      target: next.address,
      index,
    });
    this.evidence.budget.mapSet(
      this.summaries,
      node.invocation_index,
      summaries,
    );
    for (const binding of this.subscribers.get(node.invocation_index) ?? [])
      this.queue(binding);
    return index;
  }
  private queue(index: number): void {
    const binding = this.bindings[index]!,
      subscription = this.graph.continuations[index]!,
      summaries =
        this.summaries.get(subscription.callee_invocation_index) ?? [];
    if (binding.cursor < summaries.length && !this.queued.has(index)) {
      this.evidence.budget.add(this.queued, index);
      this.evidence.budget.append(this.jobs, index);
    }
  }
  hasReturns(): boolean {
    return this.head < this.jobs.length;
  }
  deliverReturn(): boolean {
    const result = this.evidence.budget.run(() => this.prepareReturn());
    if (!result.ok) {
      this.hooks.budget("value-state-budget");
      return false;
    }
    return result.value;
  }
  private prepareReturn(): boolean {
    const index = this.jobs[this.head]!,
      binding = this.bindings[index]!,
      continuation = this.graph.continuations[index]!,
      summaries = this.summaries.get(continuation.callee_invocation_index)!,
      retained = summaries[binding.cursor]!,
      summary = this.graph.return_summaries[retained.index]!;
    const mismatch =
      retained.target !== null &&
      retained.target !== continuation.return_address;
    const partition = mismatch
      ? retained.state.partition_index
      : this.hooks.mergePartitions(
          continuation.caller_partition_index,
          retained.state.partition_index,
        );
    if (partition === null) return false;

    const state = cloneNesDiscoveryState(retained.state);
    state.partition_index = partition;
    if (!mismatch)
      state.frame = returnNesDiscoveryFrame(binding.frame, state.frame);
    const address = retained.target ?? continuation.return_address;
    const invocation = mismatch
      ? summary.invocation_index
      : continuation.caller_invocation_index;
    this.evidence.budget.append(this.graph.edges, {
      index: this.graph.edges.length,
      from: summary.return_node_index,
      analysis_index: summary.return_analysis_index,
      kind: mismatch ? "stack-jump" : "return",
      condition: null,
      value_snapshot: null,
      register_domains: null,
      flag_predicates: null,
      target_address: address,
      target_context_index: summary.context_index,
      target_invocation_index: invocation,
      target_partition_index: partition,
      continuation_index: mismatch ? null : continuation.index,
      summary_index: mismatch ? null : summary.index,
      to: null,
      resolution: "resolved",
      reason: null,
    });
    if (!this.hooks.enqueue(invocation, summary.context_index, address, state))
      return false;
    const priorHead = this.head,
      priorCursor = binding.cursor;
    this.evidence.budget.record(() => {
      this.head = priorHead;
      binding.cursor = priorCursor;
    });
    this.head++;
    this.evidence.budget.delete(this.queued, index);
    binding.cursor++;
    this.queue(index);
    return true;
  }
  pending(): Graph["pending_returns"] {
    return [...this.queued]
      .sort((a, b) => a - b)
      .map((continuation_index) => ({
        continuation_index,
        next_summary_offset: this.bindings[continuation_index]!.cursor,
      }));
  }
}
