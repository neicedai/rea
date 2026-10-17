import { nesByteBits } from "./nesByteValue.js";
import type { NesLatchMapperState, NesMapperWrite } from "./nesMapperTrace.js";

/** Apply to an owned register snapshot; the PRG/CHR selectors ignore unconnected data bits. */
export const applyNesLatchWrite = (
  state: NesLatchMapperState,
  write: NesMapperWrite,
): {
  state: NesLatchMapperState;
  effect: "outside-mapper" | "prg-bank" | "chr-bank" | "nametable";
} => {
  const register = write.address & 0xf000;
  const value =
    write.value ?? ("known_bits" in write ? write.known_bits : null);
  if (register === 0xa000) {
    state.prg_bank = nesByteBits(value, 15);
    return { state, effect: "prg-bank" };
  }
  const field = (
    {
      0xb000: "chr_fd_0",
      0xc000: "chr_fe_0",
      0xd000: "chr_fd_1",
      0xe000: "chr_fe_1",
    } as const
  )[register as 0xb000 | 0xc000 | 0xd000 | 0xe000];
  if (field !== undefined) {
    state[field] = nesByteBits(value, 31);
    return { state, effect: "chr-bank" };
  }
  if (register === 0xf000) {
    state.mirroring = nesByteBits(value, 1) as 0 | 1 | null;
    return { state, effect: "nametable" };
  }
  return { state, effect: "outside-mapper" };
};

/** The triggering PPU read uses the previous bank; only subsequent reads see this state. */
export const latchAfterPpuRead = (
  previous: NesLatchMapperState,
  address: number,
): NesLatchMapperState => {
  const state = { ...previous };
  const low = state.mapper === 9 ? address : address & 0xfff8;
  if (low === 0x0fd8) state.latch_0 = "fd";
  if (low === 0x0fe8) state.latch_0 = "fe";
  const high = address & 0xfff8;
  if (high === 0x1fd8) state.latch_1 = "fd";
  if (high === 0x1fe8) state.latch_1 = "fe";
  return state;
};
