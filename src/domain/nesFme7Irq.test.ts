import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { fme7Fixture } from "./nesFme7.fixture.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { traceNesMapperEventsInputSchema } from "./nesMapperEvents.js";
import { clockFme7CpuCycle, nesFme7IrqStateSchema } from "./nesFme7Irq.js";
import { nesFme7StateSchema } from "./nesFme7.js";

const command = (cmd: number, value: number) => [
  { kind: "cpu-write", address: 0x8000, value: cmd },
  { kind: "cpu-write", address: 0xa000, value },
];
const cycle = { kind: "fme7-cpu-cycle" };
it.each(["fme7", "5a", "5b"] as const)(
  "calculates %s count enable, direct bytes, independent IRQ enable and continuation",
  async (variant) => {
    const { bytes } = fme7Fixture(variant),
      header = parseNesHeader(bytes);
    if (!header.ok) throw new Error(header.error);
    const input = traceNesMapperEventsInputSchema.parse({
      path: "/fme7.nes",
      initial: { mapper: 69, variant },
      initial_irq: { model: "fme7" },
      events: [
        ...command(14, 1),
        ...command(15, 0),
        ...command(13, 0x80),
        { kind: "ppu-read", address: 0 },
        cycle,
        cycle,
        ...command(13, 1),
        cycle,
        ...command(14, 0),
        ...command(15, 0),
        ...command(13, 0x81),
        cycle,
        ...command(14, 2),
        ...command(15, 1),
        cycle,
        ...command(13, 0x80),
        cycle,
      ],
    });
    const trace = await deriveNesMapperEvents(
      header.value,
      input.initial,
      input.events,
      { initialIrq: input.initial_irq },
    );
    if (trace.status !== "derived") throw new Error(trace.reason);

    expect(trace.steps[6]?.irq).toMatchObject({
      counter_low: 1,
      counter_high: 0,
      asserted: false,
    });
    expect(trace.steps[8]?.irq).toMatchObject({
      counter_low: 255,
      counter_high: 255,
      asserted: false,
    });
    expect(trace.steps[11]?.irq_clock).toBe(false);
    expect(trace.steps[18]?.irq).toMatchObject({
      counter_low: 255,
      counter_high: 255,
      asserted: true,
    });
    expect(trace.steps[23]?.irq).toMatchObject({
      counter_low: 1,
      counter_high: 1,
      asserted: true,
    });
    expect(trace.final_irq).toMatchObject({
      counter_low: 0,
      counter_high: 1,
      asserted: false,
    });
    const first = await deriveNesMapperEvents(
      header.value,
      input.initial,
      input.events.slice(0, 19),
      { initialIrq: input.initial_irq },
    );
    if (first.status !== "derived") throw new Error(first.reason);

    const rest = await deriveNesMapperEvents(
      header.value,
      first.final,
      input.events.slice(19),
      { initialIrq: first.final_irq },
    );
    if (rest.status !== "derived") throw new Error(rest.reason);

    expect(rest.final_irq).toEqual(trace.final_irq);
    expect(rest.final).toEqual(trace.final);
  },
);

it("joins counter and assertion proofs independently under partial count/IRQ enable", () => {
  const previous = nesFme7IrqStateSchema.parse({
    model: "fme7",
    counter_low: 0,
    counter_high: 0,
    asserted: false,
  });
  const state = (control: unknown) =>
    nesFme7StateSchema.parse({
      mapper: 69,
      variant: "fme7",
      irq_control: control,
    });
  expect(
    clockFme7CpuCycle(previous, state({ mask: 1, value: 1 })),
  ).toMatchObject({
    clock: null,
    state: { counter_low: null, counter_high: null, asserted: null },
  });
  expect(
    clockFme7CpuCycle(previous, state({ mask: 128, value: 128 })),
  ).toMatchObject({
    clock: true,
    state: { counter_low: 255, counter_high: 255, asserted: null },
  });
  expect(
    clockFme7CpuCycle({ ...previous, asserted: true }, state(0)),
  ).toMatchObject({ clock: false, state: { asserted: true } });
});

it("retains uncertain parameter destinations without false acknowledgement or latch reload", async () => {
  const header = parseNesHeader(fme7Fixture("fme7").bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/fme7.nes",
    initial: {
      mapper: 69,
      variant: "fme7",
      command: { mask: 13, value: 13 },
      irq_control: 0,
    },
    initial_irq: {
      model: "fme7",
      counter_low: 5,
      counter_high: 255,
      asserted: true,
    },
    events: [{ kind: "cpu-write", address: 0xa000, value: 0 }, cycle],
  });
  const trace = await deriveNesMapperEvents(
    header.value,
    input.initial,
    input.events,
    { initialIrq: input.initial_irq },
  );
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.steps[0]?.write_effect).toBe("uncertain-register-write");
  expect(trace.final_irq).toMatchObject({
    counter_low: 5,
    counter_high: null,
    asserted: null,
  });
  expect(trace.steps[1]?.irq_clock).toBe(false);
});

it("rejects incompatible clock families and missing or mismatched IRQ models", async () => {
  const header = parseNesHeader(fme7Fixture("fme7").bytes);
  if (!header.ok) throw new Error(header.error);
  for (const [model, events] of [
    [null, [cycle]],
    ["sharp", [cycle]],
    ["bandai-fcg", [cycle]],
    ["fme7", [{ kind: "bandai-cpu-cycle" }]],
    ["fme7", [{ kind: "vrc-cpu-cycle" }]],
    ["fme7", [{ kind: "mmc3-irq-clock" }]],
  ] as const) {
    const input = traceNesMapperEventsInputSchema.parse({
      path: "/fme7.nes",
      initial: { mapper: 69, variant: "fme7" },
      initial_irq: model === null ? null : { model },
      events,
    });
    expect(
      (
        await deriveNesMapperEvents(header.value, input.initial, input.events, {
          initialIrq: input.initial_irq,
        })
      ).status,
    ).toBe("unsupported");
  }
});
