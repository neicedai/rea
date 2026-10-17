import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mapperTraceFixture } from "./nesMapperTrace.fixture.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import {
  nesMapperEventsTraceSchema,
  nesMapperEventSnapshot,
} from "./nesMapperEvents.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";

const bus = { model: "nmos-6502-bus", dma_reads: "absent" };
const run = async (
  mapper: Parameters<typeof mapperTraceFixture>[0],
  selected: Record<string, unknown>,
) => {
  const bytes = mapperTraceFixture(mapper);
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/irq.nes",
    initial_cpu_bus: bus,
    entry: 0x200,
    initial_ram: [
      { address: 0x200, value: 0xea },
      { address: 0x201, value: 0xea },
    ],
    max_instructions: 2,
    ...selected,
  });
  const prg = bytes.subarray(
    header.value.prgRom.offset,
    header.value.prgRom.offset + header.value.prgRom.size,
  );
  const result = nesCodeTraceSchema.parse(
    await deriveNesCode(header.value, prg, input),
  );
  return { result, header: header.value, prg, input };
};

it("advances CPU-clocked cartridge models through actual fetch/dummy actions and replays their committed states", async () => {
  const cases = [
    {
      mapper: 19,
      initial: { mapper: 19, variant: "namco163", irq_high: 128 },
      irq: {
        model: "namco163",
        counter_low: 252,
        counter_high: 127,
        asserted: false,
      },
      final: { counter_low: 255, counter_high: 127, asserted: true },
      event: "namco163-cpu-cycle",
    },
    {
      mapper: 69,
      initial: { mapper: 69, variant: "fme7", irq_control: 129 },
      irq: { model: "fme7", counter_low: 2, counter_high: 0, asserted: false },
      final: { counter_low: 254, counter_high: 255, asserted: true },
      event: "fme7-cpu-cycle",
    },
    {
      mapper: 16,
      initial: { mapper: 16, variant: "fcg", irq_control: 1 },
      irq: {
        model: "bandai-fcg",
        counter_low: 2,
        counter_high: 0,
        asserted: false,
      },
      final: { counter_low: 254, counter_high: 255, asserted: true },
      event: "bandai-cpu-cycle",
    },
    {
      mapper: 159,
      initial: { mapper: 159, irq_control: 1 },
      irq: {
        model: "bandai-lz93d50",
        counter_low: 2,
        counter_high: 0,
        asserted: false,
      },
      final: { counter_low: 254, counter_high: 255, asserted: true },
      event: "bandai-cpu-cycle",
    },
    {
      mapper: 21,
      initial: {
        mapper: 21,
        variant: "vrc4",
        irq_control: 6,
        irq_enabled: true,
        irq_latch_low: 5,
        irq_latch_high: 2,
      },
      irq: { model: "vrc4", counter: 253, asserted: false },
      final: { counter: 38, asserted: true },
      event: "vrc-cpu-cycle",
    },
    {
      mapper: 24,
      initial: { mapper: 24, irq_control: 6, irq_enabled: true, irq_latch: 37 },
      irq: { model: "vrc6", counter: 253, asserted: false },
      final: { counter: 38, asserted: true },
      event: "vrc-cpu-cycle",
    },
  ] as const;
  for (const sample of cases) {
    const { result, header, prg, input } = await run(sample.mapper, {
      initial: sample.initial,
      initial_irq: sample.irq,
    });
    if (
      result.status !== "derived" ||
      result.mapper_trace.status !== "derived" ||
      !("steps" in result.mapper_trace)
    )
      throw new Error(JSON.stringify(result));
    expect(result.instructions).toHaveLength(2);
    expect(result.mapper_trace).toMatchObject({ final_irq: sample.final });
    expect(
      result.mapper_trace.steps.map((step) =>
        "event" in step ? step.event.kind : null,
      ),
    ).toEqual(Array(4).fill(sample.event));
    const replay = await deriveNesMapperEvents(
      header,
      input.initial,
      result.mapper_trace.steps.flatMap((step) =>
        "event" in step ? [step.event] : [],
      ),
      { prg, initialIrq: input.initial_irq },
    );
    expect(replay).toEqual(result.mapper_trace);
  }
});

it("reads Namco's advancing low counter and live enable bit before the following CPU edge", async () => {
  const program = [0xad, 0, 0x50, 0xad, 0, 0x58];
  const { result } = await run(19, {
    initial: { mapper: 19, variant: "namco163", irq_low: 0, irq_high: 128 },
    initial_irq: {
      model: "namco163",
      counter_low: 250,
      counter_high: 127,
      asserted: false,
    },
    initial_ram: program.map((value, index) => ({
      address: 0x200 + index,
      value,
    })),
  });
  if (result.status !== "derived") throw new Error(result.reason);
  expect(
    result.instructions.map((instruction) => instruction.data_reads[0]?.value),
  ).toEqual([253, 255]);
  expect(result.instructions[0]!.data_reads[0]).toMatchObject({
    mapper_origins: [
      {
        kind: "namco163-irq-counter",
        counter_low: 253,
        counter_high: 127,
        irq_high: 128,
        mapper_event_index: 3,
      },
    ],
  });
  expect(result.mapper_trace).toMatchObject({
    final_irq: { counter_low: 255, counter_high: 127, asserted: true },
  });
});

it("retains partial counter read frontiers and their hypothetical events without committing a failed indirect jump", async () => {
  const program = [0x6c, 0xff, 0x57];
  const { result, header, prg, input } = await run(19, {
    initial: { mapper: 19, variant: "namco163", irq_high: 128 },
    initial_irq: {
      model: "namco163",
      counter_low: { mask: 254, value: 248 },
      counter_high: 127,
      asserted: false,
    },
    initial_ram: program.map((value, index) => ({
      address: 0x200 + index,
      value,
    })),
  });
  if (result.status !== "derived" || !("cpu_bus_frontier" in result.stop))
    throw new Error(JSON.stringify(result));
  expect(result.instructions).toEqual([]);
  expect(result.mapper_trace).toMatchObject({
    steps: [],
    final_irq: input.initial_irq,
  });
  expect(result.cpu_bus?.final.next_cycle_index).toBe(0);
  expect(result.stop.reason).toBe("unknown-control-target");
  expect(result.stop.cpu_bus_frontier.mapper_events).toHaveLength(7);
  expect(result.stop.data_reads.map((read) => read.address)).toEqual([
    0x57ff, 0x5700,
  ]);
  expect(result.stop.data_reads[0]!.mapper_origins[0]).toMatchObject({
    mapper_event_index: 3,
  });
  const hypothetical = await deriveNesMapperEvents(
    header,
    input.initial,
    result.stop.cpu_bus_frontier.mapper_events,
    { prg, initialIrq: input.initial_irq },
  );
  if (hypothetical.status !== "derived") throw new Error(hypothetical.reason);
  expect(hypothetical.final_irq).not.toEqual(input.initial_irq);
});

it("rejects incompatible clocks, missing bus timing and event-index overflow before deriving source work", async () => {
  for (const [mapper, initial, irq, reason] of [
    [4, { mapper: 4 }, { model: "sharp" }, "PPU signals"],
    [5, { mapper: 5 }, { model: "mmc5" }, "PPU signals"],
    [19, { mapper: 19, variant: "namco163" }, { model: "fme7" }, "Mapper 69"],
  ] as const)
    expect(
      (await run(mapper, { initial, initial_irq: irq })).result,
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining(reason),
    });
  expect(
    (
      await run(19, {
        initial: { mapper: 19, variant: "namco163" },
        initial_irq: { model: "namco163" },
        initial_cpu_bus: null,
      })
    ).result,
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("initial_cpu_bus"),
  });
  expect(
    (
      await run(19, {
        initial: { mapper: 19, variant: "namco163" },
        initial_irq: { model: "namco163" },
        max_instructions: Math.floor(Number.MAX_SAFE_INTEGER / 8),
      })
    ).result,
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("event indices"),
  });
});

it("commits accepted-entry IRQ clocks before an unmapped handler fetch", async () => {
  const { result } = await run(19, {
    initial: { mapper: 19, variant: "namco163", irq_high: 128 },
    initial_irq: {
      model: "namco163",
      counter_low: 250,
      counter_high: 127,
      asserted: false,
    },
    entry: { accepted_interrupt: "nmi", return_address: 0x200 },
    cpu: { sp: 0 },
  });
  expect(result).toMatchObject({
    status: "derived",
    instructions: [],
    entry_interrupt: { mapper_event_range: { start: 0, count: 7 } },
    cpu_bus: { final: { next_cycle_index: 7 } },
    mapper_trace: { final_irq: { counter_low: 255, asserted: true } },
    stop: { reason: "unmapped-instruction" },
  });
});

it("gives each elapsed IRQ state one event owner while sharing unchanged mapper snapshots", async () => {
  const { result } = await run(19, {
    initial: { mapper: 19, variant: "namco163", irq_high: 128 },
    initial_irq: {
      model: "namco163",
      counter_low: 0,
      counter_high: 0,
      asserted: false,
    },
  });
  if (
    result.status !== "derived" ||
    result.mapper_trace.status !== "derived" ||
    !("mapper_snapshots" in result.mapper_trace)
  )
    throw new Error(JSON.stringify(result));
  const trace = result.mapper_trace;
  expect(trace.mapper_snapshots).toHaveLength(1);
  expect(trace.mapper_snapshots[0]).not.toHaveProperty("irq");
  expect(
    trace.steps.map((step) => nesMapperEventSnapshot(trace, step)?.irq),
  ).toMatchObject([
    { counter_low: 1 },
    { counter_low: 2 },
    { counter_low: 3 },
    { counter_low: 4 },
  ]);
  const duplicate = structuredClone(trace);
  Object.assign(duplicate.mapper_snapshots[0]!, { irq: null });
  expect(nesMapperEventsTraceSchema.safeParse(duplicate).success).toBe(false);
  const missing = structuredClone(trace);
  for (const step of missing.steps) Reflect.deleteProperty(step, "irq");
  expect(nesMapperEventsTraceSchema.safeParse(missing).success).toBe(false);
  expect(nesMapperEventSnapshot(missing, missing.steps[0]!)).toBeNull();
});
