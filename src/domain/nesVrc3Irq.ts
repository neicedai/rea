import { z } from "zod";
import {
  joinNesBytes,
  nesByteBits,
  nesByteCandidates,
  nesByteProof,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import { vrc3Register, type NesVrc3State } from "./nesVrc3.js";
import type { NesMapperWrite } from "./nesMapperTrace.js";

export const nesVrc3IrqStateSchema = z
  .strictObject({
    model: z.literal("vrc3"),
    counter_low: nesByteValueSchema.default(null),
    counter_high: nesByteValueSchema.default(null),
    enabled: z
      .boolean()
      .nullable()
      .default(null)
      .describe(
        "Effective CPU-edge enable, independent of retained C000 E: D000 copies retained A into this fact without changing the raw control byte. Counter overflow reloads and keeps enable.",
      ),
    asserted: z.boolean().nullable().default(null),
  })
  .describe(
    "Qualified VRC3 CPU-cycle upcounter with mode and nibble latch owned by raw mapper state. Enabled 16-bit FFFF overflow asserts and reloads both bytes; 8-bit low FF overflow asserts and reloads only low, preserving high. C000 acknowledges and updates enable; E=1 reloads all 16 bits even in 8-bit mode. D000 acknowledges and copies A into effective enable without reloading. No prescaler, power-on defaults, physical write/clock ordering or CPU interrupt acceptance is inferred; source workflows apply a committed write before its separately modeled subsequent CPU edge.",
  );
export type NesVrc3IrqState = z.infer<typeof nesVrc3IrqStateSchema>;
export const isVrc3IrqState = (
  state: { model: string } | null,
): state is NesVrc3IrqState => state?.model === "vrc3";

const bits = (byte: NesByteValue) =>
  typeof byte === "number"
    ? { mask: 255, value: byte }
    : (byte ?? { mask: 0, value: 0 });
const latchByte = (low: NesByteValue, high: NesByteValue): NesByteValue => {
  const lower = bits(low),
    upper = bits(high);
  return nesByteProof(
    (lower.mask & 15) | ((upper.mask & 15) << 4),
    (lower.value & 15) | ((upper.value & 15) << 4),
  );
};
const latch = (mapper: NesVrc3State) => ({
  counter_low: latchByte(
    mapper.irq_latch_nibbles[0]!,
    mapper.irq_latch_nibbles[1]!,
  ),
  counter_high: latchByte(
    mapper.irq_latch_nibbles[2]!,
    mapper.irq_latch_nibbles[3]!,
  ),
});

export const writeVrc3Irq = (
  previous: NesVrc3IrqState,
  mapper: NesVrc3State,
  write: NesMapperWrite,
): NesVrc3IrqState => {
  const register = vrc3Register(write.address);
  if (register === 0xd000) {
    const enabled = nesByteBits(mapper.irq_control, 1);
    return {
      ...previous,
      enabled: enabled === null ? null : enabled !== 0,
      asserted: false,
    };
  }
  if (register !== 0xc000) return { ...previous };
  const enabled = nesByteBits(
      write.value ?? ("known_bits" in write ? write.known_bits : null),
      2,
    ),
    reload = latch(mapper);
  return {
    ...previous,
    counter_low:
      enabled === 0
        ? previous.counter_low
        : enabled === null
          ? joinNesBytes(previous.counter_low, reload.counter_low)
          : reload.counter_low,
    counter_high:
      enabled === 0
        ? previous.counter_high
        : enabled === null
          ? joinNesBytes(previous.counter_high, reload.counter_high)
          : reload.counter_high,
    enabled: enabled === null ? null : enabled !== 0,
    asserted: false,
  };
};

type Clocked = { state: NesVrc3IrqState; clock: boolean | null };
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

/** Each branch projects no more than 256 candidates per byte, never all 65,536 words. */
const enabledBranches = (
  previous: NesVrc3IrqState,
  mapper: NesVrc3State,
  small: boolean,
): Clocked[] => {
  const lows = nesByteCandidates(previous.counter_low),
    highs = nesByteCandidates(previous.counter_high),
    lowBeforeOverflow = lows.filter((value) => value < 255),
    highBeforeOverflow = highs.filter((value) => value < 255),
    reload = latch(mapper),
    branches: Clocked[] = [];
  const add = (
    counter_low: NesByteValue,
    counter_high: NesByteValue,
    asserted = previous.asserted,
  ) =>
    branches.push({
      clock: true,
      state: {
        ...previous,
        counter_low,
        counter_high,
        enabled: true,
        asserted,
      },
    });
  if (lowBeforeOverflow.length > 0)
    add(
      byteEnvelope(lowBeforeOverflow.map((value) => value + 1)),
      previous.counter_high,
    );
  if (!lows.includes(255)) return branches;
  if (small) add(reload.counter_low, previous.counter_high, true);
  else {
    if (highBeforeOverflow.length > 0)
      add(0, byteEnvelope(highBeforeOverflow.map((value) => value + 1)));
    if (highs.includes(255)) add(reload.counter_low, reload.counter_high, true);
  }
  return branches;
};

export const clockVrc3CpuCycle = (
  previous: NesVrc3IrqState,
  mapper: NesVrc3State,
): Clocked => {
  if (previous.enabled === false)
    return { state: { ...previous }, clock: false };
  const mode = nesByteBits(mapper.irq_control, 4),
    modes = mode === null ? [false, true] : [mode !== 0],
    branches = modes.flatMap((small) =>
      enabledBranches(previous, mapper, small),
    );
  if (previous.enabled === null)
    branches.push({ state: { ...previous, enabled: false }, clock: false });
  return joinBranches(branches);
};
