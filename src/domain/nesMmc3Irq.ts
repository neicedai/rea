import type { NesByteValue } from "./nesByteValue.js";
import { z } from "zod";
import type { NesMapperWrite } from "./nesMapperTrace.js";

export const MMC3_A12_PHASES = [
  "high",
  "low-0",
  "low-1",
  "low-2",
  "low-3",
] as const;
export type Mmc3A12Phase = (typeof MMC3_A12_PHASES)[number];

/** Explicit conventional counter model, not inferred silicon identity or reset state. */
export const nesMmc3IrqStateSchema = z.strictObject({
  model: z
    .enum(["sharp", "nec", "mc-acc"])
    .describe(
      "Caller-selected conventional IRQ model; does not identify physical silicon or model consecutive-reload hardware glitches",
    ),
  a12_filter: z
    .array(z.enum(MMC3_A12_PHASES))
    .min(1)
    .max(5)
    .nullable()
    .default(null)
    .describe(
      "Possible A12 filter phases: high, or low after 0/1/2/at least 3 M2 falling edges. Omission means all five possibilities; retained phases allow exact filter continuation.",
    ),
  mcacc_prescaler: z
    .strictObject({
      a12_high: z.boolean().nullable().default(null),
      pulses: z
        .array(z.number().int().min(0).max(7))
        .min(1)
        .max(8)
        .nullable()
        .default(null),
    })
    .nullable()
    .default(null)
    .describe(
      "MC-ACC only: possible pulse counts modulo eight and prior A12 level; null means unknown. C001 resets pulses to zero; the next falling edge clocks the IRQ counter.",
    ),
  counter: z.number().int().min(0).max(255).nullable().default(null),
  reload_pending: z.boolean().nullable().default(null),
  enabled: z.boolean().nullable().default(null),
  asserted: z.boolean().nullable().default(null),
});
export type NesMmc3IrqState = z.infer<typeof nesMmc3IrqStateSchema>;

/** Dispatch by this owner's model tags rather than excluding every other cartridge. */
export const isMmc3IrqState = (
  state: { model: string } | null,
): state is NesMmc3IrqState =>
  state !== null &&
  (state.model === "sharp" ||
    state.model === "nec" ||
    state.model === "mc-acc");

export const writeMmc3Irq = (
  previous: NesMmc3IrqState,
  write: NesMapperWrite,
): NesMmc3IrqState => {
  const state = { ...previous };
  if (write.address < 0x8000) return state;
  switch (write.address & 0xe001) {
    case 0xc001:
      if (state.model === "mc-acc")
        state.mcacc_prescaler = {
          a12_high: state.mcacc_prescaler?.a12_high ?? null,
          pulses: [0],
        };
      state.counter = 0;
      state.reload_pending = true;
      break;
    case 0xe000:
      state.enabled = false;
      state.asserted = false;
      break;
    case 0xe001:
      state.enabled = true;
      break;
  }
  return state;
};

/** One externally qualified counter clock, after the board's A12 filter/prescaler. */
export const clockMmc3Irq = (
  previous: NesMmc3IrqState,
  latch: NesByteValue,
): NesMmc3IrqState => {
  const counters = new Set<number>();
  const assertions = new Set<boolean>();
  let unknownCounter = false;
  const booleans = (value: boolean | null): readonly boolean[] =>
    value === null ? [false, true] : [value];
  for (
    let old = previous.counter ?? 0;
    old <= (previous.counter ?? 255);
    old++
  ) {
    for (const reload of booleans(previous.reload_pending)) {
      const reloading = old === 0 || reload;
      const counter = reloading
        ? typeof latch === "number"
          ? latch
          : null
        : old - 1;
      if (counter === null) unknownCounter = true;
      else counters.add(counter);
      // A proven set latch bit excludes zero even when the complete reload is unknown.
      const zeros =
        counter !== null
          ? [counter === 0]
          : reloading &&
              latch !== null &&
              typeof latch !== "number" &&
              latch.value !== 0
            ? [false]
            : [false, true];
      for (const zero of zeros) {
        const fires = zero && (previous.model !== "nec" || old > 0 || reload);
        for (const enabled of booleans(previous.enabled))
          for (const asserted of booleans(previous.asserted))
            assertions.add(asserted || (enabled && fires));
      }
    }
  }
  return {
    ...previous,
    counter: !unknownCounter && counters.size === 1 ? [...counters][0]! : null,
    reload_pending: false,
    asserted: assertions.size === 1 ? [...assertions][0]! : null,
  };
};

/** Join a qualified clock with no clock when supplied signal history is ambiguous. */
export const applyPossibleMmc3IrqClock = (
  previous: NesMmc3IrqState,
  latch: NesByteValue,
  clock: boolean | null,
): NesMmc3IrqState => {
  if (clock === false) return { ...previous };
  const clocked = clockMmc3Irq(previous, latch);
  if (clock === true) return clocked;
  return {
    ...previous,
    counter: previous.counter === clocked.counter ? previous.counter : null,
    reload_pending:
      previous.reload_pending === clocked.reload_pending
        ? previous.reload_pending
        : null,
    asserted: previous.asserted === clocked.asserted ? previous.asserted : null,
  };
};
