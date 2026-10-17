import { z } from "zod";
import {
  nesByteBits,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesMapperWrite, NesMapperTraceStep } from "./nesMapperTrace.js";

export const j87Limitations =
  "Mapper 87 uses a raw CHR latch written at 6000–7FFF without PRG-ROM bus conflicts. CPU D0 drives CHR bank bit 1 and D1 drives bank bit 0; only connected CHR ROM address lines affect the selected 8 KiB bank. PRG ROM is fixed at 16 or 32 KiB, with the 16 KiB image mirrored at C000. Header H/V mirroring is fixed. No PRG RAM, IRQ, power-on CHR selector, CHR RAM, four-screen or clone wiring is inferred.";

export const nesJ87StateSchema = z.strictObject({
  mapper: z.literal(87),
  chr_bank: nesByteValueSchema
    .default(null)
    .describe(
      "Raw 6000–7FFF CHR latch byte. D0 selects bank bit 1 and D1 selects bank bit 0; omitted bits remain unknown and disconnected outputs are masked only at physical mapping.",
    ),
});
export type NesJ87State = z.infer<typeof nesJ87StateSchema>;
export const isJ87State = (state: { mapper: number }): state is NesJ87State =>
  state.mapper === 87;

export const j87ChrBank = (
  raw: NesByteValue,
  physicalMask: number,
): number | null => {
  const mask = physicalMask & 3,
    byte = nesByteBits(raw, ((mask & 1) << 1) | ((mask & 2) >> 1));
  return byte === null ? null : (((byte & 1) << 1) | ((byte & 2) >> 1)) & mask;
};

/** This board latches below PRG ROM, so ROM bytes never participate in a write. */
export const applyJ87Write = (
  state: NesJ87State,
  write: NesMapperWrite,
): { state: NesJ87State; effect: NesMapperTraceStep["effect"] } => {
  if (write.address < 0x6000 || write.address > 0x7fff)
    return { state, effect: "outside-mapper" };
  state.chr_bank =
    write.value ?? ("known_bits" in write ? write.known_bits : null);
  return { state, effect: "chr-bank" };
};
