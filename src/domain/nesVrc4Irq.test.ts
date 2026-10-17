import {
  nesMapperEventSnapshot,
  type NesLegacyMapperEventsTrace,
} from "./nesMapperEvents.js";
import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mapperTraceFixture } from "./nesMapperTrace.fixture.js";
import {
  nesLegacyMapperEventsTraceSchema,
  traceNesMapperEventsInputSchema,
} from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { clockVrcCpuCycle, nesVrcIrqStateSchema } from "./nesVrcIrq.js";
import type { NesByteValue } from "./nesByteValue.js";

const cycle = { kind: "vrc-cpu-cycle" };
const write = (address: number, value: number | null) => ({
  kind: "cpu-write",
  address,
  value,
});
const trace = async (
  events: unknown[],
  initial: unknown = { mapper: 23, variant: "vrc4" },
  irq: unknown = { model: "vrc4" },
) => {
  const bytes = mapperTraceFixture(23);
  bytes[8] = 0x10;
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/vrc4.nes",
    initial,
    initial_irq: irq,
    events,
  });
  const result = nesLegacyMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header.value, input.initial, input.events, {
      initialIrq: input.initial_irq,
    }),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  return result;
};

it("counts scanline-mode intervals 114/114/113, latches overflow and resumes a mid-interval snapshot", async () => {
  const events = [
    write(0xf000, 14),
    write(0xf001, 15),
    write(0xf002, 3),
    ...Array.from({ length: 341 }, () => cycle),
  ];
  const result = await trace(events);
  expect(result.steps.flatMap((s, i) => (s.irq_clock ? [i] : []))).toEqual([
    116, 230, 343,
  ]);
  expect(result.steps[116]?.irq).toEqual({
    model: "vrc4",
    counter: 255,
    prescaler: [340],
    asserted: false,
  });
  expect(result.steps[230]?.irq).toEqual({
    model: "vrc4",
    counter: 254,
    prescaler: [339],
    asserted: true,
  });
  expect(result.final_irq).toEqual({
    model: "vrc4",
    counter: 255,
    prescaler: [341],
    asserted: true,
  });
  const cut = 60;
  const snapshot = nesMapperEventSnapshot(result, result.steps[cut - 1]!)!;
  const resumed = await trace(events.slice(cut), snapshot.state, snapshot.irq);
  expect(resumed.final_irq).toEqual(result.final_irq);
  expect(
    resumed.steps.map((s) => ({
      ...semanticStep(resumed, s),
      index: s.index + cut,
    })),
  ).toEqual(result.steps.slice(cut).map((s) => semanticStep(result, s)));
});

it("clocks cycle mode, preserves counter on acknowledge and stops disabled counting", async () => {
  const result = await trace([
    write(0xf000, 15),
    write(0xf001, 15),
    write(0xf002, 7),
    cycle,
    write(0xf003, null),
    cycle,
    write(0xf002, 0),
    cycle,
  ]);
  expect(result.steps[3]?.irq).toEqual({
    model: "vrc4",
    counter: 255,
    prescaler: null,
    asserted: true,
  });
  expect(result.steps[4]?.irq).toEqual({
    model: "vrc4",
    counter: 255,
    prescaler: null,
    asserted: false,
  });
  expect(result.steps[5]?.irq).toMatchObject({ counter: 255, asserted: true });
  expect(result.steps[6]?.irq).toMatchObject({ counter: 255, asserted: false });
  expect(result.steps[7]?.irq_clock).toBe(false);
  expect(result.final_irq).toEqual(result.steps[6]?.irq);
});

it("preserves partial reload and counter proofs without inventing overflow", async () => {
  const result = await trace([
    { ...write(0xf000, null), known_bits: { mask: 14, value: 14 } },
    write(0xf001, 15),
    write(0xf002, 6),
    cycle,
  ]);
  expect(result.steps[2]?.irq).toMatchObject({
    counter: { mask: 254, value: 254 },
    asserted: false,
  });
  expect(result.final_irq).toMatchObject({
    counter: { mask: 254, value: 254 },
    asserted: null,
  });
  const scan = await trace(
    [cycle],
    { mapper: 23, variant: "vrc4", irq_control: 2, irq_enabled: true },
    { model: "vrc4", counter: 254, asserted: false },
  );
  expect(scan.steps[0]?.irq_clock).toBeNull();
  expect(scan.final_irq).toEqual({
    model: "vrc4",
    counter: { mask: 254, value: 254 },
    prescaler: null,
    asserted: false,
  });
});

it("does not infer CPU cycles from writes or PPU reads and preserves unknown enable state", async () => {
  const result = await trace(
    [write(0x8000, 2), { kind: "ppu-read", address: 0 }],
    { mapper: 23, variant: "vrc4", irq_control: 6, irq_enabled: true },
    { model: "vrc4", counter: 255, prescaler: [1], asserted: false },
  );
  expect(result.steps.map((s) => s.irq_clock)).toEqual([false, false]);
  expect(result.final_irq).toEqual(result.initial_irq);
  const unknown = await trace(
    [cycle],
    { mapper: 23, variant: "vrc4", irq_control: 6 },
    { model: "vrc4", counter: 255, asserted: false },
  );
  expect(unknown.steps[0]?.irq_clock).toBeNull();
  expect(unknown.final_irq?.asserted).toBeNull();
});

it("joins possible control reloads but retains known prescaler alternatives", async () => {
  const result = await trace(
    [{ ...write(0xf002, null), known_bits: { mask: 4, value: 0 } }],
    { mapper: 23, variant: "vrc4", irq_latch_low: 1, irq_latch_high: 8 },
    { model: "vrc4", counter: 128, prescaler: [15], asserted: true },
  );
  expect(result.final_irq).toEqual({
    model: "vrc4",
    counter: { mask: 254, value: 128 },
    prescaler: [15, 341],
    asserted: false,
  });
});

it("matches every partial counter's concrete one-cycle envelope", () => {
  const mapper = nesMapperStateSchema.parse({
    mapper: 23,
    variant: "vrc4",
    irq_control: 6,
    irq_enabled: true,
    irq_latch_low: 10,
    irq_latch_high: 5,
  });
  if (!("variant" in mapper) || mapper.variant !== "vrc4")
    throw new Error("Expected VRC4");
  const initial = nesVrcIrqStateSchema.parse({
    model: "vrc4",
    asserted: false,
  });
  for (let mask = 0; mask < 256; mask++) {
    for (let value = 0; value < 256; value++) {
      if ((value & ~mask) !== 0) continue;
      const counter: NesByteValue =
        mask === 0 ? null : mask === 255 ? value : { mask, value };
      const old = Array.from({ length: 256 }, (_, byte) => byte).filter(
        (byte) => (byte & mask) === value,
      );
      const next = old.map((byte) => (byte === 255 ? 0x5a : byte + 1));
      const first = next[0]!;
      const common = next.reduce((bits, byte) => bits & ~(byte ^ first), 255);
      const expected =
        common === 0
          ? null
          : common === 255
            ? first
            : { mask: common, value: first & common };
      const actual = clockVrcCpuCycle({ ...initial, counter }, mapper);
      expect(actual.clock).toBe(true);
      expect(actual.state.counter).toEqual(expected);
      expect(actual.state.asserted).toBe(
        old.every((byte) => byte === 255)
          ? true
          : old.includes(255)
            ? null
            : false,
      );
    }
  }
});

it.each([
  { prescaler: [] },
  { prescaler: [0] },
  { prescaler: [342] },
  { prescaler: [1, 1] },
])("rejects invalid prescaler phases $prescaler", ({ prescaler }) => {
  expect(
    nesVrcIrqStateSchema.safeParse({ model: "vrc4", prescaler }).success,
  ).toBe(false);
});

type Trace = Extract<NesLegacyMapperEventsTrace, { status: "derived" }>;
function semanticStep(trace: Trace, step: Trace["steps"][number]) {
  const snapshot = nesMapperEventSnapshot(trace, step);
  if (snapshot === null) throw new Error("Unresolved mapper snapshot");
  const value = { ...step, ...snapshot };
  Reflect.deleteProperty(value, "mapper_snapshot");
  return value;
}
