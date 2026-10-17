import { nesByteCandidates } from "./nesByteValue.js";
import type { NesSunsoft4State } from "./nesSunsoft4.js";

export type NesSunsoft4NametableCandidate = {
  source: "ciram" | "chr-rom";
  bank: number;
};

/** One electrical mux projection, shared by mapper windows and PPU byte owners. */
export const sunsoft4NametableCandidates = (
  state: NesSunsoft4State,
  page: number,
  chrCapacityBytes: number,
): NesSunsoft4NametableCandidate[] => {
  const modes = new Set(
      nesByteCandidates(state.control).map((byte) => byte & 19),
    ),
    mask = chrCapacityBytes / 1024 - 1,
    registers = state.nametable_banks.map((raw) => [
      ...new Set(nesByteCandidates(raw).map((byte) => (byte | 128) & mask)),
    ]),
    candidates = new Map<string, NesSunsoft4NametableCandidate>();
  for (const mode of modes) {
    const slot =
      (mode & 3) === 0
        ? page & 1
        : (mode & 3) === 1
          ? page >> 1
          : (mode & 3) - 2;
    if ((mode & 16) === 0)
      candidates.set(`ciram:${slot}`, { source: "ciram", bank: slot });
    else
      for (const bank of registers[slot]!)
        candidates.set(`rom:${bank}`, { source: "chr-rom", bank });
  }
  return [...candidates.values()].sort((left, right) =>
    left.source === right.source
      ? left.bank - right.bank
      : left.source === "ciram"
        ? -1
        : 1,
  );
};
