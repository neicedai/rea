import type {
  DiscoverNesCodeInput,
  NesCodeDiscovery,
} from "./nesCodeDiscovery.js";
import type { decodeNesDiscoveryNode } from "./nesCodeDiscoveryDecode.js";
import {
  cloneNesDiscoveryState,
  type NesDiscoveryState,
} from "./nesCodeDiscoveryState.js";
import { nesCpuByte, setNesCpuByte } from "./nesCpuRegister.js";
import type { NesByteValue } from "./nesByteValue.js";
import {
  nesDiscoveryValueRegisterEquals,
  narrowNesDiscoveryValue,
} from "./nesCodeDiscoveryValues.js";
import type { NesDiscoveryConditionEvidence } from "./nesCodeDiscoveryConditionEvidence.js";
import type { NesDiscoveryValueBudget } from "./nesCodeDiscoveryValueBudget.js";
import { nesDiscoveryDomainHas } from "./nesCodeDiscoveryDomains.js";
import { refreshNesDiscoveryPredicates } from "./nesCodeDiscoveryPredicates.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";

type Graph = Extract<NesCodeDiscovery, { status: "derived" }>;
type Decoded = NonNullable<ReturnType<typeof decodeNesDiscoveryNode>>;
type Work = {
  invocation_index: number;
  context_index: number;
  address: number;
  state: NesDiscoveryState;
};
type Job = Work & {
  decoded: Decoded;
  register: "x" | "y";
  source_value: NesByteValue;
  next_value: number;
  source_domain_index: number;
};
export type NesDiscoveryRefinement = NonNullable<
  Graph["analyses"][number]["refinement"]
>;
const registerFor = (mode: string): "x" | "y" | null =>
  ["abx", "zpx", "izx"].includes(mode)
    ? "x"
    : ["aby", "zpy", "izy"].includes(mode)
      ? "y"
      : null;
const compatible = (source: NesByteValue, value: number): boolean =>
  typeof source === "number"
    ? value === source
    : source === null || (value & source.mask) === source.value;
const nextCompatible = (
  state: NesDiscoveryState,
  register: "x" | "y",
  start: number,
): number => {
  const group = nesDiscoveryValueRegisterEquals(state.values, register);
  let value = start;
  while (
    value < 256 &&
    !group.every(
      (member) =>
        compatible(nesCpuByte(state.cpu, member), value) &&
        nesDiscoveryDomainHas(state.register_domains[member], value),
    )
  )
    value++;
  return value;
};

type Selection = Graph["partitions"][number]["selections"][number];
const compareSites = (a: Selection, b: Selection): number =>
  a.node_index - b.node_index ||
  (a.register === "x" ? 0 : 1) - (b.register === "x" ? 0 : 1);
function* selectedChoices(
  parent: readonly Selection[],
  selected: Selection,
): Generator<Selection> {
  let inserted = false;
  for (const prior of parent) {
    const comparison = compareSites(prior, selected);
    if (!inserted && comparison >= 0) {
      yield selected;
      inserted = true;
    }
    if (comparison !== 0) yield prior;
  }
  if (!inserted) yield selected;
}
function* mergedChoices(
  caller: readonly Selection[],
  callee: readonly Selection[],
): Generator<Selection> {
  let a = 0,
    b = 0;
  while (a < caller.length || b < callee.length) {
    if (a === caller.length) {
      yield callee[b++]!;
      continue;
    }
    if (b === callee.length) {
      yield caller[a++]!;
      continue;
    }
    const comparison = compareSites(caller[a]!, callee[b]!);
    if (comparison < 0) yield caller[a++]!;
    else {
      yield callee[b++]!;
      if (comparison === 0) a++;
    }
  }
}
/** A partition is a finite map of static selector sites, never a path-prefix history. */
export class NesDiscoveryPartitions {
  private readonly indices = new Map<string, number>([["[]", 0]]);
  private readonly jobs: Job[] = [];
  private head = 0;
  private retainedSelections = 0;
  readonly evidence: NesDiscoveryDomainEvidence;
  readonly conditions: NesDiscoveryConditionEvidence;
  readonly budget: NesDiscoveryValueBudget;
  constructor(
    readonly graph: Graph,
    readonly input: DiscoverNesCodeInput,
    owners: {
      evidence: NesDiscoveryDomainEvidence;
      conditions: NesDiscoveryConditionEvidence;
      budget: NesDiscoveryValueBudget;
    },
  ) {
    this.evidence = owners.evidence;
    this.conditions = owners.conditions;
    this.budget = owners.budget;
  }
  private intern(choices: () => Iterable<Selection>): number | null {
    let key = "[",
      length = 0;
    for (const choice of choices()) {
      if (length > 0) key += ",";
      key += JSON.stringify([choice.node_index, choice.register, choice.value]);
      length++;
    }
    key += "]";
    const prior = this.indices.get(key);
    if (prior !== undefined) return prior;
    if (this.graph.partitions.length >= this.input.max_partitions) {
      this.graph.termination = "partition-budget";
      return null;
    }
    if (
      length >
      this.input.max_partition_selections - this.retainedSelections
    ) {
      this.graph.termination = "partition-selection-budget";
      return null;
    }
    const index = this.graph.partitions.length;
    this.budget.append(this.graph.partitions, {
      index,
      selections: Array.from(choices()),
    });
    this.budget.mapSet(this.indices, key, index);
    const beforeSelections = this.retainedSelections;
    this.budget.record(() => {
      this.retainedSelections = beforeSelections;
    });
    this.retainedSelections += length;
    return index;
  }
  private select(
    partition: number,
    node: number,
    register: "x" | "y",
    value: number,
  ): number | null {
    const selected = Object.freeze({ node_index: node, register, value });
    return this.intern(() =>
      selectedChoices(this.graph.partitions[partition]!.selections, selected),
    );
  }
  merge(caller: number, callee: number): number | null {
    if (callee === 0) return caller;
    if (caller === 0) return callee;
    return this.intern(() =>
      mergedChoices(
        this.graph.partitions[caller]!.selections,
        this.graph.partitions[callee]!.selections,
      ),
    );
  }
  begin(work: Work, decoded: Decoded): boolean {
    const register = registerFor(decoded.opcode.mode);
    if (register === null) return false;
    const source_value = nesCpuByte(work.state.cpu, register);
    if (typeof source_value === "number") return false;
    this.jobs.push({
      ...work,
      state: cloneNesDiscoveryState(work.state),
      decoded,
      register,
      source_value,
      next_value: nextCompatible(work.state, register, 0),
      source_domain_index: this.evidence.domain(
        work.state.register_domains[register],
      ),
    });
    return true;
  }
  hasWork(): boolean {
    return this.head < this.jobs.length;
  }
  runNext(
    execute: (
      work: Work,
      decoded: Decoded,
      refinement: NesDiscoveryRefinement,
    ) => boolean,
  ): boolean {
    const checkpoint = this.budget.begin();
    const job = this.jobs[this.head]!,
      value = job.next_value,
      partition = this.select(
        job.state.partition_index,
        job.decoded.node.index,
        job.register,
        value,
      );
    if (partition === null) {
      this.budget.rollback(checkpoint);
      return false;
    }
    const state = cloneNesDiscoveryState(job.state),
      equal_registers = nesDiscoveryValueRegisterEquals(
        state.values,
        job.register,
      );
    state.partition_index = partition;
    const condition = this.conditions.condition(
      {
        node_index: job.decoded.node.index,
        kind: "index",
        variable: job.register === "x" ? 1 : 2,
        value,
        source_domain_index: job.source_domain_index,
        result_domain_index: this.evidence.domain(1n << BigInt(value)),
      },
      this.graph.analyses.length,
    );
    state.values = narrowNesDiscoveryValue(
      state.values,
      job.register === "x" ? 1 : 2,
      1n << BigInt(value),
      {
        condition,
        compatible: (id, selected) => this.conditions.compatible(id, selected),
      },
    )!;
    for (const register of equal_registers)
      setNesCpuByte(state.cpu, register, value);
    refreshNesDiscoveryPredicates(
      state.cpu,
      state.values,
      state.flag_predicates,
    );
    const completed = execute({ ...job, state }, job.decoded, {
      register: job.register,
      source_value: job.source_value,
      value,
      equal_registers,
      source_domain_index: job.source_domain_index,
    });
    if (!completed || this.budget.failed) {
      this.budget.rollback(checkpoint);
      this.budget.failed = true;
      return false;
    }
    this.budget.commit();
    job.next_value = nextCompatible(job.state, job.register, value + 1);
    if (job.next_value === 256) this.head++;
    return true;
  }
  pending(): Graph["pending_refinements"] {
    return this.jobs.slice(this.head).map((job) => ({
      invocation_index: job.invocation_index,
      context_index: job.context_index,
      address: job.address,
      node_index: job.decoded.node.index,
      partition_index: job.state.partition_index,
      register: job.register,
      source_value: job.source_value,
      next_value: job.next_value,
      source_domain_index: job.source_domain_index,
    }));
  }
}
