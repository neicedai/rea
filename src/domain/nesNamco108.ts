import { z } from "zod";
import type { NesRomMetadata } from "./nes.js";
import { nesByteValueSchema } from "./nesByteValue.js";
import { writeNesSelectedBank } from "./nesBankRegisters.js";
import type { NesMapperWrite, NesMapperTraceStep } from "./nesMapperTrace.js";

const registers = {
  bank_select: nesByteValueSchema
    .default(null)
    .describe(
      "Raw even 8000–9FFF write. Only D2:D0 select R0..R7; higher bits never select PRG/CHR modes.",
    ),
  banks: z
    .array(nesByteValueSchema)
    .length(8)
    .default([null, null, null, null, null, null, null, null])
    .describe(
      "Raw R0..R7 bytes. Mapper 76 maps four 2 KiB CHR windows through R2..R5; its retained R0/R1 have no window. R6/R7 select the lower two 8 KiB PRG windows.",
    ),
};
export const nesNamco108StateSchema = z.union([
  z.strictObject({ mapper: z.literal(76), ...registers }),
  z.strictObject({ mapper: z.literal(206), ...registers }),
]);
export type NesNamco108State = z.infer<typeof nesNamco108StateSchema>;
export const isNamco108State = (state: {
  mapper: number;
}): state is NesNamco108State => state.mapper === 76 || state.mapper === 206;

/** The caller owns the clone; retain complete bus bytes before projecting wiring. */
export const applyNamco108Write = (
  state: NesNamco108State,
  write: NesMapperWrite,
): { state: NesNamco108State; effect: NesMapperTraceStep["effect"] } => {
  if (write.address < 0x8000 || write.address >= 0xa000)
    return { state, effect: "outside-mapper" };
  const byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  if ((write.address & 1) === 0) {
    state.bank_select = byte;
    return { state, effect: "bank-select" };
  }
  state.banks = writeNesSelectedBank(state.banks, state.bank_select, byte);
  return { state, effect: "bank-data" };
};

/** NES 2.0 submapper 1 wires CPU A13/A14 directly to a fixed 32 KiB PRG ROM. */
export const namco108HasFixedPrg = (header: NesRomMetadata): boolean =>
  header.mapper === 206 && header.submapper === 1;

export const namco108Limitations =
  "Namco 108 / DxROM uses fixed PRG/CHR modes, header mirroring and no IRQ or PRG RAM. Submapper 1 fixes 32 KiB PRG. CPU bus decoding covers 8000–9FFF only; chip-specific spurious writes while executing from 8000–9FFF and writing internal RAM are not simulated. Clone decoders and electrical timing are unverified.";

export const namco109Limitations =
  "Mapper 76 uses the documented Namco 109 / 3446 wiring: two switchable 8 KiB PRG windows plus the fixed final pair, and four independent 2 KiB CHR ROM windows through R2..R5. PRG has four selector bits up to 128 KiB; CHR has six selector bits up to 128 KiB. R0/R1 and unused selector/data high bits remain raw evidence without adding windows or modes. Header H/V mirroring is hardwired; no PRG RAM, IRQ, four-screen storage or nonzero submapper is modeled. The documented Namco 109 profile is not affected by the Namco 108 spurious internal-RAM-write erratum; this does not qualify other 206 chips or clones. Power-on state, electrical timing and commercial-game behavior remain unverified.";
