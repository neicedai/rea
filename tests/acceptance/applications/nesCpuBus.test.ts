import { createNesSourceCaller } from "../../support/nesSourceDelivery.js";
import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nesCodeFixture } from "../../../src/domain/nesCode.fixture.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const origin = { kind: "initial-state" };
const initial = { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 2, 1] };
const bus = {
  model: "nmos-6502-bus",
  dma_reads: "absent",
  next_cycle_index: 100,
};
const apu = (position: number) => ({
  model: "apu-registers",
  frame_clocks: "cpu-ordered",
  dmc_reads: "absent",
  next_event_index: 600,
  frame_sequencer: {
    region: "ntsc",
    position: { min: position, max: position },
    five_step: false,
    cpu_phase: "get",
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
  },
  registers: { 16407: { value: 0, origin } },
  frame_irq: { value: false, origin },
});

type Calls = Awaited<ReturnType<typeof createNesSourceCaller>>;

async function verifyReads({ call, code }: Calls, root: string) {
  for (const position of [29824, 29825]) {
    const fixture = nesCodeFixture(4, [0x2c, 0x15, 0x40, 2]);
    const path = join(root, `read-${position}.nes`);
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial,
      initial_cpu_bus: bus,
      initial_apu: apu(position),
      cpu: { a: 0 },
    };
    const { trace, evidence } = await code(input);
    expect(evidence.subject?.digest?.sha256).toBe(
      createHash("sha256").update(fixture.bytes).digest("hex"),
    );
    const instruction = trace.instructions[0]!;
    expect(instruction.cpu_after.v).toBe(position === 29825);
    expect(instruction.file_offsets).toEqual([
      fixture.programOffset,
      fixture.programOffset + 1,
      fixture.programOffset + 2,
    ]);
    expect(trace.cpu_bus?.final.next_cycle_index).toBe(104);
    expect(trace.stop).toMatchObject({
      reason: "unsupported-opcode",
      cpu_bus_frontier: { cycles: [{ index: 104, role: "opcode" }] },
    });
    const mapped = trace.mapper_trace;
    if (mapped.status !== "derived" || !("apu_trace" in mapped))
      throw new Error("Missing APU trace");
    expect(mapped.apu_trace.final.frame_irq.value).toBe(true);
    expect(mapped.steps.map((step) => step.event.kind)).toEqual([
      "apu-cpu-cycle",
      "apu-cpu-cycle",
      "apu-cpu-cycle",
      "cpu-read",
      "apu-cpu-cycle",
    ]);
    const replay = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await call("trace_nes_mapper_events", {
        path,
        initial,
        initial_apu: input.initial_apu,
        events: mapped.steps.map((step) => step.event),
      }),
    ).normalized_result.trace;
    if (replay.status !== "derived" || !("apu_trace" in replay))
      throw new Error("Missing replay");
    expect(replay.apu_trace.final).toEqual(mapped.apu_trace.final);
    const explored = toolContract("explore_nes_code").outputSchema.parse(
      await call("explore_nes_code", input, false),
    ).normalized_result.code_exploration;
    expect(explored).toMatchObject({ paths: [{ trace }] });
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
}

async function verifyStackReset({ code }: Calls, path: string) {
  const { trace: reset } = await code({
    path,
    initial,
    initial_cpu_bus: bus,
    initial_apu: apu(100),
    cpu: { a: 128 },
    max_instructions: 3,
  });
  expect(reset.cpu_bus?.final.next_cycle_index).toBe(108);
  expect(reset.mapper_trace).toMatchObject({
    apu_trace: {
      final: {
        frame_sequencer: {
          five_step: true,
          position: { min: 1, max: 1 },
          reset_delay: { min: 0, max: 0 },
        },
      },
    },
  });
  const { trace: jsr } = await code({
    path,
    initial,
    initial_cpu_bus: bus,
    entry: 0x1fd,
    cpu: { sp: 255 },
    initial_ram: [
      { address: 0x1fd, value: 32 },
      { address: 0x1fe, value: 0x34 },
      { address: 0x1ff, value: 0x80 },
    ],
    max_instructions: 1,
  });
  expect(jsr.instructions[0]).toMatchObject({
    bytes_hex: "203401",
    next_address: 0x134,
    ram_origins: [
      { initial_ram_index: 0 },
      { initial_ram_index: 1 },
      { instruction_index: 0, write_index: 0 },
    ],
  });
  const { trace: failed } = await code({
    path,
    initial,
    initial_cpu_bus: bus,
    entry: 0x1fd,
    cpu: { sp: 0xfd },
    initial_ram: [
      { address: 0x1fd, value: 32 },
      { address: 0x1fe, value: 0x34 },
    ],
  });
  expect(failed).toMatchObject({
    instructions: [],
    final_cpu: { sp: 0xfd },
    cpu_bus: { final: { next_cycle_index: 100 } },
    stop: {
      reason: "unmapped-instruction",
      cpu_bus_frontier: {
        writes: [{ address: 0x1fd }, { address: 0x1fc }],
      },
    },
  });
}

async function verifyBranchDma({ call, code }: Calls, path: string) {
  const branchInput = {
    path,
    initial,
    initial_cpu_bus: bus,
    entry: 0x100,
    initial_ram: [
      { address: 0x100, value: 0xd0 },
      { address: 0x101, value: 0 },
      { address: 0x102, value: 2 },
    ],
  };
  const explored = toolContract("explore_nes_code").outputSchema.parse(
    await call("explore_nes_code", branchInput),
  ).normalized_result.code_exploration;
  if (explored.status !== "derived") throw new Error(explored.reason);
  expect(explored.paths).toHaveLength(3);
  expect(
    explored.paths.map((p) =>
      p.trace.status === "derived"
        ? p.trace.cpu_bus?.final.next_cycle_index
        : null,
    ),
  ).toEqual([100, 102, 103]);
  for (const branch of explored.paths) {
    const { trace } = await code({
      ...branchInput,
      branch_choices: branch.branch_choices,
    });
    expect(trace).toEqual(branch.trace);
  }
  for (const address of [0x4014, 0x4015]) {
    const { trace } = await code({
      path,
      initial,
      initial_cpu_bus: bus,
      entry: 0x100,
      cpu: { a: 16 },
      initial_ram: [
        { address: 0x100, value: 0x8d },
        { address: 0x101, value: address & 255 },
        { address: 0x102, value: 0x40 },
        { address: 0x103, value: 0xea },
      ],
    });
    expect(trace).toMatchObject({
      instructions: [{ writes: [{ address, value: 16 }] }],
      cpu_bus: {
        final: { dma_reads: "unobserved", next_cycle_index: 104 },
      },
      stop: {
        reason: "cpu-timing-dma",
        cpu_bus_frontier: { cycles: [], blocked_address: 0x103 },
      },
    });
  }
}

async function verifyBoundaries(
  { call, code, contract }: Calls,
  client: Client,
  path: string,
) {
  const pending = await code({
    path,
    initial,
    initial_cpu_bus: bus,
    initial_controllers: {
      model: "standard-controllers",
      dma_reads: "absent",
      oam_dma_pending: { status: "pending", page: 2 },
    },
  });
  expect(pending.trace).toMatchObject({
    instructions: [],
    cpu_bus: {
      initial: { dma_reads: "absent" },
      initialized: { dma_reads: "unobserved" },
    },
    stop: { reason: "cpu-timing-dma" },
  });
  const capacity = toolContract("trace_nes_code").outputSchema.parse(
    await call("trace_nes_code", {
      path,
      initial,
      initial_cpu_bus: {
        ...bus,
        next_cycle_index: Number.MAX_SAFE_INTEGER - 7,
      },
      max_instructions: 1,
    }),
  ).normalized_result.code_trace;
  expect(capacity).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("cycle index"),
  });
  const validateInput = contract("trace_nes_code").input;
  for (const invalid of [
    { ...bus, model: "6502" },
    { ...bus, dma_reads: "yes" },
    { ...bus, next_cycle_index: -1 },
  ]) {
    const input = { path, initial, initial_cpu_bus: invalid };
    expect(validateInput(input)).toBe(false);
    expect(
      (await client.callTool({ name: "trace_nes_code", arguments: input }))
        .isError,
    ).toBe(true);
  }
}

function verifyReturnFrontier(
  trace: NesCodePath,
  programOffset: number,
  ramOrigin: Record<string, unknown>,
) {
  if (!("cpu_bus_frontier" in trace.stop))
    throw new Error("Missing unresolved RTS bus frontier");
  const frontier = trace.stop.cpu_bus_frontier;
  expect(trace.stop).toMatchObject({
    reason: "unknown-control-target",
    address: 0xe013,
    bytes_hex: "60",
  });
  expect(frontier.writes).toEqual([]);
  expect(frontier.mapper_events).toEqual([]);
  expect(
    frontier.cycles.map((cycle) => {
      if (cycle.kind !== "read")
        throw new Error("RTS frontier contains a write");
      expect(cycle.read.mapper_origins).toEqual([]);
      expect(cycle.read.ram_origins).toEqual(
        cycle.index === 112 ? [ramOrigin] : [],
      );
      return [
        cycle.index,
        cycle.role,
        cycle.read.address,
        cycle.read.file_offset,
        cycle.read.value,
      ];
    }),
  ).toEqual([
    [110, "opcode", 0xe013, programOffset + 19, 0x60],
    [111, "dummy", 0xe014, programOffset + 20, 2],
    [112, "dummy", 0x1fd, null, 0xe0],
    [113, "stack", 0x1fe, null, null],
    [114, "stack", 0x1ff, null, null],
    [115, "dummy", null, null, null],
  ]);
  expect(trace.cpu_bus?.final.next_cycle_index).toBe(110);
}

async function verifyReturnContinuation({ code }: Calls, root: string) {
  const fixture = nesCodeFixture(4, [
    0x20,
    0x10,
    0xe0,
    ...Array<number>(13).fill(2),
    0xa2,
    0xfd,
    0x9a,
    0x60,
    2,
  ]);
  const path = join(root, "unresolved-return.nes");
  await writeFile(path, fixture.bytes);
  const input = { path, initial, initial_cpu_bus: bus, cpu: { sp: 0xfd } };
  const { trace: whole } = await code(input);
  expect(whole.instructions.map((instruction) => instruction.address)).toEqual([
    0xe000, 0xe010, 0xe012,
  ]);
  expect(
    whole.instructions.map((instruction) => instruction.file_offsets),
  ).toEqual([
    [
      fixture.programOffset,
      fixture.programOffset + 1,
      fixture.programOffset + 2,
    ],
    [fixture.programOffset + 16, fixture.programOffset + 17],
    [fixture.programOffset + 18],
  ]);
  const { trace: prefix } = await code({ ...input, max_instructions: 3 });
  expect(prefix.stop).toMatchObject({
    reason: "instruction-budget",
    address: 0xe013,
  });
  expect(prefix.instructions).toEqual(whole.instructions);
  expect(prefix.final_cpu).toEqual(whole.final_cpu);
  if (prefix.mapper_trace.status !== "derived")
    throw new Error(prefix.mapper_trace.reason);
  const initial_ram = prefix.instructions
    .flatMap((instruction) =>
      instruction.writes.map((write) => {
        if (write.value === null) throw new Error("Unknown stack handoff byte");
        return { address: write.address & 0x7ff, value: write.value };
      }),
    )
    .sort((a, b) => a.address - b.address);
  expect(initial_ram).toEqual([
    { address: 0x1fc, value: 2 },
    { address: 0x1fd, value: 0xe0 },
  ]);
  const continuation = {
    path,
    initial: prefix.mapper_trace.final,
    cpu: prefix.final_cpu,
    initial_cpu_bus: prefix.cpu_bus!.final,
    entry: prefix.stop.address,
    initial_ram,
  };
  const { trace: tail } = await code(continuation);
  expect(tail.instructions).toEqual([]);
  expect(tail.final_cpu).toEqual(prefix.final_cpu);
  expect(tail.mapper_trace).toEqual(prefix.mapper_trace);
  verifyReturnFrontier(whole, fixture.programOffset, {
    byte_index: 0,
    region: "internal-ram",
    ram_address: 0x1fd,
    instruction_index: 0,
    write_index: 0,
  });
  verifyReturnFrontier(tail, fixture.programOffset, {
    byte_index: 0,
    region: "internal-ram",
    ram_address: 0x1fd,
    initial_ram_index: 1,
  });
  const { trace: unknownStack } = await code({
    ...continuation,
    cpu: { ...prefix.final_cpu, sp: null },
  });
  expect(unknownStack).toMatchObject({
    instructions: [],
    final_cpu: { sp: null },
    cpu_bus: { final: { next_cycle_index: 110 } },
    stop: {
      reason: "unknown-stack",
      cpu_bus_frontier: { cycles: [{ index: 110, role: "opcode" }] },
    },
  });
  const { trace: untimed } = await code({
    ...continuation,
    initial_cpu_bus: null,
  });
  expect(untimed.instructions).toEqual([]);
  expect(untimed.stop.reason).toBe("return");
  expect(untimed.final_cpu).toEqual(prefix.final_cpu);
  expect(untimed.stop).not.toHaveProperty("cpu_bus_frontier");
  expect(untimed.cpu_bus).toBeNull();
  expect(await readFile(path)).toEqual(fixture.bytes);
}

cliTest(
  "preserves nominal bus ordering, APU clock placement and unapplied frontiers through actual CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cpu-bus-");
    const client = await connectTestMcp("cpu-bus-oracle");
    const calls = await createNesSourceCaller(cli, client);
    await verifyReads(calls, root);
    const fixture = nesCodeFixture(4, [0x8d, 0x17, 0x40, 0xea, 0xea, 2]);
    const path = join(root, "delayed-reset.nes");
    await writeFile(path, fixture.bytes);
    await verifyStackReset(calls, path);
    await verifyBranchDma(calls, path);
    await verifyBoundaries(calls, client, path);
    await verifyReturnContinuation(calls, root);
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  180000,
);
