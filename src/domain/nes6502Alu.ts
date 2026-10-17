import { joinNesBytes, nesByteProof } from "./nesByteValue.js";
import type { NesKnownBits, NesByteValue } from "./nesByteValue.js";
import type { NesCpuState } from "./nesCodeTrace.js";
import { nesCpuByte, setNesCpuByte } from "./nesCpuRegister.js";

export const setNesNz = (cpu: NesCpuState, value: NesByteValue): void => {
  const mask = typeof value === "number" ? 255 : (value?.mask ?? 0);
  const bits = typeof value === "number" ? value : (value?.value ?? 0);
  cpu.n = (mask & 128) === 0 ? null : (bits & 128) !== 0;
  cpu.z = bits !== 0 ? false : mask === 255 ? true : null;
};

/** Ricoh binary arithmetic: D is retained as a flag but never enables BCD correction. */
export const nesAdd = (
  cpu: NesCpuState,
  value: NesByteValue,
  subtract: boolean,
): void => {
  const accumulator = nesCpuByte(cpu, "a");
  const carry = cpu.c;
  // Two unknown bytes cover every result and both values of every output flag.
  if (accumulator === null && value === null) {
    setNesCpuByte(cpu, "a", null);
    cpu.c = null;
    cpu.v = null;
    setNesNz(cpu, null);
    return;
  }
  const mask = typeof value === "number" ? 255 : (value?.mask ?? 0);
  const minimum = typeof value === "number" ? value : (value?.value ?? 0);
  const maximum = minimum | (255 ^ mask);
  let first = true;
  let resultAnd = 255,
    resultOr = 0;
  const aMin =
    typeof accumulator === "number" ? accumulator : (accumulator?.value ?? 0);
  const aMask =
    typeof accumulator === "number" ? 255 : (accumulator?.mask ?? 0);
  for (let a = aMin; a <= (aMin | (255 ^ aMask)); a++) {
    if ((a & aMask) !== aMin) continue;
    for (let operand = minimum; operand <= maximum; operand++) {
      if ((operand & mask) !== minimum) continue;
      for (
        let c = carry === null ? 0 : Number(carry);
        c <= (carry === null ? 1 : Number(carry));
        c++
      ) {
        const other = subtract ? operand ^ 255 : operand;
        const sum = a + other + c;
        const result = sum & 255;
        const overflow = (~(a ^ other) & (a ^ sum) & 128) !== 0;
        resultAnd &= result;
        resultOr |= result;
        cpu.c = first || cpu.c === sum > 255 ? sum > 255 : null;
        cpu.v = first || cpu.v === overflow ? overflow : null;
        cpu.n =
          first || cpu.n === ((result & 128) !== 0)
            ? (result & 128) !== 0
            : null;
        cpu.z = first || cpu.z === (result === 0) ? result === 0 : null;
        first = false;
      }
    }
  }
  setNesCpuByte(cpu, "a", nesByteProof(~(resultAnd ^ resultOr), resultAnd));
};

/** Compare every byte allowed by the register and operand proofs. */
export const nesCompare = (
  cpu: NesCpuState,
  left: NesByteValue,
  right: NesByteValue,
): void => {
  if (left !== null && typeof left === "object") {
    let first = true;
    for (let a = left.value; a < 256; a++) {
      if ((a & left.mask) !== left.value) continue;
      for (let b = 0; b < 256; b++) {
        if (
          typeof right === "number"
            ? b !== right
            : right !== null && (b & right.mask) !== right.value
        )
          continue;
        const c = a >= b,
          n = ((a - b) & 128) !== 0,
          z = a === b;
        cpu.c = first || cpu.c === c ? c : null;
        cpu.n = first || cpu.n === n ? n : null;
        cpu.z = first || cpu.z === z ? z : null;
        first = false;
      }
    }
    return;
  }
  const mask = typeof right === "number" ? 255 : (right?.mask ?? 0);
  const minimum = typeof right === "number" ? right : (right?.value ?? 0);
  const maximum = minimum | (255 ^ mask);
  cpu.c =
    (left ?? 0) >= maximum ? true : (left ?? 255) < minimum ? false : null;
  if (left === null || mask === 0) {
    setNesNz(cpu, null);
    return;
  }
  if (mask === 255) {
    setNesNz(cpu, (left - minimum) & 255);
    return;
  }
  cpu.z = (left & mask) !== minimum ? false : null;
  let negative: boolean | undefined;
  for (let operand = minimum; operand <= maximum; operand++) {
    if ((operand & mask) !== minimum) continue;
    const current = ((left - operand) & 255 & 128) !== 0;
    if (negative !== undefined && negative !== current) {
      cpu.n = null;
      return;
    }
    negative = current;
  }
  cpu.n = negative ?? null;
};

/** Retain only bits shared by all incremented/decremented operand bytes. */
export const nesIncrement = (
  cpu: NesCpuState,
  value: NesByteValue,
  delta: 1 | -1,
): NesByteValue => {
  if (value === null || typeof value === "number") {
    const result = value === null ? null : (value + delta) & 255;
    setNesNz(cpu, result);
    return result;
  }
  let result: NesByteValue | undefined;
  for (let candidate = value.value; candidate < 256; candidate++) {
    if ((candidate & value.mask) !== value.value) continue;
    const next = (candidate + delta) & 255;
    const first = result === undefined;
    cpu.n = first || cpu.n === ((next & 128) !== 0) ? (next & 128) !== 0 : null;
    cpu.z = first || cpu.z === (next === 0) ? next === 0 : null;
    result = result === undefined ? next : joinNesBytes(result, next);
  }
  return result ?? null;
};

/** Shift the bit proof itself, retaining the inserted zero or known carry. */
export const nesShift = (
  cpu: NesCpuState,
  value: NesByteValue,
  operation: "ASL" | "LSR" | "ROL" | "ROR",
): NesByteValue => {
  const carry = cpu.c;
  const mask = typeof value === "number" ? 255 : (value?.mask ?? 0);
  const bits = typeof value === "number" ? value : (value?.value ?? 0);
  const left = operation === "ASL" || operation === "ROL";
  const rotate = operation === "ROL" || operation === "ROR";
  const outgoing = left ? 128 : 1;
  cpu.c = (mask & outgoing) === 0 ? null : (bits & outgoing) !== 0;
  const inserted = left ? 1 : 128;
  const shiftedMask =
    ((left ? mask << 1 : mask >> 1) |
      (!rotate || carry !== null ? inserted : 0)) &
    255;
  const shiftedBits =
    ((left ? bits << 1 : bits >> 1) |
      (rotate && carry === true ? inserted : 0)) &
    255;
  const result =
    shiftedMask === 0
      ? null
      : shiftedMask === 255
        ? shiftedBits
        : { mask: shiftedMask, value: shiftedBits };
  setNesNz(cpu, result);
  return result;
};

/** Stable immediate operations; join possible masked inputs without guessing unknown bits. */
export const nesUnofficialImmediate = (
  cpu: NesCpuState,
  operand: number,
  operation: "ANC" | "ALR" | "AXS",
): void => {
  const destination = operation === "AXS" ? "x" : "a";
  const input = nesLogicByte(
    nesCpuByte(cpu, "a"),
    operation === "AXS" ? nesCpuByte(cpu, "x") : operand,
    "AND",
  );
  const mask = typeof input === "number" ? 255 : (input?.mask ?? 0),
    bits = typeof input === "number" ? input : (input?.value ?? 0);
  let first = true,
    proof: NesByteValue | undefined;
  for (let masked = bits; masked < 256; masked++) {
    if ((masked & mask) !== bits) continue;
    const result =
      operation === "AXS"
        ? (masked - operand) & 255
        : operation === "ALR"
          ? masked >> 1
          : masked;
    const carry =
      operation === "AXS"
        ? masked >= operand
        : (masked & (operation === "ANC" ? 128 : 1)) !== 0;
    proof = proof === undefined ? result : joinNesBytes(proof, result);
    cpu.c = first || cpu.c === carry ? carry : null;
    cpu.n =
      first || cpu.n === ((result & 128) !== 0) ? (result & 128) !== 0 : null;
    cpu.z = first || cpu.z === (result === 0) ? result === 0 : null;
    first = false;
  }
  setNesCpuByte(cpu, destination, proof ?? null);
};

export const nesStatusValue = (
  cpu: NesCpuState,
  breakFlag = true,
): { value: number | null; known_bits?: NesKnownBits | undefined } => {
  const flags = [cpu.c, cpu.z, cpu.i, cpu.d, breakFlag, true, cpu.v, cpu.n];
  let mask = 0,
    value = 0;
  for (const [bit, flag] of flags.entries()) {
    if (flag === null) continue;
    mask |= 1 << bit;
    if (flag) value |= 1 << bit;
  }
  return mask === 255
    ? { value }
    : { value: null, known_bits: { mask, value } };
};

export const setNesStatusValue = (
  cpu: NesCpuState,
  source: { value: number | null; known_bits?: NesKnownBits | undefined },
): void => {
  const mask = source.value === null ? (source.known_bits?.mask ?? 0) : 255;
  const value = source.value ?? source.known_bits?.value ?? 0;
  for (const [flag, bit] of [
    ["c", 0],
    ["z", 1],
    ["i", 2],
    ["d", 3],
    ["v", 6],
    ["n", 7],
  ] as const)
    cpu[flag] = (mask & (1 << bit)) === 0 ? null : (value & (1 << bit)) !== 0;
};

/** Derive the bits common to all independent operand candidates. */
export const nesLogicByte = (
  left: NesByteValue,
  value: NesByteValue,
  op: "AND" | "ORA" | "EOR",
): NesByteValue => {
  const aMask = typeof left === "number" ? 255 : (left?.mask ?? 0);
  const a = typeof left === "number" ? left : (left?.value ?? 0);
  const bMask = typeof value === "number" ? 255 : (value?.mask ?? 0);
  const b = typeof value === "number" ? value : (value?.value ?? 0);
  const mask =
    (op === "AND"
      ? (aMask & bMask) | (aMask & ~a) | (bMask & ~b)
      : op === "ORA"
        ? (aMask & bMask) | a | b
        : aMask & bMask) & 255;
  const bits = (op === "AND" ? a & b : op === "ORA" ? a | b : a ^ b) & mask;
  return nesByteProof(mask, bits);
};

export const nesLogic = (
  cpu: NesCpuState,
  value: NesByteValue,
  op: "AND" | "ORA" | "EOR",
): void => {
  const result = nesLogicByte(nesCpuByte(cpu, "a"), value, op);
  setNesCpuByte(cpu, "a", result);
  setNesNz(cpu, result);
};

/** Ricoh ARR has binary-only flag rules, including when D is set. */
export const nesArr = (cpu: NesCpuState, operand: number): void => {
  const accumulator = nesCpuByte(cpu, "a");
  const carry = cpu.c;
  let first = true;
  let proof: NesByteValue | undefined;
  const mask = typeof accumulator === "number" ? 255 : (accumulator?.mask ?? 0),
    bits =
      typeof accumulator === "number" ? accumulator : (accumulator?.value ?? 0);
  for (let a = bits; a < 256; a++) {
    if ((a & mask) !== bits) continue;
    const masked = a & operand;
    for (
      let c = carry === null ? 0 : Number(carry);
      c <= (carry === null ? 1 : Number(carry));
      c++
    ) {
      const result = (masked >> 1) | (c << 7);
      const nextCarry = (result & 64) !== 0;
      const overflow = ((result ^ (result << 1)) & 64) !== 0;
      proof = proof === undefined ? result : joinNesBytes(proof, result);
      cpu.c = first || cpu.c === nextCarry ? nextCarry : null;
      cpu.v = first || cpu.v === overflow ? overflow : null;
      cpu.n = first || cpu.n === (c !== 0) ? c !== 0 : null;
      cpu.z = first || cpu.z === (result === 0) ? result === 0 : null;
      first = false;
    }
  }
  setNesCpuByte(cpu, "a", proof ?? null);
};
