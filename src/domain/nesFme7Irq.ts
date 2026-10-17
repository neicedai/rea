import { z } from "zod";
import {
  nesByteValueSchema,
  nesByteBits,
  joinNesBytes,
} from "./nesByteValue.js";
import { decrementNesWord } from "./nesWordCounter.js";
import { fme7Commands, type NesFme7State } from "./nesFme7.js";
import type { NesMapperWrite } from "./nesMapperTrace.js";

export const nesFme7IrqStateSchema = z.strictObject({
  model: z.literal("fme7"),
  counter_low: nesByteValueSchema.default(null),
  counter_high: nesByteValueSchema.default(null),
  asserted: z.boolean().nullable().default(null),
});
export type NesFme7IrqState = z.infer<typeof nesFme7IrqStateSchema>;
export const isFme7IrqState = (
  state: { model: string } | null,
): state is NesFme7IrqState => state?.model === "fme7";
export const writeFme7Irq = (
  previous: NesFme7IrqState,
  state: NesFme7State,
  write: NesMapperWrite,
): NesFme7IrqState => {
  if ((write.address & 0xe000) !== 0xa000) return { ...previous };
  const byte = write.value ?? ("known_bits" in write ? write.known_bits : null),
    variants = fme7Commands(state.command).map((cmd) => ({
      ...previous,
      ...(cmd === 13
        ? { asserted: false }
        : cmd === 14
          ? { counter_low: byte }
          : cmd === 15
            ? { counter_high: byte }
            : {}),
    }));
  return variants.reduce(
    (v, s) => ({
      ...v,
      counter_low: joinNesBytes(v.counter_low, s.counter_low),
      counter_high: joinNesBytes(v.counter_high, s.counter_high),
      asserted: v.asserted === s.asserted ? v.asserted : null,
    }),
    variants[0]!,
  );
};
export const clockFme7CpuCycle = (
  previous: NesFme7IrqState,
  state: NesFme7State,
): { state: NesFme7IrqState; clock: boolean | null } => {
  const count = nesByteBits(state.irq_control, 128),
    irq = nesByteBits(state.irq_control, 1);
  if (count === 0) return { state: { ...previous }, clock: false };
  const next = decrementNesWord(previous.counter_low, previous.counter_high),
    triggered =
      next.underflow === false || irq === 0
        ? false
        : next.underflow === true && irq === 1
          ? true
          : null;
  const asserted =
    previous.asserted === true || triggered === true
      ? true
      : previous.asserted === false && triggered === false
        ? false
        : null;
  return {
    clock: count === null ? null : true,
    state: {
      ...previous,
      counter_low:
        count === null
          ? joinNesBytes(previous.counter_low, next.counter_low)
          : next.counter_low,
      counter_high:
        count === null
          ? joinNesBytes(previous.counter_high, next.counter_high)
          : next.counter_high,
      asserted:
        count === null && previous.asserted !== asserted ? null : asserted,
    },
  };
};
