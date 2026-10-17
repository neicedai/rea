import {
  nesByteBits,
  nesByteCandidates,
  nesByteProof,
  joinNesBytes,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesPpuRegisters } from "./nesPpuState.js";

export const ppuBits = (value: NesByteValue) =>
  typeof value === "number"
    ? { mask: 255, value }
    : (value ?? { mask: 0, value: 0 });
export const ppuSmall = (value: NesByteValue, mask: number): NesByteValue => {
  const proof = ppuBits(value),
    known = proof.mask & mask;
  return known === 0
    ? null
    : known === mask
      ? proof.value & mask
      : { mask: known, value: proof.value & known };
};
export const ppuReplace = (
  old: NesByteValue,
  mask: number,
  source: NesByteValue,
  shift = 0,
): NesByteValue => {
  const before = ppuBits(old),
    bits = ppuBits(source);
  return nesByteProof(
    (before.mask & ~mask) |
      ((shift < 0 ? bits.mask >> -shift : bits.mask << shift) & mask),
    (before.value & ~mask) |
      ((shift < 0 ? bits.value >> -shift : bits.value << shift) & mask),
  );
};
export const ppuBusAddress = (value: NesPpuRegisters["v"]): number | null => {
  const low = nesByteBits(value.low, 255),
    high = nesByteBits(value.high, 63);
  return low === null || high === null ? null : (high << 8) | low;
};
export const ppuIncrement = (
  value: NesPpuRegisters["v"],
  control: NesByteValue,
): NesPpuRegisters["v"] => {
  const increments =
    nesByteBits(control, 4) === null
      ? [1, 32]
      : nesByteBits(control, 4) === 0
        ? [1]
        : [32];
  const lows: NesByteValue[] = [],
    highs: NesByteValue[] = [];
  for (const amount of increments) {
    const lowCandidates = nesByteCandidates(value.low),
      carries = new Set<number>();
    for (const low of lowCandidates) {
      lows.push((low + amount) & 255);
      carries.add(low + amount > 255 ? 1 : 0);
    }
    for (const high of new Set(
      nesByteCandidates(value.high).map((n) => n & 127),
    ))
      for (const carry of carries) highs.push((high + carry) & 127);
  }
  return {
    low: lows.reduce(joinNesBytes),
    high: ppuSmall(highs.reduce(joinNesBytes), 127),
  };
};
