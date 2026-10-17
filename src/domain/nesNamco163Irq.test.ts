import { expect, it } from "vitest";
import {
  clockNamco163CpuCycle,
  nesNamco163IrqStateSchema,
  writeNamco163Irq,
  readNamco163Irq,
} from "./nesNamco163Irq.js";
import { nesNamco163StateSchema } from "./nesNamco163.js";
import type { NesByteValue } from "./nesByteValue.js";

it("reads live counter ports without acknowledgement and joins high count bits with the independent enable proof", () => {
  const irq = nesNamco163IrqStateSchema.parse({
    model: "namco163",
    counter_low: 37,
    counter_high: 255,
    asserted: true,
  });
  for (const enabled of [0, 128, null] as const) {
    const mapper = nesNamco163StateSchema.parse({
      mapper: 19,
      variant: "namco163",
      irq_high: enabled,
    });
    for (const address of [0x5000, 0x57ff])
      expect(readNamco163Irq(irq, mapper, address)).toMatchObject({
        address,
        value: 37,
        source: { counter_low: 37, counter_high: 255, irq_high: enabled },
      });
    for (const address of [0x5800, 0x5fff])
      expect(readNamco163Irq(irq, mapper, address)).toMatchObject(
        enabled === null
          ? { value: null, known_bits: { mask: 127, value: 127 } }
          : { value: enabled | 127 },
      );
    for (const address of [null, 0x4fff, 0x6000])
      expect(readNamco163Irq(irq, mapper, address)).toBeNull();
    expect(irq.asserted).toBe(true);
  }
});

it("matches all 32768 saturating counter transitions with both raw high-bit values", () => {
  const mapper = nesNamco163StateSchema.parse({
    mapper: 19,
    variant: "namco163",
    irq_high: 128,
  });
  for (const rawHigh of [0, 128])
    for (let counter = 0; counter < 32768; counter++) {
      const initial = {
        model: "namco163" as const,
        counter_low: counter & 255,
        counter_high: rawHigh | (counter >> 8),
        asserted: false,
      };
      const next = clockNamco163CpuCycle(initial, mapper),
        target = Math.min(counter + 1, 32767);
      expect(next).toEqual({
        clock: counter !== 32767,
        state: {
          ...initial,
          counter_low: target & 255,
          counter_high: rawHigh | (target >> 8),
          asserted: counter === 32766,
        },
      });
    }
});
it("acknowledges on either aliased counter write and never reasserts an acknowledged saturated counter", () => {
  let irq = nesNamco163IrqStateSchema.parse({
    model: "namco163",
    counter_low: 255,
    counter_high: 255,
    asserted: true,
  });
  const mapper = nesNamco163StateSchema.parse({
    mapper: 19,
    variant: "namco163",
    irq_high: 255,
  });
  irq = writeNamco163Irq(irq, {
    address: 0x5fff,
    value: 255,
    preceded_by_cpu_write: false,
  });
  expect(clockNamco163CpuCycle(irq, mapper)).toEqual({
    clock: false,
    state: { ...irq, asserted: false },
  });
  expect(
    writeNamco163Irq(irq, {
      address: 0x57ff,
      value: null,
      known_bits: { mask: 254, value: 254 },
      preceded_by_cpu_write: false,
    }),
  ).toMatchObject({ counter_low: { mask: 254, value: 254 }, asserted: false });
  expect(
    writeNamco163Irq(irq, {
      address: 0x6000,
      value: 0,
      preceded_by_cpu_write: false,
    }),
  ).toEqual(irq);
});
it("preserves uncertainty at enable, carry and saturation boundaries", () => {
  const irq = nesNamco163IrqStateSchema.parse({
    model: "namco163",
    counter_low: { mask: 254, value: 254 },
    counter_high: 127,
    asserted: false,
  });
  const mapper = nesNamco163StateSchema.parse({
    mapper: 19,
    variant: "namco163",
    irq_high: 128,
  });
  expect(clockNamco163CpuCycle(irq, mapper)).toEqual({
    clock: null,
    state: { ...irq, counter_low: 255, asserted: null },
  });
  expect(clockNamco163CpuCycle(irq, { ...mapper, irq_high: 0 })).toEqual({
    clock: false,
    state: irq,
  });
  expect(clockNamco163CpuCycle(irq, { ...mapper, irq_high: null })).toEqual({
    clock: null,
    state: { ...irq, asserted: null },
  });
});

it("matches concrete envelopes for partial byte, enable and pending-IRQ proofs", () => {
  const inputs: [NesByteValue, NesByteValue][] = [
    [null, null],
    [null, 127],
    [255, null],
    [{ mask: 254, value: 254 }, 127],
    [255, { mask: 126, value: 126 }],
    [
      { mask: 240, value: 240 },
      { mask: 127, value: 127 },
    ],
    [
      { mask: 15, value: 15 },
      { mask: 240, value: 112 },
    ],
  ];
  const concrete = (proof: NesByteValue) =>
    Array.from({ length: 256 }, (_, n) => n).filter((n) =>
      typeof proof === "number"
        ? n === proof
        : proof === null || (n & proof.mask) === proof.value,
    );
  const envelope = (values: Set<number>): NesByteValue => {
    const first = values.values().next().value!;
    let mask = 255;
    for (const value of values) mask &= ~(first ^ value);
    return mask === 0
      ? null
      : mask === 255
        ? first
        : { mask, value: first & mask };
  };
  for (const [low, high] of inputs)
    for (const enabled of [true, false, null])
      for (const asserted of [true, false, null]) {
        const lows = new Set<number>(),
          highs = new Set<number>(),
          clocks = new Set<boolean>(),
          pending = new Set<boolean>();
        for (const l of concrete(low))
          for (const h of concrete(high))
            for (const e of enabled === null ? [true, false] : [enabled])
              for (const a of asserted === null ? [true, false] : [asserted]) {
                const counter = ((h & 127) << 8) | l;
                const next = e ? Math.min(counter + 1, 32767) : counter;
                lows.add(next & 255);
                highs.add((h & 128) | (next >> 8));
                clocks.add(e && counter !== 32767);
                pending.add(a || (e && counter === 32766));
              }
        const mapper = nesNamco163StateSchema.parse({
          mapper: 19,
          variant: "namco163",
          irq_high: enabled === null ? null : enabled ? 128 : 0,
        });
        const state = {
          model: "namco163" as const,
          counter_low: low,
          counter_high: high,
          asserted,
        };
        const actual = clockNamco163CpuCycle(state, mapper);
        expect(actual).toEqual({
          clock: clocks.size === 1 ? [...clocks][0] : null,
          state: {
            ...state,
            counter_low: envelope(lows),
            counter_high: envelope(highs),
            asserted: pending.size === 1 ? [...pending][0] : null,
          },
        });
      }
});
