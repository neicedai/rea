import { z } from "zod";
import {
  joinNesBytes,
  nesByteBits,
  nesByteValueSchema,
} from "./nesByteValue.js";
import { decrementNesWord } from "./nesWordCounter.js";
import type { NesBandaiState } from "./nesBandai.js";
import type { NesMapperWrite, NesMapperTraceStep } from "./nesMapperTrace.js";

/** Two byte proofs avoid expanding a 16-bit mask into huge advertised enum tables. */
export const nesBandaiIrqStateSchema = z.strictObject({
  model: z
    .enum(["bandai-fcg", "bandai-lz93d50"])
    .describe(
      "Explicit conventional Bandai counter calculation, not observed physical silicon timing or CPU interrupt acceptance.",
    ),
  counter_low: nesByteValueSchema.default(null),
  counter_high: nesByteValueSchema.default(null),
  asserted: z.boolean().nullable().default(null),
});
export type NesBandaiIrqState = z.infer<typeof nesBandaiIrqStateSchema>;
export const isBandaiIrqState = (
  state: { model: string } | null,
): state is NesBandaiIrqState =>
  state?.model === "bandai-fcg" || state?.model === "bandai-lz93d50";

/** Register writes own byte values; this owner retains the elapsed counter/line state. */
export const writeBandaiIrq = (
  previous: NesBandaiIrqState,
  state: NesBandaiState,
  write: NesMapperWrite,
  effect: NesMapperTraceStep["effect"],
): NesBandaiIrqState => {
  if (effect === "irq-control")
    return previous.model === "bandai-fcg"
      ? { ...previous, asserted: false }
      : {
          ...previous,
          counter_low: state.irq_low,
          counter_high: state.irq_high,
          asserted: false,
        };
  if (effect === "irq-latch" && previous.model === "bandai-fcg")
    return {
      ...previous,
      ...((write.address & 15) === 11
        ? { counter_low: state.irq_low }
        : { counter_high: state.irq_high }),
    };
  return { ...previous };
};

/** One explicit CPU cycle. Underflow uses the old zero value, then wraps to FFFF. */
export const clockBandaiCpuCycle = (
  previous: NesBandaiIrqState,
  state: NesBandaiState,
): { state: NesBandaiIrqState; clock: boolean | null } => {
  const enabled = nesByteBits(state.irq_control, 1);
  if (enabled === 0) return { state: { ...previous }, clock: false };
  const { counter_low, counter_high, underflow } = decrementNesWord(
    previous.counter_low,
    previous.counter_high,
  );
  const asserted =
    previous.asserted === true || underflow === true
      ? true
      : previous.asserted === false && underflow === false
        ? false
        : null;
  const next = {
    ...previous,
    counter_low,
    counter_high,
    asserted,
  };
  return {
    clock: enabled === null ? null : true,
    state:
      enabled === null
        ? {
            ...next,
            counter_low: joinNesBytes(previous.counter_low, next.counter_low),
            counter_high: joinNesBytes(
              previous.counter_high,
              next.counter_high,
            ),
            asserted:
              previous.asserted === next.asserted ? next.asserted : null,
          }
        : next,
  };
};
