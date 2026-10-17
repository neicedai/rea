import type { NesVrc6State } from "./nesVrc6.js";
import { z } from "zod";
import {
  joinNesBytes,
  nesByteBits,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesMapperState, NesMapperTraceStep } from "./nesMapperTrace.js";

type Vrc = Extract<NesMapperState, { variant: "vrc4" }> | NesVrc6State;
const phases = Array.from({ length: 341 }, (_, index) => index + 1);

/** Explicit conventional VRC4/VRC6 timing assumption, independent of physical silicon identity. */
export const nesVrcIrqStateSchema = z.strictObject({
  model: z
    .enum(["vrc4", "vrc6"])
    .describe(
      "Caller-selected conventional VRC4/VRC6 calculation model; not physical silicon identity or CPU interrupt acceptance.",
    ),
  counter: nesByteValueSchema
    .default(null)
    .describe(
      "A complete counter byte, null for unknown, or canonical {mask,value} retaining proven bits. Partial proofs and phase sets conservatively join unresolved alternatives.",
    ),
  prescaler: z
    .array(z.number().int().min(1).max(341))
    .min(1)
    .max(341)
    .superRefine((values, ctx) => {
      if (new Set(values).size !== values.length)
        ctx.addIssue({
          code: "custom",
          message: "VRC prescaler phases must be unique",
        });
    })
    .overwrite((values) => [...values].sort((a, b) => a - b))
    .meta({ uniqueItems: true })
    .nullable()
    .default(null)
    .describe(
      "Possible countdown phases 1..341; null means unknown. Enabling through IRQ control reloads phase 341. Cycle mode bypasses this countdown and leaves its physical phase unknown.",
    ),
  asserted: z.boolean().nullable().default(null),
});
export type NesVrcIrqState = z.infer<typeof nesVrcIrqStateSchema>;

export const isVrcIrqState = (
  state: { model: string } | null,
): state is NesVrcIrqState =>
  state?.model === "vrc4" || state?.model === "vrc6";

const compactPhases = (values: Iterable<number>): number[] | null => {
  const distinct = [...new Set(values)].sort((a, b) => a - b);
  return distinct.length === 341 ? null : distinct;
};

const latch = (state: Vrc): NesByteValue => {
  if ("irq_latch" in state) return state.irq_latch;
  const proof = (value: NesByteValue | undefined) =>
    typeof value === "number"
      ? { mask: 15, value: value & 15 }
      : { mask: (value?.mask ?? 0) & 15, value: (value?.value ?? 0) & 15 };
  const low = proof(state.irq_latch_low),
    high = proof(state.irq_latch_high);
  const mask = low.mask | (high.mask << 4),
    value = low.value | (high.value << 4);
  return mask === 0 ? null : mask === 255 ? value : { mask, value };
};

/** Mapper writes own raw registers and enable bits; this owner retains counter/line history. */
export const writeVrcIrq = (
  previous: NesVrcIrqState,
  mapper: Vrc,
  effect: NesMapperTraceStep["effect"],
): NesVrcIrqState => {
  if (effect === "irq-acknowledge") return { ...previous, asserted: false };
  if (effect !== "irq-control") return { ...previous };
  const enabled = mapper.irq_enabled;
  return {
    ...previous,
    asserted: false,
    counter:
      enabled === false
        ? previous.counter
        : enabled === true
          ? latch(mapper)
          : joinNesBytes(previous.counter, latch(mapper)),
    prescaler:
      enabled === false
        ? previous.prescaler
        : enabled === true
          ? [341]
          : compactPhases([...(previous.prescaler ?? phases), 341]),
  };
};

const byteValues = (byte: NesByteValue): number[] =>
  typeof byte === "number"
    ? [byte]
    : Array.from({ length: 256 }, (_, value) => value).filter(
        (value) => byte === null || (value & byte.mask) === byte.value,
      );

/** One enabled counter clock; overflow reloads and latches IRQ, not CPU acceptance. */
const clockCounter = (
  previous: NesVrcIrqState,
  reload: NesByteValue,
): NesVrcIrqState => {
  let counter: NesByteValue | undefined;
  const assertions = new Set<boolean>();
  for (const old of byteValues(previous.counter)) {
    const next = old === 255 ? reload : old + 1;
    counter = counter === undefined ? next : joinNesBytes(counter, next);
    for (const asserted of previous.asserted === null
      ? [false, true]
      : [previous.asserted])
      assertions.add(asserted || old === 255);
  }
  return {
    ...previous,
    counter: counter ?? null,
    asserted: assertions.size === 1 ? [...assertions][0]! : null,
  };
};

/** One caller-supplied complete CPU cycle; writes and PPU reads never imply cycles. */
export const clockVrcCpuCycle = (
  previous: NesVrcIrqState,
  mapper: Vrc,
): { state: NesVrcIrqState; clock: boolean | null } => {
  const enabled = mapper.irq_enabled;
  if (enabled === false) return { state: { ...previous }, clock: false };
  const mode = nesByteBits(mapper.irq_control, 4);
  const nextPhases = new Set<number>();
  const clocks = new Set<boolean>();
  if (enabled === null) {
    for (const phase of previous.prescaler ?? phases) nextPhases.add(phase);
    clocks.add(false);
  }
  if (mode !== 0) {
    // Bypass timing does not establish the physical prescaler's retained phase.
    for (const phase of phases) nextPhases.add(phase);
    clocks.add(true);
  }
  if (mode !== 4) {
    for (const phase of previous.prescaler ?? phases) {
      const remaining = phase - 3;
      nextPhases.add(remaining <= 0 ? remaining + 341 : remaining);
      clocks.add(remaining <= 0);
    }
  }
  const clock = clocks.size === 1 ? [...clocks][0]! : null;
  const next =
    clock === false ? previous : clockCounter(previous, latch(mapper));
  return {
    clock,
    state: {
      ...next,
      prescaler: compactPhases(nextPhases),
      counter:
        clock === null
          ? joinNesBytes(previous.counter, next.counter)
          : next.counter,
      asserted:
        clock === null && previous.asserted !== next.asserted
          ? null
          : next.asserted,
    },
  };
};
