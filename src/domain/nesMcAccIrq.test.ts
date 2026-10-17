import { expect, it } from "vitest";
import { applyMmc3A12 } from "./nesMmc3A12.js";
import { nesMmc3IrqStateSchema, writeMmc3Irq } from "./nesMmc3Irq.js";
const low = { kind: "ppu-a12", high: false } as const;
const high = { kind: "ppu-a12", high: true } as const;
const m2 = { kind: "cpu-m2-fall" } as const;
const reload = { address: 0xdfff, value: null, preceded_by_cpu_write: null };
const initial = () =>
  nesMmc3IrqStateSchema.parse({
    model: "mc-acc",
    enabled: true,
    asserted: false,
  });

it("clocks falling edges 1, 9 and 17 after reload rather than every eighth edge or an A12 rise", () => {
  let state = writeMmc3Irq(initial(), reload);
  state = applyMmc3A12(state, high, 1).state;
  const clocked: number[] = [];
  const counts: (number | null)[] = [];
  for (let pulse = 1; pulse <= 17; pulse++) {
    const falling = applyMmc3A12(state, low, 1);
    if (falling.clock) clocked.push(pulse);
    state = falling.state;
    counts.push(state.counter);
    for (const event of [m2, low, high, m2]) {
      const ignored = applyMmc3A12(state, event, 1);
      expect(ignored.clock).toBe(false);
      state = ignored.state;
    }
  }
  expect(clocked).toEqual([1, 9, 17]);
  expect(counts).toEqual([...Array(8).fill(1), ...Array(8).fill(0), 1]);
  expect(state).toMatchObject({
    asserted: true,
    mcacc_prescaler: { a12_high: true, pulses: [1] },
    a12_filter: null,
  });
});

it("resets the pulse phase without inventing a falling edge while A12 is already low", () => {
  const old = nesMmc3IrqStateSchema.parse({
    ...initial(),
    counter: 4,
    mcacc_prescaler: { a12_high: false, pulses: [5] },
  });
  let state = writeMmc3Irq(old, reload);
  expect(state).toMatchObject({
    counter: 0,
    reload_pending: true,
    mcacc_prescaler: { a12_high: false, pulses: [0] },
  });
  expect(applyMmc3A12(state, low, 2).clock).toBe(false);
  state = applyMmc3A12(state, high, 2).state;
  expect(applyMmc3A12(state, low, 2)).toMatchObject({
    clock: true,
    state: { counter: 2, reload_pending: false },
  });
  expect(old.mcacc_prescaler?.pulses).toEqual([5]);
});

it("retains unknown phase and edge history, then recovers after an explicit reset", () => {
  let state = nesMmc3IrqStateSchema.parse({
    ...initial(),
    counter: 1,
    reload_pending: false,
  });
  expect(applyMmc3A12(state, m2, 0)).toEqual({ state, clock: false });
  const uncertain = applyMmc3A12(state, low, 0);
  expect(uncertain).toMatchObject({
    clock: null,
    state: {
      counter: null,
      asserted: null,
      mcacc_prescaler: { a12_high: false, pulses: [0, 1, 2, 3, 4, 5, 6, 7] },
    },
  });
  state = writeMmc3Irq(uncertain.state, { ...reload, address: 0xe000 });
  state = writeMmc3Irq(state, reload);
  state = applyMmc3A12(state, high, 0).state;
  expect(applyMmc3A12(state, low, 0)).toMatchObject({
    clock: true,
    state: { counter: 0, asserted: false, enabled: false },
  });
});

it.each([0, 1, 2, 4])(
  "rejects MC-ACC IRQ assumptions for declared submapper %i",
  async (submapper) => {
    const { mapperTraceFixture } = await import("./nesMapperTrace.fixture.js");
    const { parseNesHeader } = await import("./nes.js");
    const { nesMapperStateSchema } = await import("./nesMapperTrace.js");
    const { deriveNesMapperEvents } =
      await import("./nesMapperEventsDerivation.js");
    const bytes = mapperTraceFixture(4);
    bytes[7] = 8;
    bytes[8] = submapper << 4;
    const parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const result = await deriveNesMapperEvents(
      parsed.value,
      nesMapperStateSchema.parse({ mapper: 4 }),
      [],
      { initialIrq: initial() },
    );
    expect(result).toEqual({
      status: "unsupported",
      reason:
        "The mc-acc IRQ model requires legacy Mapper 4 or NES 2.0 submapper 3.",
    });
  },
);
