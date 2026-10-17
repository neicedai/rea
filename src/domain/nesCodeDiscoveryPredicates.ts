import type { NesCpuState } from "./nesCodeTrace.js";
import {
  equalNesDiscoveryVariables,
  narrowNesDiscoveryValue,
  nesDiscoveryValueDomain,
  nesDiscoveryValueLeader,
  type NesDiscoveryValues,
} from "./nesCodeDiscoveryValues.js";
import type { NesDiscoveryConditionEvidence } from "./nesCodeDiscoveryConditionEvidence.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import {
  nesDiscoveryAllBytes,
  nesDiscoveryProjectDomains,
  type NesDiscoveryRegisterDomains,
} from "./nesCodeDiscoveryDomains.js";
export type NesDiscoveryPredicateFlag = "c" | "z" | "n";
type PredicateFields = Readonly<{
  carrier_variable: number;
  source_witness_indices: readonly number[];
}>;
export type NesDiscoveryComparePredicate = PredicateFields &
  Readonly<{ kind: "compare"; operand: number }>;
export type NesDiscoveryFlagPredicate =
  | NesDiscoveryComparePredicate
  | (PredicateFields & Readonly<{ kind: "result"; operand: null }>);
export type NesDiscoveryFlagPredicates = {
  c: NesDiscoveryComparePredicate | null;
  z: NesDiscoveryFlagPredicate | null;
  n: NesDiscoveryFlagPredicate | null;
};
export const emptyNesDiscoveryPredicates = (): NesDiscoveryFlagPredicates => ({
  c: null,
  z: null,
  n: null,
});
export const nesDiscoveryPredicateTruth = (
  flag: NesDiscoveryPredicateFlag,
  predicate: NesDiscoveryFlagPredicate,
  value: number,
): boolean => {
  if (predicate.kind === "result")
    return flag === "z" ? value === 0 : (value & 128) !== 0;
  const operand = predicate.operand!;
  return flag === "c"
    ? value >= operand
    : flag === "z"
      ? value === operand
      : ((value - operand) & 128) !== 0;
};
const predicateMask = (
  flag: NesDiscoveryPredicateFlag,
  predicate: NesDiscoveryFlagPredicate,
): bigint => {
  const operand = predicate.operand ?? 0;
  if (flag === "z") return 1n << BigInt(operand);
  if (flag === "c")
    return nesDiscoveryAllBytes ^ ((1n << BigInt(operand)) - 1n);
  const high = nesDiscoveryAllBytes ^ ((1n << 128n) - 1n),
    shift = BigInt(operand);
  return ((high << shift) | (high >> (256n - shift))) & nesDiscoveryAllBytes;
};
export const nesDiscoveryPredicateDomain = (
  predicate: NesDiscoveryFlagPredicate,
  values: NesDiscoveryValues,
): bigint => nesDiscoveryValueDomain(values, predicate.carrier_variable);
export const refreshNesDiscoveryPredicates = (
  cpu: NesCpuState,
  values: NesDiscoveryValues,
  predicates: NesDiscoveryFlagPredicates,
): void => {
  for (const flag of ["c", "z", "n"] as const) {
    const predicate = predicates[flag];
    if (predicate === null) continue;
    const domain = nesDiscoveryPredicateDomain(predicate, values),
      selected = domain & predicateMask(flag, predicate);
    cpu[flag] = selected === 0n ? false : selected === domain ? true : null;
  }
};
export const conditionNesDiscoveryFlag = (
  state: {
    cpu: NesCpuState;
    values: NesDiscoveryValues;
    readonly register_domains: NesDiscoveryRegisterDomains;
    flag_predicates: NesDiscoveryFlagPredicates;
    register_relations: number;
  },
  flag: "c" | "z" | "n" | "v",
  value: boolean,
  source?: {
    conditions: NesDiscoveryConditionEvidence;
    domains: NesDiscoveryDomainEvidence;
    node: number;
    analysis: number;
  },
): boolean => {
  const predicate = flag === "v" ? null : state.flag_predicates[flag];
  if (predicate !== null) {
    const mask = predicateMask(flag as NesDiscoveryPredicateFlag, predicate),
      domain =
        nesDiscoveryPredicateDomain(predicate, state.values) &
        (value ? mask : nesDiscoveryAllBytes ^ mask);
    if (domain === 0n) return false;
    const variable = nesDiscoveryValueLeader(
        state.values,
        predicate.carrier_variable,
      ),
      condition =
        source === undefined ||
        flag === "v" ||
        domain === nesDiscoveryValueDomain(state.values, variable)
          ? null
          : source.conditions.condition(
              {
                node_index: source.node,
                kind: "branch",
                variable,
                flag,
                value,
                source_domain_index: source.domains.domain(
                  nesDiscoveryValueDomain(state.values, variable),
                ),
                result_domain_index: source.domains.domain(domain),
              },
              source.analysis,
            );
    const selected = narrowNesDiscoveryValue(state.values, variable, domain, {
      condition,
      ...(source === undefined
        ? {}
        : {
            compatible: (id: number, selected: bigint) =>
              source.conditions.compatible(id, selected),
          }),
    });
    if (selected === null) return false;
    state.values = selected;
    nesDiscoveryProjectDomains(state.cpu, state.register_domains);
    refreshNesDiscoveryPredicates(
      state.cpu,
      state.values,
      state.flag_predicates,
    );
  }
  state.cpu[flag] = value;
  return true;
};
const semantics = (predicate: NesDiscoveryFlagPredicate) =>
  JSON.stringify([
    predicate.kind,
    predicate.operand,
    predicate.carrier_variable,
  ]);
export const nesDiscoveryPredicateKey = (
  predicates: NesDiscoveryFlagPredicates,
): string =>
  JSON.stringify(
    (["c", "z", "n"] as const).map((flag) =>
      predicates[flag] === null ? null : semantics(predicates[flag]),
    ),
  );
export const joinNesDiscoveryPredicates = (
  left: NesDiscoveryFlagPredicates,
  right: NesDiscoveryFlagPredicates,
  values: {
    left: NesDiscoveryValues;
    right: NesDiscoveryValues;
    joined: NesDiscoveryValues;
  },
): NesDiscoveryFlagPredicates => {
  const { left: leftValues, right: rightValues, joined: joinedValues } = values;
  const common = (
    a: NesDiscoveryFlagPredicate | null,
    b: NesDiscoveryFlagPredicate | null,
  ): NesDiscoveryFlagPredicate | null => {
    if (
      a === null ||
      b === null ||
      a.kind !== b.kind ||
      a.operand !== b.operand
    )
      return null;
    const rights = new Set(
      equalNesDiscoveryVariables(rightValues, b.carrier_variable),
    );
    const members = equalNesDiscoveryVariables(
      leftValues,
      a.carrier_variable,
    ).filter((variable) => rights.has(variable));
    if (members.length === 0) return null;
    const carrier_variable = nesDiscoveryValueLeader(joinedValues, members[0]!);
    const sources = [
      ...new Set([...a.source_witness_indices, ...b.source_witness_indices]),
    ].sort((x, y) => x - y);
    return carrier_variable === a.carrier_variable &&
      JSON.stringify(sources) === JSON.stringify(a.source_witness_indices)
      ? a
      : { ...a, carrier_variable, source_witness_indices: sources };
  };
  const carry = common(left.c, right.c);
  return {
    c: carry?.kind === "compare" ? carry : null,
    z: common(left.z, right.z),
    n: common(left.n, right.n),
  };
};
