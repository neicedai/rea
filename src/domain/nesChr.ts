import {
  nesByteBits,
  nesTwoBitProof,
  type NesByteValue,
  type NesTwoBitValue,
} from "./nesByteValue.js";

/** Decode the two plane bits of one physical source before joining alternatives. */
export const decodeNesChrPixel = (
  low: NesByteValue | undefined,
  high: NesByteValue | undefined,
  bit: number,
): NesTwoBitValue => {
  const lo = nesByteBits(low, bit),
    hi = nesByteBits(high, bit),
    mask = lo === null ? (hi === null ? 0 : 2) : hi === null ? 1 : 3,
    value = (lo ? 1 : 0) | (hi ? 2 : 0);
  return nesTwoBitProof(mask, value);
};

/** A NES tile has eight low-plane rows followed by eight high-plane rows, MSB left. */
export function decodeNesChrTile(bytes: readonly number[]): number[][];
export function decodeNesChrTile(
  bytes: readonly NesByteValue[],
): NesTwoBitValue[][];
export function decodeNesChrTile(
  bytes: readonly NesByteValue[],
): NesTwoBitValue[][] {
  if (bytes.length !== 16) throw new RangeError("A NES tile requires 16 bytes");
  return Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 8 }, (_, x) =>
      decodeNesChrPixel(bytes[row], bytes[row + 8], 1 << (7 - x)),
    ),
  );
}
