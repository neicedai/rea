import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { traceNesCodeInputSchema, type NesCodePath } from "./nesCodeTrace.js";

const initial = { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 2, 1] };
const bus = {
  model: "nmos-6502-bus",
  dma_reads: "absent",
  next_cycle_index: 70,
};
const run = async (
  program: number[],
  selected: Record<string, unknown> = {},
) => {
  const fixture = nesCodeFixture(4, program);
  const prg = fixture.bytes.subarray(
    fixture.prgOffset,
    fixture.prgOffset + fixture.prgSize,
  );
  const {
    trace: result,
    input,
    header,
  } = await deriveNesFixtureTrace(fixture.bytes, prg, {
    path: "/bus.nes",
    initial,
    initial_cpu_bus: bus,
    ...selected,
  });

  return { result, fixture, header: header, prg, input };
};
const cycles = (instruction: NesCodePath["instructions"][number]) => {
  if (!("cpu_bus_cycles" in instruction)) throw new Error("Missing bus cycles");
  return instruction.cpu_bus_cycles;
};
const actions = (instruction: NesCodePath["instructions"][number]) =>
  cycles(instruction).map((cycle) => [
    cycle.kind,
    cycle.role,
    cycle.kind === "read"
      ? cycle.read.address
      : instruction.writes[cycle.write_index]!.address,
  ]);
const frame = (position: number) => ({
  model: "apu-registers",
  frame_clocks: "cpu-ordered",
  dmc_reads: "absent",
  frame_sequencer: {
    region: "ntsc",
    position: { min: position, max: position },
    five_step: false,
    cpu_phase: "get",
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
  },
  registers: { 16407: { value: 0, origin: { kind: "initial-state" } } },
  frame_irq: { value: false, origin: { kind: "initial-state" } },
});

it("orders zero-page, indirect, indexed, RMW and unofficial NOP bus actions without duplicating semantic reads", async () => {
  const { result } = await run(
    [
      0xb5, 0xff, 0xa1, 0xfe, 0xb1, 0x20, 0x9d, 0xff, 0x80, 0xfe, 0xff, 0x80,
      0x1c, 0xff, 0x80,
    ],
    {
      cpu: { x: 1, y: 1 },
      max_instructions: 6,
      initial_ram: [
        { address: 255, value: 0xff },
        { address: 0, value: 0x80 },
        { address: 0x20, value: 0xff },
        { address: 0x21, value: 0x80 },
      ],
    },
  );
  expect(
    result.instructions.map((instruction) => cycles(instruction).length),
  ).toEqual([4, 6, 6, 5, 7, 5]);
  expect(actions(result.instructions[0]!)).toEqual([
    ["read", "opcode", 0xe000],
    ["read", "operand", 0xe001],
    ["read", "dummy", 255],
    ["read", "data", 0],
  ]);
  expect(actions(result.instructions[1]!).slice(2)).toEqual([
    ["read", "dummy", 254],
    ["read", "pointer", 255],
    ["read", "pointer", 0],
    ["read", "data", 0x80ff],
  ]);
  expect(actions(result.instructions[2]!).slice(2)).toEqual([
    ["read", "pointer", 32],
    ["read", "pointer", 33],
    ["read", "dummy", 0x8000],
    ["read", "data", 0x8100],
  ]);
  expect(actions(result.instructions[4]!).slice(3)).toEqual([
    ["read", "dummy", 0x8000],
    ["read", "data", 0x8100],
    ["write", "dummy", 0x8100],
    ["write", "data", 0x8100],
  ]);
  expect(
    result.instructions.map((instruction) => instruction.data_reads.length),
  ).toEqual([1, 3, 3, 0, 1, 0]);
  expect(result.cpu_bus?.final.next_cycle_index).toBe(103);
  expect(result.stop).not.toHaveProperty("cpu_bus_frontier");
});

it("fetches JSR's high operand after its own stack writes, with same-instruction physical RAM provenance", async () => {
  for (const timed of [false, true]) {
    const { result } = await run([], {
      entry: 0x1fd,
      cpu: { sp: 0xff },
      max_instructions: 1,
      initial_cpu_bus: timed ? bus : null,
      initial_ram: [
        { address: 0x1fd, value: 0x20 },
        { address: 0x1fe, value: 0x34 },
        { address: 0x1ff, value: 0x80 },
      ],
    });
    const instruction = result.instructions[0]!;
    expect(instruction).toMatchObject({
      bytes_hex: "203401",
      next_address: 0x134,
      cpu_after: { sp: 0xfd },
      ram_origins: [
        { byte_index: 0, initial_ram_index: 0 },
        { byte_index: 1, initial_ram_index: 1 },
        {
          byte_index: 2,
          instruction_index: 0,
          write_index: 0,
          ram_address: 0x1ff,
        },
      ],
    });
    if (timed)
      expect(actions(instruction)).toEqual([
        ["read", "opcode", 0x1fd],
        ["read", "operand", 0x1fe],
        ["read", "dummy", 0x1ff],
        ["write", "stack", 0x1ff],
        ["write", "stack", 0x1fe],
        ["read", "operand", 0x1ff],
      ]);
    else expect(result.cpu_bus).toBeNull();
  }
  const failed = await run([], {
    entry: 0x1fd,
    cpu: { sp: 0xfd },
    initial_ram: [
      { address: 0x1fd, value: 0x20 },
      { address: 0x1fe, value: 0x34 },
    ],
  });
  expect(failed.result).toMatchObject({
    instructions: [],
    final_cpu: { sp: 0xfd },
    cpu_bus: { final: { next_cycle_index: 70 } },
    stop: {
      reason: "unmapped-instruction",
      cpu_bus_frontier: {
        writes: [
          { address: 0x1fd, value: 1 },
          { address: 0x1fc, value: 255 },
        ],
      },
    },
  });
});

it("keeps an unresolved RTS bus frontier identical across an actual CPU, stack and bus continuation", async () => {
  const program = [
    0x20,
    0x10,
    0xe0,
    ...Array<number>(13).fill(0xea),
    0xa2,
    0xfd,
    0x9a,
    0x60,
    0xea,
  ];
  const selected = { cpu: { sp: 0xfd }, max_instructions: 4 };
  const { result: whole } = await run(program, selected);
  const { result: prefix } = await run(program, {
    ...selected,
    max_instructions: 3,
  });
  expect(prefix.stop).toMatchObject({
    reason: "instruction-budget",
    address: 0xe013,
  });
  const initialRam = prefix.instructions
    .flatMap((instruction) => instruction.writes)
    .map((write) => {
      if (write.value === null) throw new Error("Missing committed stack byte");
      return { address: write.address, value: write.value };
    })
    .sort((a, b) => a.address - b.address);
  expect(initialRam).toEqual([
    { address: 0x1fc, value: 2 },
    { address: 0x1fd, value: 0xe0 },
  ]);
  expect(prefix.final_cpu).toMatchObject({ x: 0xfd, sp: 0xfd });
  expect(prefix.cpu_bus?.final.next_cycle_index).toBe(80);
  if (prefix.mapper_trace.status !== "derived")
    throw new Error("Missing committed mapper state");
  const { result: resumed } = await run(program, {
    entry: prefix.stop.address,
    cpu: prefix.final_cpu,
    initial: prefix.mapper_trace.final,
    initial_cpu_bus: prefix.cpu_bus?.final,
    initial_ram: initialRam,
    max_instructions: 1,
  });
  expect(whole.instructions).toHaveLength(3);
  expect(resumed.instructions).toEqual([]);
  expect(whole.stop.reason).toBe("unknown-control-target");
  expect(resumed.stop.reason).toBe(whole.stop.reason);
  expect(resumed.final_cpu).toEqual(whole.final_cpu);
  expect(resumed.cpu_bus?.final).toEqual(whole.cpu_bus?.final);
  if (
    !("cpu_bus_frontier" in whole.stop) ||
    !("cpu_bus_frontier" in resumed.stop)
  )
    throw new Error("Missing unresolved RTS frontier");
  const observed = (frontier: typeof whole.stop.cpu_bus_frontier) =>
    frontier.cycles.map((cycle) => {
      if (cycle.kind !== "read") throw new Error("RTS frontier wrote memory");
      return [cycle.index, cycle.role, cycle.read.address, cycle.read.value];
    });
  expect(observed(whole.stop.cpu_bus_frontier)).toEqual([
    [80, "opcode", 0xe013, 0x60],
    [81, "dummy", 0xe014, 0xea],
    [82, "dummy", 0x1fd, 0xe0],
    [83, "stack", 0x1fe, null],
    [84, "stack", 0x1ff, null],
    [85, "dummy", null, null],
  ]);
  expect(observed(resumed.stop.cpu_bus_frontier)).toEqual(
    observed(whole.stop.cpu_bus_frontier),
  );
  const resumedDummy = resumed.stop.cpu_bus_frontier.cycles[2]!;
  if (resumedDummy.kind !== "read") throw new Error("Missing stack dummy");
  expect(resumedDummy.read.ram_origins).toEqual([
    {
      byte_index: 0,
      region: "internal-ram",
      ram_address: 0x1fd,
      initial_ram_index: 1,
    },
  ]);
});

it.each([null, 0xfd])(
  "uses unresolved stack facts in qualified bus mode while retaining the nonbus RTS boundary for SP %s",
  async (sp) => {
    const { result: qualified } = await run([0x60], { cpu: { sp } });
    expect(qualified.instructions).toEqual([]);
    expect(qualified.stop.reason).toBe(
      sp === null ? "unknown-stack" : "unknown-control-target",
    );
    expect(qualified.final_cpu.sp).toBe(sp);
    expect(qualified.cpu_bus?.final.next_cycle_index).toBe(70);
    const { result: unqualified } = await run([0x60], {
      cpu: { sp },
      initial_cpu_bus: null,
    });
    expect(unqualified.instructions).toEqual([]);
    expect(unqualified.stop.reason).toBe("return");
    expect(unqualified.final_cpu.sp).toBe(sp);
    expect(unqualified.cpu_bus).toBeNull();
  },
);

it("keeps branch clocks and unknown crossing boundaries distinct even when both branches reach the same PC", async () => {
  const unknown = await run([0xd0, 0, 0xea]);
  expect(unknown.result).toMatchObject({
    instructions: [],
    stop: {
      reason: "unknown-branch",
      successors: [0xe002, 0xe002],
      cpu_bus_frontier: { cycles: [{ index: 70 }, { index: 71 }] },
    },
    cpu_bus: { final: { next_cycle_index: 70 } },
  });
  for (const taken of [false, true]) {
    const chosen = await run([0xd0, 0], {
      branch_choices: [{ address: 0xe000, taken }],
      max_instructions: 1,
    });
    expect(cycles(chosen.result.instructions[0]!).length).toBe(taken ? 3 : 2);
  }
  const crossed = await run([], {
    entry: 0x1fc,
    cpu: { z: false },
    initial_ram: [
      { address: 0x1fc, value: 0xd0 },
      { address: 0x1fd, value: 2 },
    ],
    max_instructions: 1,
  });
  expect(actions(crossed.result.instructions[0]!)).toEqual([
    ["read", "opcode", 0x1fc],
    ["read", "operand", 0x1fd],
    ["read", "dummy", 0x1fe],
    ["read", "dummy", 0x100],
  ]);
  const ambiguous = await run([0xbd, 0xff, 0x80]);
  expect(ambiguous.result).toMatchObject({
    instructions: [],
    stop: {
      reason: "cpu-timing-unresolved",
      cpu_bus_frontier: {
        cycles: [{ index: 70 }, { index: 71 }, { index: 72 }],
      },
    },
  });
  const stable = await run([0xbd, 0, 0x80], { max_instructions: 1 });
  expect(cycles(stable.result.instructions[0]!).length).toBe(4);
  const partial = await run([0xbd, 0xff, 0x80], {
    cpu: { register_bits: { x: { mask: 1, value: 1 } } },
    max_instructions: 1,
  });
  expect(cycles(partial.result.instructions[0]!).length).toBe(5);
});

it("commits stores before stopping at a possible DMA read, preserving the caller's absence qualification", async () => {
  for (const address of [0x4014, 0x4015]) {
    const { result } = await run([0x8d, address & 255, address >> 8, 0xea], {
      cpu: { a: 16 },
    });
    expect(result).toMatchObject({
      instructions: [{ writes: [{ address, value: 16 }] }],
      cpu_bus: {
        initial: { dma_reads: "absent" },
        final: { dma_reads: "unobserved", next_cycle_index: 74 },
      },
      stop: {
        reason: "cpu-timing-dma",
        cpu_bus_frontier: { cycles: [], writes: [], blocked_address: 0xe003 },
      },
    });
  }
  const disabled = await run([0x8d, 0x15, 0x40, 0xea], {
    cpu: { a: 0 },
    max_instructions: 2,
  });
  expect(disabled.result.instructions).toHaveLength(2);
  const unobserved = await run([0xea], {
    initial_cpu_bus: { ...bus, dma_reads: "unobserved" },
  });
  expect(unobserved.result.stop.reason).toBe("cpu-timing-dma");
});

it("places APU reads between source fetch edges and the following edge, and replays the committed event prefix", async () => {
  for (const position of [29824, 29825]) {
    const { result, header, prg, input } = await run([0x2c, 0x15, 0x40, 2], {
      cpu: { a: 0 },
      initial_apu: frame(position),
    });
    expect(result.instructions[0]!.cpu_after.v).toBe(position === 29825);
    expect(result.stop).toMatchObject({
      reason: "unsupported-opcode",
      cpu_bus_frontier: { cycles: [{ index: 74, role: "opcode" }] },
    });
    const mapped = result.mapper_trace;
    if (mapped.status !== "derived" || !("apu_trace" in mapped))
      throw new Error("Missing APU events");
    expect(mapped.steps.map((step) => step.event.kind)).toEqual([
      "apu-cpu-cycle",
      "apu-cpu-cycle",
      "apu-cpu-cycle",
      "cpu-read",
      "apu-cpu-cycle",
    ]);
    expect(mapped.apu_trace.final.frame_irq.value).toBe(true);
    const replay = await deriveNesMapperEvents(
      header,
      input.initial,
      mapped.steps.map((step) => step.event),
      { prg, initialApu: input.initial_apu },
    );
    if (replay.status !== "derived" || !("apu_trace" in replay))
      throw new Error("Missing replay");
    expect(replay.apu_trace.final).toEqual(mapped.apu_trace.final);
  }
});

it("derives seven accepted-entry actions then six RTI actions with separate stack origins", async () => {
  const { result } = await run([0x40], {
    entry: { accepted_interrupt: "nmi", return_address: 0xe010 },
    cpu: { sp: 0, i: false },
    max_instructions: 1,
  });
  expect(result.entry_interrupt).toMatchObject({
    cpu_bus_cycles: [
      { role: "dummy" },
      { role: "dummy" },
      { role: "stack" },
      { role: "stack" },
      { role: "stack" },
      { role: "vector" },
      { role: "vector" },
    ],
  });
  expect(result.instructions[0]!).toMatchObject({
    next_address: 0xe010,
    cpu_after: { sp: 0, i: false },
  });
  expect(cycles(result.instructions[0]!).length).toBe(6);
  expect(result.cpu_bus?.final.next_cycle_index).toBe(83);
  const { result: brk } = await run([0], {
    cpu: { sp: 0xfd },
    max_instructions: 1,
  });
  expect(cycles(brk.instructions[0]!).length).toBe(7);
});

it("cancels an ordered bus loop without mutating caller state or source bytes", async () => {
  const fixture = nesCodeFixture(4, [0x4c, 0, 0xe0]);
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/cancel.nes",
    initial,
    initial_cpu_bus: bus,
    initial_apu: frame(100),
    max_instructions: 100000,
  });
  const before = structuredClone(input),
    original = Buffer.from(fixture.bytes);
  const controller = new AbortController();
  const pending = deriveNesCode(
    header.value,
    fixture.bytes.subarray(
      fixture.prgOffset,
      fixture.prgOffset + fixture.prgSize,
    ),
    input,
    { signal: controller.signal },
  );
  controller.abort(new Error("cancel ordered source"));
  await expect(pending).rejects.toThrow("cancel ordered source");
  expect(input).toEqual(before);
  expect(fixture.bytes).toEqual(original);
});
