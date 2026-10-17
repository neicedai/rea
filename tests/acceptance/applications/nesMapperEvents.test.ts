import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
} from "../../support/nesSourceDelivery.js";
import {
  connectTestMcp,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import type { NesMapperIrqState } from "../../../src/domain/nesMapperEvents.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nesMapperEventsReportSchema } from "../../../src/domain/nesMapperEvents.js";
import { nesCodeTraceReportSchema } from "../../../src/domain/nesCodeTrace.js";
import { nesCodeExplorationReportSchema } from "../../../src/domain/nesCodeExploration.js";
import { mapperTraceFixture } from "../../../src/domain/nesMapperTrace.fixture.js";
import { nesCodeFixture } from "../../../src/domain/nesCode.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

function counter(irq: NesMapperIrqState | null): number | null {
  if (
    irq !== null &&
    (irq.model === "sharp" || irq.model === "nec" || irq.model === "mc-acc")
  )
    return irq.counter;
  throw new Error("Expected a selected MMC3 counter model");
}

const verifyMapper = async (
  mapper: 9 | 10,
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const fixture = nesCodeFixture(
    mapper,
    [0xa9, 2, 0x8d, 0xff, 0xaf, 0x4c, 0, 0x80],
  );
  const bankOffset = fixture.prgOffset + 2 * (mapper === 9 ? 8192 : 16384);
  fixture.bytes.set([0xa9, 0x55, 0x60], bankOffset);
  const path = join(root, `mapper${mapper}.nes`);
  await writeFile(path, fixture.bytes);
  const input = {
    path,
    initial: { mapper, chr_fd_0: 1, chr_fe_0: 2, latch_0: "fd" },
    events: [
      { kind: "cpu-write", address: 0xafff, value: 0xf2 },
      { kind: "ppu-read", address: 0xfe9 },
      { kind: "ppu-read", address: 0xfe8 },
      { kind: "ppu-read", address: 0 },
    ],
  };
  const requestFile = join(root, `request${mapper}.json`);
  await writeFile(requestFile, JSON.stringify(input));
  const contract = toolContract("trace_nes_mapper_events");
  const cliResult = await cli.run({
    arguments: [
      "trace-nes-mapper-events",
      mapper === 9 ? requestFile : JSON.stringify(input),
      "--json",
    ],
  });
  expect(cliResult.exitCode).toBe(0);
  const evidence = contract.outputSchema.parse(cliResult.json);
  expect(evidence.subject?.digest).toMatchObject({
    sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
  });
  const result = await client.callTool({
    name: contract.name,
    arguments: input,
  });
  expect(result.isError).not.toBe(true);
  const mcp = contract.outputSchema.parse(result.structuredContent);
  expect(mcp.evidence_id).toBe(evidence.evidence_id);
  expect(mcp.normalized_result).toEqual(evidence.normalized_result);
  const trace = nesMapperEventsReportSchema.parse(mcp.normalized_result).trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  if ("mapper_snapshots" in trace)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  expect(trace.steps.map((s) => s.read_source?.bank ?? null)).toEqual(
    mapper === 9 ? [null, 1, 1, 2] : [null, 1, 2, 2],
  );
  expect(trace.nes_prg_views).toEqual([{ mapper, prg_bank: 2 }]);
  for (const step of trace.steps)
    if (step.event.kind === "ppu-read" && step.read_source?.file_offset != null)
      expect(fixture.bytes[step.read_source.file_offset]).toBe(
        (step.read_source.bank! * 4096 + (step.event.address & 4095)) >> 10,
      );

  const writeResult = await replayNesThroughMcp(client, {
    path,
    initial: { mapper },
    writes: [{ address: 0xafff, value: 0xf2 }],
  });

  expect(writeResult.normalized_result).toMatchObject({
    trace: { final: { mapper, prg_bank: 2 } },
  });
  const codeContract = toolContract("trace_nes_code");
  const code = await client.callTool({
    name: codeContract.name,
    arguments: { path, initial: { mapper } },
  });
  expect(code.isError).not.toBe(true);
  const codeTrace = nesCodeTraceReportSchema.parse(
    codeContract.outputSchema.parse(code.structuredContent).normalized_result,
  ).code_trace;
  expect(codeTrace).toMatchObject({
    status: "derived",
    stop: { reason: "return" },
    final_cpu: { a: 0x55 },
  });

  const explored = await exploreNesThroughMcp(client, {
    path,
    initial: { mapper },
  });

  const exploration = nesCodeExplorationReportSchema.parse(
    explored.normalized_result,
  ).code_exploration;
  expect(exploration).toMatchObject({
    status: "derived",
    paths: [{ trace: codeTrace }],
  });
  for (const extra of [
    { max_steps: 1 },
    { events: [{ kind: "ppu-read", address: 16384 }] },
  ])
    expect(
      (
        await client.callTool({
          name: contract.name,
          arguments: { ...input, ...extra },
        })
      ).isError,
    ).toBe(true);
  const mismatch = await client.callTool({
    name: contract.name,
    arguments: { ...input, initial: { mapper: 5 } },
  });
  expect(mismatch.isError).not.toBe(true);
  const unsupported = nesMapperEventsReportSchema.parse(
    contract.outputSchema.parse(mismatch.structuredContent).normalized_result,
  );
  expect(unsupported.header.mapper).toBe(mapper);
  expect(unsupported.trace).toEqual({
    status: "unsupported",
    reason: "Initial state mapper does not match the cartridge header.",
  });
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyRegisterEvents = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const scenarios = [
    {
      mapper: 1 as const,
      initial: {
        mapper: 1,
        chr_mode: 1,
        chr_bank_0: 1,
        chr_bank_1: 2,
        shift_bits: [],
      },
      events: [
        { kind: "ppu-read", address: 0 },
        ...[1, 1, 0, 0].flatMap((value) => [
          {
            kind: "cpu-write",
            address: 0xa000,
            value,
            preceded_by_cpu_write: false,
          },
          { kind: "ppu-read", address: 4095 },
        ]),
        {
          kind: "cpu-write",
          address: 0xa000,
          value: 0,
          preceded_by_cpu_write: false,
        },
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-read", address: 8191 },
      ],
      offsets: [4096, 8191, 8191, 8191, 8191, 12288, 12287],
    },
    {
      mapper: 4 as const,
      initial: { mapper: 4, bank_select: 0, banks: [2, 4, 6, 7, 8, 9, 0, 1] },
      events: [
        { kind: "ppu-read", address: 0 },
        { kind: "cpu-write", address: 0x8000, value: 128 },
        { kind: "ppu-read", address: 0 },
        { kind: "cpu-write", address: 0x8000, value: 130 },
        { kind: "cpu-write", address: 0x8001, value: 11 },
        { kind: "ppu-read", address: 1023 },
        { kind: "cpu-write", address: 0x8001, value: null },
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-read", address: 8192 },
      ],
      offsets: [2048, 6144, 12287, null, null],
    },
    {
      mapper: 66 as const,
      initial: { mapper: 66, prg_bank: 0, chr_bank: 0 },
      events: [
        { kind: "ppu-read", address: 0 },
        { kind: "cpu-write", address: 0x8000, value: 3 },
        { kind: "ppu-read", address: 8191 },
      ],
      offsets: [0, 16383],
    },
  ];
  const contract = toolContract("trace_nes_mapper_events");
  for (const scenario of scenarios) {
    const bytes = mapperTraceFixture(scenario.mapper);
    // Mapper 66: ROM drives 1 during the write of 3, selecting CHR bank 1.
    if (scenario.mapper === 66) bytes[528] = 1;
    const path = join(root, `register-events-${scenario.mapper}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: scenario.initial, events: scenario.events };
    const mcp = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await (
        await createToolDelivery(client, cli)
      ).invoke("trace-nes-mapper-events", input),
    );
    const trace = nesMapperEventsReportSchema.parse(
      mcp.normalized_result,
    ).trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    if ("mapper_snapshots" in trace)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    // Independent iNES header calculation includes the trainer and PRG ROM.
    const chrStart = 16 + (bytes[6]! & 4 ? 512 : 0) + bytes[4]! * 16384;
    const reads = trace.steps.filter((step) => step.event.kind === "ppu-read");
    expect(reads.map((step) => step.read_source?.file_offset)).toEqual(
      scenario.offsets.map((offset) =>
        offset === null ? null : chrStart + offset,
      ),
    );
    for (const [index, offset] of scenario.offsets.entries())
      if (offset !== null)
        expect(bytes[reads[index]!.read_source!.file_offset!]).toBe(
          Math.floor(offset / 1024),
        );
    expect(trace.coverage).toMatchObject({
      supplied_events: scenario.events.length,
      processed_events: scenario.events.length,
      unknown_pattern_reads: scenario.mapper === 4 ? 1 : 0,
    });
    if (scenario.mapper === 4) {
      expect(trace.steps[0]!.state).toMatchObject({
        banks: [2, 4, 6, 7, 8, 9, 0, 1],
      });
      expect(reads.at(-1)!.read_source?.status).toBe("outside-pattern-tables");
    }
    expect(await readFile(path)).toEqual(bytes);
  }
};

const verifyIrqEvents = async (cli: TestCli, client: Client, root: string) => {
  const bytes = mapperTraceFixture(4);
  const path = join(root, "mmc3-irq-events.nes");
  await writeFile(path, bytes);
  const clock = { kind: "mmc3-irq-clock" };
  const write = (address: number, value: number | null = null) => ({
    kind: "cpu-write",
    address,
    value,
  });
  const events = [
    write(0xc001),
    { kind: "ppu-read", address: 0 },
    write(0xe001),
    clock,
    clock,
    clock,
    write(0xe000),
    clock,
    write(0xe001),
    write(0xc000, 0),
    write(0xc001),
    clock,
    write(0xe000),
    write(0xe001),
    clock,
  ];
  const contract = toolContract("trace_nes_mapper_events");
  for (const model of ["sharp", "nec"] as const) {
    const input = {
      path,
      initial: { mapper: 4, irq_latch: 2 },
      initial_irq: {
        model,
        counter: 7,
        reload_pending: false,
        enabled: false,
        asserted: false,
      },
      events,
    };
    const evidence = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await (
        await createToolDelivery(client, cli)
      ).invoke("trace-nes-mapper-events", input),
    );
    expect(evidence.subject?.digest).toMatchObject({
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const trace = nesMapperEventsReportSchema.parse(
      evidence.normalized_result,
    ).trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    if ("mapper_snapshots" in trace)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    expect(trace.steps.map((step) => counter(step.irq))).toEqual([
      0, 0, 0, 2, 1, 0, 0, 2, 2, 2, 0, 0, 0, 0, 0,
    ]);
    expect(trace.steps.map((step) => step.irq?.asserted)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      false,
      model === "sharp",
    ]);
    expect(
      trace.steps
        .filter((step) => step.event.kind === "mmc3-irq-clock")
        .every(
          (step) => step.read_source === null && step.write_effect === null,
        ),
    ).toBe(true);
    const resumed = await client.callTool({
      name: contract.name,
      arguments: {
        path,
        initial: trace.steps[3]!.state,
        initial_irq: trace.steps[3]!.irq,
        events: events.slice(4),
      },
    });
    expect(resumed.isError).not.toBe(true);
    const resumedTrace = nesMapperEventsReportSchema.parse(
      contract.outputSchema.parse(resumed.structuredContent).normalized_result,
    ).trace;
    expect(resumedTrace).toMatchObject({
      status: "derived",
      final_irq: trace.final_irq,
      final: trace.final,
    });
  }
  expect(await readFile(path)).toEqual(bytes);
  await verifyIrqAdmission(client, root, path, bytes);
  await verifyUnknownIrq(client, path);
};

const verifyUnknownIrq = async (client: Client, path: string) => {
  const contract = toolContract("trace_nes_mapper_events");
  const clock = { kind: "mmc3-irq-clock" };
  const write = (address: number) => ({
    kind: "cpu-write",
    address,
    value: null,
  });
  for (const model of ["sharp", "nec"] as const) {
    const result = await client.callTool({
      name: contract.name,
      arguments: {
        path,
        initial: { mapper: 4, irq_latch: 0 },
        initial_irq: { model },
        events: [
          clock,
          write(0xe000),
          clock,
          write(0xc001),
          write(0xe001),
          clock,
        ],
      },
    });
    expect(result.isError).not.toBe(true);
    const trace = nesMapperEventsReportSchema.parse(
      contract.outputSchema.parse(result.structuredContent).normalized_result,
    ).trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    if ("mapper_snapshots" in trace)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    expect(trace.initial_irq).toEqual({
      model,
      a12_filter: null,
      mcacc_prescaler: null,
      counter: null,
      reload_pending: null,
      enabled: null,
      asserted: null,
    });
    expect(
      trace.steps.map((step) => [counter(step.irq), step.irq?.asserted]),
    ).toEqual([
      [null, null],
      [null, false],
      [null, false],
      [0, false],
      [0, false],
      [0, true],
    ]);
    expect(trace.final_irq).toEqual({
      model,
      a12_filter: ["high"],
      mcacc_prescaler: null,
      counter: 0,
      reload_pending: false,
      enabled: true,
      asserted: true,
    });
  }
};

const verifyA12Signals = async (cli: TestCli, client: Client, root: string) => {
  const path = join(root, "mmc3-irq-events.nes");
  const contract = toolContract("trace_nes_mapper_events");
  const low = { kind: "ppu-a12", high: false };
  const high = { kind: "ppu-a12", high: true };
  const m2 = { kind: "cpu-m2-fall" };
  const events = [
    low,
    m2,
    m2,
    high,
    high,
    low,
    m2,
    low,
    m2,
    m2,
    high,
    m2,
    m2,
    m2,
    high,
    low,
    m2,
    m2,
    m2,
    high,
  ];
  for (const model of ["sharp", "nec"] as const) {
    const input = {
      path,
      initial: { mapper: 4, irq_latch: 2 },
      initial_irq: {
        model,
        counter: 2,
        reload_pending: false,
        enabled: true,
        asserted: false,
        a12_filter: ["high"],
      },
      events,
    };
    const evidence = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await (
        await createToolDelivery(client, cli)
      ).invoke("trace-nes-mapper-events", input),
    );
    const trace = nesMapperEventsReportSchema.parse(
      evidence.normalized_result,
    ).trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    if ("mapper_snapshots" in trace)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    expect(
      trace.steps.flatMap((step, index) => (step.irq_clock ? [index] : [])),
    ).toEqual([10, 19]);
    expect(trace.steps.map((step) => counter(step.irq))).toEqual([
      ...Array(10).fill(2),
      ...Array(9).fill(1),
      0,
    ]);
    expect(trace.final_irq).toMatchObject({
      counter: 0,
      asserted: true,
      a12_filter: ["high"],
    });
    expect(trace.steps[9]!.irq).toMatchObject({
      counter: 2,
      a12_filter: ["low-3"],
    });
    const resumed = await client.callTool({
      name: contract.name,
      arguments: {
        ...input,
        initial: trace.steps[9]!.state,
        initial_irq: trace.steps[9]!.irq,
        events: events.slice(10),
      },
    });
    expect(
      contract.outputSchema.parse(resumed.structuredContent).normalized_result,
    ).toMatchObject({ trace: { final_irq: trace.final_irq } });
    const uncertain = await client.callTool({
      name: contract.name,
      arguments: {
        ...input,
        initial_irq: {
          ...input.initial_irq,
          counter: 1,
          a12_filter: undefined,
        },
        events: [m2, m2, m2, high],
      },
    });
    expect(
      contract.outputSchema.parse(uncertain.structuredContent)
        .normalized_result,
    ).toMatchObject({
      trace: {
        final_irq: { counter: null, asserted: null },
        steps: [
          { irq_clock: false },
          { irq_clock: false },
          { irq_clock: false },
          { irq_clock: null },
        ],
      },
    });
  }
};

const verifyMcAccSignals = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const bytes = mapperTraceFixture(4);
  bytes[7] = 8;
  bytes[8] = 0x30;
  const path = join(root, "mcacc-irq-signals.nes");
  await writeFile(path, bytes);
  const high = { kind: "ppu-a12", high: true };
  const low = { kind: "ppu-a12", high: false };
  const m2 = { kind: "cpu-m2-fall" };
  const reload = { kind: "cpu-write", address: 0xc001, value: null };
  const events = [
    reload,
    high,
    ...Array.from({ length: 9 }, () => [low, m2, low, high, m2]).flat(),
  ];
  const input = {
    path,
    initial: { mapper: 4, irq_latch: 1 },
    initial_irq: { model: "mc-acc", enabled: true, asserted: false },
    events,
  };
  const contract = toolContract("trace_nes_mapper_events");
  const evidence = toolContract("trace_nes_mapper_events").outputSchema.parse(
    await (
      await createToolDelivery(client, cli)
    ).invoke("trace-nes-mapper-events", input),
  );
  expect(evidence.subject?.digest).toMatchObject({
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const trace = nesMapperEventsReportSchema.parse(
    evidence.normalized_result,
  ).trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  if ("mapper_snapshots" in trace)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  expect(
    trace.steps.flatMap((step, index) => (step.irq_clock ? [index] : [])),
  ).toEqual([2, 42]);
  expect(trace.steps[21]!.irq).toMatchObject({
    counter: 1,
    mcacc_prescaler: { a12_high: true, pulses: [4] },
  });
  expect(trace.final_irq).toMatchObject({
    counter: 0,
    asserted: true,
    a12_filter: null,
    mcacc_prescaler: { a12_high: true, pulses: [1] },
  });
  const resumed = await client.callTool({
    name: contract.name,
    arguments: {
      ...input,
      initial: trace.steps[21]!.state,
      initial_irq: trace.steps[21]!.irq,
      events: events.slice(22),
    },
  });
  expect(
    contract.outputSchema.parse(resumed.structuredContent).normalized_result,
  ).toMatchObject({ trace: { final_irq: trace.final_irq } });
  const clock = { kind: "mmc3-irq-clock" };
  const qualified = await client.callTool({
    name: contract.name,
    arguments: { ...input, events: [reload, clock, clock, high] },
  });
  expect(
    contract.outputSchema.parse(qualified.structuredContent).normalized_result,
  ).toMatchObject({ trace: { final_irq: trace.final_irq } });
  const wrongFilter = await client.callTool({
    name: contract.name,
    arguments: {
      ...input,
      initial_irq: { ...input.initial_irq, a12_filter: ["high"] },
    },
  });
  expect(
    contract.outputSchema.parse(wrongFilter.structuredContent)
      .normalized_result,
  ).toMatchObject({
    trace: {
      status: "unsupported",
      reason: expect.stringContaining("filter state"),
    },
  });
  expect(await readFile(path)).toEqual(bytes);
};

const verifyIrqAdmission = async (
  client: Client,
  root: string,
  path: string,
  bytes: Buffer,
) => {
  const contract = toolContract("trace_nes_mapper_events");
  const clock = { kind: "mmc3-irq-clock" };
  const unsupported = await client.callTool({
    name: contract.name,
    arguments: { path, initial: { mapper: 4 }, events: [clock] },
  });
  expect(unsupported.isError).not.toBe(true);
  expect(
    contract.outputSchema.parse(unsupported.structuredContent)
      .normalized_result,
  ).toMatchObject({
    trace: {
      status: "unsupported",
      reason: expect.stringContaining("initial_irq"),
    },
  });
  for (const initial_irq of [
    { model: "sharp", counter: 256 },
    { model: "unknown" },
  ]) {
    const invalid = await client.callTool({
      name: contract.name,
      arguments: { path, initial: { mapper: 4 }, initial_irq, events: [clock] },
    });
    expect(invalid.isError).toBe(true);
  }
  const mcacc = Buffer.from(bytes);
  mcacc[7] = 8;
  mcacc[8] = 0x30;
  const mcaccPath = join(root, "mcacc-irq-unsupported.nes");
  await writeFile(mcaccPath, mcacc);
  const rejected = await client.callTool({
    name: contract.name,
    arguments: {
      path: mcaccPath,
      initial: { mapper: 4 },
      initial_irq: { model: "sharp" },
      events: [clock],
    },
  });
  expect(rejected.isError).not.toBe(true);
  expect(
    contract.outputSchema.parse(rejected.structuredContent).normalized_result,
  ).toMatchObject({
    trace: { status: "unsupported", reason: expect.stringContaining("MC-ACC") },
  });
  expect(await readFile(path)).toEqual(bytes);
};

const verifyPartialIrqLatch = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const path = join(root, "partial-irq-latch.nes");
  await writeFile(path, mapperTraceFixture(4));
  const contract = toolContract("trace_nes_mapper_events");
  const definition = (await client.listTools()).tools.find(
    (tool) => tool.name === contract.name,
  );
  if (!definition?.outputSchema)
    throw new Error("Missing mapper event schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = definition.inputSchema;
  const outputSchema: Record<string, unknown> = definition.outputSchema;
  const validateInput = ajv.compile(inputSchema);
  const validateOutput = ajv.compile(outputSchema);
  for (const value of [128, 0]) {
    const input = {
      path,
      initial: { mapper: 4 },
      initial_irq: {
        model: "sharp",
        counter: 0,
        reload_pending: true,
        enabled: true,
        asserted: false,
      },
      events: [
        {
          kind: "cpu-write",
          address: 0xc000,
          value: null,
          known_bits: { mask: 128, value },
        },
        { kind: "mmc3-irq-clock" },
      ],
    };
    const output = await cli.run({
      arguments: ["trace-nes-mapper-events", JSON.stringify(input), "--json"],
    });
    expect(output.exitCode).toBe(0);
    const evidence = contract.outputSchema.parse(output.json);
    const response = await client.callTool({
      name: contract.name,
      arguments: input,
    });
    expect(response.isError).not.toBe(true);
    expect(validateInput(input), JSON.stringify(validateInput.errors)).toBe(
      true,
    );
    expect(
      validateOutput(response.structuredContent),
      JSON.stringify(validateOutput.errors),
    ).toBe(true);
    const trace = nesMapperEventsReportSchema.parse(
      evidence.normalized_result,
    ).trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    if ("mapper_snapshots" in trace)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    const continuation = {
      ...input,
      initial: trace.steps[0]!.state,
      initial_irq: trace.steps[0]!.irq,
      events: [{ kind: "mmc3-irq-clock" }],
    };
    expect(
      validateInput(continuation),
      JSON.stringify(validateInput.errors),
    ).toBe(true);
    const resumed = await client.callTool({
      name: contract.name,
      arguments: continuation,
    });
    expect(resumed.isError).not.toBe(true);
    expect(
      validateOutput(resumed.structuredContent),
      JSON.stringify(validateOutput.errors),
    ).toBe(true);
    expect(
      contract.outputSchema.parse(resumed.structuredContent).normalized_result,
    ).toMatchObject({
      trace: { final: trace.final, final_irq: trace.final_irq },
    });
    const invalid = {
      ...continuation,
      initial: { mapper: 4, irq_latch: { mask: 128, value: 1 } },
    };
    expect(validateInput(invalid)).toBe(false);
    const rejected = await client.callTool({
      name: contract.name,
      arguments: invalid,
    });
    expect(rejected.isError).toBe(true);

    expect(
      contract.outputSchema.parse(response.structuredContent).normalized_result,
    ).toEqual(evidence.normalized_result);
    expect(evidence.normalized_result).toMatchObject({
      trace: {
        final: { irq_latch: { mask: 128, value } },
        final_irq: { counter: null, asserted: value === 128 ? false : null },
      },
    });
  }
};

cliTest(
  "retains mapper read sources and qualified MMC3 IRQ states through CLI and MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nes-events-");
    const client = await connectTestMcp("nes-events-acceptance");
    for (const mapper of [9, 10] as const)
      await verifyMapper(mapper, cli, client, root);
    await verifyRegisterEvents(cli, client, root);
    await verifyIrqEvents(cli, client, root);
    await verifyPartialIrqLatch(cli, client, root);
    await verifyA12Signals(cli, client, root);
    await verifyMcAccSignals(cli, client, root);
    await client.ping();
  },
  90_000,
);
