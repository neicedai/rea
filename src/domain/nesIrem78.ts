import { z } from "zod";
import {
  nesByteBits,
  nesByteCandidates,
  andNesBytes,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperWrite, NesMapperTraceStep } from "./nesMapperTrace.js";

export const nesIrem78VariantSchema = z.enum(["cosmo-carrier", "holy-diver"]);
export type NesIrem78Variant = z.infer<typeof nesIrem78VariantSchema>;
export const nesIrem78StateSchema = z.strictObject({
  mapper: z.literal(78),
  variant: nesIrem78VariantSchema.describe(
    "Immutable board qualification: Cosmo Carrier uses D3 single-screen A/B; Holy Diver uses D3 horizontal/vertical. Legacy/submapper-0 headers need an explicit choice; NES 2.0 submappers 1/3 respectively identify these boards.",
  ),
  latch: nesByteValueSchema
    .default(null)
    .describe(
      "Complete or partial byte actually latched after CPU data AND the pre-write mapped PRG-ROM bus proof. D2:D0 select lower 16 KiB PRG, D3 selects board-specific CIRAM routing, and D7:D4 select 8 KiB CHR ROM. Initial latch facts are caller assumptions; no reset value or pre-conflict CPU byte is substituted.",
    ),
});
export type NesIrem78State = z.infer<typeof nesIrem78StateSchema>;
export const isIrem78State = (state: {
  mapper: number;
}): state is NesIrem78State => state.mapper === 78;

/** Board qualification does not reinterpret the source header's mirroring flags. */
export const irem78Board = (
  header: Pick<NesRomMetadata, "mapper" | "submapper">,
  selected?: NesIrem78Variant,
): NesIrem78Variant | null => {
  if (header.mapper !== 78) return null;
  if (header.submapper === null || header.submapper === 0)
    return selected ?? null;
  const declared =
    header.submapper === 1
      ? "cosmo-carrier"
      : header.submapper === 3
        ? "holy-diver"
        : null;
  return selected === undefined || selected === declared ? declared : null;
};

/** The caller supplies a pre-write ROM proof and owns the cloned mapper state. */
export const applyIrem78Write = (
  state: NesIrem78State,
  write: NesMapperWrite,
  rom: NesByteValue,
): { state: NesIrem78State; effect: NesMapperTraceStep["effect"] } => {
  if (write.address < 0x8000 || write.address > 0xffff)
    return { state, effect: "outside-mapper" };
  state.latch = andNesBytes(
    write.value ?? ("known_bits" in write ? write.known_bits : null),
    rom,
  );
  return { state, effect: "prg-chr-bank" };
};

/** Resolve only the connected PRG address lines, retaining every compatible bank. */
export const irem78PrgCandidates = (
  state: NesIrem78State,
  prgBankCount: number,
): number[] =>
  [
    ...new Set(
      nesByteCandidates(state.latch).map(
        (byte) => byte & ((prgBankCount - 1) & 7),
      ),
    ),
  ].sort((left, right) => left - right);

export const irem78Mirroring = (
  state: NesIrem78State,
): "horizontal" | "vertical" | "one-screen-a" | "one-screen-b" | "unknown" => {
  const bit = nesByteBits(state.latch, 8);
  if (bit === null) return "unknown";
  return state.variant === "cosmo-carrier"
    ? bit === 0
      ? "one-screen-a"
      : "one-screen-b"
    : bit === 0
      ? "horizontal"
      : "vertical";
};

/** Holy Diver's first/last logical pages stay determined under unknown D3. */
export const irem78NametablePages = (
  state: NesIrem78State,
  page: number,
): number[] => {
  const bit = nesByteBits(state.latch, 8),
    modes = bit === null ? [0, 1] : [bit === 0 ? 0 : 1];
  return [
    ...new Set(
      modes.map((mode) =>
        state.variant === "cosmo-carrier"
          ? mode
          : mode === 0
            ? page >> 1
            : page & 1,
      ),
    ),
  ].sort((left, right) => left - right);
};

export const irem78Limitations =
  "Mapper 78 qualifies either Cosmo Carrier (D3=0 single-screen A, D3=1 B) or Holy Diver (D3=0 horizontal, D3=1 vertical) as an immutable board choice. Both use a shared eight-bit latch with D2:D0 lower 16 KiB PRG selection, the fixed final PRG bank and D7:D4 8 KiB CHR ROM selection, with at most 128 KiB PRG and 128 KiB CHR ROM. Writes at 8000–FFFF latch CPU data AND the pre-write mapped ROM proof; partial and unknown bus facts remain explicit. NES 2.0 submappers 1/3 identify the boards; legacy/submapper 0 requires a caller choice. The historical legacy four-screen flag is retained as a header observation, not extra nametable storage or reliable board identity. No PRG RAM, CHR RAM, IRQ, reset latch value, electrical timing or commercial-game compatibility is inferred. Deprecated submapper 2, other explicit storage, actual four-screen and clone wiring require separate profiles.";
