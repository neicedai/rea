import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";
import type { NesMapperWrite, NesMapperTraceStep } from "./nesMapperTrace.js";

export const sunsoft3Limitations =
  "Sunsoft 3 uses one four-bit 16 KiB PRG selector and a fixed final PRG bank, four independent six-bit 2 KiB CHR ROM selectors, and E800 D1:D0 vertical/horizontal/one-screen-A/one-screen-B mirroring. F800 D4 is a separate output latch; no 512 KiB expansion wiring is inferred. Fantasy Zone II cartridge measurements establish x000 IRQ acknowledgement and no C800/D800 acknowledgement; the 8800 acknowledgement mask follows the modern mapper specification. C800 writes the current counter through a separately modeled high/low write phase, not a reload latch. Counter underflow and source write-then-subsequent-clock ordering are qualified derivations, not physical IRQ observations. External IRQ input, power-on/reset state and electrical timing are not modeled. One explicitly declared NES 2.0 8 KiB PRG RAM/NVRAM chip qualifies fixed 6000–7FFF wiring; the measured Fantasy Zone II cartridge lacks this storage and legacy RAM remains unknown. CHR RAM, four-screen wiring, Vs. System and other storage or clone wiring require separate profiles.";

export const nesSunsoft3StateSchema = z.strictObject({
  mapper: z.literal(67),
  prg_bank: nesByteValueSchema
    .default(null)
    .describe(
      "Raw F800 byte; D3:D0 select a 16 KiB PRG bank. D4 is retained as a separate unused output latch, not another PRG address bit.",
    ),
  chr_banks: z
    .array(nesByteValueSchema)
    .length(4)
    .default([null, null, null, null]),
  mirroring: nesByteValueSchema
    .default(null)
    .describe(
      "Raw E800 byte; D1:D0 select vertical, horizontal, one-screen A or one-screen B.",
    ),
  irq_control: nesByteValueSchema
    .default(null)
    .describe(
      "Raw D800 byte. D4 controls counting; every write resets the separate IRQ write phase to high without acknowledging IRQ.",
    ),
  irq_data: nesByteValueSchema
    .default(null)
    .describe(
      "Most recent raw C800 write. The separate IRQ owner applies it to the current counter's high/low half; this byte is not a reload latch.",
    ),
});
export type NesSunsoft3State = z.infer<typeof nesSunsoft3StateSchema>;
export const isSunsoft3State = (state: {
  mapper: number;
}): state is NesSunsoft3State => state.mapper === 67;

/** A11 clear acknowledges before the remaining A11-A14 register decode. */
export const sunsoft3Register = (address: number): number | null =>
  address < 0x8000
    ? null
    : (address & 0x8800) === 0x8000
      ? 0x8000
      : address & 0xf800;

/** The caller owns the clone; live IRQ counter, phase and line have a separate owner. */
export const applySunsoft3Write = (
  state: NesSunsoft3State,
  write: NesMapperWrite,
): { state: NesSunsoft3State; effect: NesMapperTraceStep["effect"] } => {
  const register = sunsoft3Register(write.address),
    byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  switch (register) {
    case 0x8000:
      return { state, effect: "irq-acknowledge" };
    case 0x8800:
    case 0x9800:
    case 0xa800:
    case 0xb800:
      state.chr_banks[(register - 0x8800) >> 12] = byte;
      return { state, effect: "chr-bank" };
    case 0xc800:
      state.irq_data = byte;
      return { state, effect: "irq-latch" };
    case 0xd800:
      state.irq_control = byte;
      return { state, effect: "irq-control" };
    case 0xe800:
      state.mirroring = byte;
      return { state, effect: "nametable" };
    case 0xf800:
      state.prg_bank = byte;
      return { state, effect: "prg-bank" };
    default:
      return { state, effect: "outside-mapper" };
  }
};
