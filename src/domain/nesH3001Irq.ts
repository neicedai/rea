import { z } from "zod";
import {
  joinNesBytes,
  nesByteBits,
  nesByteCandidates,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import { h3001Register, type NesH3001State } from "./nesH3001.js";
import type { NesMapperWrite } from "./nesMapperTrace.js";

export const nesH3001IrqStateSchema = z
  .strictObject({
    model: z.literal("h3001"),
    counter_low: nesByteValueSchema.default(null),
    counter_high: nesByteValueSchema.default(null),
    enabled: z
      .boolean()
      .nullable()
      .default(null)
      .describe(
        "Effective counter enable, retained independently from raw 9003 D7 and from an initial caller assumption. Reaching zero disables it; later clocks never revive it from the raw byte.",
      ),
    asserted: z.boolean().nullable().default(null),
    zero_behavior: z
      .enum(["wrap", "pause", "assert"])
      .nullable()
      .default(null)
      .describe(
        "Explicit conditional behavior when an enabled counter starts an edge at zero: wrap decrements to FFFF; pause keeps zero and enable; assert asserts and disables. Omission joins these reference-model alternatives and does not infer a hardware default.",
      ),
  })
  .describe(
    "Qualified Irem H3001 CPU-cycle countdown. Nonzero 0001 to 0000 asserts and disables. 9003 D7 updates effective enable and acknowledges; 9004 reloads the raw 9005/9006 latch and acknowledges without enabling. Latch writes, CPU reads and PPU events do not clock or acknowledge. Byte proofs cover partial counters conservatively without treating them as independently selectable correlated histories. No power-on state, physical IRQ observation or CPU interrupt acceptance is inferred.",
  );
export type NesH3001IrqState = z.infer<typeof nesH3001IrqStateSchema>;
export const isH3001IrqState = (
  state: { model: string } | null,
): state is NesH3001IrqState => state?.model === "h3001";

export const admitH3001Irq = (
  irq: NesH3001IrqState,
  mapper: NesH3001State,
): string | null =>
  nesByteBits(mapper.irq_control, 128) === 0 && irq.enabled === true
    ? "H3001 effective enable contradicts the retained disabled 9003 D7."
    : null;

export const writeH3001Irq = (
  previous: NesH3001IrqState,
  mapper: NesH3001State,
  write: NesMapperWrite,
): NesH3001IrqState => {
  const register = h3001Register(write.address);
  if (register === 0x9003) {
    const enabled = nesByteBits(
      write.value ?? ("known_bits" in write ? write.known_bits : null),
      128,
    );
    return {
      ...previous,
      enabled: enabled === null ? null : enabled !== 0,
      asserted: false,
    };
  }
  return register === 0x9004
    ? {
        ...previous,
        counter_low: structuredClone(mapper.irq_low),
        counter_high: structuredClone(mapper.irq_high),
        asserted: false,
      }
    : { ...previous };
};

type Clocked = { state: NesH3001IrqState; clock: boolean | null };
const byteEnvelope = (values: readonly number[]): NesByteValue =>
  values
    .slice(1)
    .reduce<NesByteValue>(
      (proof, value) => joinNesBytes(proof, value),
      values[0]!,
    );
const joinFlag = (left: boolean | null, right: boolean | null) =>
  left === right ? left : null;
const joinBranches = (branches: readonly Clocked[]): Clocked =>
  branches.slice(1).reduce<Clocked>(
    (left, right) => ({
      clock: joinFlag(left.clock, right.clock),
      state: {
        ...left.state,
        counter_low: joinNesBytes(
          left.state.counter_low,
          right.state.counter_low,
        ),
        counter_high: joinNesBytes(
          left.state.counter_high,
          right.state.counter_high,
        ),
        enabled: joinFlag(left.state.enabled, right.state.enabled),
        asserted: joinFlag(left.state.asserted, right.state.asserted),
      },
    }),
    branches[0]!,
  );
const zeroBranches = (previous: NesH3001IrqState): Clocked[] =>
  (previous.zero_behavior === null
    ? (["wrap", "pause", "assert"] as const)
    : [previous.zero_behavior]
  ).map((behavior) => ({
    clock: behavior !== "pause",
    state: {
      ...previous,
      counter_low: behavior === "wrap" ? 255 : 0,
      counter_high: behavior === "wrap" ? 255 : 0,
      enabled: behavior !== "assert",
      asserted: behavior === "assert" ? true : previous.asserted,
    },
  }));

/** Each branch projects at most 256 candidates per byte, never 65,536 words. */
const enabledBranches = (previous: NesH3001IrqState): Clocked[] => {
  const lows = nesByteCandidates(previous.counter_low),
    highs = nesByteCandidates(previous.counter_high),
    positiveHighs = highs.filter((value) => value > 0),
    branches: Clocked[] = [];
  if (positiveHighs.length > 0) {
    const highResults = [
      ...(lows.some((value) => value > 0) ? positiveHighs : []),
      ...(lows.includes(0) ? positiveHighs.map((value) => value - 1) : []),
    ];
    branches.push({
      clock: true,
      state: {
        ...previous,
        enabled: true,
        counter_low: byteEnvelope(lows.map((value) => (value - 1) & 255)),
        counter_high: byteEnvelope(highResults),
      },
    });
  }
  if (highs.includes(0)) {
    const positiveLows = lows.filter((value) => value > 1);
    if (positiveLows.length > 0)
      branches.push({
        clock: true,
        state: {
          ...previous,
          enabled: true,
          counter_low: byteEnvelope(positiveLows.map((value) => value - 1)),
          counter_high: 0,
        },
      });
    if (lows.includes(1))
      branches.push({
        clock: true,
        state: {
          ...previous,
          counter_low: 0,
          counter_high: 0,
          enabled: false,
          asserted: true,
        },
      });
    if (lows.includes(0)) branches.push(...zeroBranches(previous));
  }
  return branches;
};

export const clockH3001CpuCycle = (previous: NesH3001IrqState): Clocked => {
  if (previous.enabled === false)
    return { state: { ...previous }, clock: false };
  const branches = enabledBranches(previous);
  if (previous.enabled === null)
    branches.push({ state: { ...previous, enabled: false }, clock: false });
  return joinBranches(branches);
};
