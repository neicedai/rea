import { expect, it } from "vitest";
import {
  deriveNesFixtureTrace,
  expectNesFixtureMapperReplay as replay,
} from "./nesSource.fixture.js";

const origin = { kind: "initial-state" };
const program = [0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0xea, 0xea, 2];
function apu(long = false) {
  return {
    model: "apu-registers",
    frame_clocks: "cpu-ordered",
    dmc_reads: "explicit",
    next_event_index: 16000,
    registers: Object.fromEntries(
      [
        [0x4010, 143],
        [0x4012, 38],
        [0x4013, long ? 1 : 0],
        [0x4015, 0],
        [0x4017, 64],
      ].map(([address, value]) => [address, { value, origin }]),
    ),
    lengths: Array.from({ length: 4 }, () => ({
      value: { min: 0, max: 0 },
      origin,
    })),
    dmc_remaining: { value: { min: 0, max: 0 }, origin },
    dmc_irq: { value: false, origin },
    frame_irq: { value: false, origin },
    frame_sequencer: {
      region: "ntsc",
      cpu_phase: "put",
      position: { min: 0, max: 0 },
      five_step: false,
      reset_delay: { min: 0, max: 0 },
      clock_block: 0,
    },
    dmc: {
      model: "dmc-reader-output",
      region: "ntsc",
      clocks: "cpu-ordered",
      current_address: 0xc980,
      buffer: { status: "empty" },
      shift: 2,
      bits_remaining: 1,
      silence: false,
      level: 64,
      timer_remaining: 13,
      cpu_timing: {
        model: "2a03-dmc-dma",
        duplication: "disabled",
        request: { status: "none" },
        stop: { status: "none" },
      },
    },
  };
}
const oam = {
  initial_cpu_dma: {
    model: "oam-cpu-dma",
    region: "ntsc",
    cpu_phase: "get",
    oam_dma_pending: { status: "pending", page: 0x92 },
  },
  initial_ppu: {
    model: "ppu-memory",
    register_writes_enabled: true,
    access_phase: "non-rendering",
    dma_reads: "absent",
    chr_ram_size: null,
    nametable_layout: "ciram-2k",
    control: 0,
    mask: 0,
    oam: {
      model: "oam-memory",
      address: 211,
      retention: "stable",
      reads: "supported",
      dma_pending: { status: "pending", page: 0x92 },
    },
  },
};
async function run(selected: Record<string, unknown> = {}, code = program) {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 1, 0, 8]);
  bytes.set(code, 16 + 0x42c0);
  bytes[16 + 0x4980] = 0x81;
  bytes[16 + 0x4981] = 0x96;
  for (let index = 0; index < 256; index++)
    bytes[16 + 0x1200 + index] = (index * 23 + 0x2d) & 255;
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0xc2c0, 16 + 32768 - delta);
  const prg = bytes.subarray(16, 16 + 32768),
    chr = bytes.subarray(16 + 32768);
  const { trace, input, header } = await deriveNesFixtureTrace(
    bytes,
    prg,
    {
      path: "/independent-dmc-phase.nes",
      initial: { mapper: 0 },
      entry: 0xc2c0,
      max_instructions: 5,
      initial_cpu_bus: {
        model: "nmos-6502-bus",
        dma_reads: "absent",
        next_cycle_index: 1500,
      },
      initial_apu: apu(),
      ...selected,
    },
    { chr },
  );
  if (
    trace.cpu_bus === null ||
    !("dmc" in trace.cpu_bus) ||
    trace.mapper_trace.status !== "derived" ||
    !("apu_trace" in trace.mapper_trace)
  )
    throw new Error(JSON.stringify(trace));
  return {
    trace,
    dmc: trace.cpu_bus.dmc,
    mapped: trace.mapper_trace,
    final: trace.mapper_trace.apu_trace.final,
    input,
    header,
    prg,
    chr,
  };
}
type Source = Awaited<ReturnType<typeof run>>;

function gets(source: Source) {
  return [
    ...source.trace.instructions.flatMap((instruction) =>
      "cpu_bus_cycles" in instruction ? instruction.cpu_bus_cycles : [],
    ),
    ...source.dmc.boundary_cycles,
    ...("cpu_dma" in source.trace
      ? source.trace.cpu_dma.transfers.flatMap(
          (transfer) => transfer.cpu_bus_cycles,
        )
      : []),
  ].filter((cycle) => cycle.kind === "read" && cycle.role === "dmc-get");
}

it("halts on the next get immediately after a normal put-cycle byte boundary", async () => {
  const source = await run({ initial_apu: apu(true) });
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(1518);
  expect(source.dmc.transfers).toMatchObject([
    {
      type: "load",
      outcome: "sample",
      first_cycle_index: 1509,
      sample_cycle_index: 1511,
    },
    {
      type: "reload",
      outcome: "sample",
      first_cycle_index: 1513,
      sample_cycle_index: 1515,
      setup: [
        { cycle_index: 1513, phase: "halt" },
        { cycle_index: 1514, phase: "dummy" },
      ],
    },
  ]);
  expect(gets(source)).toMatchObject([
    {
      index: 1511,
      read: { address: 0xc980, value: 0x81, file_offset: 16 + 0x4980 },
    },
    {
      index: 1515,
      read: { address: 0xc981, value: 0x96, file_offset: 16 + 0x4981 },
    },
  ]);
  expect(source.final.dmc_remaining.value).toEqual({ min: 15, max: 15 });
  expect(source.final.dmc).toMatchObject({
    buffer: { status: "full", value: 0x96 },
    shift: 0x81,
    level: 62,
    timer_remaining: 49,
  });
  await replay(source);
});

it("stops in the reload dummy and retains its real discarded get, IRQ and first-byte playback", async () => {
  const source = await run();
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(1518);
  expect(source.dmc.transfers).toMatchObject([
    {
      type: "load",
      outcome: "sample",
      sample_cycle_index: 1511,
      mapper_event_index: 13,
    },
    {
      type: "reload",
      outcome: "discarded",
      first_cycle_index: 1513,
      get_cycle_index: 1515,
      cause: "implicit-stop",
      stop_origin: { kind: "dmc-read", index: 16013, cycle_index: 1511 },
      stop_event_index: 16016,
      setup: [
        { cycle_index: 1513, phase: "halt" },
        { cycle_index: 1514, phase: "dummy" },
      ],
    },
  ]);
  expect(gets(source)).toMatchObject([
    { index: 1511, read: { address: 0xc980, value: 0x81 } },
    { index: 1515, read: { address: 0xc980, value: 0x81 } },
  ]);
  expect(
    source.mapped.steps.filter(
      (step) => step.event.kind === "apu-dmc-cpu-read",
    ),
  ).toHaveLength(1);
  expect(source.final.dmc_irq).toEqual({
    value: true,
    origin: { kind: "dmc-read", index: 16013 },
  });
  expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(source.final.dmc).toMatchObject({
    current_address: 0xc980,
    buffer: { status: "empty" },
    shift: 0x81,
    shift_origin: { kind: "dmc-read", index: 16013 },
    level: 66,
    timer_remaining: 49,
  });
  await replay(source);
  const exact = await run({
    max_dmc_dma_source_bytes: source.dmc.retained_source_bytes,
  });
  expect(exact.trace).toEqual(source.trace);
  const short = await run({
    max_dmc_dma_source_bytes: source.dmc.retained_source_bytes - 1,
  });
  expect(short.trace.stop.reason).toBe("dmc-dma-source-budget");
  expect(short.trace.instructions).toHaveLength(4);
  expect(short.trace.cpu_bus!.final.next_cycle_index).toBe(1513);
  expect(short.dmc.transfers).toHaveLength(1);
  expect(short.dmc.frontier!.active).toMatchObject({
    type: "reload",
    first_cycle_index: 1513,
  });
  const prefix = await run({ max_instructions: 4 });
  const resumed = await run({
    entry: prefix.trace.stop.address,
    cpu: prefix.trace.final_cpu,
    initial: prefix.mapped.final,
    initial_cpu_bus: prefix.trace.cpu_bus!.final,
    initial_apu: prefix.final,
    max_instructions: 1,
  });
  expect(resumed.final).toEqual(source.final);
  expect(resumed.trace.cpu_bus!.final).toEqual(source.trace.cpu_bus!.final);
});

it.each([true, false])(
  "retries a write-blocked normal request but respects an implicit stop deadline (long=$long)",
  async (long) => {
    const source = await run(
      { initial_apu: apu(long) },
      [0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0x85, 0x10, 0xea, 2],
    );
    expect(source.trace.instructions[3]!.writes).toMatchObject([
      { address: 16, value: 16 },
    ]);
    const second = source.dmc.transfers[1]!;
    expect(second.first_cycle_index).toBe(1514);
    if (long) {
      expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(1520);
      expect(second).toMatchObject({
        outcome: "sample",
        sample_cycle_index: 1517,
      });
      expect(second.setup.map((item) => item.phase)).toEqual([
        "halt",
        "dummy",
        "alignment",
      ]);
    } else {
      expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(1517);
      expect(second).toMatchObject({
        outcome: "aborted",
        cause: "implicit-stop",
        setup: [{ cycle_index: 1514, phase: "halt" }],
      });
      expect(source.final.dmc_irq).toEqual({
        value: true,
        origin: { kind: "dmc-read", index: 16013 },
      });
    }
    await replay(source);
  },
);

it("expires the implicit stop through two consecutive RMW writes without retrying a halt", async () => {
  const source = await run(
    { initial_ram: [{ address: 16, value: 3 }], max_instructions: 4 },
    [0xa9, 16, 0x8d, 0x15, 0x40, 0x0e, 0x10, 0, 0xea, 2],
  );
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(1517);
  expect(
    source.trace.instructions[2]!.writes.map((write) => write.value),
  ).toEqual([3, 6]);
  expect(source.dmc.transfers).toHaveLength(1);
  expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(source.final.dmc_irq).toEqual({
    value: true,
    origin: { kind: "dmc-read", index: 16013 },
  });
  expect(source.final.dmc!.cpu_timing).toMatchObject({
    request: { status: "none" },
    stop: { status: "none" },
  });
  await replay(source);
});

it("retains caller reload latency without using it to invent a get/put phase", async () => {
  const state = apu(true);
  state.registers[16405]!.value = 16;
  state.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(state.dmc, { bits_remaining: 8, timer_remaining: 54 });
  Object.assign(state.dmc.cpu_timing, {
    request: { status: "pending", type: "reload", delay: 1 },
  });
  const known = await run({ initial_apu: state, max_instructions: 1 }, [0xea]);
  expect(known.trace.cpu_bus!.final.next_cycle_index).toBe(1505);
  expect(known.dmc.transfers).toMatchObject([
    { type: "reload", first_cycle_index: 1501, sample_cycle_index: 1503 },
  ]);
  await replay(known);
  Object.assign(state.frame_sequencer, { cpu_phase: null });
  const unknown = await run(
    { initial_apu: state, max_instructions: 1 },
    [0xea],
  );
  expect(unknown.trace.stop.reason).toBe("dmc-dma-phase");
  expect(unknown.trace.cpu_bus!.final.next_cycle_index).toBe(1500);
  expect(unknown.dmc.frontier!.active).toBeNull();
});

it("shares the late implicit stop's halt and dummy with actual OAM get/put actions", async () => {
  const state = apu();
  state.frame_sequencer.cpu_phase = "get";
  state.registers[16405]!.value = 16;
  state.dmc_remaining.value = { min: 1, max: 1 };
  state.dmc.timer_remaining = 4;
  Object.assign(state.dmc.cpu_timing, {
    request: { status: "pending", type: "load", delay: 0 },
  });
  const source = await run({
    ...oam,
    entry: 0xe120,
    max_instructions: 1,
    initial_apu: state,
  });
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(2018);
  expect(source.dmc.transfers).toMatchObject([
    { type: "load", outcome: "sample", sample_cycle_index: 1502 },
    {
      type: "reload",
      outcome: "discarded",
      get_cycle_index: 1506,
      setup: [
        { cycle_index: 1504, phase: "halt", shared_with_oam: true },
        { cycle_index: 1505, phase: "dummy", shared_with_oam: true },
      ],
    },
  ]);
  await replay(source);
});

it("drains a reload queued by the final OAM put and rolls back an under-budget tail", async () => {
  const state = apu(true);
  state.frame_sequencer.cpu_phase = "get";
  state.registers[16400]!.value = 128;
  state.registers[16405]!.value = 16;
  state.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(state.dmc, {
    buffer: { status: "full", value: 0x59, origin },
    bits_remaining: 2,
    timer_remaining: 86,
  });
  const input = {
    ...oam,
    entry: 0xe120,
    max_instructions: 1,
    initial_apu: state,
  };
  const source = await run(input);
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(2017);
  expect(source.dmc.boundary_cycles).toEqual([]);
  expect(source.dmc.transfers).toMatchObject([
    {
      type: "reload",
      outcome: "sample",
      first_cycle_index: 2014,
      sample_cycle_index: 2016,
      setup: [
        { cycle_index: 2014, phase: "halt", shared_with_oam: false },
        { cycle_index: 2015, phase: "dummy", shared_with_oam: false },
      ],
    },
  ]);
  if (!("cpu_dma" in source.trace)) throw new Error("Missing OAM trace");
  const transfer = source.trace.cpu_dma.transfers[0]!;
  expect(transfer.cpu_bus_cycles).toHaveLength(517);
  for (const [index, write] of transfer.writes.entries())
    expect(write.value).toBe((index * 23 + 0x2d) & 255);
  await replay(source);
  const short = await run({
    ...input,
    max_dmc_dma_source_bytes: source.dmc.retained_source_bytes - 1,
  });
  expect(short.trace.stop.reason).toBe("dmc-dma-source-budget");
  expect(short.trace.cpu_bus!.final.next_cycle_index).toBe(1500);
  if (!("cpu_dma" in short.trace))
    throw new Error("Missing OAM budget frontier");
  expect(short.trace.cpu_dma.transfers).toEqual([]);
  expect(short.trace.cpu_dma.frontier!.writes).toHaveLength(256);
  expect(short.dmc.frontier!.active).toMatchObject({
    type: "reload",
    first_cycle_index: 2014,
  });
});
