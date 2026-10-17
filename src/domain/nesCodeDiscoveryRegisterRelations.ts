import type { Nes6502Opcode } from "./nes6502Opcodes.js";
import type { NesCpuState } from "./nesCodeTrace.js";
import { nesCpuByte, type NesCpuRegister } from "./nesCpuRegister.js";

const registers = ["a", "x", "y", "sp"] as const;
const pairs = [
  ["a", "x"],
  ["a", "y"],
  ["a", "sp"],
  ["x", "y"],
  ["x", "sp"],
  ["y", "sp"],
] as const;

/** All equivalence relations in the six-bit pair order above; identity is implicit. */
export const nesRegisterRelationMasks = [
  0, 1, 2, 4, 8, 11, 12, 16, 18, 21, 32, 33, 38, 56, 63,
] as const;
const masks = new Set<number>(nesRegisterRelationMasks);
export const isNesRegisterRelations = (value: unknown): value is number =>
  typeof value === "number" && masks.has(value);

/** A join retains only equalities established on both incoming paths. */
export const joinNesRegisterRelations = (
  left: number,
  right: number,
): number =>
  isNesRegisterRelations(left) && isNesRegisterRelations(right)
    ? left & right
    : 0;

export const nesRegisterEquals = (
  relations: number,
  register: NesCpuRegister,
): NesCpuRegister[] => {
  const result = new Set<NesCpuRegister>([register]);
  if (isNesRegisterRelations(relations))
    for (const [bit, [left, right]] of pairs.entries())
      if ((relations & (1 << bit)) !== 0) {
        if (left === register) result.add(right);
        if (right === register) result.add(left);
      }
  return registers.filter((candidate) => result.has(candidate));
};
const kill = (
  relations: number,
  written: readonly NesCpuRegister[],
): number => {
  let result = relations;
  for (const [bit, [left, right]] of pairs.entries())
    if (written.includes(left) || written.includes(right))
      result &= ~(1 << bit);
  return result;
};
const alias = (relations: number, equal: readonly NesCpuRegister[]): number => {
  let result = kill(relations, equal);
  for (const [bit, [left, right]] of pairs.entries())
    if (equal.includes(left) && equal.includes(right)) result |= 1 << bit;
  return result;
};
const copy = (
  relations: number,
  source: NesCpuRegister,
  destination: NesCpuRegister,
): number => {
  const group = nesRegisterEquals(relations, source);
  let result = kill(relations, [destination]);
  for (const [bit, [left, right]] of pairs.entries())
    if (
      (left === destination && group.includes(right)) ||
      (right === destination && group.includes(left))
    )
      result |= 1 << bit;
  return result;
};

/** Contradictory byte envelopes invalidate a whole group, preserving equivalence. */
const compatible = (relations: number, cpu: NesCpuState): number => {
  let result = isNesRegisterRelations(relations) ? relations : 0;
  const examined = new Set<NesCpuRegister>();
  for (const register of registers) {
    if (examined.has(register)) continue;
    const group = nesRegisterEquals(result, register);
    let mask = 0,
      bits = 0;
    for (const member of group) {
      examined.add(member);
      const value = nesCpuByte(cpu, member),
        proof = typeof value === "number" ? { mask: 255, value } : value;
      if (proof === null) continue;
      if (((bits ^ proof.value) & mask & proof.mask) !== 0) {
        result = kill(result, group);
        break;
      }
      bits |= proof.value;
      mask |= proof.mask;
    }
  }
  return result;
};
const copies = new Map<
  Nes6502Opcode["mnemonic"],
  readonly [NesCpuRegister, NesCpuRegister]
>([
  ["TAX", ["a", "x"]],
  ["TAY", ["a", "y"]],
  ["TXA", ["x", "a"]],
  ["TYA", ["y", "a"]],
  ["TSX", ["sp", "x"]],
  ["TXS", ["x", "sp"]],
]);
const writesA = new Set([
  "ADC",
  "SBC",
  "AND",
  "ORA",
  "EOR",
  "LDA",
  "ANC",
  "ALR",
  "ARR",
  "ISC",
  "SLO",
  "RLA",
  "SRE",
  "RRA",
]);
const writesX = new Set(["LDX", "INX", "DEX", "AXS"]);
const writesY = new Set(["LDY", "INY", "DEY"]);
const writesSp = new Set(["BRK", "JSR", "RTS", "RTI", "PHA", "PHP", "PLP"]);
const shifts = new Set(["ASL", "LSR", "ROL", "ROR"]);
const unchanged = new Set([
  "BCC",
  "BCS",
  "BEQ",
  "BMI",
  "BNE",
  "BPL",
  "BVC",
  "BVS",
  "BIT",
  "CLC",
  "CLD",
  "CLI",
  "CLV",
  "CMP",
  "CPX",
  "CPY",
  "DEC",
  "DCP",
  "INC",
  "JMP",
  "NOP",
  "SAX",
  "SEC",
  "SED",
  "SEI",
  "STA",
  "STX",
  "STY",
]);

/** One format-aware register-write/copy classification serves relations and finite domains. */
export const nesDiscoveryRegisterEffect = (
  opcode: Pick<Nes6502Opcode, "mnemonic" | "mode">,
): {
  written: readonly NesCpuRegister[];
  copy: readonly [NesCpuRegister, NesCpuRegister] | null;
  equal: readonly NesCpuRegister[] | null;
} => {
  const transfer = copies.get(opcode.mnemonic);
  if (transfer !== undefined)
    return { written: [transfer[1]], copy: transfer, equal: null };
  if (opcode.mnemonic === "LAX")
    return { written: ["a", "x"], copy: null, equal: ["a", "x"] };
  if (opcode.mnemonic === "LAS")
    return { written: ["a", "x", "sp"], copy: null, equal: ["a", "x", "sp"] };
  const written =
    opcode.mnemonic === "PLA"
      ? (["a", "sp"] as const)
      : writesA.has(opcode.mnemonic)
        ? (["a"] as const)
        : writesX.has(opcode.mnemonic)
          ? (["x"] as const)
          : writesY.has(opcode.mnemonic)
            ? (["y"] as const)
            : writesSp.has(opcode.mnemonic)
              ? (["sp"] as const)
              : shifts.has(opcode.mnemonic)
                ? opcode.mode === "acc"
                  ? (["a"] as const)
                  : []
                : unchanged.has(opcode.mnemonic)
                  ? []
                  : registers;
  return { written, copy: null, equal: null };
};

/** Only semantic copies create equality; coincident numeric values never do. */
export const transferNesRegisterRelations = (
  relations: number,
  opcode: Pick<Nes6502Opcode, "mnemonic" | "mode">,
  beforeCpu: NesCpuState,
  afterCpu: NesCpuState,
): number => {
  const before = compatible(relations, beforeCpu),
    effect = nesDiscoveryRegisterEffect(opcode);
  let after: number;
  if (effect.copy !== null)
    after = copy(before, effect.copy[0], effect.copy[1]);
  else if (effect.equal !== null) after = alias(before, effect.equal);
  else after = kill(before, effect.written);
  return compatible(after, afterCpu);
};
