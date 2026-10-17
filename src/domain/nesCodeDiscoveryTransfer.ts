import type { Nes6502Opcode } from "./nes6502Opcodes.js";
import { applyNes6502Instruction } from "./nes6502Instruction.js";
import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import { NesCodeDiscoveryMemory } from "./nesCodeDiscoveryMemory.js";
import {
  cloneNesDiscoveryState,
  type NesDiscoveryState,
} from "./nesCodeDiscoveryState.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import { transferNesDiscoveryStack } from "./nesCodeDiscoveryStack.js";
import { invalidateNesDiscoveryFrame } from "./nesCodeDiscoveryFrame.js";
import { nesRegisterEquals } from "./nesCodeDiscoveryRegisterRelations.js";
import {
  nes6502BranchCondition,
  nes6502BranchTarget,
  type Nes6502BranchFlag,
  type Nes6502BranchCondition,
} from "./nes6502Branches.js";
import { conditionNesDiscoveryFlag } from "./nesCodeDiscoveryPredicates.js";
import { havocUnresolvedNesDiscoveryWrite } from "./nesCodeDiscoveryCpuEffects.js";

type Kind = Extract<
  NesCodeDiscovery,
  { status: "derived" }
>["edges"][number]["kind"];
export type NesDiscoverySuccessor = {
  kind: Kind;
  address: number | null;
  mapper: NesMapperState;
  state: NesDiscoveryState;
  reason: string | null;
  condition: { flag: Nes6502BranchFlag; value: boolean } | null;
  return_proof?: "physical-bytes" | "relative-bytes" | "opaque-token";
};
const branchSuccessors = (
  memory: NesCodeDiscoveryMemory,
  branch: Nes6502BranchCondition,
  next: number,
  displacement: number,
): NesDiscoverySuccessor[] => {
  const source = memory.cpu[branch.flag],
    successors: NesDiscoverySuccessor[] = [];
  for (const taken of [false, true]) {
    const value = taken ? branch.expected : !branch.expected;
    if (source !== null && source !== value) continue;
    const state = cloneNesDiscoveryState(memory.state);
    if (
      !conditionNesDiscoveryFlag(state, branch.flag, value, {
        conditions: memory.conditionEvidence,
        domains: memory.domainEvidence,
        node: memory.nodeIndex,
        analysis: memory.analysisIndex,
      })
    )
      continue;
    successors.push({
      kind: taken ? "branch-taken" : "branch-not-taken",
      address: taken ? nes6502BranchTarget(next, displacement) : next,
      mapper: memory.mapper,
      state,
      reason: null,
      condition: { flag: branch.flag, value },
    });
  }
  return successors;
};
/** Instruction effects feed invocation-matched call and return tabulation. */
export const transferNesDiscoveryInstruction = (
  memory: NesCodeDiscoveryMemory,
  opcode: Nes6502Opcode,
  bytes: number[],
  pc: number,
): NesDiscoverySuccessor[] => {
  const next = (pc + opcode.length) & 65535,
    absolute = (bytes[1] ?? 0) | ((bytes[2] ?? 0) << 8),
    successor = (
      kind: Kind,
      address: number | null,
      reason: string | null = null,
    ): NesDiscoverySuccessor => ({
      kind,
      address,
      mapper: memory.mapper,
      state: cloneNesDiscoveryState(memory.state),
      reason,
      condition: null,
    });
  const branch = nes6502BranchCondition(opcode.mnemonic);
  if (branch !== null) return branchSuccessors(memory, branch, next, bytes[1]!);
  const stack = transferNesDiscoveryStack(memory, opcode.mnemonic, {
    pc,
    next,
    absolute,
  });
  if (stack !== null)
    return memory.stackAliasConflict
      ? []
      : stack.map((outcome) => ({
          ...successor(outcome.kind, outcome.address, outcome.reason),
          ...(outcome.return_proof === undefined
            ? {}
            : { return_proof: outcome.return_proof }),
        }));
  const previousSp = memory.cpu.sp,
    copiedSameSp =
      opcode.mnemonic === "TXS" &&
      nesRegisterEquals(memory.state.register_relations, "sp").includes("x"),
    applied = applyNes6502Instruction(memory, opcode, bytes, { pc });
  if (
    (opcode.mnemonic === "TXS" || opcode.mnemonic === "LAS") &&
    !copiedSameSp &&
    !(previousSp !== null && previousSp === memory.cpu.sp)
  ) {
    memory.stackMemory.assignSp(previousSp, memory.cpu.sp);
    if (memory.state.frame.entry_sp !== null && memory.cpu.sp !== null)
      memory.state.frame.relative_sp =
        (memory.cpu.sp - memory.state.frame.entry_sp) & 255;
    else invalidateNesDiscoveryFrame(memory.state.frame);
  }
  if (memory.stackAliasConflict) return [];
  if ("reason" in applied) {
    if (applied.reason === "unknown-write-address") {
      havocUnresolvedNesDiscoveryWrite(memory.cpu, opcode);
      memory.frontiers.push(applied.reason);
      memory.references.push({
        node_index: memory.nodeIndex,
        kind: "write",
        address: null,
        value: null,
        file_offsets: [],
        ram_origins: [],
        relative_stack_origins: [],
      });
      memory.invalidateUnknownStore();
      return [successor("fallthrough", next)];
    }
    return [
      successor(
        opcode.mnemonic === "JMP" ? "jump" : "fallthrough",
        null,
        applied.reason,
      ),
    ];
  }
  return [
    successor(opcode.mnemonic === "JMP" ? "jump" : "fallthrough", applied.next),
  ];
};
