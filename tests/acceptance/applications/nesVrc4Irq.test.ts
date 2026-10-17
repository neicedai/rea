import {
  connectTestMcp,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import {
  nesMapperEventSnapshot,
  nesLegacyMapperEventsTraceSchema,
} from "../../../src/domain/nesMapperEvents.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { NesLegacyMapperEventsTrace } from "../../../src/domain/nesMapperEvents.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

type Trace = Extract<NesLegacyMapperEventsTrace, { status: "derived" }>;
const contract = toolContract("trace_nes_mapper_events");
const cycle = { kind: "vrc-cpu-cycle" };
const boards = [
  [21, 1, 1, 2],
  [21, 2, 6, 7],
  [23, 1, 0, 1],
  [23, 2, 2, 3],
  [25, 1, 1, 0],
  [25, 2, 3, 2],
] as const;

function scenario(mapper: number, submapper: number, a0: number, a1: number) {
  const bytes = Buffer.alloc(528 + 65536 + 524288);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    4,
    64,
    ((mapper & 15) << 4) | 4,
    0x18,
    submapper << 4,
  ]);
  const port = (base: number, p: number) =>
    base | ((p & 1) << a0) | ((p >> 1) << a1);
  const write = (address: number, value: number) => ({
    kind: "cpu-write",
    address,
    value,
  });
  const scan = submapper === 1;
  const events = [
    write(port(0xf000, 0), scan ? 14 : 15),
    write(port(0xf000, 1), 15),
    write(port(0xf000, 2), scan ? 3 : 7),
    ...Array.from({ length: scan ? 113 : 1 }, () => cycle),
    { kind: "ppu-read", address: 0x3ff },
    write(port(0x9000, 2), 2),
    ...Array.from({ length: scan ? 115 : 0 }, () => cycle),
    write(port(0xf000, 3), 255),
    ...Array.from({ length: scan ? 113 : 1 }, () => cycle),
  ];
  return {
    bytes,
    scan,
    input: {
      initial: {
        mapper,
        variant: "vrc4",
        prg_control: 0,
        prg_banks: [2, 5],
        chr_low: [15, ...Array(7).fill(null)],
        chr_high: [31, ...Array(7).fill(null)],
      },
      initial_irq: {
        model: "vrc4",
        counter: 42,
        prescaler: [17],
        asserted: true,
      },
      events,
    },
  };
}

function verifyTiming(trace: Trace, scan: boolean, bytes: Buffer) {
  expect(trace.coverage.processed_events).toBe(trace.steps.length);
  expect(trace.steps[2]?.irq).toEqual({
    model: "vrc4",
    counter: scan ? 254 : 255,
    prescaler: [341],
    asserted: false,
  });
  expect(
    trace.steps.flatMap((s, index) => (s.irq_clock ? [index] : [])),
  ).toEqual(scan ? [118, 232, 346] : [3, 7]);
  const read = trace.steps[scan ? 116 : 4]!;
  expect(read.irq_clock).toBe(false);
  expect(read.read_source).toEqual({
    status: "chr-rom",
    bank: 511,
    file_offset: bytes.length - 1,
  });
  expect(trace.steps[scan ? 117 : 5]?.irq).toEqual(read.irq);
  expect(trace.steps[scan ? 233 : 6]?.irq).toEqual({
    model: "vrc4",
    counter: scan ? 254 : 255,
    prescaler: scan ? [339] : null,
    asserted: false,
  });
  expect(trace.final_irq).toEqual({
    model: "vrc4",
    counter: 255,
    prescaler: scan ? [341] : null,
    asserted: !scan,
  });
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    6, 5, 2, 7,
  ]);
}

async function verifyContinuation(
  client: Client,
  path: string,
  trace: Trace,
  scan: boolean,
) {
  const cut = scan ? 117 : 5;
  const snapshot = nesMapperEventSnapshot(trace, trace.steps[cut - 1]!)!;
  const response = await client.callTool({
    name: contract.name,
    arguments: {
      path,
      initial: snapshot.state,
      initial_irq: snapshot.irq,
      events: trace.steps.slice(cut).map((s) => s.event),
    },
  });
  expect(response.isError).not.toBe(true);
  const resumed = nesLegacyMapperEventsTraceSchema.parse(
    contract.outputSchema.parse(response.structuredContent).normalized_result
      .trace,
  );
  if (resumed.status !== "derived") throw new Error(resumed.reason);
  expect(
    resumed.steps.map((s) => ({
      ...semanticStep(resumed, s),
      index: s.index + cut,
    })),
  ).toEqual(trace.steps.slice(cut).map((s) => semanticStep(trace, s)));
  expect(resumed.final_irq).toEqual(trace.final_irq);
  expect(resumed.final_mapping).toEqual(trace.final_mapping);
}

async function verifyFailures(client: Client, path: string) {
  for (const extra of [
    { initial_irq: null, events: [cycle] },
    { initial_irq: { model: "sharp" }, events: [cycle] },
    { initial_irq: { model: "vrc4" }, events: [{ kind: "cpu-m2-fall" }] },
    { initial_irq: { model: "vrc4" }, events: [{ kind: "mmc3-irq-clock" }] },
  ]) {
    const response = await client.callTool({
      name: contract.name,
      arguments: { path, initial: { mapper: 25, variant: "vrc4" }, ...extra },
    });
    expect(response.isError).not.toBe(true);
    expect(
      contract.outputSchema.parse(response.structuredContent).normalized_result
        .trace.status,
    ).toBe("unsupported");
  }
  const capacity = await client.callTool({
    name: contract.name,
    arguments: {
      path,
      initial: { mapper: 25, variant: "vrc4" },
      initial_irq: { model: "vrc4" },
      events: [cycle, cycle],
      max_steps: 1,
    },
  });
  expect(capacity.isError).toBe(true);
}

async function partialCounter(client: Client, path: string) {
  const response = await client.callTool({
    name: contract.name,
    arguments: {
      path,
      initial: {
        mapper: 25,
        variant: "vrc4",
        irq_control: 6,
        irq_enabled: true,
        irq_latch_low: 14,
        irq_latch_high: 15,
      },
      initial_irq: {
        model: "vrc4",
        counter: { mask: 254, value: 254 },
        asserted: false,
      },
      events: [cycle],
    },
  });
  expect(response.isError).not.toBe(true);
  expect(
    contract.outputSchema.parse(response.structuredContent).normalized_result
      .trace,
  ).toMatchObject({
    final_irq: { counter: { mask: 254, value: 254 }, asserted: null },
  });
  return response.structuredContent;
}

cliTest(
  "derives VRC4 IRQ timing through CLI/MCP with scanline intervals, bank switching and exact continuation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc4-irq-");
    const client = await connectTestMcp("vrc4-irq");
    const advertised = (await client.listTools()).tools.find(
      (t) => t.name === contract.name,
    )!;
    const ajv = new Ajv2020({ strict: false });
    const inputSchema: Record<string, unknown> = advertised.inputSchema;
    const outputSchema: Record<string, unknown> = advertised.outputSchema!;
    const validateInput = ajv.compile(inputSchema),
      validateOutput = ajv.compile(outputSchema);
    for (const [mapper, submapper, a0, a1] of boards) {
      const current = scenario(mapper, submapper, a0, a1);
      const path = join(root, `vrc4-${mapper}-${submapper}.nes`);
      await writeFile(path, current.bytes);
      const input = { ...current.input, path };
      expect(validateInput(input)).toBe(true);
      const evidence = toolContract(
        "trace_nes_mapper_events",
      ).outputSchema.parse(
        await (
          await createToolDelivery(client, cli)
        ).invoke("trace-nes-mapper-events", input),
      );
      expect(evidence.subject?.digest?.sha256).toBe(
        createHash("sha256").update(current.bytes).digest("hex"),
      );
      const trace = nesLegacyMapperEventsTraceSchema.parse(
        evidence.normalized_result.trace,
      );
      if (trace.status !== "derived") throw new Error(trace.reason);
      verifyTiming(trace, current.scan, current.bytes);
      await verifyContinuation(client, path, trace, current.scan);
      expect(await readFile(path)).toEqual(current.bytes);
    }
    for (const prescaler of [[], [0], [342], [1, 1]]) {
      const input = {
        path: join(root, "invalid.nes"),
        initial: { mapper: 21, variant: "vrc4" },
        initial_irq: { model: "vrc4", prescaler },
        events: [],
      };
      expect(validateInput(input)).toBe(false);
      expect(
        (await client.callTool({ name: contract.name, arguments: input }))
          .isError,
      ).toBe(true);
    }
    await verifyFailures(client, join(root, "vrc4-25-2.nes"));
    expect(
      validateOutput(await partialCounter(client, join(root, "vrc4-25-2.nes"))),
    ).toBe(true);
    const invalidCounter = {
      path: join(root, "vrc4-25-2.nes"),
      initial: { mapper: 25, variant: "vrc4" },
      initial_irq: { model: "vrc4", counter: { mask: 1, value: 2 } },
      events: [],
    };
    expect(validateInput(invalidCounter)).toBe(false);
    expect(
      (
        await client.callTool({
          name: contract.name,
          arguments: invalidCounter,
        })
      ).isError,
    ).toBe(true);
  },
  120000,
);

function semanticStep(trace: Trace, step: Trace["steps"][number]) {
  const snapshot = nesMapperEventSnapshot(trace, step);
  if (snapshot === null) throw new Error("Unresolved mapper snapshot");
  const value = { ...step, ...snapshot };
  Reflect.deleteProperty(value, "mapper_snapshot");
  return value;
}
