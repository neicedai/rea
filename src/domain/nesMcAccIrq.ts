import type { NesByteValue } from "./nesByteValue.js";
import type { NesMmc3SignalEvent } from "./nesMmc3A12.js";
import {
  applyPossibleMmc3IrqClock,
  type NesMmc3IrqState,
} from "./nesMmc3Irq.js";

/** MC-ACC clocks on falling A12 edges 1, 9, 17 ... after the C001 phase reset. */
export const applyMcAccA12 = (
  previous: NesMmc3IrqState,
  event: NesMmc3SignalEvent,
  latch: NesByteValue,
): { state: NesMmc3IrqState; clock: boolean | null } => {
  if (event.kind === "cpu-m2-fall")
    return { state: { ...previous }, clock: false };
  const oldHigh = previous.mcacc_prescaler?.a12_high ?? null;
  const pulses = previous.mcacc_prescaler?.pulses ?? [0, 1, 2, 3, 4, 5, 6, 7];
  const next = new Set<number>();
  const clocks = new Set<boolean>();
  for (const wasHigh of oldHigh === null ? [false, true] : [oldHigh]) {
    const falling = wasHigh && !event.high;
    for (const pulse of pulses) {
      next.add(falling ? (pulse + 1) % 8 : pulse);
      clocks.add(falling && pulse === 0);
    }
  }
  const clock = clocks.size === 1 ? [...clocks][0]! : null;
  const state = applyPossibleMmc3IrqClock(previous, latch, clock);
  return {
    state: {
      ...state,
      mcacc_prescaler: {
        a12_high: event.high,
        pulses: [...next].sort((a, b) => a - b),
      },
    },
    clock,
  };
};
