import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesPpuFixture, nesPpuFixtureState } from "./nesPpu.fixture.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { nesMapperEventsTraceSchema } from "./nesMapperEvents.js";
import {
  nesOamTraceReadBytes,
  nesCpuReadProofBytes,
} from "./nesCpuDmaBudget.js";
import { exploreNesCode } from "./nesCodeExplorationDerivation.js";
import { exploreNesCodeInputSchema } from "./nesCodeExploration.js";
import { namco163RamFixture } from "./nesNamco163Ram.fixture.js";

const origin = { kind: "initial-state" };
const apu = (phase: "get" | "put" | null = "get") => ({
  model: "apu-registers",
  frame_clocks: "cpu-ordered",
  dmc_reads: "absent",
  frame_sequencer: {
    region: "ntsc",
    cpu_phase: phase,
    position: { min: 7400, max: 7400 },
    five_step: false,
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
  },
  registers: { 16407: { value: 0, origin } },
  frame_irq: { value: false, origin },
  dmc_irq: { value: false, origin },
});
const oam = (pending: unknown = { status: "none" }) => ({
  model: "oam-memory",
  address: 254,
  retention: "stable",
  reads: "supported",
  address_writes: "uncorrupted",
  dma_pending: pending,
});
const run = async (
  program: number[] = [0xa9, 0x82, 0x8d, 0x14, 0x40, 0xea],
  selected: Record<string, unknown> = {},
) => {
  const fixture = nesPpuFixture(program);
  for (let offset = 0; offset < 256; offset++)
    fixture.bytes[fixture.prgOffset + 0x200 + offset] = offset ^ 0xa5;
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/oam-timing.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState({ oam: oam() }),
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 99,
    },
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: "get" },
    max_instructions: 3,
    ...selected,
  });
  const prg = fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset);
  const raw = await deriveNesCode(header.value, prg, input);
  const trace = nesCodeTraceSchema.parse(raw);
  if (trace.status !== "derived" || !("cpu_dma" in trace))
    throw new Error(JSON.stringify(trace));
  const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
  if (mapped.status !== "derived" || !("ppu_trace" in mapped))
    throw new Error("Missing devices");
  return { trace, mapped, header: header.value, prg, input, fixture };
};

it.each(["get", "put"] as const)(
  "derives exact get/put ordering from qualified phase %s rather than cycle-index parity",
  async (phase) => {
    const { trace, mapped, fixture, header, prg, input } = await run(
      undefined,
      {
        initial_cpu_dma: {
          model: "oam-cpu-dma",
          region: "ntsc",
          cpu_phase: phase,
        },
      },
    );
    const transfer = trace.cpu_dma.transfers[0]!;
    const count = phase === "get" ? 514 : 513;
    expect(transfer.cpu_bus_cycles).toHaveLength(count);
    expect(transfer.writes).toHaveLength(256);
    expect(transfer.before_instruction_index).toBe(2);
    expect(transfer.cpu_bus_cycles[0]).toMatchObject({
      role: "dummy",
      read: { address: fixture.entry + 5 },
    });
    expect(
      transfer.cpu_bus_cycles.slice(count - 512).map((cycle) => cycle.kind),
    ).toEqual(Array.from({ length: 256 }, () => ["read", "write"]).flat());
    expect(transfer.writes.map((write) => write.value)).toEqual(
      Array.from({ length: 256 }, (_, index) => index ^ 0xa5),
    );
    for (const [index, cycle] of transfer.cpu_bus_cycles
      .slice(count - 512)
      .entries())
      if (cycle.kind === "read")
        expect(cycle.read).toMatchObject({
          address: 0x8200 + index / 2,
          file_offset: fixture.prgOffset + 0x200 + index / 2,
          value: (index / 2) ^ 0xa5,
        });
    expect(trace.cpu_bus!.final.next_cycle_index).toBe(99 + 8 + count);
    expect(trace.cpu_dma.final).toMatchObject({
      cpu_phase: "get",
      oam_dma_pending: { status: "none" },
    });
    expect(mapped.ppu_trace.final.oam).toMatchObject({
      address: 254,
      dma_pending: { status: "none" },
      cells: {
        254: { value: 0xa5 & 227 },
        255: { value: 0xa4 },
        0: { value: 0xa7 },
      },
    });
    const replay = await deriveNesMapperEvents(
      header,
      input.initial,
      mapped.steps.map((step) => step.event),
      { prg, initialPpu: input.initial_ppu },
    );
    expect(replay).toEqual(mapped);
  },
);

it("commits a complete transfer before an unsupported opcode and advances the APU during stalls", async () => {
  const { trace, mapped } = await run([2], {
    initial_ppu: nesPpuFixtureState({
      oam: oam({ status: "pending", page: 0x82 }),
    }),
    initial_apu: apu(null),
  });
  expect(trace.instructions).toEqual([]);
  expect(trace.stop.reason).toBe("unsupported-opcode");
  expect(trace.cpu_dma.transfers).toHaveLength(1);
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(613);
  expect(trace.cpu_dma.final.cpu_phase).toBe("get");
  if (!("apu_trace" in mapped)) throw new Error("Missing APU");
  expect(mapped.steps[0]!.event).toEqual({
    kind: "apu-cpu-phase",
    phase: "get",
  });
  expect(mapped.apu_trace.final).toMatchObject({
    frame_sequencer: {
      position: { min: 7914, max: 7914 },
      cpu_phase: "get",
    },
  });
  expect(
    mapped.apu_trace.operations.some((operation) =>
      operation.effects.includes("quarter-clock"),
    ),
  ).toBe(true);
});

it("preserves a pending request at instruction-budget exhaustion and replaces consecutive RMW pages", async () => {
  const prefix = (await run(undefined, { max_instructions: 2 })).trace;
  expect(prefix.cpu_dma.transfers).toEqual([]);
  expect(prefix.cpu_dma.final.oam_dma_pending).toEqual({
    status: "pending",
    page: 0x82,
  });
  const { trace, mapped } = await run([0xee, 0x14, 0x40, 0xea], {
    initial_ram: [],
    cpu: {},
    max_instructions: 2,
  });
  expect(trace.instructions[0]!.writes).toHaveLength(2);
  expect(trace.cpu_dma.transfers).toEqual([]);
  expect(trace.stop.reason).toBe("cpu-dma-request");
  expect(trace.cpu_dma.final.oam_dma_pending).toEqual({
    status: "pending",
    page: null,
  });
  expect(mapped.ppu_trace.final.oam!.dma_pending).toEqual({
    status: "pending",
    page: null,
  });
});

it("retains only the budgeted DMA prefix and commits no partial OAM, clocks, phase or request", async () => {
  const selected = {
    initial_ppu: nesPpuFixtureState({
      oam: oam({ status: "pending", page: 0x82 }),
    }),
  };
  const full = (await run([0xea], { ...selected, max_instructions: 1 })).trace;
  const firstReads = full.cpu_dma.transfers[0]!.cpu_bus_cycles.slice(
    0,
    3,
  ).flatMap((cycle) => (cycle.kind === "read" ? [cycle.read] : []));
  const budget = nesCpuReadProofBytes(firstReads);
  const { trace, mapped } = await run([0xea], {
    ...selected,
    max_instructions: 1,
    max_oam_dma_source_bytes: budget,
  });
  expect(trace.stop.reason).toBe("oam-dma-source-budget");
  expect(trace.cpu_dma.frontier!.cpu_bus_cycles).toHaveLength(4);
  expect(trace.cpu_dma.frontier!.writes).toHaveLength(1);
  expect(trace.cpu_dma.transfers).toEqual([]);
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(99);
  expect(trace.cpu_dma.final).toEqual(trace.cpu_dma.initialized);
  expect(mapped.ppu_trace.final.oam!.cells).toEqual({});
  expect(mapped.ppu_trace.final.oam!.dma_pending).toEqual({
    status: "pending",
    page: 0x82,
  });
  expect(nesOamTraceReadBytes(trace)).toBe(budget);
  expect(
    trace.cpu_dma.frontier!.mapper_events.map((event) => event.kind),
  ).toEqual(["oam-dma-start", "cpu-write"]);
});

it("keeps unknown phase/request and internal-register conflicts as named frontiers", async () => {
  for (const [extra, reason] of [
    [
      {
        initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc" },
        initial_ppu: nesPpuFixtureState({
          oam: oam({ status: "pending", page: 0x82 }),
        }),
      },
      "cpu-dma-phase",
    ],
    [
      { initial_ppu: nesPpuFixtureState({ oam: oam({ status: "unknown" }) }) },
      "cpu-dma-request",
    ],
    [
      {
        entry: 0x4015,
        initial_ppu: nesPpuFixtureState({
          oam: oam({ status: "pending", page: 0x82 }),
        }),
      },
      "cpu-dma-io-conflict",
    ],
  ] as const) {
    const { trace } = await run([0xea], extra);
    expect(trace.stop.reason).toBe(reason);
    expect(trace.cpu_dma.frontier!.cpu_bus_cycles).toEqual([]);
    expect(trace.cpu_dma.transfers).toEqual([]);
    expect(trace.cpu_bus!.final.next_cycle_index).toBe(99);
  }
});

it("shares DMA proof budgets across replayed exploration attempts", async () => {
  const { input, header, prg, trace } = await run([0xd0, 2, 0xea, 0xea, 0xea], {
    initial_ppu: nesPpuFixtureState({
      oam: oam({ status: "pending", page: 0x82 }),
    }),
    max_instructions: 1,
  });
  const budget = trace.cpu_dma.retained_source_bytes;
  const explored = await exploreNesCode(
    header,
    prg,
    exploreNesCodeInputSchema.parse({
      ...input,
      max_paths: 3,
      max_oam_dma_source_bytes: budget,
    }),
  );
  expect(explored).toMatchObject({
    status: "derived",
    termination: "oam-dma-source-budget",
    paths: [
      { trace: { stop: { reason: "unknown-branch" } } },
      { trace: { stop: { reason: "oam-dma-source-budget" } } },
    ],
  });
  if (explored.status === "derived")
    expect(explored.pending_paths).toHaveLength(1);
});

it("consumes Namco requests once and derives live port bytes and cartridge clocks during every stalled cycle", async () => {
  const fixture = namco163RamFixture("saturate");
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const bytes = Array.from({ length: 128 }, (_, index) => index);
  const input = traceNesCodeInputSchema.parse({
    path: "/namco-dma.nes",
    initial: {
      ...fixture.initial,
      irq_high: 128,
      chip_ram: {
        ...fixture.initial.chip_ram,
        bytes,
        address_port: 0x83,
        oam_dma_pending: 0x48,
      },
    },
    initial_ppu: nesPpuFixtureState({
      chr_ram_size: null,
      nametable_layout: null,
      oam: oam({ status: "pending", page: 0x48 }),
    }),
    initial_controllers: {
      model: "standard-controllers",
      dma_reads: "absent",
      oam_dma_pending: { status: "pending", page: 0x48 },
    },
    initial_irq: {
      model: "namco163",
      counter_low: 252,
      counter_high: 127,
      asserted: false,
    },
    initial_cpu_bus: { model: "nmos-6502-bus", dma_reads: "absent" },
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: "put" },
    entry: 0x200,
    cpu: { i: false },
    initial_interrupts: {
      model: "nmos-6502-interrupts",
      external_irq: false,
      nmi_edges: "absent",
      pending_irq: false,
      pending_nmi: false,
    },
    initial_ram: [{ address: 0x200, value: 0xea }],
    max_instructions: 1,
  });
  const prg = fixture.bytes.subarray(
    fixture.prgOffset,
    fixture.prgOffset + fixture.prgSize,
  );
  const trace = nesCodeTraceSchema.parse(
    await deriveNesCode(header.value, prg, input),
  );
  if (trace.status !== "derived" || !("cpu_dma" in trace))
    throw new Error(JSON.stringify(trace));
  const reads = trace.cpu_dma.transfers[0]!.cpu_bus_cycles.flatMap((cycle) =>
    cycle.kind === "read" && cycle.role === "data" ? [cycle.read] : [],
  );
  expect(reads.map((read) => read.value)).toEqual(
    Array.from({ length: 256 }, (_, index) => Math.min(3 + index, 127)),
  );
  expect(reads[0]!.mapper_origins[0]).toMatchObject({
    kind: "namco163-chip-ram",
    address_port: 0x83,
  });
  const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
  if (
    mapped.status !== "derived" ||
    !("controller_trace" in mapped) ||
    mapped.controller_trace === null
  )
    throw new Error("Missing devices");
  expect(
    mapped.steps.filter((step) => step.event.kind === "namco163-cpu-cycle"),
  ).toHaveLength(515);
  expect(mapped.final).toMatchObject({
    chip_ram: { address_port: 255, oam_dma_pending: "none" },
  });
  expect(mapped.controller_trace.final.oam_dma_pending).toEqual({
    status: "none",
  });
  expect(mapped.final_irq).toMatchObject({
    counter_low: 255,
    counter_high: 127,
    asserted: true,
  });
  if (!("interrupts" in trace)) throw new Error("Missing cartridge poll");
  expect(trace.interrupts.polls[0]!).toMatchObject({
    samples: [{ cartridge_irq: true }],
    pending_irq: true,
  });
  expect(
    await deriveNesMapperEvents(
      header.value,
      input.initial,
      mapped.steps.map((step) => step.event),
      {
        prg,
        initialPpu: input.initial_ppu,
        initialControllers: input.initial_controllers,
        initialIrq: input.initial_irq,
      },
    ),
  ).toEqual(mapped);
});

it("does not poll IRQ during DMA but samples the live line on the resumed CPU instruction", async () => {
  const { trace } = await run([0xea], {
    initial_ppu: nesPpuFixtureState({
      oam: oam({ status: "pending", page: 0x82 }),
    }),
    cpu: { i: false },
    initial_apu: {
      ...apu("put"),
      frame_sequencer: {
        ...apu("put").frame_sequencer,
        position: { min: 29820, max: 29820 },
      },
    },
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: "put" },
    initial_interrupts: {
      model: "nmos-6502-interrupts",
      external_irq: false,
      nmi_edges: "absent",
      pending_irq: false,
      pending_nmi: false,
    },
    max_instructions: 1,
  });
  if (!("interrupts" in trace)) throw new Error("Missing polls");
  expect(trace.interrupts.polls).toHaveLength(1);
  expect(trace.interrupts.polls[0]!).toMatchObject({
    samples: [{ cycle_index: 612, apu_frame_irq: true }],
    pending_irq: true,
  });
  expect(trace.interrupts.entries).toEqual([]);
});

it("orders a queued DMA before accepted IRQ entry and records disjoint entry/device ranges", async () => {
  const { trace } = await run([0x40], {
    entry: { accepted_interrupt: "irq", return_address: 0xc200 },
    cpu: { sp: 0xfd, i: false },
    initial_ppu: nesPpuFixtureState({
      oam: oam({ status: "pending", page: 0x82 }),
    }),
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: "put" },
    max_instructions: 1,
  });
  expect(trace.cpu_bus!.final.next_cycle_index).toBe(99 + 513 + 7 + 6);
  expect(trace.instructions[0]!.next_address).toBe(0xc200);
  expect(trace.final_cpu.sp).toBe(0xfd);
  const transfer = trace.cpu_dma.transfers[0]!;
  expect(transfer.halted_address).toBe(0xc200);
  if (
    trace.entry_interrupt === null ||
    !("mapper_event_range" in trace.entry_interrupt)
  )
    throw new Error("Missing entry range");
  expect(trace.entry_interrupt.mapper_event_range.start).toBe(
    transfer.mapper_event_range.start + transfer.mapper_event_range.count,
  );
});

it("advances PAL APU clocks during stalls and rejects contradictory shared phase/request inputs", async () => {
  const { trace, mapped } = await run([0xea], {
    initial_ppu: nesPpuFixtureState({
      oam: oam({ status: "pending", page: 0x82 }),
    }),
    initial_cpu_dma: { model: "oam-cpu-dma", region: "pal", cpu_phase: null },
    initial_apu: {
      ...apu("put"),
      frame_sequencer: {
        ...apu("put").frame_sequencer,
        region: "pal",
        position: { min: 8300, max: 8300 },
      },
    },
    max_instructions: 1,
  });
  expect(trace.cpu_dma.initialized.cpu_phase).toBe("put");
  expect(trace.cpu_dma.transfers[0]!.cpu_bus_cycles).toHaveLength(513);
  expect(mapped).toMatchObject({
    apu_trace: {
      final: { frame_sequencer: { position: { min: 8815, max: 8815 } } },
    },
  });
  const fixture = nesPpuFixture([0xea]),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  for (const extra of [
    { initial_cpu_bus: null },
    { initial_ppu: null },
    {
      initial_apu: apu("get"),
      initial_cpu_dma: {
        model: "oam-cpu-dma",
        region: "ntsc",
        cpu_phase: "put",
      },
    },
    {
      initial_cpu_dma: {
        model: "oam-cpu-dma",
        region: "ntsc",
        cpu_phase: "get",
        oam_dma_pending: { status: "pending", page: 4 },
      },
    },
    {
      initial_ppu: nesPpuFixtureState({ dma_reads: "unobserved", oam: oam() }),
    },
  ]) {
    const input = traceNesCodeInputSchema.parse({
      path: "/admission.nes",
      initial: { mapper: 0 },
      initial_cpu_bus: { model: "nmos-6502-bus", dma_reads: "absent" },
      initial_cpu_dma: {
        model: "oam-cpu-dma",
        region: "ntsc",
        cpu_phase: "get",
      },
      initial_ppu: nesPpuFixtureState({ oam: oam() }),
      ...extra,
    });
    expect(
      await deriveNesCode(
        header.value,
        fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
        input,
      ),
    ).toMatchObject({ status: "unsupported", reason: expect.any(String) });
  }
});

it("cancels an active transfer without changing caller device facts or ROM bytes", async () => {
  const fixture = nesPpuFixture([0xea]),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/cancel-dma.nes",
    initial: { mapper: 0 },
    initial_cpu_bus: { model: "nmos-6502-bus", dma_reads: "absent" },
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: "get" },
    initial_ppu: nesPpuFixtureState({
      oam: oam({ status: "pending", page: 0x82 }),
    }),
  });
  const before = structuredClone(input),
    bytes = Buffer.from(fixture.bytes),
    controller = new AbortController();
  setImmediate(() => controller.abort());
  await expect(
    deriveNesCode(
      header.value,
      fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
      input,
      { signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(input).toEqual(before);
  expect(fixture.bytes).toEqual(bytes);
});
