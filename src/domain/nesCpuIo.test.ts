import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { expect, it } from "vitest";

import { nesPpuFixture, nesPpuFixtureState } from "./nesPpu.fixture.js";

import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";

import { nesMapperEventsTraceSchema } from "./nesMapperEvents.js";
import { nesCpuReadProofBytes } from "./nesCpuDmaBudget.js";

const origin = { kind: "initial-state" };
const apu = () => ({
  model: "apu-registers",
  frame_clocks: "cpu-ordered",
  dmc_reads: "absent",
  frame_sequencer: {
    region: "ntsc",
    cpu_phase: "get",
    position: { min: 0, max: 0 },
    five_step: false,
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
  },
  registers: { 16407: { value: 0, origin }, 16405: { value: 0, origin } },
  frame_irq: { value: false, origin },
  dmc_irq: { value: false, origin },
  dmc_remaining: { value: { min: 0, max: 0 }, origin },
});
const controllers = () => ({
  model: "standard-controllers",
  dma_reads: "absent",
  strobe: false,
  oam_dma_pending: { status: "none" },
  buttons: [0xaa, 0x55],
  ports: [0xaa, 0x55].map((buttons, index) => ({
    serial_reports: [
      {
        position: 0,
        buttons,
        origin: { kind: "initial-report", port: index + 1 },
      },
    ],
  })),
});
const io = {
  model: "2a03-io",
  controller_clocking: "contiguous",
  active_controller: 0,
};
const ppu = (pending: unknown = { status: "none" }) =>
  nesPpuFixtureState({
    oam: {
      model: "oam-memory",
      address: 0,
      retention: "stable",
      reads: "supported",
      dma_pending: pending,
    },
  });
const run = async (
  program: number[],
  selected: Record<string, unknown> = {},
  patch: { offset: number; value: number }[] = [],
) => {
  const fixture = nesPpuFixture(program);
  for (let index = 0; index < 256; index++)
    fixture.bytes[fixture.prgOffset + 0x500 + index] = 2;
  for (let block = 0; block < 8; block++)
    fixture.bytes.set(
      [0x20, 0xa5, 0xe1, 0xe1],
      fixture.prgOffset + 0x500 + block * 32 + 20,
    );
  for (const item of patch)
    fixture.bytes[fixture.prgOffset + item.offset] = item.value;
  const prg = fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset);
  const {
    trace,
    input,
    header,
  } = await deriveNesFixtureTrace(fixture.bytes, prg, {
    path: "/io.nes",
    initial: { mapper: 0 },
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 100,
    },
    initial_cpu_io: io,
    max_instructions: 1,
    ...selected,
  });
  if (trace.cpu_bus === null || !("io" in trace.cpu_bus))
    throw new Error(JSON.stringify(trace));
  return {
    trace,
    io: trace.cpu_bus.io,
    header: header,
    prg,
    input,
    fixture,
  };
};

it("separates the 4015 internal value/D5 from the unchanged external latch with exact bit origins", async () => {
  const { trace, io: busIo } = await run([0xad, 0x15, 0x40], {
    initial_apu: apu(),
  });
  expect(trace.final_cpu.a).toBe(0);
  expect(busIo.final.cpu_latch).toBe(0);
  expect(busIo.final.external_latch).toBe(0x40);
  expect("latch_origins" in busIo.final && busIo.final.latch_origins).toEqual({
    cpu: [
      { mask: 32, source: { kind: "cycle", line: "external", index: 102 } },
      { mask: 223, source: { kind: "cycle", line: "cpu", index: 103 } },
    ],
    external: [
      { mask: 255, source: { kind: "cycle", line: "external", index: 102 } },
    ],
  });
  expect(trace.instructions[0]!.data_reads[0]!).toMatchObject({
    value: 0,
    file_offset: null,
    mapper_origins: [
      {
        kind: "cpu-io",
        operation: "apu-status",
        raw_value: { mask: 223, value: 0 },
        cpu_latch: 0x40,
        external_latch: 0x40,
        device_source: { kind: "apu-status" },
      },
    ],
  });
});

it("retains D5 across consecutive internal reads rather than replacing it from external pins", async () => {
  const { trace } = await run([2], {
    entry: { accepted_interrupt: "irq", return_address: 0x4015 },
    cpu: { sp: 0xfd },
    initial_apu: apu(),
    initial_cpu_io: { ...io, cpu_latch: 0x20, external_latch: 0x80 },
  });
  if (
    trace.entry_interrupt === null ||
    !("cpu_bus_cycles" in trace.entry_interrupt)
  )
    throw new Error("Missing entry");
  expect(
    trace.entry_interrupt.cpu_bus_cycles
      .slice(0, 2)
      .map((cycle) => (cycle.kind === "read" ? cycle.read.value : null)),
  ).toEqual([0x20, 0x20]);
});

it.each(["contiguous", "per-cycle"])(
  "owns consecutive controller /OE clocks for %s consoles and replays held reads",
  async (clocking) => {
    const { trace, input, header, prg } = await run([2], {
      entry: { accepted_interrupt: "irq", return_address: 0x4016 },
      cpu: { sp: 0xfd },
      initial_controllers: controllers(),
      initial_cpu_io: {
        ...io,
        controller_clocking: clocking,
        external_latch: 0xa0,
      },
    });
    const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
    if (
      mapped.status !== "derived" ||
      !("controller_trace" in mapped) ||
      mapped.controller_trace === null
    )
      throw new Error("Missing controllers");
    expect(
      mapped.controller_trace.final.ports[0]!.serial_reports[0]!.position,
    ).toBe(clocking === "contiguous" ? 1 : 2);
    expect(
      mapped.steps.filter((step) => step.event.kind === "controller-hold"),
    ).toHaveLength(clocking === "contiguous" ? 1 : 0);
    expect(
      await deriveNesMapperEvents(
        header,
        input.initial,
        mapped.steps.map((step) => step.event),
        { prg, initialControllers: input.initial_controllers },
      ),
    ).toEqual(mapped);
  },
);

it("keeps unknown initial /OE at a precise unapplied frontier", async () => {
  const { trace, io: busIo } = await run([2], {
    entry: { accepted_interrupt: "irq", return_address: 0x4016 },
    cpu: { sp: 0xfd, i: false },
    initial_controllers: controllers(),
    initial_cpu_io: { ...io, active_controller: null },
  });
  expect(trace.stop.reason).toBe("cpu-io-controller-uncertain");
  expect(trace.entry_interrupt).toBe(null);
  expect(trace.final_cpu.sp).toBe(0xfd);
  expect(busIo.final).toEqual(busIo.initialized);
});

it("derives NTSC OAM status isolation, controller conflicts and external source reads in one cycle each", async () => {
  const pads = {
    ...controllers(),
    oam_dma_pending: { status: "pending", page: 0x85 },
  };
  const {
    trace,
    input,
    header,
    prg,
    io: busIo,
    fixture,
  } = await run([2], {
    entry: 0x4000,
    initial_ppu: ppu({ status: "pending", page: 0x85 }),
    initial_controllers: pads,
    initial_apu: { ...apu(), frame_irq: { value: true, origin } },
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: "get" },
    initial_cpu_io: { ...io, cpu_latch: 0x20, external_latch: 0x80 },
  });
  if (!("cpu_dma" in trace)) throw new Error("Missing DMA");
  const transfer = trace.cpu_dma.transfers[0]!;
  expect(transfer.cpu_bus_cycles).toHaveLength(514);
  const reads = transfer.cpu_bus_cycles.filter(
    (cycle) => cycle.kind === "read" && "dma_io" in cycle,
  );
  expect(reads).toHaveLength(24);
  const status = reads[0]!;
  if (status.kind !== "read" || !("dma_io" in status))
    throw new Error("Missing status");
  expect(status.read).toMatchObject({
    address: 0x8515,
    value: 0xa5,
    file_offset: fixture.prgOffset + 0x515,
  });
  expect(status.dma_io).toMatchObject({
    decoded_address: 0x4015,
    cpu_value: 0x60,
    external_value: 0xa5,
    internal_read: { mapper_origins: [{ kind: "apu-status" }] },
  });
  for (let block = 0; block < 8; block++) {
    expect(transfer.writes[block * 32 + 21]!.value).toBe(
      block === 0 ? 0x60 : 0x20,
    );
    expect(transfer.writes[block * 32 + 22]!.value).toBe(
      block % 2 === 0 ? 0xe0 : 0xe1,
    );
    expect(transfer.writes[block * 32 + 23]!.value).toBe(
      block % 2 === 0 ? 0xe1 : 0xe0,
    );
  }
  expect(busIo.final).toMatchObject({
    cpu_latch: 2,
    external_latch: 2,
    active_controller: 0,
  });
  const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
  if (
    mapped.status !== "derived" ||
    !("controller_trace" in mapped) ||
    mapped.controller_trace === null
  )
    throw new Error("Missing devices");
  expect(
    mapped.controller_trace.final.ports.map(
      (port) => port.serial_reports[0]!.position,
    ),
  ).toEqual([8, 8]);
  expect(
    await deriveNesMapperEvents(
      header,
      input.initial,
      mapped.steps.map((step) => step.event),
      {
        prg,
        initialPpu: input.initial_ppu,
        initialControllers: input.initial_controllers,
        initialApu: input.initial_apu,
      },
    ),
  ).toEqual(mapped);
});

it("uses retained external open bus throughout a 4000 DMA page without triggering internal registers", async () => {
  const { trace } = await run([0xa9, 0x40, 0x8d, 0x14, 0x40, 2], {
    initial_ppu: ppu(),
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: "put" },
    max_instructions: 3,
  });
  if (!("cpu_dma" in trace)) throw new Error("Missing DMA");
  expect(
    trace.cpu_dma.transfers[0]!.writes.map((write) => write.value),
  ).toEqual(Array(256).fill(2));
});

it("preserves unmodeled controller-pin uncertainty when ROM drives ones during a conflict", async () => {
  const pads = {
    ...controllers(),
    oam_dma_pending: { status: "pending", page: 0x85 },
  };
  const { trace } = await run(
    [2],
    {
      entry: 0x4000,
      initial_ppu: ppu({ status: "pending", page: 0x85 }),
      initial_controllers: pads,
      initial_cpu_dma: {
        model: "oam-cpu-dma",
        region: "ntsc",
        cpu_phase: "put",
      },
    },
    [{ offset: 0x516, value: 255 }],
  );
  if (!("cpu_dma" in trace)) throw new Error("Missing DMA");
  expect(trace.cpu_dma.transfers[0]!.writes[22]).toMatchObject({
    value: null,
    known_bits: { mask: 225, value: 224 },
  });
});

it("keeps a composite-read budget failure atomic across latches and both device reads", async () => {
  const selected = {
    entry: 0x4000,
    initial_ppu: ppu({ status: "pending", page: 0x85 }),
    initial_apu: { ...apu(), frame_irq: { value: true, origin } },
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: "get" },
    initial_cpu_io: { ...io, cpu_latch: 0x20, external_latch: 0x80 },
  };
  const full = (await run([2], selected)).trace;
  if (!("cpu_dma" in full)) throw new Error("Missing DMA");
  const cycles = full.cpu_dma.transfers[0]!.cpu_bus_cycles;
  const firstComposite = cycles.findIndex((cycle) => "dma_io" in cycle);
  const proofs = cycles
    .slice(0, firstComposite)
    .flatMap((cycle) => (cycle.kind === "read" ? [cycle.read] : []));
  const { trace, io: busIo } = await run([2], {
    ...selected,
    max_oam_dma_source_bytes: nesCpuReadProofBytes(proofs),
  });
  if (!("cpu_dma" in trace)) throw new Error("Missing DMA");
  expect(trace.stop.reason).toBe("oam-dma-source-budget");
  expect(trace.cpu_dma.frontier!.cpu_bus_cycles).toHaveLength(firstComposite);
  expect(trace.cpu_dma.frontier!.writes).toHaveLength(21);
  expect(busIo.final).toEqual(busIo.initialized);
  expect(busIo.frontier).toMatchObject({
    cpu_latch: 0x20,
    external_latch: 0x20,
  });
  expect(trace.mapper_trace).toMatchObject({
    apu_trace: { final: { frame_irq: { value: true } }, frontier: [] },
    ppu_trace: { final: { oam: { cells: {} } } },
  });
  expect(
    trace.cpu_dma.frontier!.mapper_events.some(
      (event) => event.kind === "cpu-read" && event.address === 0x4015,
    ),
  ).toBe(false);
});

it("does not invent a clock ambiguity for a live high-strobe controller", async () => {
  const { trace } = await run([2], {
    entry: { accepted_interrupt: "irq", return_address: 0x4016 },
    cpu: { sp: 0xfd },
    initial_controllers: { ...controllers(), strobe: true },
    initial_cpu_io: { ...io, active_controller: null },
  });
  expect(trace.entry_interrupt).not.toBe(null);
  expect(trace.mapper_trace).toMatchObject({
    controller_trace: {
      final: {
        ports: [
          { serial_reports: [{ position: 0 }] },
          { serial_reports: [{ position: 0 }] },
        ],
      },
    },
  });
});

it.each([
  { strobe: true, live: 1, expected: { mask: 225, value: 225 } },
  { strobe: null, live: 0, expected: { mask: 225, value: 224 } },
  { strobe: null, live: 1, expected: { mask: 224, value: 224 } },
])(
  "joins live A=$live and frozen low reports under held /OE and strobe=$strobe",
  async ({ strobe, live, expected }) => {
    const pads = controllers();
    pads.ports[0]!.serial_reports[0]!.position = 1;
    const { trace } = await run([2], {
      entry: { accepted_interrupt: "irq", return_address: 0x4016 },
      cpu: { sp: 0xfd },
      initial_controllers: { ...pads, strobe, buttons: [live, 0x55] },
      initial_cpu_io: {
        ...io,
        active_controller: 1,
        external_latch: 0xe0,
        held_controller: {
          pin_value: strobe === true ? { mask: 1, value: 0 } : null,
          cycle_index: 50,
          source: {
            kind: "standard-controller",
            port: 1,
            strobe: strobe === true ? false : null,
            live: { value: 1, origin: { kind: "initial-buttons", port: 1 } },
            serial_reports: [
              {
                position: 0,
                buttons: 0xaa,
                origin: { kind: "initial-report", port: 1 },
              },
            ],
            tail_bit: 1,
            dma_reads: "absent",
            reason: "unresolved-controller-bit",
          },
        },
      },
    });
    if (
      trace.entry_interrupt === null ||
      !("cpu_bus_cycles" in trace.entry_interrupt)
    )
      throw new Error("Missing entry");
    for (const cycle of trace.entry_interrupt.cpu_bus_cycles.slice(0, 2)) {
      expect(cycle).toMatchObject({
        kind: "read",
        read: { known_bits: expected },
      });
    }
    const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
    if (
      mapped.status !== "derived" ||
      !("controller_trace" in mapped) ||
      mapped.controller_trace === null
    )
      throw new Error("Missing controllers");
    expect(mapped.controller_trace.final.ports).toEqual(
      mapped.controller_trace.initialized.ports,
    );
    if (strobe === null) {
      expect(mapped.steps[0]!.event).toMatchObject({
        kind: "controller-hold",
        held: {
          cycle_index: 50,
          source: {
            live: { value: live },
            serial_reports: [{ position: 0, buttons: 0xaa }],
          },
        },
      });
    }
  },
);
