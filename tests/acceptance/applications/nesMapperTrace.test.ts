import { replayNesThroughMcp } from "../../support/nesSourceDelivery.js";
import {
  createStdioToolClient,
  connectTestMcp,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { mapperTraceFixture } from "../../../src/domain/nesMapperTrace.fixture.js";
import {
  nesMapperTraceReportSchema,
  traceNesMapperWritesInputSchema,
  type NesMapperTrace,
} from "../../../src/domain/nesMapperTrace.js";

import { nesPrgViewsSchema } from "../../../src/domain/nesPrgViews.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

type DerivedMapperTrace = Extract<NesMapperTrace, { status: "derived" }>;
type MapperSchemas = {
  input: (value: unknown) => boolean;
  output: (value: unknown) => boolean;
};

const contract = toolContract("trace_nes_mapper_writes");
const request = (path: string, mapper: 1 | 4) => ({
  path,
  initial: { mapper },
  writes:
    mapper === 1
      ? [
          { address: 0x8000, value: 128 },
          ...[0, 1, 0, 0, 0].map((value) => ({
            address: 0xe000,
            value,
            preceded_by_cpu_write: false,
          })),
        ]
      : [
          { address: 0x8000, value: 6 },
          { address: 0x8001, value: 2 },
          { address: 0x8000, value: 7 },
          { address: 0x8001, value: 3 },
          { address: 0x8000, value: 0x46 },
        ],
});

const verifyPostWriteMappings = (trace: DerivedMapperTrace, mapper: 1 | 4) => {
  const expectedBanks =
    mapper === 1
      ? [
          [null, 3],
          [null, 3],
          [null, 3],
          [null, 3],
          [null, 3],
          [2, 3],
        ]
      : [
          [null, null, 6, 7],
          [2, null, 6, 7],
          [2, null, 6, 7],
          [2, 3, 6, 7],
          [6, 3, 2, 7],
        ];
  expect(
    trace.steps.map((step) =>
      step.mapping.prg_windows.map((window) => window.bank),
    ),
  ).toEqual(expectedBanks);
  const windowSize = mapper === 1 ? 16384 : 8192;
  for (const [index, step] of trace.steps.entries()) {
    expect(step.mapping.prg_view).toEqual(step.prg_view);
    expect(step.mapping.prg_windows).toEqual(
      expectedBanks[index]!.map((bank, slot) => ({
        start: 32768 + slot * windowSize,
        size: windowSize,
        bank,
        file_offset: bank === null ? null : 528 + bank * windowSize,
      })),
    );
  }
  expect(trace.steps.at(-1)?.mapping).toEqual(trace.final_mapping);
};

const verifyEventMappings = async (
  client: Client,
  input: unknown,
  trace: DerivedMapperTrace,
) => {
  const selected = traceNesMapperWritesInputSchema.parse(input);
  const eventResponse = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path: selected.path,
      initial: selected.initial,
      events: selected.writes.map((write) => ({ kind: "cpu-write", ...write })),
    },
  });
  expect(eventResponse.isError).not.toBe(true);
  const events = toolContract("trace_nes_mapper_events").outputSchema.parse(
    eventResponse.structuredContent,
  ).normalized_result.trace;
  if (events.status !== "derived") throw new Error(events.reason);
  if ("mapper_snapshots" in events)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  expect(events.steps.map((step) => step.mapping)).toEqual(
    trace.steps.map((step) => step.mapping),
  );
};

const verifyMapper = async (
  cli: TestCli,
  client: Client,
  root: string,
  schemas: MapperSchemas,
  mapper: 1 | 4,
  submapper?: number,
  partialWrites = false,
) => {
  const path = join(root, `mapper${mapper}.nes`);
  const bytes = mapperTraceFixture(mapper);
  if (submapper !== undefined) {
    bytes[7] = 8;
    bytes[8] = submapper << 4;
  }
  await writeFile(path, bytes);
  const selected = request(path, mapper);
  const input = {
    ...selected,
    writes: selected.writes.map((write) =>
      partialWrites && write.address === 0x8001
        ? { ...write, value: null, known_bits: { mask: 7, value: write.value } }
        : partialWrites && write.address === 0x8000
          ? {
              ...write,
              value: null,
              known_bits: { mask: 0xc7, value: write.value },
            }
          : write,
    ),
  };

  const inputFile = join(root, `trace${mapper}.json`);
  await writeFile(inputFile, JSON.stringify(input));
  const result = await cli.run({
    arguments: [
      "trace-nes-mapper-writes",
      mapper === 1 ? inputFile : JSON.stringify(input),
      "--json",
    ],
  });
  expect(result.exitCode).toBe(0);
  const evidence = contract.outputSchema.parse(result.json);
  expect(evidence.subject?.digest).toMatchObject({
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const report = nesMapperTraceReportSchema.parse(evidence.normalized_result);
  const trace = report.trace;
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.steps.map((step) => step.write)).toMatchObject(input.writes);
  expect(trace.steps.map((step) => step.write.value)).toEqual(
    input.writes.map((write) => write.value),
  );
  expect(trace.coverage).toMatchObject({
    supplied_writes: input.writes.length,
    processed_writes: input.writes.length,
  });
  expect(trace.final_mapping.prg_windows.map((window) => window.bank)).toEqual(
    mapper === 1 ? [2, 3] : [6, 3, 2, 7],
  );
  verifyPostWriteMappings(trace, mapper);
  if (partialWrites) {
    // Three physical bank bits do not establish the six-bit raw MMC3 selectors.
    expect(trace.initial_mapping.prg_view).toBeNull();
    for (const step of trace.steps) {
      expect(step.prg_view).toBeNull();
      expect(step.mapping.prg_view).toBeNull();
    }
    expect(trace.final_mapping.prg_view).toBeNull();
    expect(trace.nes_prg_views).toEqual([]);
  } else {
    const views = nesPrgViewsSchema.parse(trace.nes_prg_views);
    expect(views).toContainEqual(
      mapper === 1
        ? { mapper: 1, prg_mode: 3, prg_bank: 2 }
        : { mapper: 4, prg_mode: 1, r6: 2, r7: 3 },
    );
  }
  // Verify source offsets against distinct bytes, independent of the mapper planner.
  for (const window of trace.final_mapping.prg_windows) {
    if (window.file_offset === null)
      throw new Error("Expected known source window");
    expect(bytes[window.file_offset]).toBe(
      mapper === 1 ? window.bank! * 2 : window.bank,
    );
  }
  const response = await client.callTool({
    name: contract.name,
    arguments: input,
  });
  expect(response.isError).not.toBe(true);
  const mcp = contract.outputSchema.parse(response.structuredContent);
  expect(mcp.evidence_id).toBe(evidence.evidence_id);
  expect(mcp.normalized_result).toEqual(evidence.normalized_result);
  expect(schemas.output(response.structuredContent)).toBe(true);
  await verifyEventMappings(client, input, trace);
  if (mapper === 4) {
    const reordered = await replayNesThroughMcp(client, {
      ...input,
      writes: [
        ...input.writes.slice(2, 4),
        ...input.writes.slice(0, 2),
        ...input.writes.slice(4),
      ],
    });

    const different = reordered;
    expect(different.evidence_id).not.toBe(evidence.evidence_id);
    const reorderedTrace = nesMapperTraceReportSchema.parse(
      different.normalized_result,
    ).trace;
    if (reorderedTrace.status !== "derived")
      throw new Error(reorderedTrace.reason);

    expect(reorderedTrace.final).toEqual(trace.final);
  }
  if (partialWrites) {
    const continuation = { path, initial: trace.final, writes: [] };
    expect(schemas.input(continuation)).toBe(true);
    const resumed = await replayNesThroughMcp(client, continuation);

    expect(resumed.normalized_result).toMatchObject({
      trace: { final: trace.final, final_mapping: trace.final_mapping },
    });
  }
  const text = response.content.find((item) => item.type === "text");
  if (text?.type !== "text") throw new Error("Missing text Evidence");
  expect(contract.outputSchema.parse(JSON.parse(text.text)).evidence_id).toBe(
    evidence.evidence_id,
  );
  expect(await readFile(path)).toEqual(bytes);
};

const verifyPartialMmc1Commit = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const bytes = mapperTraceFixture(1);
  const path = join(root, "mmc1-partial-control.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    initial: {
      mapper: 1,
      shift_bits: [null, 0, 1, 1],
      prg_mode: 0,
      prg_bank: 2,
    },
    writes: [
      {
        address: 0x8000,
        value: null,
        known_bits: { mask: 129, value: 1 },
        preceded_by_cpu_write: false,
      },
    ],
  };
  const evidence = toolContract("trace_nes_mapper_writes").outputSchema.parse(
    await (
      await createToolDelivery(client, cli)
    ).invoke("trace-nes-mapper-writes", input),
  );
  const { trace } = nesMapperTraceReportSchema.parse(
    evidence.normalized_result,
  );
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.steps[0]!.write).toEqual(input.writes[0]);
  expect(trace.final).toMatchObject({
    shift_bits: [],
    mirroring: null,
    prg_mode: 3,
    chr_mode: 1,
    prg_bank: 2,
  });
  expect(trace.final_mapping.prg_windows).toEqual([
    { start: 0x8000, size: 16384, bank: 2, file_offset: 16 + 512 + 2 * 16384 },
    { start: 0xc000, size: 16384, bank: 3, file_offset: 16 + 512 + 3 * 16384 },
  ]);
  expect(trace.nes_prg_views).toContainEqual({
    mapper: 1,
    prg_mode: 3,
    prg_bank: 2,
  });
  const replay = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial: input.initial,
      events: input.writes.map((write) => ({ ...write, kind: "cpu-write" })),
    },
  });
  expect(replay.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_mapper_events").outputSchema.parse(
      replay.structuredContent,
    ).normalized_result,
  ).toMatchObject({
    trace: { final: trace.final, final_mapping: trace.final_mapping },
  });
  expect(await readFile(path)).toEqual(bytes);
};

const verifyChrSources = async (cli: TestCli, client: Client, root: string) => {
  const serial = (address: number, value: number) =>
    Array.from({ length: 5 }, (_, bit) => ({
      address,
      value: (value >> bit) & 1,
      preceded_by_cpu_write: false,
    }));
  const cases = [
    {
      name: "mmc1-4k",
      mapper: 1 as const,
      initial: {
        mapper: 1,
        shift_bits: [],
        chr_mode: 0,
        chr_bank_0: 3,
        chr_bank_1: 6,
      },
      writes: serial(0x8000, 0x1e),
      before: [2, 3],
      after: [3, 6],
      size: 4096,
    },
    {
      name: "mmc1-8k",
      mapper: 1 as const,
      initial: {
        mapper: 1,
        shift_bits: [],
        chr_mode: 1,
        chr_bank_0: 3,
        chr_bank_1: 6,
      },
      writes: serial(0x8000, 0x0e),
      before: [3, 6],
      after: [2, 3],
      size: 4096,
    },
    {
      name: "mmc3-inversion",
      mapper: 4 as const,
      initial: {
        mapper: 4,
        bank_select: 0,
        banks: [3, 7, 9, 10, 11, 12, 2, 3],
      },
      writes: [{ address: 0x9ffe, value: 128 }],
      before: [2, 3, 6, 7, 9, 10, 11, 12],
      after: [9, 10, 11, 12, 2, 3, 6, 7],
      size: 1024,
    },
    {
      name: "mmc3-unknown-inversion",
      mapper: 4 as const,
      initial: {
        mapper: 4,
        bank_select: 0,
        banks: [3, 7, 34, 35, 9, 39, 2, 3],
      },
      writes: [{ address: 0x8000, value: null }],
      before: [2, 3, 6, 7, 2, 3, 9, 7],
      after: [2, 3, null, 7, 2, 3, null, 7],
      size: 1024,
    },
  ];
  for (const scenario of cases) {
    const bytes = mapperTraceFixture(scenario.mapper);
    const path = join(root, `${scenario.name}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: scenario.initial, writes: scenario.writes };
    const evidence = toolContract("trace_nes_mapper_writes").outputSchema.parse(
      await (
        await createToolDelivery(client, cli)
      ).invoke("trace-nes-mapper-writes", input),
    );
    const { trace } = nesMapperTraceReportSchema.parse(
      evidence.normalized_result,
    );
    if (trace.status !== "derived") throw new Error(trace.reason);

    for (const [mapping, expected] of [
      [trace.initial_mapping, scenario.before],
      [trace.final_mapping, scenario.after],
    ] as const) {
      expect(mapping.chr_source).toBe("rom");
      expect(mapping.chr_windows.map((window) => window.bank)).toEqual(
        expected,
      );
      for (const [index, window] of mapping.chr_windows.entries()) {
        expect(window.start).toBe(index * scenario.size);
        expect(window.size).toBe(scenario.size);
        const bank = expected[index];
        if (bank == null) {
          expect(window.file_offset).toBeNull();
          continue;
        }
        // Header + trainer + 64 KiB PRG. Fixture bytes identify every 1 KiB CHR page.
        const offset = 16 + 512 + 65536 + bank * scenario.size;
        expect(window.file_offset).toBe(offset);
        for (let page = 0; page < scenario.size / 1024; page++) {
          expect(bytes[offset + page * 1024]).toBe(
            (bank * scenario.size) / 1024 + page,
          );
          expect(bytes[offset + page * 1024 + 1023]).toBe(
            (bank * scenario.size) / 1024 + page,
          );
        }
      }
    }
    expect(trace.steps.map((step) => step.write)).toMatchObject(
      scenario.writes,
    );
    expect(await readFile(path)).toEqual(bytes);
  }
};

const verifyFailures = async (cli: TestCli, client: Client, root: string) => {
  const path = join(root, "mapper4.nes");
  await writeFile(path, mapperTraceFixture(4));
  const input = { ...request(path, 4), max_steps: 1 };
  const result = await cli.run({
    arguments: ["trace-nes-mapper-writes", JSON.stringify(input), "--json"],
  });
  expect(result.exitCode).toBe(1);
  const rejected = await client.callTool({
    name: contract.name,
    arguments: input,
  });
  expect(rejected.isError).toBe(true);
  expect(parseMcpToolError(rejected)).toEqual({ error: result.json });
  for (const invalid of [
    { ...input, writes: [{ address: 65536, value: 0 }] },
    { ...input, initial: { mapper: 1, shift_bits: [0, 1, 0, 1, 0] } },
    { ...input, initial: { mapper: 4, banks: [0] } },
    { ...input, writes: [{ address: 32768, value: 256 }] },
  ]) {
    expect(
      (await client.callTool({ name: contract.name, arguments: invalid }))
        .isError,
    ).toBe(true);
  }
  const unsupported = await replayNesThroughMcp(client, {
    path,
    initial: { mapper: 1 },
    writes: [],
  });

  expect(
    nesMapperTraceReportSchema.parse(unsupported.normalized_result),
  ).toMatchObject({ header: { mapper: 4 }, trace: { status: "unsupported" } });
};

const verifyPartialDiscrete = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const path = join(root, "partial-color-dreams.nes");
  await writeFile(path, mapperTraceFixture(11));
  for (const bus_conflicts of ["none", "and", "unknown"]) {
    const input = {
      path,
      initial: { mapper: 11, prg_bank: 0, bus_conflicts },
      writes: [
        { address: 0x8000, value: null, known_bits: { mask: 3, value: 2 } },
      ],
    };
    const evidence = toolContract("trace_nes_mapper_writes").outputSchema.parse(
      await (
        await createToolDelivery(client, cli)
      ).invoke("trace-nes-mapper-writes", input),
    );
    expect(evidence.normalized_result).toMatchObject({
      trace: {
        final: {
          prg_bank:
            bus_conflicts === "none" ? 2 : bus_conflicts === "and" ? 0 : null,
          chr_bank: bus_conflicts === "and" ? 0 : null,
        },
      },
    });
  }
};

const verifyPartialSelectors = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  for (const mapper of [9, 10, 34, 71] as const) {
    const bytes = mapperTraceFixture(mapper);
    if (mapper === 71) {
      bytes[7] = 0x48;
      bytes[8] = 0x10;
    }
    const path = join(root, `partial-selectors-${mapper}.nes`);
    await writeFile(path, bytes);
    const address = mapper === 34 ? 0x7ffd : mapper === 71 ? 0xc000 : 0xa000;
    const mask = mapper === 34 ? 1 : mapper === 71 ? 7 : 15;
    const input = {
      path,
      initial: { mapper },
      writes: [{ address, value: null, known_bits: { mask, value: 1 } }],
    };
    const evidence = toolContract("trace_nes_mapper_writes").outputSchema.parse(
      await (
        await createToolDelivery(client, cli)
      ).invoke("trace-nes-mapper-writes", input),
    );
    expect(evidence.normalized_result).toMatchObject({
      trace: {
        final: { prg_bank: 1 },
        steps: [{ write: { known_bits: { mask, value: 1 } } }],
      },
    });
  }
};

const verifyQuattro = async (cli: TestCli, client: Client, root: string) => {
  for (const submapper of [0, 1]) {
    const bytes = Buffer.alloc(16 + 262144);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      16,
      0,
      0x80,
      0xe8,
      submapper << 4,
      0,
      0,
      7,
    ]);
    for (let bank = 0; bank < 16; bank++)
      bytes.fill(bank, 16 + bank * 16384, 16 + (bank + 1) * 16384);
    const path = join(root, `quattro-${submapper}.nes`);
    await writeFile(path, bytes);
    const input = {
      path,
      initial: { mapper: 232 },
      writes: [
        { address: 0x8000, value: null, known_bits: { mask: 24, value: 8 } },
        { address: 0xc000, value: 2 },
      ],
    };
    const result = await cli.run({
      arguments: ["trace-nes-mapper-writes", JSON.stringify(input), "--json"],
    });
    expect(result.exitCode).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    expect(evidence.subject?.digest).toMatchObject({
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    const response = await replayNesThroughMcp(client, input);

    const mcp = response;
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    const trace = nesMapperTraceReportSchema.parse(mcp.normalized_result).trace;
    if (trace.status !== "derived") throw new Error(trace.reason);

    const banks = submapper === 0 ? [6, 7] : [10, 11];
    expect(
      trace.final_mapping.prg_windows.map((w) => [w.bank, w.file_offset]),
    ).toEqual(banks.map((b) => [b, 16 + b * 16384]));
    expect(trace.steps[0]?.write).toMatchObject(input.writes[0]!);
    expect(trace.initial_mapping.prg_windows.map((w) => w.bank)).toEqual([
      null,
      null,
    ]);
    expect(await readFile(path)).toEqual(bytes);
  }
};

const verifyQuattroPartial = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const definition = (await client.listTools()).tools.find(
    (tool) => tool.name === contract.name,
  );
  if (!definition?.outputSchema) throw new Error("Missing Quattro schemas");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const inputSchema: Record<string, unknown> = definition.inputSchema;
  const outputSchema: Record<string, unknown> = definition.outputSchema;
  const validInput = ajv.compile(inputSchema);
  const validOutput = ajv.compile(outputSchema);
  for (const submapper of [0, 1]) {
    const bytes = Buffer.alloc(16 + 131072);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      8,
      0,
      0x80,
      0xe8,
      submapper << 4,
      0,
      0,
      7,
    ]);
    const path = join(root, `quattro-partial-${submapper}.nes`);
    await writeFile(path, bytes);
    const mask = submapper === 0 ? 8 : 16;
    const input = {
      path,
      initial: { mapper: 232, prg_bank: 2 },
      writes: [
        { address: 0x8000, value: null, known_bits: { mask, value: mask } },
      ],
    };
    const mcp = toolContract("trace_nes_mapper_writes").outputSchema.parse(
      await (
        await createToolDelivery(client, cli)
      ).invoke("trace-nes-mapper-writes", input),
    );
    const trace = nesMapperTraceReportSchema.parse(mcp.normalized_result).trace;
    if (trace.status !== "derived") throw new Error(trace.reason);

    expect(trace.final).toEqual({
      mapper: 232,
      prg_outer_bank: { mask: 1, value: 1 },
      prg_bank: 2,
    });
    expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([6, 7]);
    expect(trace.nes_prg_views).toEqual([]);
    const continuation = { path, initial: trace.final, writes: [] };
    expect(validInput(continuation)).toBe(true);
    const resumed = await replayNesThroughMcp(client, continuation);

    expect(resumed.normalized_result).toMatchObject({
      trace: { initial_mapping: trace.final_mapping },
    });
    for (const prg_outer_bank of [
      { mask: 1, value: 2 },
      { mask: 2, value: 1 },
      { mask: 3, value: 1 },
    ]) {
      expect(
        validInput({
          ...continuation,
          initial: { mapper: 232, prg_outer_bank },
        }),
      ).toBe(false);
    }
    expect(await readFile(path)).toEqual(bytes);
  }
};

describe("supplied mapper writes over compiled CLI and stdio MCP", () => {
  const connection = createStdioToolClient("nes-mapper-trace");
  const { client, transport } = connection;
  let schemas: MapperSchemas;

  beforeAll(async () => {
    await client.connect(transport);
    const tools = (await client.listTools()).tools;
    expect(tools).toContainEqual(
      expect.objectContaining({
        name: contract.name,
        annotations: expect.objectContaining({
          readOnlyHint: false,
          openWorldHint: false,
        }),
      }),
    );
    const definition = tools.find((tool) => tool.name === contract.name);
    if (!definition?.outputSchema) throw new Error("Missing mapper schemas");
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    const inputSchema: Record<string, unknown> = definition.inputSchema;
    const outputSchema: Record<string, unknown> = definition.outputSchema;
    schemas = {
      input: ajv.compile(inputSchema),
      output: ajv.compile(outputSchema),
    };
    const session = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(JSON.stringify(session.structuredContent)).toContain(contract.name);
  }, 60_000);

  afterAll(async () => {
    await connection.close();
  });

  for (const scenario of [
    {
      name: "MMC1 serial commits",
      mapper: 1,
      submapper: undefined,
      partial: false,
    },
    {
      name: "MMC3 mode swaps",
      mapper: 4,
      submapper: undefined,
      partial: false,
    },
    { name: "MC-ACC bank windows", mapper: 4, submapper: 3, partial: false },
    { name: "NEC MMC3 bank windows", mapper: 4, submapper: 4, partial: false },
    {
      name: "MMC3 partial selectors",
      mapper: 4,
      submapper: undefined,
      partial: true,
    },
  ] as const) {
    cliTest(
      `${scenario.name} retain every post-write mapping and identical Evidence`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-nes-mapper-trace-");
        await verifyMapper(
          cli,
          client,
          root,
          schemas,
          scenario.mapper,
          scenario.submapper,
          scenario.partial,
        );
        await client.ping();
      },
      60_000,
    );
  }

  for (const [name, verify] of [
    ["partial MMC1 commits", verifyPartialMmc1Commit],
    ["partial discrete writes", verifyPartialDiscrete],
    ["partial selector continuation", verifyPartialSelectors],
    ["CHR source windows", verifyChrSources],
    ["input and capacity failures", verifyFailures],
  ] as const) {
    cliTest(
      `preserves ${name} through CLI/MCP`,
      async ({ cli }) => {
        const root = await createTestTempDirectory("rea-nes-mapper-trace-");
        await verify(cli, client, root);
        await client.ping();
      },
      60_000,
    );
  }
});

cliTest(
  "preserves Quattro partial outer selectors through CLI/MCP and advertised schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nes-quattro-trace-");
    const client = await connectTestMcp("nes-quattro-trace");
    await verifyQuattro(cli, client, root);
    await verifyQuattroPartial(cli, client, root);
    await client.ping();
  },
  60_000,
);
