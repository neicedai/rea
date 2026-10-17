import { createNesSourceCaller } from "../../support/nesSourceDelivery.js";
import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { mapperTraceFixture } from "../../../src/domain/nesMapperTrace.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const bus = { model: "nmos-6502-bus", dma_reads: "absent" };
const mapper19 = {
  mapper: 19,
  variant: "namco163",
  prg_banks: [0, 1, 2],
  irq_low: 0,
  irq_high: 128,
};
const irq19 = {
  model: "namco163",
  counter_low: 250,
  counter_high: 127,
  asserted: false,
};
const origin = { kind: "initial-state" };
const apu = {
  model: "apu-registers",
  frame_clocks: "cpu-ordered",
  dmc_reads: "absent",
  next_event_index: 6000,
  registers: { 16407: { value: 0, origin } },
  frame_irq: { value: false, origin },
  frame_sequencer: {
    region: "ntsc",
    position: { min: 100, max: 100 },
    five_step: false,
    cpu_phase: "get",
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
  },
};
type Calls = Awaited<ReturnType<typeof createNesSourceCaller>>;
const ram = (program: number[]) =>
  program.map((value, index) => ({ address: 0x200 + index, value }));

async function verifyNamcoBankProgram({ call, code }: Calls, root: string) {
  const bytes = mapperTraceFixture(19),
    path = join(root, "namco-counter-banks.nes"),
    prg = 528;
  bytes.fill(2, prg, prg + 65536);
  bytes.set(
    [0xad, 0, 0x50, 0x29, 1, 0x8d, 0, 0xe0, 0x4c, 0, 0x80],
    prg + 7 * 8192 + 0x100,
  );
  bytes.set(
    [0xa9, 0x55, 0x8d, 0, 0x50, 0xad, 0, 0x58, 0xad, 0, 0x50],
    prg + 8192,
  );
  bytes.set([0xea, 2], prg + 8192 + 16);
  await writeFile(path, bytes);
  const input = {
    path,
    initial: mapper19,
    initial_irq: irq19,
    initial_cpu_bus: bus,
    initial_apu: apu,
    initial_controllers: {
      model: "standard-controllers",
      dma_reads: "absent",
      oam_dma_pending: { status: "none" },
      next_event_index: 4000,
    },
    entry: 0xe100,
  };
  const { trace, evidence } = await code(input),
    mapped = trace.mapper_trace;
  if (
    mapped.status !== "derived" ||
    !("apu_trace" in mapped) ||
    !("controller_trace" in mapped) ||
    mapped.controller_trace === null
  )
    throw new Error("Missing interleaved source events");
  expect(trace.instructions.map((instruction) => instruction.address)).toEqual([
    0xe100, 0xe103, 0xe105, 0xe108, 0x8000, 0x8002, 0x8005, 0x8008,
  ]);
  expect(
    trace.instructions.flatMap((instruction) =>
      instruction.data_reads.map((read) => read.value),
    ),
  ).toEqual([253, 255, 93]);
  expect(mapped.final_irq).toMatchObject({
    counter_low: 94,
    counter_high: 127,
    asserted: false,
  });
  expect(mapped.final).toMatchObject({ irq_low: 85, irq_high: 128 });
  expect(mapped.steps).toHaveLength(59);
  expect(trace.cpu_bus?.final.next_cycle_index).toBe(27);
  expect(mapped.apu_trace.final).toMatchObject({
    next_event_index: 6059,
    frame_sequencer: { position: { min: 127, max: 127 } },
  });
  expect(mapped.controller_trace?.final.next_event_index).toBe(4059);
  for (const instruction of trace.instructions) {
    for (const [index, offset] of instruction.file_offsets.entries())
      expect(bytes[offset!]).toBe(
        Buffer.from(instruction.bytes_hex, "hex")[index],
      );
    if (!("cpu_bus_cycles" in instruction))
      throw new Error("Missing source bus");
    for (const cycle of instruction.cpu_bus_cycles) {
      if (cycle.kind !== "read") continue;
      if (cycle.read.file_offset !== null)
        expect(cycle.read.value).toBe(bytes[cycle.read.file_offset]);
      for (const proof of cycle.read.mapper_origins)
        if (proof.kind === "namco163-irq-counter") {
          const { mapper_event_index, byte_index, ...source } = proof;
          expect(byte_index).toBe(0);
          expect(mapped.steps[mapper_event_index]).toMatchObject({
            event: { kind: "cpu-read", address: cycle.read.address },
            cpu_read: { value: cycle.read.value, source },
          });
        }
    }
  }
  const replay = toolContract("trace_nes_mapper_events").outputSchema.parse(
    await call("trace_nes_mapper_events", {
      path,
      initial: input.initial,
      initial_irq: input.initial_irq,
      initial_apu: input.initial_apu,
      initial_controllers: input.initial_controllers,
      events: mapped.steps.map((step) => step.event),
    }),
  ).normalized_result.trace;
  expect(replay).toMatchObject({
    final: mapped.final,
    final_irq: mapped.final_irq,
    apu_trace: { final: mapped.apu_trace.final },
    controller_trace: { final: mapped.controller_trace?.final },
  });
  const explored = toolContract("explore_nes_code").outputSchema.parse(
    await call("explore_nes_code", input),
  ).normalized_result.code_exploration;
  expect(explored).toMatchObject({ paths: [{ trace }] });
  const resumed = await code({
    ...input,
    entry: 0x8010,
    max_instructions: 1,
    initial: mapped.final,
    initial_irq: mapped.final_irq,
    initial_apu: mapped.apu_trace.final,
    initial_controllers: mapped.controller_trace?.final,
    initial_cpu_bus: trace.cpu_bus!.final,
  });
  expect(resumed.trace.mapper_trace).toMatchObject({
    final_irq: { counter_low: 96, asserted: false },
    apu_trace: {
      final: {
        next_event_index: 6063,
        frame_sequencer: { position: { min: 129, max: 129 } },
      },
    },
  });
  expect(evidence.subject?.digest?.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(await readFile(path)).toEqual(bytes);
  return path;
}

async function verifyControlWrites({ code, call }: Calls, root: string) {
  const samples = [
    {
      mapper: 21,
      initial: {
        mapper: 21,
        variant: "vrc4",
        irq_control: 0,
        irq_enabled: false,
        irq_latch_low: 14,
        irq_latch_high: 15,
      },
      irq: { model: "vrc4", counter: 1, asserted: false },
      address: 0xf004,
      value: 6,
      final: { counter: 255, asserted: true },
    },
    {
      mapper: 24,
      initial: {
        mapper: 24,
        irq_control: 0,
        irq_enabled: false,
        irq_latch: 254,
      },
      irq: { model: "vrc6", counter: 1, asserted: false },
      address: 0xf001,
      value: 6,
      final: { counter: 255, asserted: true },
    },
    {
      mapper: 16,
      initial: { mapper: 16, variant: "fcg", irq_control: 0 },
      irq: {
        model: "bandai-fcg",
        counter_low: 2,
        counter_high: 0,
        asserted: false,
      },
      address: 0x600a,
      value: 1,
      final: { counter_low: 255, counter_high: 255, asserted: true },
    },
    {
      mapper: 159,
      initial: { mapper: 159, irq_control: 0, irq_low: 0, irq_high: 0 },
      irq: {
        model: "bandai-lz93d50",
        counter_low: 2,
        counter_high: 0,
        asserted: false,
      },
      address: 0x800a,
      value: 1,
      final: { counter_low: 253, counter_high: 255, asserted: true },
    },
    {
      mapper: 69,
      initial: { mapper: 69, variant: "fme7", command: 13, irq_control: 0 },
      irq: { model: "fme7", counter_low: 0, counter_high: 0, asserted: false },
      address: 0xa000,
      value: 129,
      final: { counter_low: 253, counter_high: 255, asserted: true },
    },
    {
      mapper: 19,
      initial: { ...mapper19, irq_high: 0 },
      irq: {
        model: "namco163",
        counter_low: 254,
        counter_high: 127,
        asserted: false,
      },
      address: 0x5800,
      value: 255,
      final: { counter_low: 255, counter_high: 255, asserted: true },
    },
  ] as const;
  for (const sample of samples) {
    const bytes = mapperTraceFixture(sample.mapper),
      path = join(root, `control-${sample.mapper}.nes`);
    await writeFile(path, bytes);
    const input = {
      path,
      initial: sample.initial,
      initial_irq: sample.irq,
      initial_cpu_bus: bus,
      entry: 0x200,
      initial_ram: ram([
        0xa9,
        sample.value,
        0x8d,
        sample.address & 255,
        sample.address >> 8,
        0xea,
      ]),
      max_instructions: 3,
    };
    const { trace } = await code(input),
      mapped = trace.mapper_trace;
    if (mapped.status !== "derived" || !("final_irq" in mapped))
      throw new Error("Missing IRQ trace");
    expect(mapped.final_irq).toMatchObject(sample.final);
    expect(trace.cpu_bus?.final.next_cycle_index).toBe(8);
    expect(trace.instructions[1]!.writes).toMatchObject([
      { address: sample.address, value: sample.value },
    ]);
    const replay = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await call(
        "trace_nes_mapper_events",
        {
          path,
          initial: input.initial,
          initial_irq: input.initial_irq,
          events: mapped.steps.map((step) => step.event),
        },
        false,
      ),
    ).normalized_result.trace;
    expect(replay).toEqual(mapped);
    expect(await readFile(path)).toEqual(bytes);
  }
}

async function verifyUnknownSources({ call, code }: Calls, path: string) {
  const input = {
    path,
    initial: mapper19,
    initial_irq: { ...irq19, counter_low: { mask: 254, value: 250 } },
    initial_cpu_bus: bus,
    entry: 0x200,
    initial_ram: ram([
      0xad, 0, 0x50, 0x29, 1, 0xf0, 3, 0xa9, 0x11, 2, 0xa9, 0x22, 2,
    ]),
  };
  const explored = toolContract("explore_nes_code").outputSchema.parse(
    await call("explore_nes_code", input),
  ).normalized_result.code_exploration;
  if (explored.status !== "derived") throw new Error(explored.reason);
  expect(explored.paths).toHaveLength(3);
  for (const pathResult of explored.paths)
    expect(
      (await code({ ...input, branch_choices: pathResult.branch_choices }))
        .trace,
    ).toEqual(pathResult.trace);
  expect(
    explored.paths
      .slice(1)
      .map((p) => (p.trace.status === "derived" ? p.trace.final_cpu.a : null)),
  ).toEqual([0x11, 0x22]);
  const failedInput = {
    ...input,
    initial_irq: { ...irq19, counter_low: { mask: 254, value: 248 } },
    initial_ram: ram([0x6c, 0xff, 0x57]),
  };
  const { trace } = await code(failedInput);
  expect(trace).toMatchObject({
    instructions: [],
    cpu_bus: { final: { next_cycle_index: 0 } },
    mapper_trace: { steps: [], final_irq: failedInput.initial_irq },
    stop: { reason: "unknown-control-target" },
  });
  if (!("cpu_bus_frontier" in trace.stop))
    throw new Error("Missing hypothetical IRQ events");
  expect(trace.stop.cpu_bus_frontier.mapper_events).toHaveLength(7);
  const replay = toolContract("trace_nes_mapper_events").outputSchema.parse(
    await call(
      "trace_nes_mapper_events",
      {
        path,
        initial: input.initial,
        initial_irq: failedInput.initial_irq,
        events: trace.stop.cpu_bus_frontier.mapper_events,
      },
      false,
    ),
  ).normalized_result.trace;
  if (replay.status !== "derived") throw new Error(replay.reason);
  expect(replay.final_irq).not.toEqual(failedInput.initial_irq);
  const reads = replay.steps.flatMap((step) =>
    "cpu_read" in step && step.cpu_read != null ? [step.cpu_read] : [],
  );
  expect(reads.map((r) => r.value)).toEqual(
    trace.stop.data_reads.map((r) => r.value),
  );
  expect(reads.map((r) => ("known_bits" in r ? r.known_bits : null))).toEqual(
    trace.stop.data_reads.map((r) => ("known_bits" in r ? r.known_bits : null)),
  );
}

async function verifyInvalid(
  { call, contract }: Calls,
  client: Client,
  path: string,
) {
  const validateInput = contract("trace_nes_code").input;
  for (const initial_irq of [
    { model: "automatic" },
    { model: "namco163", counter_low: { mask: 1, value: 2 } },
  ]) {
    const input = {
      path,
      initial: mapper19,
      initial_irq,
      initial_cpu_bus: bus,
    };
    expect(validateInput(input)).toBe(false);
    expect(
      (await client.callTool({ name: "trace_nes_code", arguments: input }))
        .isError,
    ).toBe(true);
  }
  const unsupported = toolContract("trace_nes_code").outputSchema.parse(
    await call("trace_nes_code", {
      path,
      initial: mapper19,
      initial_irq: irq19,
    }),
  ).normalized_result.code_trace;
  expect(unsupported).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("initial_cpu_bus"),
  });
  const capacity = toolContract("trace_nes_code").outputSchema.parse(
    await call("trace_nes_code", {
      path,
      initial: mapper19,
      initial_irq: irq19,
      initial_cpu_bus: bus,
      initial_apu: { ...apu, next_event_index: Number.MAX_SAFE_INTEGER - 23 },
      max_instructions: 1,
    }),
  ).normalized_result.code_trace;
  expect(capacity).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("event index"),
  });
}

async function verifyReadOwners({ call }: Calls, path: string) {
  for (const address of [0x4015, 0x5000]) {
    const result = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await call(
        "trace_nes_mapper_events",
        {
          path,
          initial: {
            ...mapper19,
            prg_banks: [64, 1, 2],
            chip_ram: {
              address_port: 129,
              increment_model: "saturate",
              dma_reads: "absent",
              oam_dma_pending: 72,
            },
          },
          initial_irq: { ...irq19, counter_low: 255, asserted: true },
          initial_apu: {
            model: "apu-registers",
            frame_clocks: "explicit",
            dmc_reads: "absent",
            registers: { 16407: { value: 0, origin } },
            frame_irq: { value: true, origin },
          },
          events: [{ kind: "cpu-read", address }],
        },
        address === 0x4015,
      ),
    ).normalized_result.trace;
    expect(result).toMatchObject({
      final: { chip_ram: { address_port: 255, oam_dma_pending: "none" } },
      final_irq: { asserted: true },
      apu_trace: { final: { frame_irq: { value: address !== 0x4015 } } },
      steps: [
        {
          cpu_read: {
            source: {
              kind: address === 0x4015 ? "apu-status" : "namco163-irq-counter",
            },
          },
        },
      ],
    });
  }
}

async function verifyDefaultCapacity({ call }: Calls, path: string) {
  for (const withApu of [false, true]) {
    const evidence = toolContract("trace_nes_code").outputSchema.parse(
      await call(
        "trace_nes_code",
        {
          path,
          initial: mapper19,
          initial_irq: { ...irq19, counter_low: 0, counter_high: 0 },
          initial_cpu_bus: bus,
          ...(withApu ? { initial_apu: apu } : {}),
          entry: 0x200,
          initial_ram: ram([0x4c, 0, 2]),
        },
        false,
      ),
    );
    const trace = evidence.normalized_result.code_trace;
    if (
      trace.status !== "derived" ||
      trace.mapper_trace.status !== "derived" ||
      !("mapper_snapshots" in trace.mapper_trace)
    )
      throw new Error("Missing complete default-budget counter trace");
    expect(trace.instructions).toHaveLength(1024);
    expect(trace.stop.reason).toBe("instruction-budget");
    expect(trace.mapper_trace.steps).toHaveLength(withApu ? 6144 : 3072);
    expect(trace.mapper_trace.mapper_snapshots).toHaveLength(1);
    expect(trace.mapper_trace.final_irq).toMatchObject({
      counter_low: 0,
      counter_high: 12,
      asserted: false,
    });
    expect(trace.cpu_bus?.final.next_cycle_index).toBe(3072);
    const replay = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await call(
        "trace_nes_mapper_events",
        {
          path,
          initial: mapper19,
          initial_irq: { ...irq19, counter_low: 0, counter_high: 0 },
          ...(withApu ? { initial_apu: apu } : {}),
          max_steps: trace.mapper_trace.steps.length,
          events: trace.mapper_trace.steps.map((step) => step.event),
        },
        false,
      ),
    ).normalized_result.trace;
    expect(replay).toEqual(trace.mapper_trace);
  }
}

cliTest(
  "advances source cartridge IRQs, uses live Namco counter reads for bank selection and preserves replay/frontier identity",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-source-irq-");
    const client = await connectTestMcp("source-irq-oracle");
    const calls = await createNesSourceCaller(cli, client);
    const path = await verifyNamcoBankProgram(calls, root);
    await verifyControlWrites(calls, root);
    await verifyUnknownSources(calls, path);
    await verifyInvalid(calls, client, path);
    await verifyReadOwners(calls, path);
    await verifyDefaultCapacity(calls, path);
  },
  240000,
);
