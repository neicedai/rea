import { z } from "zod";
import {
  nesByteBits,
  nesByteCandidates,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesMapperWrite, NesMapperTraceStep } from "./nesMapperTrace.js";

export const h3001Limitations =
  "Irem H3001 uses two six-bit PRG selectors, 9000 D7 PRG-window swapping, eight independent 1 KiB CHR selectors and 9001 D6-priority vertical/horizontal/one-screen-A mirroring. C000 is not a bank register. No power-on or reset selector state is inferred. One explicitly declared NES 2.0 8 KiB PRG RAM/NVRAM chip uses fixed 6000–7FFF wiring; legacy RAM remains unknown. IRQ timing requires its separate explicit counter model. zero_behavior wrap/pause/assert selects a reference assumption; omission joins those possibilities. Zero-start and terminal IRQ behavior have no physical-hardware verification in this project. Other storage, clone wiring and electrical timing remain unverified.";

export const nesH3001StateSchema = z.strictObject({
  mapper: z.literal(65),
  control: nesByteValueSchema
    .default(null)
    .describe(
      "Raw 9000 byte; D7 swaps the selected and fixed second-last PRG windows.",
    ),
  mirroring: nesByteValueSchema
    .default(null)
    .describe(
      "Raw 9001 byte; D6 selects one-screen A, otherwise D7 selects horizontal or vertical.",
    ),
  prg_banks: z.array(nesByteValueSchema).length(2).default([null, null]),
  chr_banks: z
    .array(nesByteValueSchema)
    .length(8)
    .default([null, null, null, null, null, null, null, null]),
  irq_control: nesByteValueSchema.default(null),
  irq_low: nesByteValueSchema.default(null),
  irq_high: nesByteValueSchema.default(null),
});
export type NesH3001State = z.infer<typeof nesH3001StateSchema>;
export const isH3001State = (state: {
  mapper: number;
}): state is NesH3001State => state.mapper === 65;

/** Only A0-A2 and A12-A15 decode; the two PRG registers ignore A0-A2. */
export const h3001Register = (address: number): number | null => {
  if (address < 0x8000) return null;
  const page = address & 0xf000;
  return page === 0x8000 || page === 0xa000 ? page : address & 0xf007;
};

/** The caller owns the cloned mapper; IRQ counter/line state has a separate owner. */
export const applyH3001Write = (
  state: NesH3001State,
  write: NesMapperWrite,
): { state: NesH3001State; effect: NesMapperTraceStep["effect"] } => {
  const register = h3001Register(write.address),
    byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  switch (register) {
    case 0x8000:
    case 0xa000:
      state.prg_banks[register === 0x8000 ? 0 : 1] = byte;
      return { state, effect: "prg-bank" };
    case 0x9000:
      state.control = byte;
      return { state, effect: "register-commit" };
    case 0x9001:
      state.mirroring = byte;
      return { state, effect: "nametable" };
    case 0x9003:
      state.irq_control = byte;
      return { state, effect: "irq-control" };
    case 0x9004:
      return { state, effect: "irq-reload" };
    case 0x9005:
      state.irq_high = byte;
      return { state, effect: "irq-latch" };
    case 0x9006:
      state.irq_low = byte;
      return { state, effect: "irq-latch" };
    default:
      if (register !== null && register >= 0xb000 && register <= 0xb007) {
        state.chr_banks[register & 7] = byte;
        return { state, effect: "chr-bank" };
      }
      return { state, effect: "outside-mapper" };
  }
};

export const h3001Mirroring = (
  value: NesByteValue,
): "vertical" | "horizontal" | "one-screen-a" | "unknown" => {
  const single = nesByteBits(value, 64);
  if (single === 64) return "one-screen-a";
  const horizontal = nesByteBits(value, 128);
  return single === null || horizontal === null
    ? "unknown"
    : horizontal === 0
      ? "vertical"
      : "horizontal";
};

/** Project only physically possible CIRAM pages; this chip never selects single B. */
export const h3001NametablePages = (
  value: NesByteValue,
  page: number,
): number[] =>
  [
    ...new Set(
      nesByteCandidates(value).map((byte) =>
        byte & 64 ? 0 : byte & 128 ? page >> 1 : page & 1,
      ),
    ),
  ].sort((a, b) => a - b);
