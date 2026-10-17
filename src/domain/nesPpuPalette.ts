import { z } from "zod";
import {
  nesKnownBitsSchema,
  nesByteBits,
  nesByteProof,
  nesByteCandidates,
} from "./nesByteValue.js";
import { ppuSmall } from "./nesPpuAddress.js";
import { readNesPpuCell, ppuPaletteAddress } from "./nesPpuMemory.js";
import type { NesPpuState } from "./nesPpuState.js";

export const nesPpuPaletteAddresses = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 17, 18, 19, 21, 22, 23,
  25, 26, 27, 29, 30, 31,
] as const;
const paletteIndices = new Map<number, number>(
  nesPpuPaletteAddresses.map((address, index) => [address, index]),
);
export const nesPpuPaletteIndex = (address: number): number =>
  paletteIndices.get(ppuPaletteAddress(address))!;

export const nesPpuColorCodeSchema = z
  .union([
    z.number().int().min(0).max(63),
    nesKnownBitsSchema
      .safeExtend({
        mask: z.number().int().min(1).max(62),
        value: z.number().int().min(0).max(63),
      })
      .meta(nesKnownBitsSchema.meta() ?? {}),
  ])
  .nullable();
/** Raw palette facts and qualified grayscale codes share one physical memory owner. */
export const readNesPpuPaletteCell = (ppu: NesPpuState, address: number) => {
  const value = ppuSmall(readNesPpuCell(ppu, "palette", address).value, 63),
    grayscale = nesByteBits(ppu.mask, 1);
  let codeMask = 0n;
  for (const raw of nesByteCandidates(value)) {
    if (raw >= 64) continue;
    if (grayscale !== 1) codeMask |= 1n << BigInt(raw);
    if (grayscale !== 0) codeMask |= 1n << BigInt(raw & 48);
  }
  let first: number | null = null,
    common = 63;
  for (let candidate = 0; candidate < 64; candidate++)
    if (codeMask & (1n << BigInt(candidate))) {
      if (first === null) first = candidate;
      else common &= ~(first ^ candidate);
    }
  const code = ppuSmall(nesByteProof(common, first! & common), 63);
  return { address, value, code, code_mask: codeMask };
};
