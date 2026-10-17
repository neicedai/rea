import {
  connectTestMcp,
  mcpContractsFor,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import type { Client } from "@modelcontextprotocol/client";

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { mmc5Fixture } from "../../../src/domain/nesMmc5.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

function fixture(chrSize = 1048576) {
  const source = mmc5Fixture(0),
    bytes = Buffer.alloc(source.prgOffset + source.prgSize + chrSize);
  source.bytes.copy(bytes);
  bytes[5] = chrSize / 8192;
  const chrOffset = source.prgOffset + source.prgSize;
  for (let i = chrOffset; i < bytes.length; i++)
    bytes[i] = ((i - chrOffset) >> 10) ^ ((i - chrOffset) & 255);
  const writes = [
    [0x5101, 3],
    [0x5130, 1],
    [0x5120, 5],
    [0x5128, 9],
    [0x5130, 2],
    [0x2008, 0],
    [0x2000, 32],
    [0x2009, 0],
    [0x2001, 24],
    [0x5c00, 42],
    [0x5104, 0],
    [0x5105, 170],
  ];
  const code = [
    ...writes.flatMap(([address, value]) => [
      0xa9,
      value!,
      0x8d,
      address! & 255,
      address! >> 8,
    ]),
    0x60,
  ];
  bytes.set(code, source.prgOffset + 3 * 8192);
  bytes.writeUInt16LE(0xe000, source.prgOffset + source.prgSize - 4);
  return { bytes, chrOffset, writes };
}
async function both(
  cli: TestCli,
  client: Client,
  input: Record<string, unknown>,
) {
  const contract = toolContract("trace_nes_mapper_events");
  const b = toolContract("trace_nes_mapper_events").outputSchema.parse(
    await (
      await createToolDelivery(client, cli)
    ).invoke("trace-nes-mapper-events", input),
  );
  const trace = b.normalized_result.trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  return { trace, evidence: b };
}

const ppuEvents = () => [
  { kind: "ppu-read", address: 0x0011, mmc5_fetch: "sprite" },
  { kind: "ppu-read", address: 0x1011, mmc5_fetch: "background" },
  { kind: "ppu-read", address: 0x0011, mmc5_fetch: "ppudata" },
  { kind: "ppu-read", address: 0x0011 },
  { kind: "ppu-read", address: 0x2000, mmc5_fetch: "ppudata" },
  { kind: "ppu-write", address: 0x2400, value: 167 },
  { kind: "ppu-read", address: 0x3000, mmc5_fetch: "ppudata" },
  { kind: "cpu-write", address: 0x5105, value: 255 },
  { kind: "cpu-write", address: 0x5106, value: 39 },
  {
    kind: "cpu-write",
    address: 0x5107,
    value: null,
    known_bits: { mask: 1, value: 1 },
  },
  { kind: "ppu-read", address: 0x2fbf, mmc5_fetch: "ppudata" },
  { kind: "ppu-read", address: 0x2fc0, mmc5_fetch: "ppudata" },
  { kind: "cpu-write", address: 0x5104, value: 3 },
  { kind: "cpu-write", address: 0x5105, value: 170 },
  { kind: "ppu-write", address: 0x2000, value: 0 },
  { kind: "ppu-read", address: 0x2000, mmc5_fetch: "ppudata" },
  { kind: "cpu-read", address: 0x5c00 },
];

cliTest(
  "analyzes MMC5 CHR latches and PPU ExRAM/fill sources through actual CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc5-ppu-");

    const client = await connectTestMcp("mmc5-ppu");

    const { input: validateInput } = (await mcpContractsFor(client))(
      "trace_nes_mapper_events",
    );
    const f = fixture(),
      path = join(root, "ppu.nes");
    await writeFile(path, f.bytes);
    const initial = {
      mapper: 5,
      prg_mode: 3,
      prg_banks: [0, 128, 129, 130, 3],
      ram_wiring: "none",
      exram_mode: 2,
      split: [0, null, null],
    };
    const code = await client.callTool({
      name: "trace_nes_code",
      arguments: { path, initial, entry: 0xe000 },
    });
    expect(code.isError).not.toBe(true);
    const trace = toolContract("trace_nes_code").outputSchema.parse(
      code.structuredContent,
    ).normalized_result.code_trace;
    if (trace.status !== "derived" || trace.mapper_trace.status !== "derived")
      throw new Error("Expected derived code and mapper writes");
    expect(trace.stop.reason).toBe("return");
    expect(trace.mapper_trace.final).toMatchObject({
      ppu_control: 32,
      ppu_mask: 24,
    });
    expect(
      trace.mapper_trace.steps.some(
        (s) => "write" in s && s.write.address === 0x2000,
      ),
    ).toBe(true);
    expect(
      trace.mapper_trace.steps.some(
        (s) => "write" in s && s.write.address === 0x2008,
      ),
    ).toBe(false);
    if (trace.mapper_trace.final.mapper !== 5)
      throw new Error("Expected MMC5 state");
    expect([
      trace.mapper_trace.final.chr_bank_modes[0],
      trace.mapper_trace.final.chr_bank_modes[8],
    ]).toEqual([3, 3]);
    expect([
      trace.mapper_trace.final.chr_bank_upper[0],
      trace.mapper_trace.final.chr_bank_upper[8],
    ]).toEqual([1, 1]);
    const prefix = trace.instructions
      .flatMap((i) => i.writes)
      .map((w) => ({ ...w, kind: "cpu-write" }));
    const tail = ppuEvents();
    const input = { path, initial, events: [...prefix, ...tail] };
    expect(validateInput(input)).toBe(true);
    const { trace: event, evidence } = await both(cli, client, input);
    const steps = event.steps.slice(prefix.length);
    verifyPatternBytes(steps, f);
    expect(steps[4]!.read_source).toMatchObject({
      status: "exram",
      value: 42,
      mmc5: { cell_address: 0, cell_value: 42 },
    });
    expect(steps[6]!.read_source).toMatchObject({
      status: "exram",
      value: 167,
    });
    expect(steps[10]!.read_source).toMatchObject({
      status: "fill-mode",
      value: 39,
    });
    expect(steps[11]!.read_source).toMatchObject({
      value: null,
      known_bits: { mask: 85, value: 85 },
    });
    expect(steps[14]!.write_effect).toBe("exram-write-ignored");
    expect(steps[15]!.read_source).toMatchObject({
      status: "constant-zero",
      value: 0,
    });
    expect(steps[16]).toMatchObject({ cpu_read: { value: 167 } });
    expect(evidence.subject?.digest?.sha256).toBe(
      createHash("sha256").update(f.bytes).digest("hex"),
    );
    expect(event.coverage).toMatchObject({
      unknown_pattern_reads: 1,
      unknown_nametable_reads: 0,
      unknown_cpu_reads: 0,
    });
    const resumed = await both(cli, client, {
      path,
      initial: trace.mapper_trace.final,
      events: tail,
    });
    expect(resumed.trace.final).toEqual(event.final);
    expect(resumed.trace.final_mapping).toEqual(event.final_mapping);
    await verifyModeChanges(cli, client, path);
    await verifyChrCandidates({
      cli,
      client,
      path,
      chrOffset: f.chrOffset,
    });
    await verifyInvalidInputs(client, validateInput, input);
    expect(await readFile(path)).toEqual(f.bytes);
  },
  120_000,
);

function verifyPatternBytes(
  steps: Awaited<ReturnType<typeof both>>["trace"]["steps"],
  f: ReturnType<typeof fixture>,
) {
  for (const [index, bank] of [
    [0, 261],
    [1, 265],
    [2, 265],
  ]) {
    const r = steps[index!]!.read_source!;
    expect(r).toMatchObject({
      status: "chr-rom",
      bank,
      file_offset: f.chrOffset + bank! * 1024 + 17,
      value: (bank! ^ 17) & 255,
      mmc5: {
        rom_sources: {
          status: "examined",
          file_offsets: [f.chrOffset + bank! * 1024 + 17],
        },
      },
    });
    expect(f.bytes[r.file_offset!]).toBe((bank! ^ 17) & 255);
  }
  expect(steps[3]!.read_source).toMatchObject({
    status: "unknown-chr-bank",
    file_offset: null,
    value: null,
    known_bits: { mask: 243, value: 16 },
    mmc5: {
      rom_sources: {
        status: "examined",
        file_offsets: [261, 265].map((bank) => f.chrOffset + bank * 1024 + 17),
      },
    },
  });
}

async function verifyModeChanges(cli: TestCli, client: Client, path: string) {
  const initial = { mapper: 5, ppu_control: 0, exram_mode: 2, chr_mode: 3 };
  const writes = [
    [0x5130, 1],
    [0x5127, 5],
    [0x5101, 0],
  ].map(([address, value]) => ({ kind: "cpu-write", address, value }));
  const input = {
    path,
    initial,
    events: [
      ...writes,
      { kind: "ppu-read", address: 0, mmc5_fetch: "ppudata" },
      { kind: "cpu-write", address: 0x5130, value: 0 },
      { kind: "cpu-write", address: 0x5127, value: 3 },
      { kind: "ppu-read", address: 0, mmc5_fetch: "ppudata" },
      { kind: "cpu-write", address: 0x5101, value: 3 },
      { kind: "ppu-read", address: 0x1c00, mmc5_fetch: "sprite" },
    ],
  };
  const { trace } = await both(cli, client, input);
  expect(trace.steps[3]!.read_source?.bank).toBe(256);
  expect(trace.steps[6]!.read_source?.bank).toBe(24);
  expect(trace.steps[8]!.read_source).toMatchObject({
    status: "unknown-chr-bank",
    file_offset: null,
  });
}

async function verifyChrCandidates({
  cli,
  client,
  path,
  chrOffset,
}: {
  cli: TestCli;
  client: Client;
  path: string;
  chrOffset: number;
}) {
  for (const allBanks of [false, true]) {
    const input = {
      path,
      initial: {
        mapper: 5,
        ppu_control: 0,
        exram_mode: 2,
        chr_mode: 3,
        chr_banks: [allBanks ? null : 5, ...Array(11).fill(null)],
        chr_bank_modes: [3, ...Array(11).fill(null)],
        chr_bank_upper: [
          allBanks ? null : { mask: 2, value: 0 },
          ...Array(11).fill(null),
        ],
      },
      events: [{ kind: "ppu-read", address: 0x11, mmc5_fetch: "sprite" }],
    };
    const { trace } = await both(cli, client, input);
    const source = trace.steps[0]!.read_source!;
    const banks = allBanks
      ? Array.from({ length: 1024 }, (_, bank) => bank)
      : [5, 261];
    expect(source).toMatchObject({
      status: "unknown-chr-bank",
      bank: null,
      file_offset: null,
      value: allBanks ? null : 20,
      mmc5: {
        rom_sources: {
          status: "examined",
          file_offsets: banks.map((bank) => chrOffset + bank * 1024 + 17),
        },
      },
    });
    expect("known_bits" in source).toBe(false);
    expect(trace.coverage.unknown_pattern_reads).toBe(1);
  }
}

async function verifyInvalidInputs(
  client: Client,
  validateInput: (value: unknown) => boolean,
  input: Record<string, unknown>,
) {
  for (const invalid of [
    { events: [{ kind: "ppu-read", address: 0, mmc5_fetch: "BG" }] },
    { events: [{ kind: "ppu-write", address: 16384, value: 0 }] },
    {
      events: [
        {
          kind: "ppu-write",
          address: 8192,
          value: null,
          known_bits: { mask: 3, value: 4 },
        },
      ],
    },
    { initial: { mapper: 5, chr_bank_modes: [0] } },
  ]) {
    expect(validateInput({ ...input, ...invalid })).toBe(false);
    expect(
      (
        await client.callTool({
          name: "trace_nes_mapper_events",
          arguments: { ...input, ...invalid },
        })
      ).isError,
    ).toBe(true);
  }
}
