import {
  nesDiscoveryAllBytes,
  type NesDiscoveryRegisterDomains,
} from "./nesCodeDiscoveryDomains.js";
import type { NesCpuRegister } from "./nesCpuRegister.js";
export const nesDiscoveryVariableCount = 2052;
export const nesDiscoveryRegisterVariables = {
  a: 0,
  x: 1,
  y: 2,
  sp: 3,
} as const;
export type NesDiscoveryValueEntry = Readonly<{
  leader: number;
  domain: bigint;
  condition_witness_indices: readonly number[];
}>;
export type NesDiscoveryValuePage = readonly (
  | NesDiscoveryValueEntry
  | undefined
)[];
export type NesDiscoveryValues = readonly (NesDiscoveryValuePage | undefined)[];
const empty = Object.freeze(Array<undefined>(65).fill(undefined));
export const emptyNesDiscoveryValues = (): NesDiscoveryValues => empty;
export const readNesDiscoveryValue = (
  values: NesDiscoveryValues,
  variable: number,
): NesDiscoveryValueEntry | undefined => values[variable >> 5]?.[variable & 31];
export const nesDiscoveryValueDomain = (
  values: NesDiscoveryValues,
  variable: number,
): bigint =>
  readNesDiscoveryValue(values, variable)?.domain ?? nesDiscoveryAllBytes;
export const nesDiscoveryValueLeader = (
  values: NesDiscoveryValues,
  variable: number,
): number => readNesDiscoveryValue(values, variable)?.leader ?? variable;
export const equalNesDiscoveryVariables = (
  values: NesDiscoveryValues,
  variable: number,
): number[] => {
  const leader = nesDiscoveryValueLeader(values, variable);
  if (readNesDiscoveryValue(values, variable) === undefined) return [variable];
  const members: number[] = [];
  for (let page = 0; page < 65; page++) {
    const entries = values[page];
    if (entries === undefined) continue;
    for (let offset = 0; offset < entries.length; offset++)
      if (entries[offset]?.leader === leader) members.push(page * 32 + offset);
  }
  return members;
};
export const nesDiscoveryValueConditions = (
  values: NesDiscoveryValues,
  variable: number,
): readonly number[] =>
  readNesDiscoveryValue(values, nesDiscoveryValueLeader(values, variable))
    ?.condition_witness_indices ?? [];
const immutableEntry = (
  leader: number,
  domain: bigint,
  conditions: readonly number[],
): NesDiscoveryValueEntry =>
  Object.freeze({
    leader,
    domain,
    condition_witness_indices: Object.freeze([...conditions]),
  });
const sameEntry = (
  a: NesDiscoveryValueEntry | undefined,
  b: NesDiscoveryValueEntry | undefined,
): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.leader === b.leader &&
    a.domain === b.domain &&
    a.condition_witness_indices.length === b.condition_witness_indices.length &&
    a.condition_witness_indices.every(
      (id, index) => id === b.condition_witness_indices[index],
    ));
const update = (
  values: NesDiscoveryValues,
  changes: Map<number, NesDiscoveryValueEntry | undefined>,
): NesDiscoveryValues => {
  if (changes.size === 0) return values;
  const pages = [...values],
    changed = new Map<number, (NesDiscoveryValueEntry | undefined)[]>();
  for (const [variable, entry] of changes) {
    if (sameEntry(readNesDiscoveryValue(values, variable), entry)) continue;
    const page = variable >> 5;
    let entries = changed.get(page);
    if (entries === undefined) {
      entries = [
        ...(values[page] ??
          Array<undefined>(page === 64 ? 4 : 32).fill(undefined)),
      ];
      changed.set(page, entries);
    }
    entries[variable & 31] = entry;
  }
  if (changed.size === 0) return values;
  for (const [page, entries] of changed)
    pages[page] = entries.every((entry) => entry === undefined)
      ? undefined
      : Object.freeze(entries);
  return Object.freeze(pages);
};
const putGroup = (
  changes: Map<number, NesDiscoveryValueEntry | undefined>,
  members: readonly number[],
  domain: bigint,
  conditions: readonly number[],
) => {
  const leader = members[0];
  if (leader === undefined) return;
  for (const member of members)
    changes.set(
      member,
      members.length === 1 &&
        domain === nesDiscoveryAllBytes &&
        conditions.length === 0
        ? undefined
        : immutableEntry(leader, domain, member === leader ? conditions : []),
    );
};
export const assignNesDiscoveryValue = (
  values: NesDiscoveryValues,
  variable: number,
  domain: bigint,
  conditions: readonly number[] = [],
): NesDiscoveryValues => {
  const members = equalNesDiscoveryVariables(values, variable),
    changes = new Map<number, NesDiscoveryValueEntry | undefined>();
  putGroup(
    changes,
    members.filter((member) => member !== variable),
    nesDiscoveryValueDomain(values, variable),
    nesDiscoveryValueConditions(values, variable),
  );
  putGroup(changes, [variable], domain, conditions);
  return update(values, changes);
};
export const copyNesDiscoveryValue = (
  values: NesDiscoveryValues,
  destination: number,
  source: number,
): NesDiscoveryValues => {
  if (
    nesDiscoveryValueLeader(values, destination) ===
    nesDiscoveryValueLeader(values, source)
  )
    return values;
  const detached = assignNesDiscoveryValue(
      values,
      destination,
      nesDiscoveryAllBytes,
    ),
    members = [
      ...equalNesDiscoveryVariables(detached, source),
      destination,
    ].sort((a, b) => a - b),
    changes = new Map<number, NesDiscoveryValueEntry | undefined>();
  putGroup(
    changes,
    members,
    nesDiscoveryValueDomain(detached, source),
    nesDiscoveryValueConditions(detached, source),
  );
  return update(detached, changes);
};
export const narrowNesDiscoveryValue = (
  values: NesDiscoveryValues,
  variable: number,
  domain: bigint,
  proof: {
    condition?: number | null;
    compatible?: (condition: number, domain: bigint) => boolean;
  } = {},
): NesDiscoveryValues | null => {
  const { condition = null, compatible } = proof;
  const selected = nesDiscoveryValueDomain(values, variable) & domain;
  if (selected === 0n) return null;
  const original = nesDiscoveryValueConditions(values, variable),
    filtered =
      compatible === undefined
        ? original
        : original.filter((id) => compatible(id, selected)),
    prior = filtered.length === original.length ? original : filtered,
    conditions =
      condition === null || prior.includes(condition)
        ? prior
        : [...prior, condition].sort((a, b) => a - b);
  if (
    selected === nesDiscoveryValueDomain(values, variable) &&
    conditions === original
  )
    return values;
  const changes = new Map<number, NesDiscoveryValueEntry | undefined>();
  putGroup(
    changes,
    equalNesDiscoveryVariables(values, variable),
    selected,
    conditions,
  );
  return update(values, changes);
};
export const forgetNesDiscoveryValues = (
  values: NesDiscoveryValues,
  variables: Iterable<number>,
): NesDiscoveryValues => {
  const forgotten = new Set(variables),
    removedLeaders = new Set(
      [...forgotten].map((variable) =>
        nesDiscoveryValueLeader(values, variable),
      ),
    ),
    changes = new Map<number, NesDiscoveryValueEntry | undefined>(),
    groups = new Map<number, number[]>();
  for (let variable = 0; variable < nesDiscoveryVariableCount; variable++) {
    if (forgotten.has(variable)) {
      changes.set(variable, undefined);
      continue;
    }
    const entry = readNesDiscoveryValue(values, variable);
    if (entry === undefined) continue;
    const members = groups.get(entry.leader) ?? [];
    members.push(variable);
    groups.set(entry.leader, members);
  }
  for (const [leader, members] of groups)
    if (removedLeaders.has(leader))
      putGroup(
        changes,
        members,
        nesDiscoveryValueDomain(values, leader),
        nesDiscoveryValueConditions(values, leader),
      );
  return update(values, changes);
};
/** The intersection of two equivalence relations is grouped by their leader pair. */
export const joinNesDiscoveryValues = (
  left: NesDiscoveryValues,
  right: NesDiscoveryValues,
): NesDiscoveryValues => {
  if (left === right) return left;
  const groups = new Map<string, number[]>(),
    changes = new Map<number, NesDiscoveryValueEntry | undefined>(),
    affected = new Set<number>();
  for (let page = 0; page < 65; page++) {
    if (left[page] === right[page]) continue;
    for (let offset = 0; offset < (page === 64 ? 4 : 32); offset++) {
      const variable = page * 32 + offset;
      if (
        sameEntry(
          readNesDiscoveryValue(left, variable),
          readNesDiscoveryValue(right, variable),
        )
      )
        continue;
      for (const member of equalNesDiscoveryVariables(left, variable))
        affected.add(member);
      for (const member of equalNesDiscoveryVariables(right, variable))
        affected.add(member);
    }
  }
  for (const variable of [...affected].sort((a, b) => a - b)) {
    const key = `${nesDiscoveryValueLeader(left, variable)}:${nesDiscoveryValueLeader(right, variable)}`,
      members = groups.get(key) ?? [];
    members.push(variable);
    groups.set(key, members);
  }
  for (const members of groups.values()) {
    const variable = members[0]!,
      domain =
        nesDiscoveryValueDomain(left, variable) |
        nesDiscoveryValueDomain(right, variable),
      conditions = [
        ...new Set([
          ...nesDiscoveryValueConditions(left, variable),
          ...nesDiscoveryValueConditions(right, variable),
        ]),
      ].sort((a, b) => a - b);
    putGroup(changes, members, domain, conditions);
  }
  return update(left, changes);
};
export const nesDiscoveryValuesKey = (values: NesDiscoveryValues): string =>
  JSON.stringify(
    values.map(
      (page, pageIndex) =>
        page?.flatMap((entry, offset) =>
          entry === undefined ||
          (entry.leader === pageIndex * 32 + offset &&
            entry.domain === nesDiscoveryAllBytes)
            ? []
            : [[offset, entry.leader, entry.domain.toString(16)]],
        ) ?? [],
    ),
  );
export const nesDiscoveryValuesEvidenceKey = (
  values: NesDiscoveryValues,
): string =>
  JSON.stringify(
    values.map(
      (page) =>
        page?.flatMap((entry, offset) =>
          entry === undefined
            ? []
            : [
                [
                  offset,
                  entry.leader,
                  entry.domain.toString(16),
                  entry.condition_witness_indices,
                ],
              ],
        ) ?? [],
    ),
  );
export const nesDiscoveryValueRegisterDomains = (
  values: NesDiscoveryValues,
): NesDiscoveryRegisterDomains => ({
  a: nesDiscoveryValueDomain(values, 0),
  x: nesDiscoveryValueDomain(values, 1),
  y: nesDiscoveryValueDomain(values, 2),
  sp: nesDiscoveryValueDomain(values, 3),
});
export const nesDiscoveryValueRegisterEquals = (
  values: NesDiscoveryValues,
  register: NesCpuRegister,
): NesCpuRegister[] =>
  (["a", "x", "y", "sp"] as const).filter(
    (other) =>
      nesDiscoveryValueLeader(values, nesDiscoveryRegisterVariables[other]) ===
      nesDiscoveryValueLeader(values, nesDiscoveryRegisterVariables[register]),
  );
export const nesDiscoveryValueRegisterRelations = (
  values: NesDiscoveryValues,
): number => {
  const pairs = [
    [0, 1],
    [0, 2],
    [0, 3],
    [1, 2],
    [1, 3],
    [2, 3],
  ] as const;
  let result = 0;
  for (const [bit, [a, b]] of pairs.entries())
    if (
      nesDiscoveryValueLeader(values, a) === nesDiscoveryValueLeader(values, b)
    )
      result |= 1 << bit;
  return result;
};
