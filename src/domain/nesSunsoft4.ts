import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";
import type { NesMapperWrite, NesMapperTraceStep } from "./nesMapperTrace.js";

export const nesSunsoft4StateSchema = z.strictObject({
  mapper: z.literal(68),
  variant: z
    .literal("normal")
    .describe(
      "Immutable normal Sunsoft-4 board qualification. NES 2.0 submapper 0 selects this profile; it never overrides explicit Dual Cartridge System submapper 1. Legacy headers at or below 128 KiB PRG require this explicit board choice.",
    ),
  prg_bank: nesByteValueSchema
    .default(null)
    .describe(
      "Raw F000 byte. D3:D0 select lower 16 KiB PRG ROM; D4 gates a separately qualified 8 KiB PRG RAM chip. Remaining bits are retained without adding address lines or an external cartridge.",
    ),
  chr_banks: z
    .array(nesByteValueSchema)
    .length(4)
    .default([null, null, null, null])
    .describe(
      "Raw 8000/9000/A000/B000 bytes for four independent 2 KiB pattern windows. D6:D0 select banks; ignored high bits remain source evidence.",
    ),
  nametable_banks: z
    .array(nesByteValueSchema)
    .length(2)
    .default([null, null])
    .describe(
      "Raw C000/D000 bytes for the low/high nametable selectors. ROM nametable mode projects D6:D0 and forces selector bit 7 high, then masks the actual CHR address lines. Raw bytes are not preprojected.",
    ),
  control: nesByteValueSchema
    .default(null)
    .describe(
      "Raw E000 byte. D4 selects CIRAM (0) or CHR-ROM (1) nametables; D1:D0 select vertical, horizontal, one-screen A or one-screen B in either source mode.",
    ),
});
export type NesSunsoft4State = z.infer<typeof nesSunsoft4StateSchema>;
export const isSunsoft4State = (state: {
  mapper: number;
}): state is NesSunsoft4State => state.mapper === 68;

/** Normal Sunsoft-4 decodes only the CPU's upper four address bits. */
export const sunsoft4Register = (address: number): number | null =>
  address < 0x8000 ? null : address & 0xf000;

/** The caller owns the clone; mapping owners project the preserved raw bus byte. */
export const applySunsoft4Write = (
  state: NesSunsoft4State,
  write: NesMapperWrite,
): { state: NesSunsoft4State; effect: NesMapperTraceStep["effect"] } => {
  const register = sunsoft4Register(write.address),
    byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  if (register === null) return { state, effect: "outside-mapper" };
  if (register < 0xc000) {
    state.chr_banks[(register - 0x8000) >> 12] = byte;
    return { state, effect: "chr-bank" };
  }
  if (register < 0xe000) {
    state.nametable_banks[(register - 0xc000) >> 12] = byte;
    return { state, effect: "nametable" };
  }
  if (register === 0xe000) {
    state.control = byte;
    return { state, effect: "nametable" };
  }
  state.prg_bank = byte;
  return { state, effect: "prg-bank" };
};

export const sunsoft4Limitations =
  "Normal Sunsoft-4 / Mapper 68 uses one four-bit 16 KiB PRG selector and the fixed final internal PRG bank, with four seven-bit 2 KiB CHR ROM selectors. C000/D000 select 1 KiB ROM nametables by forcing selector bit 7 high before masking actual CHR address lines; E000 D4 switches between CIRAM and ROM, and D1:D0 select vertical/horizontal/one-screen A/B routing in either mode. F000 D4 gates one explicitly qualified 8 KiB PRG RAM/NVRAM chip; legacy storage remains unknown. NES 2.0 submapper 0 qualifies the normal board. Legacy PRG at or below 128 KiB requires an explicit normal choice, since size does not identify Dual Cartridge System wiring. Submapper 1, external option ROM, licensing timers, CHR RAM, four-screen storage and clone wiring require separate models. No IRQ, power-on register values, physical bus timing or commercial-game compatibility is inferred.";
