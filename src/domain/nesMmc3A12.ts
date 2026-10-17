import type { NesByteValue } from "./nesByteValue.js";
import { applyMcAccA12 } from "./nesMcAccIrq.js";
import { z } from "zod";
import {
  applyPossibleMmc3IrqClock,
  MMC3_A12_PHASES,
  type Mmc3A12Phase,
  type NesMmc3IrqState,
} from "./nesMmc3Irq.js";

export const nesMmc3SignalEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ppu-a12"), high: z.boolean() }),
  z.strictObject({ kind: z.literal("cpu-m2-fall") }),
]);
export type NesMmc3SignalEvent = z.infer<typeof nesMmc3SignalEventSchema>;
const afterM2: Record<Mmc3A12Phase, Mmc3A12Phase> = {
  high: "high",
  "low-0": "low-1",
  "low-1": "low-2",
  "low-2": "low-3",
  "low-3": "low-3",
};

/** Supplied signal order determines whether a rising A12 edge qualifies. */
export const applyMmc3A12 = (
  previous: NesMmc3IrqState,
  event: NesMmc3SignalEvent,
  latch: NesByteValue,
): { state: NesMmc3IrqState; clock: boolean | null } => {
  if (previous.model === "mc-acc") return applyMcAccA12(previous, event, latch);
  const phases = new Set<Mmc3A12Phase>();
  const clocks = new Set<boolean>();
  for (const phase of previous.a12_filter ?? MMC3_A12_PHASES) {
    if (event.kind === "cpu-m2-fall") {
      phases.add(afterM2[phase]);
      clocks.add(false);
    } else if (event.high) {
      phases.add("high");
      clocks.add(phase === "low-3");
    } else {
      phases.add(phase === "high" ? "low-0" : phase);
      clocks.add(false);
    }
  }
  const clock = clocks.size === 1 ? [...clocks][0]! : null;
  const state = applyPossibleMmc3IrqClock(previous, latch, clock);
  return {
    state: {
      ...state,
      a12_filter: MMC3_A12_PHASES.filter((phase) => phases.has(phase)),
    },
    clock,
  };
};
