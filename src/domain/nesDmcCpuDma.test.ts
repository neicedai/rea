import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { expect, it } from "vitest";
import { nesPpuFixture, nesPpuFixtureState } from "./nesPpu.fixture.js";
import { parseNesHeader } from "./nes.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { nesCodeTraceSchema, traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { exploreNesCode } from "./nesCodeExplorationDerivation.js";
import { exploreNesCodeInputSchema } from "./nesCodeExploration.js";
import { mmc5Fixture } from "./nesMmc5.fixture.js";

const origin = { kind: "initial-state" };
const apu = (phase = "get", pending = false) => ({
  model: "apu-registers",
  frame_clocks: "cpu-ordered",
  dmc_reads: "explicit",
  registers: Object.fromEntries(
    [
      [0x4010, 128],
      [0x4012, 32],
      [0x4013, 0],
      [0x4015, pending ? 16 : 0],
      [0x4017, 64],
    ].map(([address, value]) => [address, { value, origin }]),
  ),
  dmc_remaining: {
    value: { min: pending ? 1 : 0, max: pending ? 1 : 0 },
    origin,
  },
  dmc_irq: { value: false, origin },
  frame_irq: { value: false, origin },
  frame_sequencer: {
    region: "ntsc",
    cpu_phase: phase,
    position: { min: 0, max: 0 },
    five_step: false,
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
  },
  dmc: {
    model: "dmc-reader-output",
    region: "ntsc",
    clocks: "cpu-ordered",
    current_address: 0xc800,
    buffer: { status: "empty" },
    shift: 0,
    bits_remaining: 8,
    silence: true,
    level: 64,
    timer_remaining: 428,
    cpu_timing: {
      model: "2a03-dmc-dma",
      stop: { status: "none" },
      request: pending
        ? { status: "pending", type: "load", delay: 0 }
        : { status: "none" },
    },
  },
});
const run = async (
  program: number[],
  selected: Record<string, unknown> = {},
  patch: { offset: number; value: number }[] = [],
) => {
  const rom = nesPpuFixture(program);
  rom.bytes[rom.prgOffset + 0x4800] = 129;
  for (const { offset, value } of patch)
    rom.bytes[rom.prgOffset + offset] = value;
  const prg = rom.bytes.subarray(rom.prgOffset, rom.chrOffset);
  const {
    trace,
    input,
    header,
  } = await deriveNesFixtureTrace(rom.bytes, prg, {
    path: "/dmc-dma.nes",
    initial: { mapper: 0 },
    entry: rom.entry,
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 100,
    },
    initial_apu: apu(),
    max_instructions: 4,
    ...selected,
  });
  if (trace.cpu_bus === null || !("dmc" in trace.cpu_bus))
    throw new Error(JSON.stringify(trace));
  return {
    trace,
    dmc: trace.cpu_bus.dmc,
    input,
    header: header,
    prg,
    rom,
  };
};

it("schedules the load halt at the third following get boundary after a put-cycle enable", async () => {
  const { trace, dmc, rom } = await run([
    0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0xea,
  ]);
  expect(trace.stop.reason).toBe("instruction-budget");
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(113);
  expect(dmc.transfers).toMatchObject([
    {
      type: "load",
      before_instruction_index: 3,
      first_cycle_index: 108,
      setup: [
        { cycle_index: 108, phase: "halt" },
        { cycle_index: 109, phase: "dummy" },
      ],
      sample_cycle_index: 110,
    },
  ]);
  expect(
    dmc.boundary_cycles.map((cycle) =>
      cycle.kind === "read" ? cycle.role : cycle.kind,
    ),
  ).toEqual(["dmc-halt", "dmc-dummy", "dmc-get"]);
  expect(dmc.boundary_cycles[2]).toMatchObject({
    kind: "read",
    read: { value: 129, file_offset: rom.prgOffset + 0x4800 },
  });
  expect(trace.mapper_trace).toMatchObject({
    apu_trace: {
      final: {
        dmc_remaining: { value: { min: 0, max: 0 } },
        dmc_irq: { value: true },
        dmc: { buffer: { status: "full", value: 129 } },
      },
    },
  });
});

it("retains qualified PPU buffer and controller positions across a modeled DMC enable, then reads their known facts", async () => {
  const program = [
    0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0xea, 0xad, 7, 0x20, 0xad, 0x16, 0x40,
    0x29, 1,
  ];
  const selected = {
    initial_ppu: nesPpuFixtureState({
      v: { low: 0, high: 32 },
      read_buffer: { value: 0x5a },
      nametable: { 0: 0x3d },
    }),
    initial_controllers: {
      model: "standard-controllers",
      dma_reads: "absent",
      oam_dma_pending: { status: "none" },
      strobe: false,
      buttons: [8, 0],
      ports: [8, 0].map((buttons, index) => ({
        serial_reports: [
          {
            position: index === 0 ? 3 : 2,
            buttons,
            origin: { kind: "initial-report", port: index + 1 },
          },
        ],
      })),
    },
    initial_cpu_io: {
      model: "2a03-io",
      controller_clocking: "contiguous",
      active_controller: 0,
    },
  };
  const prefix = await run(program, selected);
  expect(prefix.trace.stop.reason).toBe("instruction-budget");
  expect(prefix.dmc.transfers).toHaveLength(1);
  expect(prefix.trace.mapper_trace).toMatchObject({
    ppu_trace: {
      final: {
        dma_reads: "absent",
        v: { low: 0, high: 32 },
        read_buffer: { value: 0x5a },
      },
    },
    controller_trace: {
      final: {
        dma_reads: "absent",
        ports: [
          { serial_reports: [{ position: 3 }] },
          { serial_reports: [{ position: 2 }] },
        ],
      },
    },
  });
  const { trace, input, header, prg } = await run(program, {
    ...selected,
    max_instructions: 7,
  });
  expect(trace.stop.reason).toBe("instruction-budget");
  expect(trace.instructions[4]!.data_reads[0]).toMatchObject({
    address: 0x2007,
    value: 0x5a,
    file_offset: null,
  });
  expect(trace.final_cpu.a).toBe(1);
  const mapped = trace.mapper_trace;
  expect(mapped).toMatchObject({
    ppu_trace: {
      final: {
        dma_reads: "absent",
        v: { low: 1, high: 32 },
        read_buffer: { value: 0x3d },
      },
    },
    controller_trace: {
      final: {
        dma_reads: "absent",
        ports: [
          { serial_reports: [{ position: 4 }] },
          { serial_reports: [{ position: 2 }] },
        ],
      },
    },
  });
  if (mapped.status !== "derived" || !("mapper_snapshots" in mapped))
    throw new Error("Missing mapper events");
  expect(
    await deriveNesMapperEvents(
      header,
      input.initial,
      mapped.steps.map((step) => step.event),
      {
        prg,
        initialApu: input.initial_apu,
        initialPpu: input.initial_ppu,
        initialControllers: input.initial_controllers,
      },
    ),
  ).toEqual(mapped);
});

it("waits four following CPU cycles after a get-cycle enable before halting an inline read", async () => {
  const { trace, dmc } = await run([0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0xea], {
    initial_apu: apu("put"),
  });
  expect(trace.stop.reason).toBe("instruction-budget");
  const enable = trace.instructions[1]!;
  const stalled = trace.instructions[3]!;
  if (!("cpu_bus_cycles" in enable) || !("cpu_bus_cycles" in stalled))
    throw new Error("Missing CPU cycles");
  expect(enable.cpu_bus_cycles.at(-1)).toMatchObject({
    kind: "write",
    index: 105,
  });
  expect(enable.writes.at(-1)).toMatchObject({ address: 0x4015, value: 16 });
  expect(
    stalled.cpu_bus_cycles.map((cycle) => [cycle.index, cycle.role]),
  ).toEqual([
    [108, "opcode"],
    [109, "dmc-halt"],
    [110, "dmc-dummy"],
    [111, "dmc-get"],
    [112, "dummy"],
  ]);
  expect(dmc.boundary_cycles).toEqual([]);
  expect(dmc.transfers).toMatchObject([
    {
      type: "load",
      before_instruction_index: 3,
      first_cycle_index: 109,
      sample_cycle_index: 111,
    },
  ]);
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(113);
});

it.each([
  {
    emptied: "before",
    timer: 5,
    type: "load",
    halt: 106,
    get: 108,
    setup: ["halt", "dummy"],
    finalCycle: 111,
    finalTimer: 48,
    boundaryCount: 3,
  },
  {
    emptied: "after",
    timer: 7,
    type: "reload",
    halt: 107,
    get: 110,
    setup: ["halt", "dummy", "alignment"],
    finalCycle: 112,
    finalTimer: 49,
    boundaryCount: 0,
  },
])(
  "selects $type when a retained full buffer empties $emptied the enable delay expires",
  async ({
    timer,
    type,
    halt,
    get,
    setup,
    finalCycle,
    finalTimer,
    boundaryCount,
  }) => {
    const state = apu();
    state.registers[16400]!.value = 0x4f;
    // The reader has stopped while its last buffered byte is still playing.
    // Both timer phases empty that byte on a get, with a fixed 54-cycle rate.
    Object.assign(state.dmc, {
      buffer: { status: "full", value: 150, origin },
      bits_remaining: 1,
      silence: false,
      timer_remaining: timer,
    });
    const { trace, dmc, input, header, prg, rom } = await run(
      [0x8d, 0x15, 0x40, 0xea, 0xea],
      { initial_apu: state, cpu: { a: 16 }, max_instructions: 3 },
    );
    expect(trace.stop.reason).toBe("instruction-budget");
    const enable = trace.instructions[0]!;
    if (!("cpu_bus_cycles" in enable)) throw new Error("Missing enable cycles");
    expect(enable.cpu_bus_cycles.at(-1)).toMatchObject({
      index: 103,
      kind: "write",
    });
    expect(enable.writes).toMatchObject([{ address: 0x4015, value: 16 }]);
    expect(dmc.transfers).toMatchObject([
      {
        type,
        before_instruction_index: 2,
        first_cycle_index: halt,
        setup: setup.map((phase, index) => ({
          cycle_index: halt + index,
          phase,
          shared_with_oam: false,
        })),
        sample_cycle_index: get,
      },
    ]);
    const cycles = [
      ...dmc.boundary_cycles,
      ...trace.instructions.flatMap((instruction) =>
        "cpu_bus_cycles" in instruction ? instruction.cpu_bus_cycles : [],
      ),
    ];
    expect(cycles.filter((cycle) => cycle.role === "dmc-get")).toMatchObject([
      {
        index: get,
        kind: "read",
        read: {
          address: 0xc800,
          value: 129,
          file_offset: rom.prgOffset + 0x4800,
        },
      },
    ]);
    expect(dmc.boundary_cycles).toHaveLength(boundaryCount);
    expect(trace.cpu_bus!.final.next_cycle_index).toBe(finalCycle);
    const mapped = trace.mapper_trace;
    expect(mapped).toMatchObject({
      apu_trace: {
        final: {
          dmc_remaining: { value: { min: 1, max: 1 } },
          dmc_irq: { value: false },
          dmc: {
            current_address: 0xc800,
            shift: 150,
            buffer: { status: "full", value: 129 },
            bits_remaining: 8,
            silence: false,
            level: 62,
            timer_remaining: finalTimer,
            cpu_timing: { request: { status: "none" } },
          },
        },
      },
    });
    if (mapped.status !== "derived" || !("mapper_snapshots" in mapped))
      throw new Error("Missing committed mapper events");
    expect(
      await deriveNesMapperEvents(
        header,
        input.initial,
        mapped.steps.map((step) => step.event),
        { prg, initialApu: input.initial_apu },
      ),
    ).toEqual(mapped);
  },
);

it("derives an unknown CPU phase from delayed request history and rejects contradictory retained phases", async () => {
  const state = apu("get", true);
  Object.assign(state.frame_sequencer, { cpu_phase: null });
  state.dmc.cpu_timing.request = {
    status: "pending",
    type: "load",
    delay: 2,
  };
  const { trace, dmc, header, prg, input } = await run([0xea, 2], {
    initial_apu: state,
  });
  expect(trace.stop.reason).toBe("unsupported-opcode");
  expect(trace.instructions).toHaveLength(1);
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(105);
  expect(dmc.transfers).toMatchObject([
    { first_cycle_index: 102, sample_cycle_index: 104 },
  ]);
  const mapped = trace.mapper_trace;
  if (mapped.status !== "derived" || !("apu_trace" in mapped))
    throw new Error("Missing APU trace");
  expect(mapped.steps[0]!.event).toEqual({
    kind: "apu-cpu-phase",
    phase: "get",
  });
  const contradictory = structuredClone(input);
  if (contradictory.initial_apu?.frame_clocks !== "cpu-ordered")
    throw new Error("Missing CPU-ordered APU state");
  contradictory.initial_apu.frame_sequencer.cpu_phase = "put";
  expect(await deriveNesCode(header, prg, contradictory)).toEqual({
    status: "unsupported",
    reason:
      "DMC delayed request/stop history contradicts the retained get/put phase.",
  });
  const invalidReload = structuredClone(state);
  invalidReload.dmc.cpu_timing.request.type = "reload";
  expect(
    traceNesCodeInputSchema.safeParse({ ...input, initial_apu: invalidReload })
      .success,
  ).toBe(false);
});

it("reserves DMC stalls during accepted entry and the phase-inference event before allocating indices", async () => {
  const { input, header, prg } = await run([0xea], { max_instructions: 1 });
  const accepted = structuredClone(input);
  accepted.entry = { accepted_interrupt: "irq", return_address: 0xc100 };
  accepted.cpu.sp = 0xfd;
  accepted.initial_cpu_bus!.next_cycle_index = Number.MAX_SAFE_INTEGER - 23;
  expect(await deriveNesCode(header, prg, accepted)).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("CPU bus cycle index"),
  });
  // One instruction needs at most 8 nominal + 8 DMC cycles; accepted entry
  // separately needs 7 nominal + 8 DMC cycles, even when this path uses fewer.
  accepted.initial_cpu_bus!.next_cycle_index = Number.MAX_SAFE_INTEGER - 31;
  expect((await deriveNesCode(header, prg, accepted)).status).toBe("derived");

  const inferred = structuredClone(input);
  const initialApu = inferred.initial_apu!;
  if (initialApu.frame_clocks !== "cpu-ordered" || initialApu.dmc === null)
    throw new Error("Missing timed DMC");
  initialApu.registers[16405] = {
    value: 16,
    origin: { kind: "initial-state" },
  };
  initialApu.dmc_remaining.value = { min: 1, max: 1 };
  initialApu.dmc.cpu_timing = {
    model: "2a03-dmc-dma",
    duplication: "unknown",
    stop: { status: "none" },
    request: { status: "pending", type: "load", delay: 2 },
  };
  initialApu.frame_sequencer.cpu_phase = null;
  // 16 bus reads/edges, two deliveries and one pre-bus stop need 35 identities.
  // Proving the missing phase from request history needs one additional event.
  initialApu.next_event_index = Number.MAX_SAFE_INTEGER - 35;
  expect(await deriveNesCode(header, prg, inferred)).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("APU event index"),
  });
  initialApu.frame_sequencer.cpu_phase = "get";
  expect((await deriveNesCode(header, prg, inferred)).status).toBe("derived");
  initialApu.frame_sequencer.cpu_phase = null;
  initialApu.next_event_index = Number.MAX_SAFE_INTEGER - 36;
  expect((await deriveNesCode(header, prg, inferred)).status).toBe("derived");
});

it("commits a boundary sample before an unsupported opcode without committing that opcode's clocks", async () => {
  const { trace, dmc } = await run([2], { initial_apu: apu("get", true) });
  expect(trace.stop.reason).toBe("unsupported-opcode");
  expect(trace.instructions).toHaveLength(0);
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(103);
  expect(dmc.transfers).toHaveLength(1);
  expect(trace.mapper_trace).toMatchObject({
    apu_trace: {
      final: {
        dmc: { buffer: { status: "full", value: 129 }, timer_remaining: 425 },
      },
    },
  });
});

it("inserts reload halt/dummy/alignment/get inside a two-cycle instruction and replays the actual sample", async () => {
  const state = apu();
  state.registers[16405]!.value = 16;
  state.registers[16403]!.value = 1;
  state.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(state.dmc, {
    bits_remaining: 1,
    timer_remaining: 1,
    buffer: { status: "full", value: 0x96, origin },
  });
  const { trace, dmc, input, header, prg } = await run([0xea], {
    initial_apu: state,
    max_instructions: 1,
  });
  const first = trace.instructions[0]!;
  if (!("cpu_bus_cycles" in first)) throw new Error("Missing cycles");
  expect(
    first.cpu_bus_cycles.map((cycle) =>
      cycle.kind === "read" ? cycle.role : cycle.kind,
    ),
  ).toEqual([
    "opcode",
    "dmc-halt",
    "dmc-dummy",
    "dmc-alignment",
    "dmc-get",
    "dummy",
  ]);
  expect(dmc.boundary_cycles).toEqual([]);
  expect(dmc.transfers[0]).toMatchObject({
    type: "reload",
    first_cycle_index: 101,
    sample_cycle_index: 104,
  });
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(106);
  const mapped = trace.mapper_trace;
  if (mapped.status !== "derived" || !("mapper_snapshots" in mapped))
    throw new Error("Missing events");
  expect(
    await deriveNesMapperEvents(
      header,
      input.initial,
      mapped.steps.map((step) => step.event),
      { prg, initialApu: input.initial_apu },
    ),
  ).toEqual(mapped);
});

it("delivers a final reload with an unknown output phase without applying the initial-load stop-window qualification", async () => {
  const state = apu("put", true);
  Object.assign(state.dmc, {
    bits_remaining: null,
    timer_remaining: null,
    cpu_timing: {
      model: "2a03-dmc-dma",
      stop: { status: "none" },
      request: { status: "pending", type: "reload", delay: 0 },
    },
  });
  const { trace, dmc, input, header, prg } = await run([2], {
    initial_apu: state,
  });
  expect(trace.stop.reason).toBe("unsupported-opcode");
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(104);
  expect(dmc.transfers).toMatchObject([
    {
      type: "reload",
      first_cycle_index: 100,
      setup: [
        { cycle_index: 100, phase: "halt" },
        { cycle_index: 101, phase: "dummy" },
        { cycle_index: 102, phase: "alignment" },
      ],
      sample_cycle_index: 103,
    },
  ]);
  const mapped = trace.mapper_trace;
  expect(mapped).toMatchObject({
    apu_trace: {
      final: {
        dmc_remaining: { value: { min: 0, max: 0 } },
        dmc_irq: { value: true },
        dmc: {
          current_address: 0xc801,
          buffer: { status: "full", value: 129 },
          bits_remaining: null,
          timer_remaining: null,
          cpu_timing: { request: { status: "none" } },
        },
      },
    },
  });
  if (mapped.status !== "derived" || !("apu_trace" in mapped))
    throw new Error("Missing mapper events");
  expect(
    await deriveNesMapperEvents(
      header,
      input.initial,
      mapped.steps.map((step) => step.event),
      { prg, initialApu: input.initial_apu },
    ),
  ).toEqual({ ...mapped, apu_trace: { ...mapped.apu_trace, frontier: [] } });
});

it("retries an eligible reload through both RMW writes and derives the delayed three-cycle halt", async () => {
  const state = apu();
  state.registers[16405]!.value = 16;
  state.registers[16403]!.value = 1;
  state.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(state.dmc, {
    bits_remaining: 1,
    timer_remaining: 4,
    buffer: { status: "full", value: 0x96, origin },
  });
  const { trace, dmc } = await run([0xee, 0, 0, 0xea], {
    initial_apu: state,
    initial_ram: [{ address: 0, value: 7 }],
    max_instructions: 2,
  });
  expect(trace.instructions[0]!.writes.map((write) => write.value)).toEqual([
    7, 8,
  ]);
  expect(dmc.transfers[0]).toMatchObject({
    type: "reload",
    before_instruction_index: 1,
    first_cycle_index: 106,
    sample_cycle_index: 108,
  });
  expect(dmc.transfers[0]!.setup).toHaveLength(2);
});

it("commits a reload after all accepted IRQ stack writes before an unsupported handler", async () => {
  const state = apu();
  state.registers[16405]!.value = 16;
  state.registers[16403]!.value = 1;
  state.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(state.dmc, {
    bits_remaining: 1,
    timer_remaining: 5,
    buffer: { status: "full", value: 0x96, origin },
  });
  const { trace, dmc } = await run([2], {
    initial_apu: state,
    entry: { accepted_interrupt: "irq", return_address: 0xc100 },
    cpu: { sp: 0xfd, i: false },
  });
  expect(trace.stop.reason).toBe("unsupported-opcode");
  expect(trace.instructions).toEqual([]);
  const entry = trace.entry_interrupt;
  if (entry === null || !("cpu_bus_cycles" in entry))
    throw new Error("Missing committed interrupt entry");
  expect(entry.writes.map((write) => [write.address, write.value])).toEqual([
    [0x1fd, 0xc1],
    [0x1fc, 0],
    [0x1fb, null],
  ]);
  expect(
    entry.cpu_bus_cycles.map((cycle) => [cycle.index, cycle.role]),
  ).toEqual([
    [100, "dummy"],
    [101, "dummy"],
    [102, "stack"],
    [103, "stack"],
    [104, "stack"],
    [105, "dmc-halt"],
    [106, "dmc-dummy"],
    [107, "dmc-alignment"],
    [108, "dmc-get"],
    [109, "vector"],
    [110, "vector"],
  ]);
  expect(dmc.boundary_cycles).toEqual([]);
  expect(dmc.transfers).toMatchObject([
    {
      type: "reload",
      halted_address: 0xfffe,
      before_instruction_index: 0,
      first_cycle_index: 105,
      sample_cycle_index: 108,
    },
  ]);
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(111);
  expect(trace.final_cpu).toMatchObject({ sp: 0xfa, i: true });
  expect(trace.mapper_trace).toMatchObject({
    apu_trace: {
      final: {
        dmc_remaining: { value: { min: 1, max: 1 } },
        dmc: { buffer: { status: "full", value: 129 } },
      },
    },
  });
});

it.each(["contiguous", "per-cycle"])(
  "preserves the %s controller clocks around a DMC reload and its conflicting sample read",
  async (clocking) => {
    const state = apu();
    state.registers[16405]!.value = 16;
    state.registers[16403]!.value = 1;
    state.dmc_remaining.value = { min: 2, max: 2 };
    Object.assign(state.dmc, {
      current_address: 0xc817,
      bits_remaining: 1,
      timer_remaining: 3,
      buffer: { status: "full", value: 0x96, origin },
    });
    const { trace, dmc, header, prg, input, rom } = await run(
      [0xad, 0x16, 0x40, 0x29, 1],
      {
        initial_apu: state,
        max_instructions: 2,
        initial_cpu_io: {
          model: "2a03-io",
          controller_clocking: clocking,
          active_controller: 0,
        },
        initial_controllers: {
          model: "standard-controllers",
          dma_reads: "absent",
          oam_dma_pending: { status: "none" },
          strobe: false,
          buttons: [2, 1],
          ports: [2, 1].map((buttons, index) => ({
            serial_reports: [
              {
                position: 0,
                buttons,
                origin: { kind: "initial-report", port: index + 1 },
              },
            ],
          })),
        },
      },
      [{ offset: 0x4817, value: 129 }],
    );
    expect(trace.stop.reason).toBe("instruction-budget");
    expect(trace.final_cpu.a).toBe(clocking === "contiguous" ? 1 : 0);
    expect(trace.cpu_bus!.final.next_cycle_index).toBe(110);
    const instruction = trace.instructions[0]!;
    if (!("cpu_bus_cycles" in instruction)) throw new Error("Missing cycles");
    expect(dmc.transfers[0]).toMatchObject({
      type: "reload",
      halted_address: 0x4016,
      first_cycle_index: 103,
      sample_cycle_index: 106,
    });
    expect(instruction.cpu_bus_cycles[6]).toMatchObject({
      role: "dmc-get",
      read: { value: 129, file_offset: rom.prgOffset + 0x4817 },
      dma_io: { decoded_address: 0x4017, cpu_value: 129, external_value: 129 },
    });
    const mapped = trace.mapper_trace;
    if (
      mapped.status !== "derived" ||
      !("controller_trace" in mapped) ||
      mapped.controller_trace === null
    )
      throw new Error("Missing controller trace");
    expect(
      mapped.controller_trace.final.ports.map(
        (port) => port.serial_reports[0]!.position,
      ),
    ).toEqual([clocking === "contiguous" ? 2 : 4, 1]);
    expect(
      mapped.steps.filter((step) => step.event.kind === "controller-hold"),
    ).toHaveLength(clocking === "contiguous" ? 2 : 0);
    expect(
      await deriveNesMapperEvents(
        header,
        input.initial,
        mapped.steps.map((step) => step.event),
        {
          prg,
          initialApu: input.initial_apu,
          initialControllers: input.initial_controllers,
        },
      ),
    ).toEqual(mapped);
  },
);

it("shares OAM setup cycles and lets DMC steal a get without changing any of the 256 OAM bytes", async () => {
  const state = apu("put", true);
  state.registers[16403]!.value = 1;
  state.dmc_remaining.value = { min: 2, max: 2 };
  state.dmc.cpu_timing.request = {
    status: "pending",
    type: "reload",
    delay: 0,
  };
  const { trace, dmc } = await run([2], {
    initial_apu: state,
    initial_cpu_dma: {
      model: "oam-cpu-dma",
      region: "ntsc",
      cpu_phase: "put",
      oam_dma_pending: { status: "pending", page: 0x85 },
    },
    initial_ppu: nesPpuFixtureState({
      oam: {
        model: "oam-memory",
        address: 0,
        retention: "stable",
        reads: "supported",
        dma_pending: { status: "pending", page: 0x85 },
      },
    }),
  });
  if (!("cpu_dma" in trace)) throw new Error("Missing OAM");
  expect(trace.cpu_dma.transfers[0]!.cpu_bus_cycles).toHaveLength(515);
  expect(
    trace.cpu_dma.transfers[0]!.writes.map((write) => write.value),
  ).toEqual(Array(256).fill(2));
  expect(dmc.transfers[0]).toMatchObject({
    type: "reload",
    first_cycle_index: 100,
    setup: [
      { cycle_index: 100, phase: "halt", shared_with_oam: true },
      { cycle_index: 101, phase: "dummy", shared_with_oam: true },
      { cycle_index: 102, phase: "alignment", shared_with_oam: true },
    ],
    sample_cycle_index: 103,
  });
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(615);
});

it("finishes a DMC reload after the last OAM put without fabricating more OAM writes", async () => {
  const state = apu();
  state.registers[16405]!.value = 16;
  state.registers[16403]!.value = 1;
  state.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(state.dmc, {
    bits_remaining: 2,
    timer_remaining: 85,
    buffer: { status: "full", value: 0x96, origin },
  });
  const { trace, dmc } = await run([2], {
    initial_apu: state,
    initial_cpu_dma: {
      model: "oam-cpu-dma",
      region: "ntsc",
      cpu_phase: "get",
      oam_dma_pending: { status: "pending", page: 0x85 },
    },
    initial_ppu: nesPpuFixtureState({
      oam: {
        model: "oam-memory",
        address: 0,
        retention: "stable",
        reads: "supported",
        dma_pending: { status: "pending", page: 0x85 },
      },
    }),
  });
  expect(trace.stop.reason).toBe("unsupported-opcode");
  if (!("cpu_dma" in trace)) throw new Error("Missing OAM trace");
  const oam = trace.cpu_dma.transfers[0]!;
  expect(oam.cpu_bus_cycles).toHaveLength(517);
  expect(oam.writes.map((write) => write.value)).toEqual(Array(256).fill(2));
  expect(
    oam.cpu_bus_cycles.filter((cycle) => cycle.kind === "write").at(-1),
  ).toMatchObject({ index: 613 });
  expect(
    oam.cpu_bus_cycles.slice(-3).map((cycle) => [cycle.index, cycle.kind]),
  ).toEqual([
    [614, "read"],
    [615, "read"],
    [616, "read"],
  ]);
  expect(dmc.transfers).toMatchObject([
    {
      type: "reload",
      first_cycle_index: 613,
      setup: [
        { cycle_index: 613, phase: "halt", shared_with_oam: true },
        { cycle_index: 614, phase: "dummy", shared_with_oam: false },
        { cycle_index: 615, phase: "alignment", shared_with_oam: false },
      ],
      sample_cycle_index: 616,
    },
  ]);
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(617);
});

it("keeps a zero-budget DMC halt wholly unapplied", async () => {
  const { trace, dmc } = await run([2], {
    initial_apu: apu("get", true),
    max_dmc_dma_source_bytes: 0,
  });
  expect(trace.stop.reason).toBe("dmc-dma-source-budget");
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(100);
  expect(dmc.transfers).toEqual([]);
  expect(dmc.retained_source_bytes).toBe(0);
  expect(trace.mapper_trace).toMatchObject({
    apu_trace: {
      final: {
        dmc_remaining: { value: { min: 1, max: 1 } },
        dmc: { buffer: { status: "empty" } },
      },
    },
  });
});

it("samples the physical edge preceding the CPU poll after a stalled last read, without polling DMA as an instruction", async () => {
  const state = apu();
  state.registers[16405]!.value = 16;
  state.registers[16403]!.value = 1;
  state.registers[16407]!.value = 0;
  state.dmc_remaining.value = { min: 2, max: 2 };
  state.frame_sequencer.position = { min: 29826, max: 29826 };
  Object.assign(state.dmc, {
    bits_remaining: 1,
    timer_remaining: 1,
    buffer: { status: "full", value: 0x96, origin },
  });
  const { trace } = await run([0xea], {
    initial_apu: state,
    cpu: { i: false },
    initial_interrupts: {
      model: "nmos-6502-interrupts",
      external_irq: false,
      nmi_edges: "absent",
      pending_irq: false,
      pending_nmi: false,
    },
    max_instructions: 1,
  });
  if (!("interrupts" in trace)) throw new Error("Missing polling");
  expect(trace.interrupts.polls).toHaveLength(1);
  expect(trace.interrupts.polls[0]).toMatchObject({
    pending_irq: true,
    samples: [{ cycle_index: 104, apu_frame_irq: true, requested_irq: true }],
  });
});

it("keeps an internal-status-corrupted sample distinct from the authentic external ROM byte", async () => {
  const state = apu("get", true);
  state.registers[16407]!.value = 0;
  state.frame_irq.value = true;
  state.dmc.current_address = 0xc815;
  const fixture = nesPpuFixture([2]);
  fixture.bytes[fixture.prgOffset + 0x4815] = 129;
  const parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/conflict.nes",
    entry: 0x4010,
    initial: { mapper: 0 },
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 100,
    },
    initial_cpu_io: {
      model: "2a03-io",
      controller_clocking: "contiguous",
      active_controller: 0,
      cpu_latch: 32,
      external_latch: 128,
    },
    initial_apu: state,
    max_instructions: 1,
  });
  const trace = nesCodeTraceSchema.parse(
    await deriveNesCode(
      parsed.value,
      fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
      input,
    ),
  );
  if (
    trace.status !== "derived" ||
    trace.cpu_bus === null ||
    !("dmc" in trace.cpu_bus) ||
    trace.mapper_trace.status !== "derived" ||
    !("apu_trace" in trace.mapper_trace)
  )
    throw new Error(JSON.stringify(trace));
  expect(trace.cpu_bus.dmc.boundary_cycles[2]).toMatchObject({
    role: "dmc-get",
    read: { value: 129, file_offset: fixture.prgOffset + 0x4815 },
    dma_io: { decoded_address: 0x4015, cpu_value: 80, external_value: 129 },
  });
  expect(trace.mapper_trace.apu_trace.final.dmc!.buffer).toMatchObject({
    status: "full",
    value: 80,
  });
  const transfer = trace.cpu_bus.dmc.transfers[0]!;
  if (transfer.outcome !== "sample")
    throw new Error("Missing delivered sample");
  const step = trace.mapper_trace.steps[transfer.mapper_event_index]!;
  expect(step).toMatchObject({
    dmc_read: { value: 80, source: { kind: "cpu-dma", cycle_index: 102 } },
  });
  expect("dmc_read" in step && "file_offset" in step.dmc_read).toBe(false);
});

it("fetches a CPU-written MMC5 upper-window RAM sample with its writer instead of a fabricated ROM offset", async () => {
  const fixture = mmc5Fixture(7);
  fixture.bytes.set(
    [0xa9, 0x53, 0x8d, 0, 0xc8, 0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0xea],
    fixture.prgOffset + 7 * 8192,
  );
  const parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/mmc5-dmc-ram.nes",
    entry: 0xe000,
    initial: {
      mapper: 5,
      prg_mode: 3,
      prg_banks: [0, 128, 129, 0, 7],
      ram_wiring: "ekrom",
      ram_protect: [2, 1],
    },
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 100,
    },
    initial_apu: apu(),
    max_instructions: 6,
  });
  const trace = nesCodeTraceSchema.parse(
    await deriveNesCode(
      parsed.value,
      fixture.bytes.subarray(
        fixture.prgOffset,
        fixture.prgOffset + fixture.prgSize,
      ),
      input,
    ),
  );
  if (
    trace.status !== "derived" ||
    trace.cpu_bus === null ||
    !("dmc" in trace.cpu_bus)
  )
    throw new Error(JSON.stringify(trace));
  expect(trace.stop.reason).toBe("instruction-budget");
  expect(trace.instructions[1]!.writes).toMatchObject([
    { address: 0xc800, value: 0x53 },
  ]);
  expect(trace.cpu_bus.dmc.transfers).toMatchObject([
    {
      type: "load",
      before_instruction_index: 5,
      sample_cycle_index: 116,
    },
  ]);
  const sample = trace.cpu_bus.dmc.boundary_cycles[2]!;
  expect(sample).toMatchObject({
    kind: "read",
    role: "dmc-get",
    read: {
      address: 0xc800,
      value: 0x53,
      file_offset: null,
      ram_origins: [
        {
          region: "prg-ram",
          bank: 0,
          ram_address: 0x6800,
          instruction_index: 1,
          write_index: 0,
        },
      ],
    },
  });
  expect(trace.mapper_trace).toMatchObject({
    apu_trace: {
      final: { dmc: { buffer: { status: "full", value: 0x53 } } },
    },
  });
  expect(trace.cpu_bus.final.next_cycle_index).toBe(119);
});

it("stops an incomplete inline transfer without committing its containing instruction", async () => {
  const state = apu();
  state.registers[16405]!.value = 16;
  state.registers[16403]!.value = 1;
  state.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(state.dmc, {
    bits_remaining: 1,
    timer_remaining: 1,
    buffer: { status: "full", value: 0x96, origin },
  });
  const { trace, dmc } = await run([0xea], {
    initial_apu: state,
    max_instructions: 1,
    max_dmc_dma_source_bytes: 0,
  });
  expect(trace.stop.reason).toBe("dmc-dma-source-budget");
  expect(trace.instructions).toEqual([]);
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(100);
  expect(dmc.transfers).toEqual([]);
  expect(trace.mapper_trace).toMatchObject({
    apu_trace: {
      final: {
        dmc: {
          buffer: { status: "full", value: 150 },
          bits_remaining: 1,
          timer_remaining: 1,
        },
      },
    },
  });
});

it("shares the DMC source budget across branch prefixes and preserves unexamined siblings", async () => {
  const first = await run([0xd0, 2, 0xea, 0xea, 0xea], {
    initial_apu: apu("get", true),
  });
  const input = exploreNesCodeInputSchema.parse({
    ...first.input,
    max_total_instructions: 20,
    max_dmc_dma_source_bytes: first.dmc.retained_source_bytes,
  });
  const explored = await exploreNesCode(first.header, first.prg, input);
  if (explored.status !== "derived") throw new Error(explored.reason);
  expect(explored.termination).toBe("dmc-dma-source-budget");
  expect(explored.paths).toHaveLength(2);
  expect(explored.pending_paths).toHaveLength(1);
});

it("retains the active reader until explicit stop expiry and preserves unsupported silicon/request frontiers", async () => {
  const stopping = apu("get", true);
  stopping.registers[16403]!.value = 1;
  stopping.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(stopping.dmc, {
    buffer: { status: "full", value: 129, origin },
    cpu_timing: {
      model: "2a03-dmc-dma",
      request: { status: "none" },
      stop: { status: "none" },
    },
  });
  const stop = await run([0xa9, 0, 0x8d, 0x15, 0x40], {
    initial_apu: stopping,
    max_instructions: 2,
  });
  expect(stop.trace.stop.reason).toBe("instruction-budget");
  expect(stop.trace.mapper_trace).toMatchObject({
    apu_trace: {
      final: {
        registers: { 16405: { value: 0 } },
        dmc_remaining: { value: { min: 2, max: 2 }, origin },
        dmc: {
          buffer: { status: "full", value: 129 },
          cpu_timing: {
            stop: {
              status: "pending",
              delay: 2,
              origin: { kind: "event-write", index: 5 },
            },
          },
        },
      },
    },
  });
  const hazard = apu("get", true);
  hazard.dmc.timer_remaining = 3;
  hazard.dmc.bits_remaining = 1;
  expect((await run([2], { initial_apu: hazard })).trace.stop.reason).toBe(
    "dmc-dma-stop-window",
  );
  const unknown = apu();
  unknown.dmc.cpu_timing.request = {
    status: "unknown",
  } as typeof unknown.dmc.cpu_timing.request;
  expect((await run([2], { initial_apu: unknown })).trace.stop.reason).toBe(
    "dmc-dma-request",
  );
});
