import type { NesByteValue } from "./nesByteValue.js";
import { expect, it } from "vitest";
import {
  clockMmc3Irq,
  nesMmc3IrqStateSchema,
  writeMmc3Irq,
} from "./nesMmc3Irq.js";

it.each(["sharp", "nec"] as const)(
  "counts through disabled periods and acknowledges the latched %s IRQ",
  (model) => {
    let state = nesMmc3IrqStateSchema.parse({
      model,
      counter: 7,
      reload_pending: false,
      enabled: false,
      asserted: false,
    });
    state = writeMmc3Irq(state, {
      address: 0xdfff,
      value: null,
      preceded_by_cpu_write: null,
    });
    expect(state).toMatchObject({ counter: 0, reload_pending: true });
    const values = [];
    for (let i = 0; i < 5; i++) {
      state = clockMmc3Irq(state, 3);
      values.push(state.counter);
    }
    expect(values).toEqual([3, 2, 1, 0, 3]);
    expect(state.asserted).toBe(false);
    state = writeMmc3Irq(state, {
      address: 0xffff,
      value: null,
      preceded_by_cpu_write: null,
    });
    expect(state.asserted).toBe(false);
    for (let i = 0; i < 3; i++) state = clockMmc3Irq(state, 3);
    expect(state.asserted).toBe(true);
    state = clockMmc3Irq(state, 3);
    expect(state).toMatchObject({ counter: 3, asserted: true });
    state = writeMmc3Irq(state, {
      address: 0xfffe,
      value: null,
      preceded_by_cpu_write: null,
    });
    expect(state).toMatchObject({
      counter: 3,
      asserted: false,
      enabled: false,
    });
  },
);

it.each(["sharp", "nec"] as const)(
  "distinguishes zero reload from subsequent zero clocks for %s",
  (model) => {
    const zero = nesMmc3IrqStateSchema.parse({
      model,
      counter: 0,
      reload_pending: true,
      enabled: true,
      asserted: false,
    });
    expect(clockMmc3Irq(zero, 0)).toMatchObject({
      counter: 0,
      reload_pending: false,
      asserted: true,
    });
    expect(clockMmc3Irq({ ...zero, reload_pending: false }, 0).asserted).toBe(
      model === "sharp",
    );
    expect(
      clockMmc3Irq({ ...zero, counter: 1, reload_pending: false }, 0).asserted,
    ).toBe(true);
    expect(zero.asserted).toBe(false);
  },
);

it("joins unknown counter, reload, enable and latch values without choosing reset defaults", () => {
  const unknown = nesMmc3IrqStateSchema.parse({ model: "sharp" });
  expect(clockMmc3Irq(unknown, null)).toEqual({
    ...unknown,
    reload_pending: false,
  });
  expect(
    clockMmc3Irq(
      {
        ...unknown,
        counter: 1,
        reload_pending: false,
        enabled: true,
        asserted: false,
      },
      null,
    ),
  ).toMatchObject({ counter: 0, asserted: true });
  expect(
    clockMmc3Irq(
      { ...unknown, reload_pending: true, enabled: true, asserted: false },
      0,
    ),
  ).toMatchObject({ counter: 0, asserted: true });
  expect(
    clockMmc3Irq(
      { ...unknown, reload_pending: true, enabled: false, asserted: false },
      null,
    ),
  ).toMatchObject({ counter: null, asserted: false });
  expect(clockMmc3Irq({ ...unknown, asserted: true }, null).asserted).toBe(
    true,
  );
  const nec = {
    ...unknown,
    model: "nec" as const,
    counter: 0,
    enabled: true,
    asserted: false,
  };
  expect(clockMmc3Irq(nec, 0).asserted).toBeNull();
});

it.each(["sharp", "nec", "mc-acc"] as const)(
  "agrees with the concrete state envelope when %s input facts are omitted",
  (model) => {
    const inputs: {
      counter: number | null;
      reload_pending: boolean | null;
      enabled: boolean | null;
      asserted: boolean | null;
      latch: NesByteValue;
    }[] = [
      {
        counter: null,
        reload_pending: null,
        enabled: null,
        asserted: null,
        latch: null,
      },
      {
        counter: 1,
        reload_pending: null,
        enabled: true,
        asserted: false,
        latch: 0,
      },
      {
        counter: 0,
        reload_pending: null,
        enabled: true,
        asserted: false,
        latch: 0,
      },
      {
        counter: 2,
        reload_pending: null,
        enabled: true,
        asserted: false,
        latch: 0,
      },
      {
        counter: 0,
        reload_pending: true,
        enabled: null,
        asserted: false,
        latch: 0,
      },
      {
        counter: 1,
        reload_pending: false,
        enabled: false,
        asserted: null,
        latch: null,
      },
      {
        counter: null,
        reload_pending: false,
        enabled: true,
        asserted: false,
        latch: 0,
      },
    ];
    // Every proper partial mask, including noncontiguous masks, with both
    // all-known-clear and all-known-set bits at reload/decrement boundaries.
    for (let mask = 1; mask < 255; mask++)
      for (const value of [0, mask])
        for (const counter of [0, 1, 2])
          for (const reload_pending of [false, true, null])
            inputs.push({
              counter,
              reload_pending,
              enabled: true,
              asserted: false,
              latch: { mask, value },
            });
    const byteValues = (value: NesByteValue): number[] =>
      typeof value === "number"
        ? [value]
        : Array.from({ length: 256 }, (_, index) => index).filter(
            (candidate) =>
              value === null || (candidate & value.mask) === value.value,
          );
    const bitValues = (value: boolean | null) =>
      value === null ? [false, true] : [value];
    for (const { latch, ...fields } of inputs) {
      const state = nesMmc3IrqStateSchema.parse({ model, ...fields });
      const counters = new Set<number | null>();
      const assertions = new Set<boolean | null>();
      // Concretization checks the unknown-value join independently of its
      // compressed zero/nonzero representation. All eight-bit values matter.
      for (const counter of byteValues(state.counter))
        for (const reload_pending of bitValues(state.reload_pending))
          for (const enabled of bitValues(state.enabled))
            for (const asserted of bitValues(state.asserted))
              for (const concreteLatch of byteValues(latch)) {
                // Independent concrete transition: do not use the production
                // abstraction to generate its own expected results.
                const next =
                  counter === 0 || reload_pending ? concreteLatch : counter - 1;
                const zeroTransition =
                  model === "nec"
                    ? (counter > 0 || reload_pending) && next === 0
                    : next === 0;
                counters.add(next);
                assertions.add(asserted || (enabled && zeroTransition));
              }
      const projected = clockMmc3Irq(state, latch);
      expect(projected.counter).toBe(
        counters.size === 1 ? [...counters][0] : null,
      );
      expect(projected.asserted).toBe(
        assertions.size === 1 ? [...assertions][0] : null,
      );
      expect(projected.reload_pending).toBe(false);
      expect(state).toEqual({
        model,
        a12_filter: null,
        mcacc_prescaler: null,
        ...fields,
      });
    }
  },
  20_000,
);

it.each(["sharp", "nec", "mc-acc"] as const)(
  "excludes zero IRQ reloads from a proven latch bit for %s",
  (model) => {
    const initial = nesMmc3IrqStateSchema.parse({
      model,
      counter: 0,
      reload_pending: true,
      enabled: true,
      asserted: false,
    });
    expect(clockMmc3Irq(initial, { mask: 128, value: 128 })).toMatchObject({
      counter: null,
      asserted: false,
      reload_pending: false,
    });
    expect(clockMmc3Irq(initial, { mask: 128, value: 0 })).toMatchObject({
      counter: null,
      asserted: null,
    });
    expect(
      clockMmc3Irq(
        { ...initial, counter: 1, reload_pending: false },
        { mask: 128, value: 128 },
      ),
    ).toMatchObject({ counter: 0, asserted: true });
  },
);
