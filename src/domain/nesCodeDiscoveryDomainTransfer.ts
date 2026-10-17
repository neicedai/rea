import type { Nes6502Opcode } from "./nes6502Opcodes.js";
import { nesCpuByte, type NesCpuRegister } from "./nesCpuRegister.js";
import type { NesDiscoveryState } from "./nesCodeDiscoveryState.js";
import type { NesCodeDiscoveryMemory } from "./nesCodeDiscoveryMemory.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import {
  nesDiscoveryByteDomain,
  nesDiscoveryProjectDomains,
} from "./nesCodeDiscoveryDomains.js";
import { nesDiscoveryRegisterEffect } from "./nesCodeDiscoveryRegisterRelations.js";
import { exactNesDiscoveryAluDomains } from "./nesCodeDiscoveryDomainAlu.js";
import { nesDiscoveryWrittenFlags } from "./nesCodeDiscoveryCpuEffects.js";
import {
  refreshNesDiscoveryPredicates,
  type NesDiscoveryFlagPredicate,
  type NesDiscoveryFlagPredicates,
} from "./nesCodeDiscoveryPredicates.js";
const compareRegister = (op: string): NesCpuRegister | null =>
  op === "CMP" ? "a" : op === "CPX" ? "x" : op === "CPY" ? "y" : null;
import {
  assignNesDiscoveryValue,
  copyNesDiscoveryValue,
  equalNesDiscoveryVariables,
  nesDiscoveryRegisterVariables,
  nesDiscoveryValueLeader,
  type NesDiscoveryValues,
} from "./nesCodeDiscoveryValues.js";
const transferCarriers = (
  predicates: NesDiscoveryFlagPredicates,
  invalidated: ReadonlySet<number>,
  before: NesDiscoveryValues,
  after: NesDiscoveryValues,
): NesDiscoveryFlagPredicates => {
  const result: NesDiscoveryFlagPredicates = { c: null, z: null, n: null };
  const transfer = (
    predicate: NesDiscoveryFlagPredicate | null,
  ): NesDiscoveryFlagPredicate | null => {
    if (predicate === null) return null;
    const members = equalNesDiscoveryVariables(
      before,
      predicate.carrier_variable,
    ).filter((variable) => !invalidated.has(variable));
    return members.length === 0
      ? null
      : {
          ...predicate,
          carrier_variable: nesDiscoveryValueLeader(after, members[0]!),
        };
  };
  const carry = transfer(predicates.c);
  result.c = carry?.kind === "compare" ? carry : null;
  result.z = transfer(predicates.z);
  result.n = transfer(predicates.n);
  return result;
};
const transferRegisterValues = (
  memory: NesCodeDiscoveryMemory,
  before: NesDiscoveryState,
  opcode: Nes6502Opcode,
  operand: number | null,
) => {
  const state = memory.state,
    op = opcode.mnemonic,
    effect = nesDiscoveryRegisterEffect(opcode);
  const invalidated = new Set([
    ...memory.invalidatedVariables,
    ...effect.written.map(
      (register) => nesDiscoveryRegisterVariables[register],
    ),
  ]);
  for (const register of effect.written)
    state.values = assignNesDiscoveryValue(
      state.values,
      nesDiscoveryRegisterVariables[register],
      nesDiscoveryByteDomain(nesCpuByte(state.cpu, register)),
    );
  if (effect.copy !== null)
    state.values = copyNesDiscoveryValue(
      state.values,
      nesDiscoveryRegisterVariables[effect.copy[1]],
      nesDiscoveryRegisterVariables[effect.copy[0]],
    );
  const operandSource = memory.operandSource;
  const loads =
    op === "LDA"
      ? (["a"] as const)
      : op === "LDX"
        ? (["x"] as const)
        : op === "LDY"
          ? (["y"] as const)
          : op === "LAX"
            ? (["a", "x"] as const)
            : op === "PLA"
              ? (["a"] as const)
              : [];
  if (operandSource !== null)
    for (const register of loads)
      state.values =
        operandSource.variable === null
          ? assignNesDiscoveryValue(
              state.values,
              nesDiscoveryRegisterVariables[register],
              operandSource.domain,
            )
          : copyNesDiscoveryValue(
              state.values,
              nesDiscoveryRegisterVariables[register],
              operandSource.variable,
            );
  for (const [register, domain] of Object.entries(
    exactNesDiscoveryAluDomains(opcode, operand, before, state.cpu),
  ))
    state.values = assignNesDiscoveryValue(
      state.values,
      nesDiscoveryRegisterVariables[register as NesCpuRegister],
      domain,
    );
  if (effect.equal !== null) {
    const first = effect.equal[0]!;
    for (const register of effect.equal.slice(1))
      state.values = copyNesDiscoveryValue(
        state.values,
        nesDiscoveryRegisterVariables[register],
        nesDiscoveryRegisterVariables[first],
      );
  }
  return invalidated;
};
/** Actual writes replace value carriers; flags remain independent across partial clobbers. */
export const transferNesDiscoveryDomains = (source: {
  memory: NesCodeDiscoveryMemory;
  before: NesDiscoveryState;
  opcode: Nes6502Opcode;
  bytes: readonly number[];
  evidence: NesDiscoveryDomainEvidence;
}): void => {
  const { memory, before, opcode, bytes, evidence } = source,
    state = memory.state,
    op = opcode.mnemonic,
    effect = nesDiscoveryRegisterEffect(opcode);
  const operandRead =
    opcode.mode === "imm"
      ? (bytes[1] ?? 0)
      : (memory.references
          .filter((reference) => reference.kind === "read")
          .at(-1)?.value ?? null);
  const operand = typeof operandRead === "number" ? operandRead : null;
  const invalidated = transferRegisterValues(memory, before, opcode, operand);
  state.flag_predicates = transferCarriers(
    before.flag_predicates,
    invalidated,
    before.values,
    state.values,
  );
  const resultRegister =
    effect.written.find((register) => register !== "sp") ?? null;
  for (const flag of nesDiscoveryWrittenFlags(opcode))
    if (flag !== "v") state.flag_predicates[flag] = null;
  nesDiscoveryProjectDomains(state.cpu, state.register_domains);
  const register = compareRegister(op);
  if (register !== null && operand !== null) {
    const witness = evidence.source({
      node_index: memory.nodeIndex,
      analysis_index: memory.analysisIndex,
      register,
      kind: "compare",
      operand,
    });
    const predicate = {
      kind: "compare" as const,
      carrier_variable: nesDiscoveryValueLeader(
        state.values,
        nesDiscoveryRegisterVariables[register],
      ),
      operand,
      source_witness_indices: [witness],
    };
    state.flag_predicates = { c: predicate, z: predicate, n: predicate };
  } else if (resultRegister !== null) {
    const witness = evidence.source({
      node_index: memory.nodeIndex,
      analysis_index: memory.analysisIndex,
      register: resultRegister,
      kind: "result",
      operand: null,
    });
    const predicate = {
      kind: "result" as const,
      carrier_variable: nesDiscoveryValueLeader(
        state.values,
        nesDiscoveryRegisterVariables[resultRegister],
      ),
      operand: null,
      source_witness_indices: [witness],
    };
    state.flag_predicates.z = predicate;
    state.flag_predicates.n = predicate;
  }
  refreshNesDiscoveryPredicates(state.cpu, state.values, state.flag_predicates);
};
