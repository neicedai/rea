import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import { nesByteBits } from "./nesByteValue.js";

/** Join physical sources across possible modes without requiring ignored serial bits. */
export const mmc1PrgBanks = (
  state: Extract<NesMapperState, { mapper: 1 }>,
  count: number,
): (number | null)[] => {
  const selected = nesByteBits(state.prg_bank, (count - 1) & 15);
  const paired = nesByteBits(state.prg_bank, (count - 1) & 14);
  const modes = state.prg_mode === null ? [0, 2, 3] : [state.prg_mode];
  const alternatives = modes.map((mode) =>
    mode < 2
      ? paired === null
        ? [null, null]
        : [paired, paired + 1]
      : mode === 2
        ? [0, selected]
        : [selected, count - 1],
  );
  return [0, 1].map((index) => {
    const first = alternatives[0]![index]!;
    return alternatives.every((banks) => banks[index] === first) ? first : null;
  });
};

/** The repurposed CHR A16 output selects one 256 KiB PRG half. */
export const mmc1OuterBank = (
  state: Extract<NesMapperState, { mapper: 1 }>,
): 0 | 1 | null => {
  const output = (value: Mmc1["chr_bank_0"]): 0 | 1 | null => {
    const bit = nesByteBits(value, 16);
    return bit === null ? null : bit === 0 ? 0 : 1;
  };
  const first = output(state.chr_bank_0);
  const second = output(state.chr_bank_1);
  return state.chr_mode === 0 ? first : first === second ? first : null;
};

type Mmc1 = Extract<NesMapperState, { mapper: 1 }>;

/** Join the 4/8 KiB mux at physical address bits, after ignored bits are removed. */
export const mmc1ChrBanks = (state: Mmc1, count: number): (number | null)[] => {
  const mask = (count - 1) & 31;
  const first = nesByteBits(state.chr_bank_0, mask);
  const second = nesByteBits(state.chr_bank_1, mask);
  const paired = nesByteBits(state.chr_bank_0, mask & ~1);
  const eight = [paired, paired === null ? null : paired + 1];
  const four = [first, second];
  if (state.chr_mode !== null) return state.chr_mode === 0 ? eight : four;
  return eight.map((bank, index) => (bank === four[index] ? bank : null));
};

/** NES 2.0 explicitly identifies a CPU-wired, unbanked 32 KiB PRG ROM. */
export const mmc1HasFixedPrg = (header: NesRomMetadata): boolean =>
  header.mapper === 1 && header.submapper === 5;
