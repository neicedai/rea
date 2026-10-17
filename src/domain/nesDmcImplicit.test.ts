import { expect, it } from "vitest";
import {
  deriveNesFixtureTrace,
  expectNesFixtureMapperReplay as replay,
} from "./nesSource.fixture.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";

const origin = { kind: "initial-state" };
const start = [0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0xea, 0xea, 2];
const apu = (timer = 12, duplication = "enabled") => ({
  model: "apu-registers",
  frame_clocks: "cpu-ordered",
  dmc_reads: "explicit",
  next_event_index: 8000,
  registers: Object.fromEntries(
    [
      [0x4010, 143],
      [0x4012, 37],
      [0x4013, 0],
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
    current_address: 0xc940,
    buffer: { status: "empty" },
    shift: 2,
    bits_remaining: 1,
    silence: false,
    level: 64,
    timer_remaining: timer,
    cpu_timing: {
      model: "2a03-dmc-dma",
      duplication,
      request: { status: "none" },
      stop: { status: "none" },
    },
  },
});
/** Independent immutable ROM with nonzero event and physical cycle identities. */
async function run(selected: Record<string, unknown> = {}, program = start) {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 1, 0, 8]);
  bytes.set(program, 16 + 0x4280);
  bytes[16 + 0x4940] = 0x81;
  bytes[16 + 0x4980] = 0x96;
  for (let index = 0; index < 256; index++)
    bytes[16 + 0x1200 + index] = (index * 13 + 0x21) & 255;
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0xc280, 16 + 32768 - delta);
  const prg = bytes.subarray(16, 16 + 32768),
    chr = bytes.subarray(16 + 32768);
  const { trace, input, header } = await deriveNesFixtureTrace(
    bytes,
    prg,
    {
      path: "/independent-dmc-implicit.nes",
      initial: { mapper: 0 },
      entry: 0xc280,
      initial_cpu_bus: {
        model: "nmos-6502-bus",
        dma_reads: "absent",
        next_cycle_index: 900,
      },
      initial_apu: apu(),
      max_instructions: 4,
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

function samples(source: Source) {
  return source.dmc.transfers.map((episode) => {
    if (episode.outcome !== "sample") throw new Error("Expected delivered DMA");
    return source.mapped.steps[episode.mapper_event_index]!;
  });
}
function rawGets(source: Source) {
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

it("finishes a duplicate in the same DMA burst before resuming the halted CPU read", async () => {
  const source = await run();
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(917);
  expect(source.dmc.transfers).toMatchObject([
    {
      outcome: "sample",
      type: "load",
      first_cycle_index: 909,
      sample_cycle_index: 911,
      mapper_event_index: 13,
    },
    {
      outcome: "sample",
      type: "duplicate",
      first_cycle_index: 912,
      sample_cycle_index: 915,
      mapper_event_index: 18,
      request_origin: { kind: "dmc-read", index: 8013, cycle_index: 911 },
      setup: [
        { cycle_index: 912, phase: "halt" },
        { cycle_index: 913, phase: "dummy" },
        { cycle_index: 914, phase: "alignment" },
      ],
    },
  ]);
  expect(samples(source)).toMatchObject([
    {
      event: { output_boundary: true },
      dmc_read: {
        address: 0xc940,
        value: 0x81,
        source: { index: 8013, cycle_index: 911 },
      },
    },
    {
      event: { output_boundary: false },
      dmc_read: {
        address: 0xc940,
        value: 0x81,
        source: { index: 8018, cycle_index: 915 },
      },
    },
  ]);
  expect(rawGets(source)).toMatchObject([
    {
      index: 911,
      read: { address: 0xc940, value: 0x81, file_offset: 16 + 0x4940 },
    },
    {
      index: 915,
      read: { address: 0xc940, value: 0x81, file_offset: 16 + 0x4940 },
    },
  ]);
  expect(source.final.dmc).toMatchObject({
    shift: 0x81,
    silence: false,
    level: 62,
    timer_remaining: 49,
    buffer: {
      status: "full",
      value: 0x81,
      origin: { kind: "dmc-read", index: 8018 },
    },
  });
  expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(source.final.dmc_irq.value).toBe(true);
  await replay(source);
});

it.each([
  { timer: 12, duplication: "unknown" },
  { timer: 13, duplication: "enabled" },
])(
  "keeps an unresolved silicon window before its speculative get ($timer/$duplication)",
  async ({ timer, duplication }) => {
    const selected = apu(timer, duplication);
    if (duplication === "unknown")
      delete (selected.dmc.cpu_timing as { duplication?: string }).duplication;
    if (timer === 13)
      Object.assign(selected.registers[16400]!, {
        value: { mask: 191, value: 143 },
      });
    const source = await run({ initial_apu: selected });
    expect(source.trace.stop.reason).toBe("dmc-dma-stop-window");
    expect(source.trace.instructions).toHaveLength(3);
    expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(908);
    expect(rawGets(source)).toEqual([]);
    expect(source.dmc.transfers).toEqual([]);
    expect(source.dmc.frontier!.transfers).toEqual([]);
    expect(source.dmc.frontier!.active).toMatchObject({
      type: "load",
      first_cycle_index: 909,
      setup: [
        { cycle_index: 909, phase: "halt" },
        { cycle_index: 910, phase: "dummy" },
      ],
    });
  },
);

it("rejects future physical origins for retained duplicate requests and implicit stops", async () => {
  const baseline = await run();
  for (const kind of ["request", "stop"] as const) {
    const input = structuredClone(baseline.input),
      dmc = input.initial_apu!.dmc!;
    const read = { kind: "dmc-read" as const, index: 7999, cycle_index: 900 };
    if (kind === "request")
      dmc.cpu_timing!.request = {
        status: "pending",
        type: "duplicate",
        delay: 0,
        origin: read,
      };
    else
      dmc.cpu_timing!.stop = {
        status: "pending",
        cause: "implicit",
        delay: 3,
        origin: read,
      };
    input.initial_apu!.registers[16405]!.value = 16;
    input.initial_apu!.dmc_remaining.value = { min: 1, max: 1 };
    expect(
      await deriveNesCode(baseline.header, baseline.prg, input, {
        chr: baseline.chr,
      }),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("cycle"),
    });
  }
});

it("retains the ordinary single fetch when the caller selects duplication-disabled silicon", async () => {
  const source = await run({ initial_apu: apu(12, "disabled") });
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(913);
  expect(source.dmc.transfers).toHaveLength(1);
  expect(source.final.dmc).toMatchObject({
    shift: 1,
    silence: true,
    level: 62,
    buffer: { status: "full", value: 0x81 },
  });
  expect(source.final.dmc_irq).toEqual({
    value: true,
    origin: { kind: "dmc-read", index: 8013 },
  });
  await replay(source);
});

it("performs the implicit one-cycle abort after a known first fetch without clearing its IRQ", async () => {
  const source = await run({ initial_apu: apu(14), max_instructions: 5 });
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(916);
  expect(source.dmc.transfers).toMatchObject([
    { outcome: "sample", type: "load", sample_cycle_index: 911 },
    {
      outcome: "aborted",
      type: "reload",
      cause: "implicit-stop",
      first_cycle_index: 914,
      stop_origin: { kind: "dmc-read", index: 8013, cycle_index: 911 },
      stop_event_index: 8016,
      setup: [{ cycle_index: 914, phase: "halt" }],
    },
  ]);
  expect(source.final.registers[16405]!.value).toBe(16);
  expect(source.final.dmc_irq).toEqual({
    value: true,
    origin: { kind: "dmc-read", index: 8013 },
  });
  expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(source.final.dmc).toMatchObject({
    buffer: { status: "empty" },
    shift: 0x81,
    shift_origin: { kind: "dmc-read", index: 8013 },
    level: 66,
    timer_remaining: 52,
  });
  expect(source.mapped.apu_trace.operations).toContainEqual(
    expect.objectContaining({ kind: "apu-dmc-stop", event_index: 8016 }),
  );
  await replay(source);
});

it("cancels the implicit abort when its sole halt opportunity is a CPU write", async () => {
  const source = await run(
    { initial_apu: apu(14) },
    [0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0x8d, 0x10, 0, 0xea],
  );
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(915);
  expect(source.dmc.transfers).toHaveLength(1);
  expect(source.trace.instructions[3]!.writes).toMatchObject([
    { address: 0x10, value: 16 },
  ]);
  expect(source.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(source.final.dmc_irq).toEqual({
    value: true,
    origin: { kind: "dmc-read", index: 8013 },
  });
  expect(source.final.dmc!.cpu_timing).toMatchObject({
    request: { status: "none" },
    stop: { status: "none" },
  });
  await replay(source);
});

it("restarts the duplicate from live 4012 and reads its new raw source rather than reusing the first byte", async () => {
  const state = apu(3);
  state.frame_sequencer.cpu_phase = "get";
  state.registers[16402]!.value = 38;
  state.registers[16405]!.value = 16;
  state.dmc_remaining.value = { min: 1, max: 1 };
  Object.assign(state.dmc.cpu_timing, {
    request: { status: "pending", type: "load", delay: 0 },
  });
  const source = await run({ initial_apu: state, max_instructions: 1 }, [2]);
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(907);
  expect(rawGets(source)).toMatchObject([
    {
      index: 902,
      read: { address: 0xc940, value: 0x81, file_offset: 16 + 0x4940 },
    },
    {
      index: 906,
      read: { address: 0xc980, value: 0x96, file_offset: 16 + 0x4980 },
    },
  ]);
  expect(samples(source)).toMatchObject([
    { dmc_read: { value: 0x81, source: { index: 8003, cycle_index: 902 } } },
    { dmc_read: { value: 0x96, source: { index: 8008, cycle_index: 906 } } },
  ]);
  expect(source.final.dmc).toMatchObject({
    current_address: 0xc981,
    shift: 0x81,
    buffer: { status: "full", value: 0x96 },
  });
  await replay(source);
});

it("retains the first delivered fetch and duplicate setup in a late proof-budget frontier", async () => {
  const source = await run();
  const exact = await run({
    max_dmc_dma_source_bytes: source.dmc.retained_source_bytes,
  });
  expect(exact.trace).toEqual(source.trace);
  const short = await run({
    max_dmc_dma_source_bytes: source.dmc.retained_source_bytes - 1,
  });
  expect(short.trace.stop.reason).toBe("dmc-dma-source-budget");
  expect(short.trace.instructions).toHaveLength(3);
  expect(short.trace.cpu_bus!.final.next_cycle_index).toBe(908);
  expect(short.dmc.transfers).toEqual([]);
  expect(short.dmc.frontier!.transfers).toMatchObject([
    { outcome: "sample", sample_cycle_index: 911 },
  ]);
  expect(short.dmc.frontier!.active).toMatchObject({
    type: "duplicate",
    first_cycle_index: 912,
  });
});

it("continues an actual enable prefix into the same duplicate burst with absolute identities intact", async () => {
  const full = await run(),
    prefix = await run({ max_instructions: 3 });
  const continued = await run({
    entry: prefix.trace.stop.address,
    cpu: prefix.trace.final_cpu,
    initial: prefix.mapped.final,
    initial_apu: prefix.final,
    initial_cpu_bus: prefix.trace.cpu_bus!.final,
    max_instructions: 1,
  });
  expect(continued.final).toEqual(full.final);
  expect(continued.trace.cpu_bus!.final).toEqual(full.trace.cpu_bus!.final);
  expect(rawGets(continued)).toEqual(rawGets(full));
  await replay(continued);
});

it("shares duplicate setup with OAM and performs both fresh gets before OAM finishes", async () => {
  const state = apu(3);
  state.frame_sequencer.cpu_phase = "get";
  state.registers[16405]!.value = 16;
  state.dmc_remaining.value = { min: 1, max: 1 };
  Object.assign(state.dmc.cpu_timing, {
    request: { status: "pending", type: "load", delay: 0 },
  });
  const source = await run({
    initial_apu: state,
    entry: 0xe120,
    max_instructions: 1,
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
  });
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(1418);
  expect(source.dmc.transfers).toMatchObject([
    { type: "load", first_cycle_index: 900, sample_cycle_index: 902 },
    {
      type: "duplicate",
      first_cycle_index: 903,
      sample_cycle_index: 906,
      setup: [
        { cycle_index: 903, phase: "halt", shared_with_oam: true },
        { cycle_index: 904, phase: "dummy", shared_with_oam: true },
        { cycle_index: 905, phase: "alignment", shared_with_oam: true },
      ],
    },
  ]);
  if (!("cpu_dma" in source.trace)) throw new Error("Missing OAM trace");
  const transfer = source.trace.cpu_dma.transfers[0]!;
  expect(transfer.cpu_bus_cycles).toHaveLength(518);
  expect(transfer.writes).toHaveLength(256);
  for (const [index, write] of transfer.writes.entries())
    expect(write.value).toBe((index * 13 + 0x21) & 255);
  await replay(source);
});

it("retains the known first fetch when a duplicate's live restart address is unknown", async () => {
  const state = apu(3);
  state.frame_sequencer.cpu_phase = "get";
  state.registers[16405]!.value = 16;
  state.dmc_remaining.value = { min: 1, max: 1 };
  Object.assign(state.registers[16402]!, { value: null });
  Object.assign(state.dmc.cpu_timing, {
    request: { status: "pending", type: "load", delay: 0 },
  });
  const source = await run({ initial_apu: state, max_instructions: 1 }, [2]);
  expect(source.trace.stop.reason).toBe("dmc-dma-address");
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(900);
  expect(source.dmc.transfers).toEqual([]);
  expect(source.dmc.frontier!.transfers).toMatchObject([
    {
      type: "load",
      outcome: "sample",
      sample_cycle_index: 902,
      mapper_event_index: 3,
    },
  ]);
  expect(source.dmc.frontier!.active).toBeNull();
  if (!("cpu_bus_frontier" in source.trace.stop))
    throw new Error("Missing source frontier");
  expect(source.trace.stop.cpu_bus_frontier.cycles).toMatchObject([
    { index: 900, role: "dmc-halt" },
    { index: 901, role: "dmc-dummy" },
    {
      index: 902,
      role: "dmc-get",
      read: { address: 0xc940, value: 0x81, file_offset: 16 + 0x4940 },
    },
  ]);
  expect(source.mapped.apu_trace.frontier).toContainEqual(
    expect.objectContaining({ kind: "apu-dmc-cpu-read", event_index: 8003 }),
  );
});

it("admits only an adjacent put-cycle continuation of a retained duplicate request", async () => {
  const state = apu(54);
  state.registers[16405]!.value = 16;
  state.dmc_remaining.value = { min: 1, max: 1 };
  Object.assign(state.dmc, { shift: 0x81, bits_remaining: 8 });
  Object.assign(state.dmc.cpu_timing, {
    request: {
      status: "pending",
      type: "duplicate",
      delay: 0,
      origin: { kind: "dmc-read", index: 7999, cycle_index: 899 },
    },
  });
  const source = await run({ initial_apu: state, max_instructions: 1 }, [2]);
  expect(source.trace.stop.reason).toBe("unsupported-opcode");
  expect(source.trace.cpu_bus!.final.next_cycle_index).toBe(904);
  expect(source.dmc.transfers).toMatchObject([
    {
      type: "duplicate",
      outcome: "sample",
      first_cycle_index: 900,
      sample_cycle_index: 903,
      request_origin: { kind: "dmc-read", index: 7999, cycle_index: 899 },
    },
  ]);
  await replay(source);
  for (const mismatch of [
    "old-origin",
    "get-phase",
    "oam-get",
    "stop-get",
  ] as const) {
    let input = structuredClone(source.input);
    const selected = input.initial_apu!;
    if (selected.frame_clocks !== "cpu-ordered")
      throw new Error("Missing ordered phase");
    const request = selected.dmc!.cpu_timing!.request;
    if (request.status !== "pending" || request.type !== "duplicate")
      throw new Error("Missing duplicate history");
    if (mismatch === "old-origin") request.origin.cycle_index = 898;
    else if (mismatch === "get-phase")
      selected.frame_sequencer.cpu_phase = "get";
    else {
      selected.frame_sequencer.cpu_phase = null;
      if (mismatch === "stop-get")
        selected.dmc!.cpu_timing!.stop = {
          status: "pending",
          cause: "explicit",
          delay: 2,
          origin: { kind: "initial-state" },
        };
      else
        input = traceNesCodeInputSchema.parse({
          ...input,
          initial_cpu_dma: {
            model: "oam-cpu-dma",
            region: "ntsc",
            cpu_phase: "get",
            oam_dma_pending: { status: "none" },
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
              address: 0,
              retention: "stable",
              reads: "supported",
              dma_pending: { status: "none" },
            },
          },
        });
    }
    expect(
      await deriveNesCode(source.header, source.prg, input, {
        chr: source.chr,
      }),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("immediately follow"),
    });
  }
});
