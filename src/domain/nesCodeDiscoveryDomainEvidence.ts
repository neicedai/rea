import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import type { NesCpuRegister } from "./nesCpuRegister.js";
import {
  nesDiscoveryDomainCount,
  type NesDiscoveryRegisterDomains,
} from "./nesCodeDiscoveryDomains.js";
import type {
  NesDiscoveryFlagPredicate,
  NesDiscoveryFlagPredicates,
} from "./nesCodeDiscoveryPredicates.js";
import {
  NesDiscoveryValueBudget,
  unlimitedNesDiscoveryValueBudget,
} from "./nesCodeDiscoveryValueBudget.js";
import {
  equalNesDiscoveryVariables,
  nesDiscoveryRegisterVariables,
  type NesDiscoveryValues,
} from "./nesCodeDiscoveryValues.js";
type Graph = Extract<NesCodeDiscovery, { status: "derived" }>;
/** Domain values and opcode sources are interned independently of analysis history. */
export class NesDiscoveryDomainEvidence {
  private readonly domains = new Map<bigint, number>();
  private readonly sources = new Map<string, number>();
  private readonly sourceAnalyses = new Map<number, Set<number>>();
  constructor(
    readonly graph: Graph,
    readonly budget: NesDiscoveryValueBudget = unlimitedNesDiscoveryValueBudget(),
  ) {}
  domain(value: bigint): number {
    if (value === 0n) throw new Error("Bottom CPU domains cannot be retained");
    const prior = this.domains.get(value);
    if (prior !== undefined) return prior;
    if (!this.budget.reserve(1)) return 0;
    const index = this.graph.byte_domains.length;
    this.budget.append(this.graph.byte_domains, {
      index,
      bitmap_hex: value.toString(16).padStart(64, "0"),
      count: nesDiscoveryDomainCount(value),
    });
    this.budget.mapSet(this.domains, value, index);
    return index;
  }
  snapshot(domains: NesDiscoveryRegisterDomains): {
    a: number;
    x: number;
    y: number;
    sp: number;
  } {
    return {
      a: this.domain(domains.a),
      x: this.domain(domains.x),
      y: this.domain(domains.y),
      sp: this.domain(domains.sp),
    };
  }
  inlineCost(
    predicates: NesDiscoveryFlagPredicates,
    values: NesDiscoveryValues,
  ): number {
    let records = 9;
    for (const flag of ["c", "z", "n"] as const) {
      const predicate = predicates[flag];
      if (predicate !== null)
        records +=
          1 +
          equalNesDiscoveryVariables(values, predicate.carrier_variable).filter(
            (variable) => variable < 4,
          ).length +
          predicate.source_witness_indices.length;
    }
    return records;
  }
  wireCost(
    predicates: Graph["analyses"][number]["flag_predicates_in"],
  ): number {
    return (
      9 +
      (["c", "z", "n"] as const).reduce((n, flag) => {
        const predicate = predicates[flag];
        return (
          n +
          (predicate === null
            ? 0
            : 1 +
              predicate.registers.length +
              predicate.source_witness_indices.length)
        );
      }, 0)
    );
  }
  predicates(
    predicates: NesDiscoveryFlagPredicates,
    values: NesDiscoveryValues,
  ): Graph["analyses"][number]["flag_predicates_in"] {
    const copy = (predicate: NesDiscoveryFlagPredicate | null) => {
      if (predicate === null) return null;
      const members = equalNesDiscoveryVariables(
          values,
          predicate.carrier_variable,
        ),
        fields = {
          carrier_variable: members[0]!,
          registers: (["a", "x", "y", "sp"] as const).filter((register) =>
            members.includes(nesDiscoveryRegisterVariables[register]),
          ),
          source_witness_indices: [...predicate.source_witness_indices],
        };
      return predicate.kind === "compare"
        ? { ...fields, kind: "compare" as const, operand: predicate.operand }
        : { ...fields, kind: "result" as const, operand: null };
    };
    const carry = copy(predicates.c);
    return {
      c: carry?.kind === "compare" ? carry : null,
      z: copy(predicates.z),
      n: copy(predicates.n),
    };
  }
  source({
    node_index,
    analysis_index,
    register,
    kind,
    operand,
  }: {
    node_index: number;
    analysis_index: number;
    register: NesCpuRegister;
    kind: "result" | "compare";
    operand: number | null;
  }): number {
    const key = JSON.stringify([node_index, register, kind, operand]),
      prior = this.sources.get(key);
    if (prior !== undefined) {
      const analyses = this.sourceAnalyses.get(prior)!;
      if (!analyses.has(analysis_index) && this.budget.reserve(1)) {
        this.budget.add(analyses, analysis_index);
        this.budget.append(
          this.graph.flag_predicate_sources[prior]!.analysis_indices,
          analysis_index,
        );
      }
      return prior;
    }
    if (!this.budget.reserve(2)) return 0;
    const index = this.graph.flag_predicate_sources.length;
    if (kind === "compare" && operand === null)
      throw new Error("A comparison source requires a complete operand byte");
    this.budget.append(
      this.graph.flag_predicate_sources,
      kind === "compare"
        ? {
            index,
            node_index,
            register,
            kind: "compare",
            operand: operand!,
            analysis_indices: [analysis_index],
          }
        : {
            index,
            node_index,
            register,
            kind: "result",
            operand: null,
            analysis_indices: [analysis_index],
          },
    );
    this.budget.mapSet(this.sources, key, index);
    this.budget.mapSet(this.sourceAnalyses, index, new Set([analysis_index]));
    return index;
  }
}
