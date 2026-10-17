import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";
import type { NesMapperWrite, NesMapperTraceStep } from "./nesMapperTrace.js";

export const nesVrc3StateSchema = z.strictObject({
  mapper: z.literal(73),
  prg_bank: nesByteValueSchema
    .default(null)
    .describe(
      "Raw F000 byte. D2:D0 select the lower 16 KiB PRG ROM window; ignored high bits remain source evidence.",
    ),
  irq_latch_nibbles: z
    .array(nesByteValueSchema)
    .length(4)
    .default([null, null, null, null])
    .describe(
      "Raw 8000/9000/A000/B000 bytes, ordered from the lowest to highest IRQ reload nibble. Only D3:D0 contribute to the separate IRQ latch; raw bytes are not preprojected into a counter.",
    ),
  irq_control: nesByteValueSchema
    .default(null)
    .describe(
      "Raw C000 control byte. D2 selects 8-bit or 16-bit counting, D1 controls effective enable and full-counter reload on this write, and D0 supplies enable on a later D000 acknowledgement. Effective enable and counter history belong to the separate IRQ model.",
    ),
});
export type NesVrc3State = z.infer<typeof nesVrc3StateSchema>;
export const isVrc3State = (state: { mapper: number }): state is NesVrc3State =>
  state.mapper === 73;

/** VRC3 decodes A12-A15; E000 has no register effect. */
export const vrc3Register = (address: number): number | null =>
  address < 0x8000 ? null : address & 0xf000;

/** The caller owns the clone; IRQ acknowledgement does not rewrite raw control. */
export const applyVrc3Write = (
  state: NesVrc3State,
  write: NesMapperWrite,
): { state: NesVrc3State; effect: NesMapperTraceStep["effect"] } => {
  const register = vrc3Register(write.address),
    byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  if (register !== null && register >= 0x8000 && register <= 0xb000) {
    state.irq_latch_nibbles[(register - 0x8000) >> 12] = byte;
    return { state, effect: "irq-latch" };
  }
  switch (register) {
    case 0xc000:
      state.irq_control = byte;
      return { state, effect: "irq-control" };
    case 0xd000:
      return { state, effect: "irq-acknowledge" };
    case 0xf000:
      state.prg_bank = byte;
      return { state, effect: "prg-bank" };
    default:
      return { state, effect: "outside-mapper" };
  }
};

export const vrc3Limitations =
  "Konami VRC3 / Mapper 73 uses one three-bit 16 KiB PRG selector and the fixed final PRG bank, fixed 8 KiB CHR RAM, and hardwired header H/V nametable routing without bus conflicts. Four low-nibble reload ports and C000 mode/enable/acknowledgement controls retain their complete raw bytes; D000 acknowledges through the separate effective IRQ owner without replacing raw control, and E000 is ignored. The IRQ profile increments a CPU-cycle counter in 8-bit or 16-bit mode; no VRC4/VRC6 scanline prescaler or expansion audio is inferred. One explicitly declared NES 2.0 8 KiB PRG RAM/NVRAM chip qualifies fixed 6000–7FFF wiring; legacy storage remains unknown. CHR ROM, other RAM capacities, four-screen storage, nonzero submappers and clone wiring require separate profiles. Initial state, electrical timing and commercial-game compatibility are not observed by this conditional model.";
