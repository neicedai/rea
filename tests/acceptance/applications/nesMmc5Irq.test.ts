import {
  connectTestMcp,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { mmc5Fixture } from "../../../src/domain/nesMmc5.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const initial = {
  mapper: 5,
  prg_mode: 3,
  prg_banks: [0, 128, 129, 130, 7],
  ram_wiring: "none",
  ppu_mask: 24,
  split: [0, null, null],
  exram_mode: 0,
  irq_target: 2,
};
const clean = {
  model: "mmc5",
  counter: 0,
  in_frame: false,
  pending: false,
  enabled: false,
  asserted: false,
  matching_reads: [0],
  idle_cycles: [0],
  ppu_read_since_cycle: false,
};
const line = () => [
  ...Array.from({ length: 3 }, () => ({ kind: "ppu-read", address: 0x2000 })),
  { kind: "ppu-read", address: 0x23c0 },
];
const cpuWrite = (address: number, value: number) => ({
  kind: "cpu-write",
  address,
  value,
});
async function both(
  cli: TestCli,
  client: Client,
  input: Record<string, unknown>,
  validate: (v: unknown) => boolean,
) {
  const contract = toolContract("trace_nes_mapper_events");
  const mcp = toolContract("trace_nes_mapper_events").outputSchema.parse(
    await (
      await createToolDelivery(client, cli)
    ).invoke("trace-nes-mapper-events", input),
  );
  const trace = mcp.normalized_result.trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  if ("mapper_snapshots" in trace)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  return { trace, evidence: mcp };
}
async function signals(
  cli: TestCli,
  client: Client,
  path: string,
  validate: (v: unknown) => boolean,
) {
  const events = [
    { kind: "cpu-read", address: 0xfffa },
    cpuWrite(0x5204, 0),
    ...line(),
    cpuWrite(0x5c00, 90),
    ...line(),
    ...line(),
    cpuWrite(0x5204, 128),
    { kind: "cpu-read", address: 0x5204 },
    { kind: "mmc5-reset" },
    cpuWrite(0x2001, 0),
    ...Array.from({ length: 4 }, () => ({ kind: "mmc5-cpu-cycle" })),
    cpuWrite(0x5104, 0),
    cpuWrite(0x5c01, 91),
    cpuWrite(0x5104, 2),
    { kind: "cpu-read", address: 0x5c00 },
    { kind: "cpu-read", address: 0x5c01 },
  ];
  const input = { path, initial, initial_irq: { model: "mmc5" }, events };
  const { trace, evidence } = await both(cli, client, input, validate);
  expect(trace.steps.slice(2, 6).map((s) => s.irq_clock)).toEqual([
    false,
    false,
    false,
    true,
  ]);
  expect(trace.steps[6]).toMatchObject({
    write_effect: "exram-write",
    state: { exram: { "0": 90 } },
  });
  expect(trace.steps[14]!.irq).toMatchObject({
    counter: 2,
    in_frame: true,
    pending: true,
    enabled: false,
    asserted: false,
  });
  expect(trace.steps[15]!.irq).toMatchObject({
    pending: true,
    enabled: true,
    asserted: true,
  });
  expect(trace.steps[16]).toMatchObject({
    cpu_read: {
      value: null,
      known_bits: { mask: 192, value: 192 },
      source: { kind: "mmc5-scanline-status", counter: 2 },
    },
    irq: { counter: 2, in_frame: true, pending: false, asserted: false },
  });
  expect(trace.steps[17]!.irq).toMatchObject({
    enabled: false,
    in_frame: true,
    counter: 2,
  });
  expect(trace.steps[22]!.irq).toMatchObject({
    in_frame: false,
    idle_cycles: [3],
  });
  expect(trace.steps[24]).toMatchObject({
    write_effect: "uncertain-exram-write",
    state: { exram: { "1": null } },
  });
  expect(trace.steps[26]).toMatchObject({ cpu_read: { value: 90 } });
  expect(trace.steps[27]).toMatchObject({ cpu_read: { value: null } });
  expect(trace.steps[17]!.state).toMatchObject({
    prg_mode: { mask: 3, value: 3 },
    ram_protect: [
      { mask: 3, value: 1 },
      { mask: 3, value: 2 },
    ],
    exram_mode: { mask: 3, value: 3 },
    chr_upper: { mask: 3, value: 0 },
    split: [{ mask: 223, value: 0 }, 0, null],
    exram: { "0": 90 },
  });
  const snapshot = trace.steps[4]!;
  const continued = await both(
    cli,
    client,
    {
      ...input,
      initial: snapshot.state,
      initial_irq: snapshot.irq,
      events: events.slice(5),
    },
    validate,
  );
  expect(continued.trace.final).toEqual(trace.final);
  expect(continued.trace.final_irq).toEqual(trace.final_irq);
  return evidence;
}

async function capacity(
  cli: TestCli,
  client: Client,
  path: string,
  validate: (v: unknown) => boolean,
) {
  const events = [
    ...Array.from({ length: 241 }, line).flat(),
    { kind: "cpu-read", address: 0x5204 },
  ];
  const input = {
    path,
    initial,
    initial_irq: { ...clean, enabled: true },
    max_steps: 1200,
    events,
  };
  const { trace } = await both(cli, client, input, validate);
  expect(trace.coverage).toMatchObject({
    supplied_events: 965,
    processed_events: 965,
  });
  expect(trace.steps.filter((s) => s.irq_clock === true)).toHaveLength(241);
  expect(trace.steps[959]!.irq).toMatchObject({
    counter: 239,
    in_frame: true,
    pending: true,
    asserted: true,
  });
  expect(trace.steps[963]!.irq).toMatchObject({
    counter: 0,
    in_frame: false,
    pending: false,
    enabled: true,
    asserted: false,
  });
  expect(trace.steps[964]).toMatchObject({
    cpu_read: { value: null, known_bits: { mask: 192, value: 0 } },
  });
  const snapshot = trace.steps[481]!;
  const continued = await both(
    cli,
    client,
    {
      ...input,
      initial: snapshot.state,
      initial_irq: snapshot.irq,
      events: events.slice(482),
    },
    validate,
  );
  expect(continued.trace.final).toEqual(trace.final);
  expect(continued.trace.final_irq).toEqual(trace.final_irq);
}

async function ambiguous(
  cli: TestCli,
  client: Client,
  path: string,
  validate: (v: unknown) => boolean,
) {
  const input = {
    path,
    initial,
    initial_irq: {
      ...clean,
      in_frame: true,
      counter: 9,
      enabled: true,
      pending: true,
      asserted: true,
    },
    events: [
      { kind: "cpu-read", address: 0x200a },
      { kind: "cpu-read", address: 0xfffc },
      {
        kind: "cpu-read",
        address: 0x2002,
        ppu_status: { mask: 128, value: 0 },
      },
      { kind: "cpu-write", address: 0x4014, value: 3 },
      {
        kind: "cpu-read",
        address: 0x2002,
        ppu_status: { mask: 128, value: 128 },
      },
      { kind: "cpu-read", address: 0x5204 },
    ],
  };
  const { trace } = await both(cli, client, input, validate);
  for (const s of trace.steps.slice(0, 3))
    expect(s.irq).toMatchObject({
      counter: 9,
      in_frame: true,
      pending: true,
      asserted: true,
    });
  expect(trace.steps[3]!.irq).toMatchObject({
    counter: { mask: 246, value: 0 },
    in_frame: null,
    pending: null,
    asserted: null,
  });
  expect(trace.steps[4]!.irq).toMatchObject({
    counter: 0,
    in_frame: false,
    pending: false,
    asserted: false,
  });
  expect(trace.steps[2]).toMatchObject({
    cpu_read: {
      value: null,
      known_bits: { mask: 128, value: 0 },
      source: {
        kind: "mmc5-ppu-status-snoop",
        supplied_byte: { mask: 128, value: 0 },
      },
    },
  });
  expect(trace.steps[4]).toMatchObject({
    cpu_read: {
      value: null,
      known_bits: { mask: 128, value: 128 },
      source: {
        kind: "mmc5-ppu-status-snoop",
        supplied_byte: { mask: 128, value: 128 },
      },
    },
  });
  expect(trace.steps[5]).toMatchObject({
    cpu_read: { known_bits: { mask: 192, value: 0 } },
  });
}

async function resetMappings(
  cli: TestCli,
  client: Client,
  root: string,
  validate: (v: unknown) => boolean,
) {
  const f = mmc5Fixture(9),
    path = join(root, "reset.nes");
  await writeFile(path, f.bytes);
  const banks = Array.from({ length: 12 }, () => 5),
    upper = Array.from({ length: 12 }, () => 1),
    modes = Array.from({ length: 12 }, () => 3);
  const input = {
    path,
    initial: {
      ...initial,
      prg_mode: 0,
      ram_wiring: "ewrom",
      ram_protect: [2, 1],
      chr_mode: 3,
      chr_banks: banks,
      chr_bank_upper: upper,
      chr_bank_modes: modes,
      chr_upper: 2,
      nametable_control: 170,
      exram: { "0": 106 },
      split: [255, 127, 11],
    },
    initial_irq: {
      ...clean,
      in_frame: true,
      counter: 9,
      pending: true,
      enabled: true,
      asserted: true,
    },
    events: [
      { kind: "ppu-read", address: 0x2000, mmc5_fetch: "ppudata" },
      { kind: "mmc5-reset" },
      { kind: "ppu-read", address: 0x2000, mmc5_fetch: "ppudata" },
      { kind: "cpu-read", address: 0x5c00 },
      cpuWrite(0x5c00, 0),
      cpuWrite(0x5104, 3),
      { kind: "cpu-read", address: 0x5c00 },
    ],
  };
  const { trace, evidence } = await both(cli, client, input, validate);
  expect(trace.initial_mapping.prg_windows.map((w) => w.bank)).toEqual([
    4, 5, 6, 7,
  ]);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    0, 1, 2, 7,
  ]);
  if (
    !("cpu_windows" in trace.initial_mapping) ||
    !("cpu_windows" in trace.final_mapping)
  )
    throw new Error("Expected MMC5 CPU windows");
  expect(trace.initial_mapping.cpu_windows[0]!.writable).toBe(true);
  expect(trace.final_mapping.cpu_windows[0]!.writable).toBe(false);
  expect(trace.steps[0]!.read_source).toMatchObject({
    status: "exram",
    value: 106,
  });
  expect(trace.steps[2]!.read_source).toMatchObject({
    status: "constant-zero",
    value: 0,
  });
  expect(trace.steps[3]).toMatchObject({
    cpu_read: {
      value: null,
      source: {
        access: "unknown",
        cell_value: 106,
        written_since_reset: false,
      },
    },
  });
  expect(trace.steps[4]!.write_effect).toBe("exram-write-ignored");
  expect(trace.steps[6]).toMatchObject({
    cpu_read: { value: 106, source: { written_since_reset: true } },
  });
  expect(trace.final).toMatchObject({
    prg_mode: { mask: 3, value: 3 },
    chr_banks: banks,
    chr_bank_upper: upper,
    chr_bank_modes: modes,
    chr_upper: { mask: 3, value: 0 },
    split: [{ mask: 223, value: 0 }, 0, 11],
    exram: { "0": 106 },
  });
  expect(trace.final_irq).toMatchObject({
    counter: 9,
    in_frame: true,
    pending: true,
    enabled: false,
    asserted: false,
  });
  expect(evidence.subject?.digest?.sha256).toBe(
    createHash("sha256").update(f.bytes).digest("hex"),
  );
  expect(await readFile(path)).toEqual(f.bytes);
}

cliTest(
  "derives MMC5 delayed scanline/idle signals, status acknowledgement and frame-qualified ExRAM through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc5-irq-");
    const f = mmc5Fixture(0),
      path = join(root, "irq.nes");
    await writeFile(path, f.bytes);
    const client = await connectTestMcp("mmc5-irq");
    const tool = (await client.listTools()).tools.find(
      (t) => t.name === "trace_nes_mapper_events",
    )!;
    const ajv = new Ajv2020({ strict: false });
    const inputSchema: Record<string, unknown> = tool.inputSchema,
      outputSchema: Record<string, unknown> = tool.outputSchema!;
    const input = ajv.compile(inputSchema),
      output = ajv.compile(outputSchema);
    const evidence = await signals(cli, client, path, output);
    expect(evidence.subject?.digest?.sha256).toBe(
      createHash("sha256").update(f.bytes).digest("hex"),
    );
    await capacity(cli, client, path, output);
    await ambiguous(cli, client, path, output);
    await resetMappings(cli, client, root, output);
    for (const invalid of [
      { initial_irq: { model: "mmc5", pending: false, asserted: true } },
      {
        initial_irq: {
          model: "mmc5",
          pending: true,
          enabled: true,
          asserted: false,
        },
      },
      { initial_irq: { model: "mmc5", matching_reads: [] } },
      { initial_irq: { model: "mmc5", idle_cycles: [4] } },
      { events: [{ kind: "cpu-read", address: 0x200a, ppu_status: 128 }] },
    ]) {
      const request = {
        path,
        initial,
        initial_irq: { model: "mmc5" },
        events: [],
        ...invalid,
      };
      expect(input(request)).toBe(false);
      expect(
        (await client.callTool({ name: tool.name, arguments: request }))
          .isError,
      ).toBe(true);
    }
    for (const request of [
      { path, initial, events: [{ kind: "mmc5-cpu-cycle" }] },
      {
        path,
        initial,
        initial_irq: { model: "mmc5" },
        events: [{ kind: "mmc3-irq-clock" }],
      },
      {
        path,
        initial,
        events: [{ kind: "cpu-read", address: 0x2002, ppu_status: 128 }],
      },
    ]) {
      const result = await client.callTool({
        name: tool.name,
        arguments: request,
      });
      expect(result.isError).not.toBe(true);
      expect(
        toolContract("trace_nes_mapper_events").outputSchema.parse(
          result.structuredContent,
        ).normalized_result.trace.status,
      ).toBe("unsupported");
    }
    expect(await readFile(path)).toEqual(f.bytes);
  },
  180_000,
);
