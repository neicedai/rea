import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { bandaiCases, bandaiFixture } from "./nesBandai.fixture.js";
import { traceNesMapperEventsInputSchema } from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { nesBandaiStateSchema } from "./nesBandai.js";
import {
  clockBandaiCpuCycle,
  nesBandaiIrqStateSchema,
} from "./nesBandaiIrq.js";
import type { NesByteValue } from "./nesByteValue.js";

const cycle = { kind: "bandai-cpu-cycle" };
it.each(bandaiCases)(
  "distinguishes $mapper/$variant direct counters, latch copies and explicit CPU cycles",
  async (board) => {
    const { bytes, initial, base, other } = bandaiFixture(board);
    const parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const input = traceNesMapperEventsInputSchema.parse({
      path: "/bandai.nes",
      initial,
      initial_irq: {
        model: board.variant === "fcg" ? "bandai-fcg" : "bandai-lz93d50",
        counter_low: 9,
        counter_high: 8,
        asserted: true,
      },
      events: [
        { kind: "cpu-write", address: base + 11, value: 1 },
        { kind: "cpu-write", address: base + 12, value: 0 },
        { kind: "cpu-write", address: base + 10, value: 0 },
        { kind: "ppu-read", address: 0 },
        { kind: "cpu-write", address: other + 11, value: 255 },
        { kind: "cpu-write", address: base + 10, value: 1 },
        cycle,
        cycle,
        { kind: "cpu-write", address: base + 11, value: 2 },
        { kind: "cpu-write", address: base + 12, value: 1 },
        { kind: "cpu-write", address: base + 10, value: 0 },
        cycle,
      ],
    });
    const trace = await deriveNesMapperEvents(
      parsed.value,
      input.initial,
      input.events,
      { initialIrq: input.initial_irq },
    );
    if (trace.status !== "derived") throw new Error(trace.reason);

    expect(trace.steps[1]?.irq).toMatchObject({
      counter_low: board.variant === "fcg" ? 1 : 9,
      counter_high: board.variant === "fcg" ? 0 : 8,
      asserted: true,
    });
    expect(trace.steps[2]?.irq).toMatchObject({
      counter_low: 1,
      counter_high: 0,
      asserted: false,
    });
    expect(trace.steps[4]?.irq).toEqual(trace.steps[3]?.irq);
    expect(trace.steps[6]?.irq).toMatchObject({
      counter_low: 0,
      counter_high: 0,
      asserted: false,
    });
    expect(trace.steps[7]?.irq).toMatchObject({
      counter_low: 255,
      counter_high: 255,
      asserted: true,
    });
    expect(trace.steps[9]?.irq).toMatchObject({
      counter_low: board.variant === "fcg" ? 2 : 255,
      counter_high: board.variant === "fcg" ? 1 : 255,
    });
    expect(trace.final_irq).toMatchObject({
      counter_low: 2,
      counter_high: 1,
      asserted: false,
    });
    expect(trace.steps.flatMap((s, i) => (s.irq_clock ? [i] : []))).toEqual([
      6, 7,
    ]);
    const first = await deriveNesMapperEvents(
      parsed.value,
      input.initial,
      input.events.slice(0, 7),
      { initialIrq: input.initial_irq },
    );
    if (first.status !== "derived") throw new Error(first.reason);

    const rest = await deriveNesMapperEvents(
      parsed.value,
      first.final,
      input.events.slice(7),
      { initialIrq: first.final_irq },
    );
    if (rest.status !== "derived") throw new Error(rest.reason);

    expect(rest.final_irq).toEqual(trace.final_irq);
  },
);

const proof = (mask: number, value: number): NesByteValue =>
  mask === 0 ? null : mask === 255 ? value : { mask, value };
const values = (value: NesByteValue) =>
  Array.from({ length: 256 }, (_, v) => v).filter((v) =>
    typeof value === "number"
      ? value === v
      : value === null || (v & value.mask) === value.value,
  );
const envelope = (numbers: number[]): NesByteValue => {
  const first = numbers[0]!,
    mask = numbers.reduce((m, v) => m & ~(v ^ first), 255);
  return proof(mask, first & mask);
};

it("matches concrete 16-bit arithmetic for every partial byte on both sides of a borrow", () => {
  const state = nesBandaiStateSchema.parse({
    mapper: 16,
    variant: "fcg",
    irq_control: 1,
  });
  for (let mask = 0; mask < 256; mask++)
    for (let value = 0; value < 256; value++) {
      if ((value & ~mask) !== 0) continue;
      for (const lowPartial of [true, false]) {
        const p = proof(mask, value),
          low = lowPartial ? p : 0,
          high = lowPartial ? 0 : p;
        const words = values(low).flatMap((l) =>
            values(high).map((h) => (h << 8) | l),
          ),
          next = words.map((word) => (word - 1) & 65535);
        const result = clockBandaiCpuCycle(
          nesBandaiIrqStateSchema.parse({
            model: "bandai-fcg",
            counter_low: low,
            counter_high: high,
            asserted: false,
          }),
          state,
        );
        expect(result.clock).toBe(true);
        expect(result.state.counter_low).toEqual(
          envelope(next.map((v) => v & 255)),
        );
        expect(result.state.counter_high).toEqual(
          envelope(next.map((v) => v >> 8)),
        );
        expect(result.state.asserted).toBe(
          words.every((v) => v === 0)
            ? true
            : words.every((v) => v !== 0)
              ? false
              : null,
        );
      }
    }
});

it("joins uncertain enables and rejects invalid counter proofs and mismatched models", async () => {
  const state = nesBandaiStateSchema.parse({ mapper: 16, variant: "fcg" });
  expect(
    clockBandaiCpuCycle(
      nesBandaiIrqStateSchema.parse({
        model: "bandai-fcg",
        counter_low: 0,
        counter_high: 0,
        asserted: false,
      }),
      state,
    ),
  ).toMatchObject({
    clock: null,
    state: { counter_low: null, counter_high: null, asserted: null },
  });
  expect(
    nesBandaiIrqStateSchema.safeParse({
      model: "bandai-fcg",
      counter_low: { mask: 1, value: 2 },
    }).success,
  ).toBe(false);
  const parsed = parseNesHeader(bandaiFixture(bandaiCases[0]).bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  for (const model of ["vrc4", "sharp", "bandai-lz93d50"]) {
    const input = traceNesMapperEventsInputSchema.parse({
      path: "/bandai.nes",
      initial: state,
      initial_irq: { model },
      events: [cycle],
    });
    expect(
      (
        await deriveNesMapperEvents(parsed.value, input.initial, input.events, {
          initialIrq: input.initial_irq,
        })
      ).status,
    ).toBe("unsupported");
  }
});
