import { nesCpuStateSchema, type NesCpuState } from "./nesCodeTrace.js";
import { joinNesBytes } from "./nesByteValue.js";
import { nesCpuByte, setNesCpuByte } from "./nesCpuRegister.js";

import {
  emptyNesDiscoveryRam,
  joinNesDiscoveryRam,
  type NesDiscoveryRam,
} from "./nesCodeDiscoveryRam.js";
import {
  nesDiscoveryFrame,
  cloneNesDiscoveryFrame,
  joinNesDiscoveryFrame,
  type NesDiscoveryFrame,
} from "./nesCodeDiscoveryFrame.js";
import {
  emptyNesDiscoveryValues,
  joinNesDiscoveryValues,
  narrowNesDiscoveryValue,
  nesDiscoveryValueRegisterDomains,
  nesDiscoveryValueRegisterRelations,
  type NesDiscoveryValues,
} from "./nesCodeDiscoveryValues.js";
import {
  emptyNesDiscoveryRelativeStack,
  joinNesDiscoveryRelativeStack,
  type NesDiscoveryRelativeStack,
} from "./nesCodeDiscoveryRelativeStack.js";
import {
  nesDiscoveryByteDomain,
  nesDiscoveryProjectDomains,
  nesDiscoveryRegisters,
  type NesDiscoveryRegisterDomains,
} from "./nesCodeDiscoveryDomains.js";

import {
  emptyNesDiscoveryPredicates,
  joinNesDiscoveryPredicates,
  refreshNesDiscoveryPredicates,
  type NesDiscoveryFlagPredicates,
} from "./nesCodeDiscoveryPredicates.js";
export type NesDiscoveryState = {
  partition_index: number;
  readonly register_relations: number;
  values: NesDiscoveryValues;
  frame: NesDiscoveryFrame;
  cpu: NesCpuState;
  ram: NesDiscoveryRam;
  relative_stack: NesDiscoveryRelativeStack;
  readonly register_domains: NesDiscoveryRegisterDomains;
  flag_predicates: NesDiscoveryFlagPredicates;
};
export type NesDiscoveryWork = {
  invocation_index: number;
  context_index: number;
  address: number;
  state: NesDiscoveryState;
};
export const emptyNesDiscoveryState = (): NesDiscoveryState => ({
  partition_index: 0,
  values: emptyNesDiscoveryValues(),
  get register_relations() {
    return nesDiscoveryValueRegisterRelations(this.values);
  },
  cpu: nesCpuStateSchema.parse({}),
  frame: nesDiscoveryFrame("root", null),
  ram: emptyNesDiscoveryRam(),
  relative_stack: emptyNesDiscoveryRelativeStack(),
  get register_domains() {
    return nesDiscoveryValueRegisterDomains(this.values);
  },
  flag_predicates: emptyNesDiscoveryPredicates(),
});
export const cloneNesDiscoveryState = (
  state: NesDiscoveryState,
): NesDiscoveryState => ({
  cpu: structuredClone(state.cpu),
  ram: state.ram,
  relative_stack: state.relative_stack,
  values: state.values,
  get register_domains() {
    return nesDiscoveryValueRegisterDomains(this.values);
  },
  flag_predicates: { ...state.flag_predicates },
  frame: cloneNesDiscoveryFrame(state.frame),
  partition_index: state.partition_index,
  get register_relations() {
    return nesDiscoveryValueRegisterRelations(this.values);
  },
});

/** At one context/PC, only common byte and flag facts survive all incoming candidates. */
export const joinNesDiscoveryState = (
  retained: NesDiscoveryState,
  incoming: NesDiscoveryState,
): boolean => {
  let changed = joinNesDiscoveryFrame(retained.frame, incoming.frame);
  const values = joinNesDiscoveryValues(retained.values, incoming.values),
    predicates = joinNesDiscoveryPredicates(
      retained.flag_predicates,
      incoming.flag_predicates,
      { left: retained.values, right: incoming.values, joined: values },
    );
  if (values !== retained.values) {
    retained.values = values;
    changed = true;
  }
  if (JSON.stringify(predicates) !== JSON.stringify(retained.flag_predicates)) {
    retained.flag_predicates = predicates;
    changed = true;
  }
  changed = joinNesDiscoveryCpu(retained.cpu, incoming.cpu) || changed;
  normalizeNesDiscoveryDomains(retained);
  const ram = joinNesDiscoveryRam(retained.ram, incoming.ram);
  if (ram !== retained.ram) {
    retained.ram = ram;
    changed = true;
  }
  const stack = joinNesDiscoveryRelativeStack(
    retained.relative_stack,
    incoming.relative_stack,
  );
  if (stack !== retained.relative_stack) {
    retained.relative_stack = stack;
    changed = true;
  }
  return changed;
};

/** Exact sets own register values; CPU bytes are their common-bit projection. */
export const normalizeNesDiscoveryDomains = (
  state: NesDiscoveryState,
): boolean => {
  for (const [variable, register] of nesDiscoveryRegisters.entries()) {
    const selected = narrowNesDiscoveryValue(
      state.values,
      variable,
      nesDiscoveryByteDomain(nesCpuByte(state.cpu, register)),
    );
    if (selected === null) return false;
    state.values = selected;
  }
  nesDiscoveryProjectDomains(state.cpu, state.register_domains);
  refreshNesDiscoveryPredicates(state.cpu, state.values, state.flag_predicates);
  return true;
};

export const joinNesDiscoveryCpu = (
  retained: NesCpuState,
  incoming: NesCpuState,
): boolean => {
  let changed = false;
  for (const register of ["a", "x", "y", "sp"] as const) {
    const before = nesCpuByte(retained, register),
      after = joinNesBytes(before, nesCpuByte(incoming, register));
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      setNesCpuByte(retained, register, after);
      changed = true;
    }
  }
  for (const flag of ["c", "z", "i", "d", "v", "n"] as const)
    if (retained[flag] !== null && retained[flag] !== incoming[flag]) {
      retained[flag] = null;
      changed = true;
    }
  return changed;
};
