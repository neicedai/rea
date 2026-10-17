import { expect, it } from "vitest";
import { applyMmc3A12, type NesMmc3SignalEvent } from "./nesMmc3A12.js";
import { nesMmc3IrqStateSchema, writeMmc3Irq } from "./nesMmc3Irq.js";

const m2 = { kind: "cpu-m2-fall" } as const;
const high = { kind: "ppu-a12", high: true } as const;
const low = { kind: "ppu-a12", high: false } as const;
const initial = () =>
  nesMmc3IrqStateSchema.parse({
    model: "sharp",
    counter: 1,
    reload_pending: false,
    enabled: true,
    asserted: false,
  });

it.each([0, 1, 2, 3, 4, 12])(
  "qualifies A12 only after at least three low M2 falls: %i",
  (falls) => {
    let state = nesMmc3IrqStateSchema.parse({
      ...initial(),
      a12_filter: ["high"],
    });
    const events: NesMmc3SignalEvent[] = [
      low,
      ...Array.from({ length: falls }, () => m2),
      high,
    ];
    const clocks = [];
    for (const event of events) {
      const result = applyMmc3A12(state, event, 5);
      state = result.state;
      clocks.push(result.clock);
    }
    expect(clocks).toEqual([
      ...Array(events.length - 1).fill(false),
      falls >= 3,
    ]);
    expect(state).toMatchObject({
      counter: falls >= 3 ? 0 : 1,
      asserted: falls >= 3,
      a12_filter: ["high"],
    });
    expect(applyMmc3A12(state, high, 5).clock).toBe(false);
  },
);

it("retains unknown phase alternatives until the supplied signal history resolves them", () => {
  let state = initial();
  for (let index = 0; index < 3; index++)
    state = applyMmc3A12(state, m2, 2).state;
  expect(state.a12_filter).toEqual(["high", "low-3"]);
  const uncertain = applyMmc3A12(state, high, 2);
  expect(uncertain).toMatchObject({
    clock: null,
    state: {
      counter: null,
      asserted: null,
      reload_pending: false,
      a12_filter: ["high"],
    },
  });
  state = applyMmc3A12(state, low, 2).state;
  for (let index = 0; index < 3; index++)
    state = applyMmc3A12(state, m2, 2).state;
  expect(state.a12_filter).toEqual(["low-3"]);
  expect(applyMmc3A12(state, high, 2)).toMatchObject({
    clock: true,
    state: { counter: 0, asserted: true },
  });
});

it("does not count high M2 falls, reset on repeated low observations, or reset the filter on IRQ acknowledge", () => {
  let state = nesMmc3IrqStateSchema.parse({
    ...initial(),
    a12_filter: ["high"],
  });
  for (let index = 0; index < 4; index++)
    state = applyMmc3A12(state, m2, 2).state;
  expect(applyMmc3A12(state, high, 2).clock).toBe(false);
  for (const event of [low, m2, m2, low])
    state = applyMmc3A12(state, event, 2).state;
  expect(state.a12_filter).toEqual(["low-2"]);
  state = writeMmc3Irq(state, {
    address: 0xe000,
    value: null,
    preceded_by_cpu_write: null,
  });
  state = applyMmc3A12(state, m2, 2).state;
  expect(applyMmc3A12(state, high, 2)).toMatchObject({
    clock: true,
    state: { counter: 0, enabled: false, asserted: false },
  });
});
