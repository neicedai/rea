import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { expect, it } from "vitest";

import { deriveNesCode } from "./nesCodeDerivation.js";
import { nesCodeTraceSchema, traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { nesDmcCpuDmaTraceSchema } from "./nesDmcCpuDma.js";

const origin = { kind: "initial-state" };
const apu = () => ({
  model: "apu-registers",
  frame_clocks: "cpu-ordered",
  dmc_reads: "explicit",
  next_event_index: 5000,
  registers: Object.fromEntries(
    [
      [0x4010, 128],
      [0x4012, 37],
      [0x4013, 1],
      [0x4015, 16],
      [0x4017, 64],
    ].map(([address, value]) => [address, { value, origin }]),
  ),
  dmc_remaining: { value: { min: 3, max: 3 }, origin },
  dmc_irq: { value: true, origin },
  lengths: Array.from({ length: 4 }, () => ({
    value: { min: 0, max: 0 },
    origin,
  })),
  frame_irq: { value: false, origin },
  frame_sequencer: {
    region: "ntsc",
    cpu_phase: "get",
    position: { min: 0, max: 0 },
    five_step: false,
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
  },
  dmc: {
    model: "dmc-reader-output",
    region: "ntsc",
    clocks: "cpu-ordered",
    current_address: 0xc940,
    buffer: { status: "full", value: 0x59, origin },
    shift: 0x93,
    bits_remaining: 8,
    silence: false,
    level: 60,
    timer_remaining: 428,
    cpu_timing: {
      model: "2a03-dmc-dma",
      request: { status: "none" },
      stop: { status: "none" },
    },
  },
});

/** Trainer-free source fixture; all cycle expectations are authored below. */
const run = async (
  program: readonly number[],
  selected: Record<string, unknown> = {},
) => {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 1, 0, 8]);
  bytes.set(program, 16 + 0x4240);
  bytes[16 + 0x4940] = 0xe7;
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0xc240, 16 + 32768 - delta);
  const prg = bytes.subarray(16, 16 + 32768),
    chr = bytes.subarray(16 + 32768);
  const {
    trace,
    input,
    header,
  } = await deriveNesFixtureTrace(
    bytes,
    prg,
    {
      path: "/independent-dmc-stop.nes",
      initial: { mapper: 0 },
      entry: 0xc240,
      cpu: { a: 0 },
      initial_cpu_bus: {
        model: "nmos-6502-bus",
        dma_reads: "absent",
        next_cycle_index: 300,
      },
      initial_apu: apu(),
      max_instructions: 2,
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
    input,
    trace,
    dmc: trace.cpu_bus.dmc,
    final: trace.mapper_trace.apu_trace.final,
    mapped: trace.mapper_trace,
    header: header,
    prg,
    chr,
    bytes,
  };
};

type Source = Awaited<ReturnType<typeof run>>;
const cycles = ({ trace, dmc }: Source) =>
  [
    ...trace.instructions.flatMap((instruction) =>
      "cpu_bus_cycles" in instruction ? instruction.cpu_bus_cycles : [],
    ),
    ...dmc.boundary_cycles,
  ].sort((a, b) => a.index - b.index);
const replay = async (source: Source) => {
  const expected = structuredClone(source.mapped);
  expected.apu_trace.frontier = [];
  expect(
    await deriveNesMapperEvents(
      source.header,
      source.input.initial,
      source.mapped.steps.map((step) => step.event),
      {
        prg: source.prg,
        chr: source.chr,
        initialApu: source.input.initial_apu,
      },
    ),
  ).toEqual(expected);
};
const stoppedProof = (source: Source) => {
  const episode = source.dmc.transfers[0]!;
  if (episode.outcome === "sample") throw new Error("Expected stopped episode");
  expect(source.mapped.apu_trace.operations).toContainEqual(
    expect.objectContaining({
      kind: "apu-dmc-stop",
      event_index: episode.stop_event_index,
    }),
  );
  expect(
    nesDmcCpuDmaTraceSchema.safeParse({
      transfers: [{ ...episode, mapper_event_index: 0 }],
      retained_source_bytes: source.dmc.retained_source_bytes,
      frontier: null,
    }).success,
  ).toBe(false);
};

it("delays an explicit reader stop while preserving buffered playback and clearing IRQ at the write", async () => {
  const source = await run([0x8d, 0x15, 0x40, 0xea]);
  expect(source.trace.stop.reason).toBe("instruction-budget");
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(306);
  expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(source.final.dmc_irq.value).toBe(false);
  expect(source.final.dmc).toMatchObject({
    buffer: { status: "full", value: 0x59, origin },
    shift: 0x93,
    bits_remaining: 8,
    level: 60,
    timer_remaining: 422,
    cpu_timing: { request: { status: "none" }, stop: { status: "none" } },
  });
  expect(source.dmc.transfers).toEqual([]);
  expect(source.dmc.retained_source_bytes).toBe(0);
  await replay(source);
});

it("preserves omitted stop history as an unknown source frontier and rejects contradictory phase", async () => {
  const baseline = await run([0xea, 0xea]);
  const omitted = structuredClone(baseline.input);
  delete (omitted.initial_apu!.dmc!.cpu_timing as { stop?: unknown }).stop;
  const trace = nesCodeTraceSchema.parse(
    await deriveNesCode(
      baseline.header,
      baseline.prg,
      traceNesCodeInputSchema.parse(omitted),
      { chr: baseline.chr },
    ),
  );
  expect(trace.status).toBe("derived");
  if (trace.status !== "derived")
    throw new Error("Missing qualified source frontier");
  expect(trace.stop.reason).toBe("dmc-dma-stop-timing");
  expect(trace.instructions).toEqual([]);
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(300);
  const contradictory = structuredClone(baseline.input);
  contradictory.initial_apu!.dmc!.cpu_timing!.stop = {
    status: "pending",
    cause: "explicit",
    delay: 1,
    origin: { kind: "initial-state" },
  };
  expect(
    await deriveNesCode(baseline.header, baseline.prg, contradictory, {
      chr: baseline.chr,
    }),
  ).toMatchObject({ status: "unsupported" });
});

it("qualifies a stop replay event without consuming a CPU edge and rejects an undued event", async () => {
  const baseline = await run([0xea, 0xea]);
  const state = structuredClone(baseline.input.initial_apu!);
  if (state.frame_clocks !== "cpu-ordered")
    throw new Error("Expected ordered CPU framing");
  state.frame_sequencer.cpu_phase = "put";
  state.dmc!.cpu_timing!.stop = {
    status: "pending",
    cause: "explicit",
    delay: 1,
    origin: { kind: "initial-state" },
  };
  const stopped = await deriveNesMapperEvents(
    baseline.header,
    baseline.input.initial,
    [{ kind: "apu-dmc-stop" }],
    {
      prg: baseline.prg,
      chr: baseline.chr,
      initialApu: state,
    },
  );
  if (stopped.status !== "derived" || !("apu_trace" in stopped))
    throw new Error(JSON.stringify(stopped));
  if (stopped.apu_trace.final.frame_clocks !== "cpu-ordered")
    throw new Error("Lost ordered CPU framing");
  expect(stopped.apu_trace.final.frame_sequencer).toEqual(
    state.frame_sequencer,
  );
  expect(stopped.apu_trace.final.dmc).toMatchObject({
    timer_remaining: 428,
    buffer: state.dmc!.buffer,
    cpu_timing: { stop: { status: "none" }, request: { status: "none" } },
  });
  expect(stopped.apu_trace.final.dmc_remaining.value).toEqual({
    min: 0,
    max: 0,
  });
  expect(stopped.apu_trace.operations).toMatchObject([
    { kind: "apu-dmc-stop", event_index: 5000 },
  ]);
  const invalid = await deriveNesMapperEvents(
    baseline.header,
    baseline.input.initial,
    [{ kind: "apu-dmc-stop" }],
    {
      prg: baseline.prg,
      chr: baseline.chr,
      initialApu: baseline.input.initial_apu,
    },
  );
  expect(invalid).toMatchObject({ status: "unsupported" });
});

it("retains the implicit one-byte load stop window even after a qualified explicit stop", async () => {
  const state = apu();
  state.registers[16403]!.value = 0;
  state.dmc_remaining.value = { min: 1, max: 1 };
  Object.assign(state.dmc, {
    buffer: { status: "empty" },
    bits_remaining: 1,
    timer_remaining: 5,
  });
  Object.assign(state.dmc.cpu_timing, {
    request: { status: "pending", type: "load", delay: 0 },
    stop: { status: "pending", delay: 2, origin },
  });
  const source = await run([0xea], { initial_apu: state, max_instructions: 1 });
  expect(source.trace.stop.reason).toBe("dmc-dma-stop-window");
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(300);
  expect(source.dmc.transfers).toEqual([]);
  expect(source.dmc.frontier!.transfers).toEqual([]);
  expect(source.dmc.frontier!.active!.setup).toMatchObject([
    { cycle_index: 300, phase: "halt" },
    { cycle_index: 301, phase: "dummy" },
  ]);
  expect(source.mapped.apu_trace.frontier).toContainEqual(
    expect.objectContaining({ kind: "apu-dmc-stop" }),
  );
});

it.each([
  { phase: "put", timer: 8 },
  { phase: "get", timer: 7 },
])(
  "cancels before a reload halt when stop precedes it by four/five cycles ($phase)",
  async ({ phase, timer }) => {
    const state = apu();
    state.frame_sequencer.cpu_phase = phase;
    Object.assign(state.dmc, { bits_remaining: 1, timer_remaining: timer });
    const source = await run([0x8d, 0x15, 0x40, 0xea, 0xea, 0xea], {
      initial_apu: state,
      max_instructions: 4,
    });
    expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(310);
    expect(source.dmc.transfers).toEqual([]);
    expect(source.dmc.retained_source_bytes).toBe(0);
    expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
    expect(source.final.dmc).toMatchObject({
      buffer: { status: "empty" },
      shift: 0x59,
      bits_remaining: 8,
      level: 62,
    });
    expect(
      source.mapped.steps.some(
        (step) => step.event.kind === "apu-dmc-cpu-read",
      ),
    ).toBe(false);
    await replay(source);
  },
);

it.each([
  { phase: "put", timer: 6, halt: 306, instruction: 2 },
  { phase: "get", timer: 5, halt: 305, instruction: 1 },
])(
  "retains exactly one aborting reload halt after an adjacent stop ($phase)",
  async ({ phase, timer, halt, instruction }) => {
    const state = apu();
    state.frame_sequencer.cpu_phase = phase;
    Object.assign(state.dmc, { bits_remaining: 1, timer_remaining: timer });
    const source = await run([0x8d, 0x15, 0x40, 0xea, 0xea, 0xea], {
      initial_apu: state,
      max_instructions: 4,
    });
    expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(311);
    expect(source.dmc.transfers).toMatchObject([
      {
        outcome: "aborted",
        type: "reload",
        before_instruction_index: instruction,
        cause: "explicit-stop",
        stop_origin: { kind: "event-write", index: 5003 },
        first_cycle_index: halt,
        setup: [{ cycle_index: halt, phase: "halt", shared_with_oam: false }],
      },
    ]);
    const episode = source.dmc.transfers[0]!;
    expect("sample_cycle_index" in episode).toBe(false);
    expect("mapper_event_index" in episode).toBe(false);
    stoppedProof(source);
    expect(cycles(source).find((cycle) => cycle.index === halt)).toMatchObject({
      kind: "read",
      role: "dmc-halt",
    });
    expect(source.dmc.retained_source_bytes).toBeGreaterThan(0);
    expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
    expect(source.final.dmc).toMatchObject({
      buffer: { status: "empty" },
      current_address: 0xc940,
    });
    expect(
      source.mapped.steps.some(
        (step) => step.event.kind === "apu-dmc-cpu-read",
      ),
    ).toBe(false);
    await replay(source);
  },
);

it.each([
  {
    phase: "put",
    timer: 4,
    halt: 304,
    get: 307,
    setup: ["halt", "dummy", "alignment"],
    next: 310,
  },
  {
    phase: "get",
    timer: 3,
    halt: 304,
    get: 306,
    setup: ["halt", "dummy"],
    next: 309,
  },
])(
  "retains a real discarded get when the stop misses the halt-only abort window ($phase)",
  async ({ phase, timer, halt, get, setup, next }) => {
    const state = apu();
    state.frame_sequencer.cpu_phase = phase;
    Object.assign(state.dmc, { bits_remaining: 1, timer_remaining: timer });
    const source = await run([0x8d, 0x15, 0x40, 0xea], { initial_apu: state });
    expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(next);
    expect(source.dmc.transfers).toMatchObject([
      {
        outcome: "discarded",
        type: "reload",
        cause: "explicit-stop",
        stop_origin: { kind: "event-write", index: 5003 },
        first_cycle_index: halt,
        get_cycle_index: get,
      },
    ]);
    const episode = source.dmc.transfers[0]!;
    expect(episode.setup.map((cycle) => cycle.phase)).toEqual(setup);
    expect("sample_cycle_index" in episode).toBe(false);
    expect("mapper_event_index" in episode).toBe(false);
    stoppedProof(source);
    expect(cycles(source).find((cycle) => cycle.index === get)).toMatchObject({
      kind: "read",
      role: "dmc-get",
      read: { address: 0xc940, value: 0xe7, file_offset: 16 + 0x4940 },
    });
    expect(source.final.dmc).toMatchObject({
      buffer: { status: "empty" },
      current_address: 0xc940,
    });
    expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
    expect(source.final.dmc_irq.value).toBe(false);
    expect(
      source.mapped.steps.some(
        (step) => step.event.kind === "apu-dmc-cpu-read",
      ),
    ).toBe(false);
    await replay(source);
  },
);

it("does not commit a budget-stopped discarded transfer or its hypothetical stop edges", async () => {
  const state = apu();
  state.frame_sequencer.cpu_phase = "put";
  Object.assign(state.dmc, { bits_remaining: 1, timer_remaining: 4 });
  const source = await run([0x8d, 0x15, 0x40, 0xea], {
    initial_apu: state,
    max_dmc_dma_source_bytes: 0,
  });
  expect(source.trace.stop.reason).toBe("dmc-dma-source-budget");
  expect(source.trace.instructions).toHaveLength(1);
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(304);
  expect(source.dmc.transfers).toEqual([]);
  expect(source.dmc.retained_source_bytes).toBe(0);
  expect(source.final.dmc_remaining.value).toEqual({ min: 3, max: 3 });
  expect(source.final.dmc!.cpu_timing!.stop).toEqual({
    status: "pending",
    cause: "explicit",
    delay: 3,
    origin: { kind: "event-write", index: 5003 },
  });
});

it("makes an expiring stop visible to a halted status read and budgets that raw proof without a sample", async () => {
  const state = apu();
  state.frame_sequencer.cpu_phase = "put";
  state.dmc_irq.value = false;
  state.frame_irq.value = true;
  state.registers[16407]!.value = 0;
  Object.assign(state.dmc, { buffer: { status: "empty" } });
  Object.assign(state.dmc.cpu_timing, {
    request: { status: "pending", type: "reload", delay: 0 },
    stop: { status: "pending", delay: 1, origin },
  });
  const selected = {
    entry: 0x4015,
    initial_apu: state,
    max_instructions: 1,
    initial_cpu_io: {
      model: "2a03-io",
      controller_clocking: "contiguous",
      active_controller: 0,
      cpu_latch: 32,
      external_latch: 0,
    },
  };
  const source = await run([2], selected);
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(301);
  expect(source.dmc.transfers).toMatchObject([
    {
      outcome: "aborted",
      cause: "explicit-stop",
      stop_origin: origin,
      setup: [{ cycle_index: 300, phase: "halt", shared_with_oam: false }],
    },
  ]);
  const halted = source.dmc.boundary_cycles[0]!;
  expect(halted).toMatchObject({
    kind: "read",
    role: "dmc-halt",
    read: { address: 0x4015, value: 0x60, file_offset: null },
  });
  if (halted.kind !== "read") throw new Error("Missing halt proof");
  const bytes = Buffer.byteLength(JSON.stringify(halted.read), "utf8");
  expect(source.dmc.retained_source_bytes).toBe(bytes);
  expect(source.final.frame_irq.value).toBe(false);
  expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(
    source.mapped.steps.some((step) => step.event.kind === "apu-dmc-cpu-read"),
  ).toBe(false);
  const exact = await run([2], {
    ...selected,
    max_dmc_dma_source_bytes: bytes,
  });
  expect(exact.trace).toEqual(source.trace);
  const short = await run([2], {
    ...selected,
    max_dmc_dma_source_bytes: bytes - 1,
  });
  expect(short.trace.stop.reason).toBe("dmc-dma-source-budget");
  expect(short.trace.cpu_bus!.final.next_cycle_index).toBe(300);
  expect(short.dmc.retained_source_bytes).toBe(0);
  expect(short.dmc.transfers).toEqual([]);
  expect(short.final.frame_irq.value).toBe(true);
  expect(short.final.dmc_remaining.value).toEqual({ min: 3, max: 3 });
  await replay(source);
});

it.each([
  { phase: "get", stopDelay: 2, loadDelay: 2 },
  { phase: "put", stopDelay: 1, loadDelay: 3 },
])(
  "keeps the RMW dummy disable pending through a subsequent enable ($phase)",
  async ({ phase, stopDelay, loadDelay }) => {
    const state = apu();
    state.frame_sequencer.cpu_phase = phase;
    state.registers[16405]!.value = 8;
    state.lengths[3]!.value = { min: 2, max: 2 };
    state.dmc_remaining.value = { min: 0, max: 0 };
    state.dmc_irq.value = false;
    Object.assign(state.dmc, { buffer: { status: "empty" } });
    const selected = {
      initial_apu: state,
      initial_cpu_io: {
        model: "2a03-io",
        controller_clocking: "contiguous",
        active_controller: 0,
        cpu_latch: 0,
        external_latch: 0,
      },
    };
    const prefix = await run([0x0e, 0x15, 0x40, 0xea], {
      ...selected,
      max_instructions: 1,
    });
    expect(prefix.trace.instructions[0]!.data_reads[0]).toMatchObject({
      address: 0x4015,
      value: 8,
      file_offset: null,
    });
    expect(
      prefix.trace.instructions[0]!.writes.map((write) => write.value),
    ).toEqual([8, 16]);
    expect(prefix.final.dmc!.cpu_timing).toMatchObject({
      request: { status: "pending", type: "load", delay: loadDelay },
      stop: {
        status: "pending",
        delay: stopDelay,
        origin: { kind: "event-write", index: 5005 },
      },
    });
    const full = await run([0x0e, 0x15, 0x40, 0xea], selected);
    expect(full.trace.cpu_bus!.final.next_cycle_index).toBe(308);
    expect(full.dmc.transfers).toEqual([]);
    expect(full.final.registers[16405]!.value).toBe(16);
    expect(full.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
    const continued = await run([0x0e, 0x15, 0x40, 0xea], {
      ...selected,
      entry: prefix.trace.stop.address,
      cpu: prefix.trace.final_cpu,
      initial: prefix.mapped.final,
      initial_apu: prefix.final,
      initial_cpu_bus: prefix.trace.cpu_bus!.final,
      initial_cpu_io:
        prefix.trace.cpu_bus !== null && "io" in prefix.trace.cpu_bus
          ? prefix.trace.cpu_bus.io.final
          : null,
      max_instructions: 1,
    });
    expect(continued.final).toEqual(full.final);
    expect(continued.trace.cpu_bus!.final).toEqual(full.trace.cpu_bus!.final);
    await replay(full);
  },
);

it("applies an old stop before a same-edge enable and retains the new non-null sample identities", async () => {
  const state = apu();
  state.registers[16405]!.value = 0;
  state.dmc_irq.value = false;
  Object.assign(state.dmc, { buffer: { status: "empty" } });
  Object.assign(state.dmc.cpu_timing, {
    request: { status: "pending", type: "load", delay: 4 },
    stop: { status: "pending", delay: 4, origin },
  });
  const source = await run([0x8d, 0x15, 0x40, 0xea, 0xea], {
    initial_apu: state,
    cpu: { a: 16 },
    max_instructions: 3,
  });
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(311);
  expect(source.dmc.transfers).toMatchObject([
    {
      outcome: "sample",
      first_cycle_index: 306,
      sample_cycle_index: 308,
    },
  ]);
  const sample = source.dmc.transfers[0]!;
  if (sample.outcome !== "sample") throw new Error("Missing new sample");
  expect(sample.mapper_event_index).toBe(11);
  expect(source.mapped.steps[sample.mapper_event_index]).toMatchObject({
    dmc_read: {
      value: 0xe7,
      source: { kind: "cpu-dma", index: 5011, cycle_index: 308 },
    },
  });
  expect(source.final.dmc_remaining.value).toEqual({ min: 16, max: 16 });
  expect(source.final.dmc!.buffer).toMatchObject({
    status: "full",
    value: 0xe7,
  });
  const report = {
    transfers: source.dmc.transfers,
    retained_source_bytes: source.dmc.retained_source_bytes,
    frontier: null,
  };
  expect(nesDmcCpuDmaTraceSchema.safeParse(report).success).toBe(true);
  expect(
    nesDmcCpuDmaTraceSchema.safeParse({
      ...report,
      transfers: [{ ...sample, sample_cycle_index: null }],
    }).success,
  ).toBe(false);
  expect(
    nesDmcCpuDmaTraceSchema.safeParse({
      ...report,
      transfers: [{ ...sample, mapper_event_index: null }],
    }).success,
  ).toBe(false);
  await replay(source);
});
