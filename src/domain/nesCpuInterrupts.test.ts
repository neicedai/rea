import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import { mapperTraceFixture } from "./nesMapperTrace.fixture.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";

const interrupts = {
  model: "nmos-6502-interrupts",
  external_irq: true,
  nmi_edges: "absent",
  pending_irq: false,
  pending_nmi: false,
};
const run = async (
  program: number[],
  selected: Record<string, unknown> = {},
) => {
  const fixture = nesCodeFixture(4, program);
  fixture.bytes.writeUInt16LE(0xe100, fixture.prgOffset + fixture.prgSize - 2);
  fixture.bytes.writeUInt16LE(0xe200, fixture.prgOffset + fixture.prgSize - 6);
  fixture.bytes.set([0x40], fixture.programOffset + 0x100);
  fixture.bytes.set([0xea], fixture.programOffset + 0x200);
  return derive(fixture.bytes, {
    initial: { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 2, 1] },
    ...selected,
  });
};
const derive = async (bytes: Buffer, selected: Record<string, unknown>) => {
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/interrupt.nes",
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 100,
    },
    initial_interrupts: interrupts,
    cpu: { sp: 0xfd, i: true },
    max_instructions: 3,
    ...selected,
  });
  const prg = bytes.subarray(
    header.value.prgRom.offset,
    header.value.prgRom.offset + header.value.prgRom.size,
  );
  const result = nesCodeTraceSchema.parse(
    await deriveNesCode(header.value, prg, input),
  );
  if (result.status !== "derived" || !("interrupts" in result))
    throw new Error(JSON.stringify(result));
  return { result, input, header: header.value, prg };
};

it("delays CLI, preserves pending IRQ across budget continuation and identifies automatic stack writers", async () => {
  const { result } = await run([0x58, 0xea, 0xea]);
  expect(result.instructions.map((instruction) => instruction.address)).toEqual(
    [0xe000, 0xe001, 0xe100],
  );
  expect(result.interrupts.polls.map((poll) => poll.pending_irq)).toEqual([
    false,
    true,
    true,
  ]);
  const entry = result.interrupts.entries[0]!;
  expect(entry).toMatchObject({
    kind: "irq",
    before_instruction_index: 2,
    return_address: 0xe002,
    target_address: 0xe100,
  });
  expect(entry.writes.map((write) => write.address)).toEqual([
    0x1fd, 0x1fc, 0x1fb,
  ]);
  expect(entry.writes[2]).toMatchObject({
    value: null,
    known_bits: { mask: 0x34, value: 0x20 },
  });
  expect(entry.cpu_bus_cycles.map((cycle) => [cycle.kind, cycle.role])).toEqual(
    [
      ["read", "dummy"],
      ["read", "dummy"],
      ["write", "stack"],
      ["write", "stack"],
      ["write", "stack"],
      ["read", "vector"],
      ["read", "vector"],
    ],
  );
  expect(
    result.instructions[2]!.data_reads.map((read) => read.ram_origins[0]),
  ).toEqual([
    {
      byte_index: 0,
      region: "internal-ram",
      ram_address: 0x1fb,
      interrupt_index: 0,
      interrupt_write_index: 2,
    },
    {
      byte_index: 0,
      region: "internal-ram",
      ram_address: 0x1fc,
      interrupt_index: 0,
      interrupt_write_index: 1,
    },
    {
      byte_index: 0,
      region: "internal-ram",
      ram_address: 0x1fd,
      interrupt_index: 0,
      interrupt_write_index: 0,
    },
  ]);
  const prefix = (await run([0x58, 0xea, 0xea], { max_instructions: 2 }))
    .result;
  expect(prefix.interrupts.entries).toEqual([]);
  expect(prefix.interrupts.final.pending_irq).toBe(true);
  const continued = (
    await run([0x58, 0xea, 0xea], {
      entry: prefix.stop.address,
      cpu: prefix.final_cpu,
      initial_cpu_bus: prefix.cpu_bus!.final,
      initial_interrupts: prefix.interrupts.final,
      max_instructions: 1,
    })
  ).result;
  expect(continued.interrupts.entries[0]!.cpu_bus_cycles).toEqual(
    entry.cpu_bus_cycles,
  );
  expect(continued.final_cpu).toEqual(result.final_cpu);
});

it.each([
  {
    program: [0x78],
    cpu: { i: false, sp: 0xfd },
    ram: [],
    first: true,
    sampledI: false,
  },
  {
    program: [0x28, 0xea],
    cpu: { i: true, sp: 0xfc },
    ram: [{ address: 0x1fd, value: 0 }],
    first: false,
    sampledI: true,
  },
  {
    program: [0x28],
    cpu: { i: false, sp: 0xfc },
    ram: [{ address: 0x1fd, value: 4 }],
    first: true,
    sampledI: false,
  },
  {
    program: [0x40],
    cpu: { i: true, sp: 0xfa },
    ram: [
      { address: 0x1fb, value: 0 },
      { address: 0x1fc, value: 4 },
      { address: 0x1fd, value: 0xe0 },
    ],
    first: true,
    sampledI: false,
  },
])(
  "polls old I for SEI/PLP and restored I for RTI: $program",
  async ({ program, cpu, ram, first, sampledI }) => {
    const { result } = await run(program, {
      cpu,
      initial_ram: ram,
      max_instructions: program.length + 1,
    });
    expect(result.interrupts.polls[0]!).toMatchObject({
      pending_irq: first,
      samples: [{ i: sampledI }],
    });
    expect(result.interrupts.entries[0]!.before_instruction_index).toBe(
      first ? 1 : 2,
    );
    expect(result.interrupts.entries[0]!.cpu_after.i).toBe(true);
  },
);

it("prioritizes NMI over an already-polled IRQ and runs a handler instruction before polling again", async () => {
  const { result } = await run([0xea], {
    initial_interrupts: { ...interrupts, pending_irq: true, pending_nmi: true },
    max_instructions: 1,
  });
  expect(result.interrupts.entries).toHaveLength(1);
  expect(result.interrupts.entries[0]!).toMatchObject({
    kind: "nmi",
    before_instruction_index: 0,
    target_address: 0xe200,
  });
  expect(result.instructions[0]!.address).toBe(0xe200);
  expect(result.interrupts.final).toMatchObject({
    pending_irq: false,
    pending_nmi: false,
  });
});

it.each([false, true])(
  "uses branch-specific sampling with CPU-clocked cartridge IRQs, crossing=%s",
  async (crossing) => {
    const bytes = mapperTraceFixture(19);
    const header = parseNesHeader(bytes);
    if (!header.ok) throw new Error(header.error);
    bytes.writeUInt16LE(
      0x300,
      header.value.prgRom.offset + header.value.prgRom.size - 2,
    );
    const entry = crossing ? 0x2fd : 0x200;
    const ram = [0xd0, 2, 0xea, 0xea, 0xea].map((value, index) => ({
      address: entry + index,
      value,
    }));
    if (!ram.some((item) => item.address === 0x300))
      ram.push({ address: 0x300, value: 0xea });
    const { result, input, prg } = await derive(bytes, {
      initial: { mapper: 19, variant: "namco163", irq_high: 128 },
      initial_irq: {
        model: "namco163",
        counter_low: 253,
        counter_high: 127,
        asserted: false,
      },
      initial_interrupts: { ...interrupts, external_irq: false },
      entry,
      initial_ram: ram,
      cpu: { sp: 0xfd, i: false, z: false },
      max_instructions: 2,
    });
    expect(
      result.interrupts.polls[0]!.samples.map((sample) => sample.cycle_index),
    ).toEqual(crossing ? [100, 102] : [100]);
    expect(result.interrupts.polls[0]!.pending_irq).toBe(crossing);
    expect(result.interrupts.entries).toHaveLength(crossing ? 1 : 0);
    if (
      result.mapper_trace.status !== "derived" ||
      !("final_irq" in result.mapper_trace)
    )
      throw new Error("Expected events");
    const replay = await deriveNesMapperEvents(
      header.value,
      input.initial,
      result.mapper_trace.steps.map((step) => step.event),
      { prg, initialIrq: input.initial_irq },
    );
    expect(replay).toEqual(result.mapper_trace);
  },
);

it("stops uncertain boundary/NMI inputs and preserves masked unknown IRQ contributions", async () => {
  for (const state of [
    { ...interrupts, pending_nmi: null },
    { ...interrupts, pending_irq: null },
    { ...interrupts, nmi_edges: "unobserved" },
  ]) {
    const { result } = await run([0xea], { initial_interrupts: state });
    expect(result.stop.reason).toBe("interrupt-uncertain");
    expect(result.instructions).toEqual([]);
    expect(result.cpu_bus!.final.next_cycle_index).toBe(100);
  }
  const { result } = await run([0xea, 0x58, 0xea], {
    initial_interrupts: { ...interrupts, external_irq: null },
    max_instructions: 4,
  });
  expect(result.instructions).toHaveLength(3);
  expect(result.interrupts.polls.map((poll) => poll.pending_irq)).toEqual([
    false,
    false,
    null,
  ]);
  expect(result.stop.reason).toBe("interrupt-uncertain");
});

it("retains unapplied interrupt bus effects without committing CPU, clocks or the request", async () => {
  const { result } = await run([0xea], {
    initial_interrupts: { ...interrupts, pending_irq: true },
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "unobserved",
      next_cycle_index: 100,
    },
  });
  expect(result.stop).toMatchObject({
    reason: "cpu-timing-dma",
    cpu_bus_frontier: {
      cycles: [],
      writes: [],
      mapper_events: [],
      blocked_address: 0xe000,
    },
  });
  expect(result.interrupts.entries).toEqual([]);
  expect(result.interrupts.frontier).toMatchObject({
    kind: "irq",
    return_address: 0xe000,
  });
  expect(result.interrupts.final.pending_irq).toBe(true);
  expect(result.final_cpu.sp).toBe(0xfd);
  expect(result.cpu_bus!.final.next_cycle_index).toBe(100);
});

it("keeps a sampled APU request after the final status read acknowledges the line", async () => {
  const origin = { kind: "initial-state" };
  const { result, input, header, prg } = await run([0x2c, 0x15, 0x40], {
    cpu: { sp: 0xfd, i: false, a: 0 },
    initial_interrupts: { ...interrupts, external_irq: false },
    initial_apu: {
      model: "apu-registers",
      frame_clocks: "cpu-ordered",
      dmc_reads: "absent",
      registers: { 16407: { value: 0, origin } },
      frame_irq: { value: true, origin },
      dmc_irq: { value: false, origin },
      frame_sequencer: {
        region: "ntsc",
        position: { min: 0, max: 0 },
        five_step: false,
        cpu_phase: "get",
        reset_delay: { min: 0, max: 0 },
        clock_block: 0,
      },
    },
    max_instructions: 2,
  });
  expect(result.interrupts.polls[0]!).toMatchObject({
    pending_irq: true,
    samples: [{ cycle_index: 102, mapper_event_count: 3, apu_frame_irq: true }],
  });
  expect(result.interrupts.entries[0]!.mapper_event_range).toEqual({
    start: 5,
    count: 7,
  });
  if (
    result.mapper_trace.status !== "derived" ||
    !("final_irq" in result.mapper_trace)
  )
    throw new Error("Missing events");
  expect(
    await deriveNesMapperEvents(
      header,
      input.initial,
      result.mapper_trace.steps.map((step) => step.event),
      { prg, initialApu: input.initial_apu },
    ),
  ).toEqual(result.mapper_trace);
});

it("owns unknown-vector entry effects as a hypothetical prefix and reserves automatic-entry index capacity", async () => {
  const fixture = nesCodeFixture(1, []);
  const { result } = await derive(fixture.bytes, {
    initial: { mapper: 1 },
    entry: 0x200,
    initial_interrupts: { ...interrupts, pending_irq: true },
  });
  expect(result.stop).toMatchObject({
    reason: "unresolved-vector",
    cpu_bus_frontier: { cycles: expect.any(Array), writes: expect.any(Array) },
  });
  if (!("cpu_bus_frontier" in result.stop)) throw new Error("Missing frontier");
  expect(result.stop.cpu_bus_frontier.cycles).toHaveLength(7);
  expect(result.stop.cpu_bus_frontier.writes).toHaveLength(3);
  expect(result.interrupts.entries).toEqual([]);
  expect(result.interrupts.final.pending_irq).toBe(true);
  expect(result.final_cpu.sp).toBe(0xfd);
  expect(result.cpu_bus!.final.next_cycle_index).toBe(100);
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/capacity.nes",
    initial: { mapper: 1 },
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: Number.MAX_SAFE_INTEGER - 14,
    },
    initial_interrupts: interrupts,
    max_instructions: 1,
  });
  expect(
    await deriveNesCode(
      header.value,
      fixture.bytes.subarray(
        fixture.prgOffset,
        fixture.prgOffset + fixture.prgSize,
      ),
      input,
    ),
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("cycle index"),
  });
});
