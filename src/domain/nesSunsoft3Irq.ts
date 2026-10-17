import { z } from "zod";
import {
  joinNesBytes,
  nesByteBits,
  nesByteValueSchema,
} from "./nesByteValue.js";
import { sunsoft3Register, type NesSunsoft3State } from "./nesSunsoft3.js";
import { decrementNesWord } from "./nesWordCounter.js";
import type { NesMapperWrite } from "./nesMapperTrace.js";

export const nesSunsoft3IrqStateSchema = z
  .strictObject({
    model: z.literal("sunsoft3"),
    counter_low: nesByteValueSchema.default(null),
    counter_high: nesByteValueSchema.default(null),
    next_write: z
      .enum(["high", "low"])
      .nullable()
      .default(null)
      .describe(
        "The next C800 write selects this live counter byte, then flips the phase. Any D800 write selects high next. Omission preserves unknown history rather than assuming power-on phase.",
      ),
    enabled: z
      .boolean()
      .nullable()
      .default(null)
      .describe(
        "Effective countdown enable, independently qualified initially. D800 D4 updates it; old-zero underflow disables it. Later clocks never revive it from the retained raw control byte.",
      ),
    asserted: z.boolean().nullable().default(null),
  })
  .describe(
    "Qualified Sunsoft-3 internal counter IRQ with the external IRQ input inactive. Enabled CPU edges decrement the live 16-bit counter; old 0000 underflows to FFFF, asserts and disables. C800 alternates high/low live writes without acknowledgement; D800 updates enable and resets write phase without acknowledgement. Writes matching (address & 8800) == 8000 only acknowledge the internal IRQ. Initial state, analog M2 ordering, external IRQ input and physical CPU interrupt acceptance are not inferred.",
  );
export type NesSunsoft3IrqState = z.infer<typeof nesSunsoft3IrqStateSchema>;
export const isSunsoft3IrqState = (
  state: { model: string } | null,
): state is NesSunsoft3IrqState => state?.model === "sunsoft3";

export const admitSunsoft3Irq = (
  irq: NesSunsoft3IrqState,
  mapper: NesSunsoft3State,
): string | null =>
  nesByteBits(mapper.irq_control, 16) === 0 && irq.enabled === true
    ? "Sunsoft-3 effective enable contradicts the retained disabled D800 D4."
    : null;

export const writeSunsoft3Irq = (
  previous: NesSunsoft3IrqState,
  write: NesMapperWrite,
): NesSunsoft3IrqState => {
  const register = sunsoft3Register(write.address),
    byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  if (register === 0x8000) return { ...previous, asserted: false };
  if (register === 0xd800) {
    const enabled = nesByteBits(byte, 16);
    return {
      ...previous,
      next_write: "high",
      enabled: enabled === null ? null : enabled !== 0,
    };
  }
  if (register !== 0xc800) return { ...previous };
  if (previous.next_write === null)
    return {
      ...previous,
      counter_low: joinNesBytes(previous.counter_low, byte),
      counter_high: joinNesBytes(previous.counter_high, byte),
    };
  return {
    ...previous,
    ...(previous.next_write === "high"
      ? { counter_high: structuredClone(byte), next_write: "low" }
      : { counter_low: structuredClone(byte), next_write: "high" }),
  };
};

/** Old-zero underflow is distinct from H3001's nonzero 1-to-0 terminal edge. */
export const clockSunsoft3CpuCycle = (
  previous: NesSunsoft3IrqState,
): { state: NesSunsoft3IrqState; clock: boolean | null } => {
  if (previous.enabled === false)
    return { state: { ...previous }, clock: false };
  const { counter_low, counter_high, underflow } = decrementNesWord(
      previous.counter_low,
      previous.counter_high,
    ),
    enabled = underflow === null ? null : !underflow,
    asserted =
      previous.asserted === true || underflow === true
        ? true
        : previous.asserted === false && underflow === false
          ? false
          : null;
  return {
    clock: previous.enabled === null ? null : true,
    state: {
      ...previous,
      counter_low:
        previous.enabled === null
          ? joinNesBytes(previous.counter_low, counter_low)
          : counter_low,
      counter_high:
        previous.enabled === null
          ? joinNesBytes(previous.counter_high, counter_high)
          : counter_high,
      enabled: previous.enabled === null && enabled !== false ? null : enabled,
      asserted:
        previous.enabled === null && previous.asserted !== asserted
          ? null
          : asserted,
    },
  };
};
