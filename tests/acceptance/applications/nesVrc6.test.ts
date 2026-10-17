import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
  traceNesThroughAdapters,
} from "../../support/nesSourceDelivery.js";
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
import { vrc6Fixture } from "../../../src/domain/nesVrc6.fixture.js";
import { nesMapperEventSnapshot } from "../../../src/domain/nesMapperEvents.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

function sources(trace: NesCodePath, bytes: Buffer, seeded = false) {
  expect(trace.stop.reason).toBe("return");
  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.instructions.find((i) => i.address === 0xbfff)).toMatchObject({
    bytes_hex: "a95a",
    file_offsets: [528 + 6 * 8192 - 1, 528 + 4 * 8192],
  });
  for (const instruction of trace.instructions) {
    const code = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries()) {
      if (offset !== null) expect(bytes[offset]).toBe(code[index]);
      else {
        const origin = instruction.ram_origins.find(
          (o) => o.byte_index === index,
        )!;
        expect(origin).toMatchObject({
          region: "prg-ram",
          bank: 0,
          ram_address: instruction.address + index,
        });
        if (seeded)
          expect(origin).toMatchObject({
            initial_prg_ram_index: instruction.address + index - 0x6000,
          });
        else {
          expect(origin).toMatchObject({
            instruction_index: 29 + 2 * (instruction.address + index - 0x6000),
            write_index: 0,
          });
          if (!("instruction_index" in origin))
            throw new Error("Expected RAM writer");
          expect(
            trace.instructions[origin.instruction_index]?.writes[
              origin.write_index
            ],
          ).toMatchObject({
            address: instruction.address + index,
            value: code[index],
          });
        }
      }
    }
  }
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  if ("mapper_snapshots" in trace.mapper_trace)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  expect(
    trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
  ).toEqual([4, 5, 4, 7]);
  if (!seeded) {
    expect(trace.instructions[60]?.data_reads[0]).toMatchObject({
      address: 0x6700,
      value: 0x44,
      ram_origins: [
        { instruction_index: 27, write_index: 0, bank: 0, ram_address: 0x6700 },
      ],
    });
    expect(trace.instructions[61]?.writes.map((w) => w.value)).toEqual([
      0x44, 0x45,
    ]);
    expect(trace.mapper_trace.final).toMatchObject({
      audio_registers: [null, null, null, 7, null, null, 128, null, null, null],
    });
  }
}

async function ppu(
  client: Client,
  path: string,
  trace: NesCodePath,
  port: (base: number, p: number) => number,
  validateEvents: (value: unknown) => boolean,
) {
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  if ("mapper_snapshots" in trace.mapper_trace)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  const initial = trace.mapper_trace.initial,
    writes = trace.instructions.flatMap((i) => i.writes);
  const replay = await replayNesThroughMcp(client, { path, initial, writes });

  expect(replay.normalized_result.trace).toMatchObject({
    final: trace.mapper_trace.final,
    final_mapping: trace.mapper_trace.final_mapping,
    nes_prg_views: trace.mapper_trace.nes_prg_views,
  });
  const read = (address: number) => ({ kind: "ppu-read", address }),
    control = (value: number) => ({
      kind: "cpu-write",
      address: port(0xb000, 3),
      value,
    });
  const tail = [
    read(0x3ff),
    read(0x2401),
    control(0x31),
    read(0x2000),
    read(0x3000),
    read(0x3eff),
    read(0x3f00),
    control(0x30),
    read(0x2400),
    {
      kind: "cpu-write",
      address: port(0xb000, 3),
      value: null,
      known_bits: { mask: 35, value: 33 },
    },
    read(0x3ff),
    read(0x400),
    read(0x2000),
  ];
  const result = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial,
      events: [...writes.map((w) => ({ ...w, kind: "cpu-write" })), ...tail],
    },
  });
  expect(result.isError).not.toBe(true);
  expect(validateEvents(result.structuredContent)).toBe(true);
  const events = toolContract("trace_nes_mapper_events").outputSchema.parse(
    result.structuredContent,
  ).normalized_result.trace;
  if (events.status !== "derived") throw new Error(events.reason);
  if ("mapper_snapshots" in events)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  const steps = events.steps.slice(writes.length);
  expect(steps.map((s) => s.read_source)).toEqual([
    { status: "chr-rom", bank: 255, file_offset: 528 + 65536 + 262144 - 1 },
    { status: "ciram-unobserved", bank: 1, file_offset: null },
    null,
    { status: "chr-rom", bank: 9, file_offset: 528 + 65536 + 9 * 1024 },
    { status: "chr-rom", bank: 9, file_offset: 528 + 65536 + 9 * 1024 },
    { status: "chr-rom", bank: 15, file_offset: 528 + 65536 + 15 * 1024 + 767 },
    { status: "outside-pattern-tables", bank: null, file_offset: null },
    null,
    { status: "chr-rom", bank: 13, file_offset: 528 + 65536 + 13 * 1024 },
    null,
    {
      status: "chr-rom",
      bank: 254,
      file_offset: 528 + 65536 + 254 * 1024 + 1023,
    },
    { status: "chr-rom", bank: 255, file_offset: 528 + 65536 + 255 * 1024 },
    { status: "unknown-nametable-bank", bank: null, file_offset: null },
  ]);
  expect(events.coverage).toMatchObject({
    unknown_pattern_reads: 0,
    unknown_nametable_reads: 2,
  });
}

async function irq(
  client: Client,
  cli: TestCli,
  path: string,
  mapper: 24 | 26,
  port: (base: number, p: number) => number,
) {
  const input = {
    path,
    initial: { mapper },
    initial_irq: { model: "vrc6" },
    events: [
      { kind: "cpu-write", address: port(0xf000, 0), value: 254 },
      { kind: "cpu-write", address: port(0xf000, 1), value: 7 },
      { kind: "ppu-read", address: 0 },
      { kind: "vrc-cpu-cycle" },
      { kind: "vrc-cpu-cycle" },
      { kind: "cpu-write", address: port(0xf000, 2), value: 0 },
    ],
  };
  const trace = toolContract("trace_nes_mapper_events").outputSchema.parse(
    await (
      await createToolDelivery(client, cli)
    ).invoke("trace-nes-mapper-events", input),
  ).normalized_result.trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  if ("ppu_trace" in trace)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  expect(nesMapperEventSnapshot(trace, trace.steps[2]!)?.irq).toMatchObject({
    model: "vrc6",
    counter: 254,
    prescaler: [341],
    asserted: false,
  });
  expect(nesMapperEventSnapshot(trace, trace.steps[4]!)?.irq).toMatchObject({
    model: "vrc6",
    counter: 254,
    prescaler: null,
    asserted: true,
  });
  expect(trace.final_irq).toMatchObject({
    model: "vrc6",
    counter: 254,
    prescaler: null,
    asserted: false,
  });
  for (const initial_irq of [{ model: "vrc4" }, { model: "sharp" }]) {
    const rejected = await client.callTool({
      name: "trace_nes_mapper_events",
      arguments: { ...input, initial_irq },
    });
    expect(rejected.isError).not.toBe(true);
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(
        rejected.structuredContent,
      ).normalized_result.trace,
    ).toMatchObject({ status: "unsupported" });
  }
}

cliTest(
  "traces both VRC6 boards through RAM, noncontiguous PRG windows and CHR-ROM/CIRAM nametable transitions",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc6-");
    const client = await connectTestMcp("vrc6");
    const contract = await mcpContractsFor(client),
      validateEvents = contract("trace_nes_mapper_events").output,
      validateInput = contract("trace_nes_code").input,
      validateViews = contract("open_binary").input;
    for (const mapper of [24, 26] as const)
      for (const declaration of [7, 0x70]) {
        const { bytes, initial, routine, port } = vrc6Fixture(
            mapper,
            declaration,
          ),
          path = join(root, `vrc6-${mapper}-${declaration}.nes`);
        await writeFile(path, bytes);
        const input = { path, initial };
        expect(validateInput(input)).toBe(true);
        const evidence = await traceNesThroughAdapters(cli, client, input);
        expect(evidence.subject?.digest?.sha256).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        const trace = evidence.normalized_result.code_trace;
        if (
          trace.status !== "derived" ||
          trace.mapper_trace.status !== "derived"
        )
          throw new Error(JSON.stringify(trace));
        sources(trace, bytes);
        expect(
          validateViews({
            path,
            nes_prg_views: trace.mapper_trace.nes_prg_views,
          }),
        ).toBe(true);
        await ppu(client, path, trace, port, validateEvents);
        if (declaration === 7) await irq(client, cli, path, mapper, port);
        const explored = await exploreNesThroughMcp(client, input);

        expect(explored.normalized_result.code_exploration).toMatchObject({
          paths: [{ trace }],
        });
        const seed = {
          path,
          entry: 0x6000,
          initial: { mapper, control: { mask: 128, value: 128 } },
          initial_prg_ram: routine.map((value, index) => ({
            bank: 0,
            address: 0x6000 + index,
            value,
          })),
        };
        const seeded = await client.callTool({
          name: "trace_nes_code",
          arguments: seed,
        });
        expect(seeded.isError).not.toBe(true);
        const seededTrace = toolContract("trace_nes_code").outputSchema.parse(
          seeded.structuredContent,
        ).normalized_result.code_trace;
        if (seededTrace.status !== "derived")
          throw new Error(seededTrace.reason);

        sources(seededTrace, bytes, true);
        const resumed = await client.callTool({
          name: "trace_nes_code",
          arguments: {
            path,
            initial: trace.mapper_trace.final,
            entry: 0x8010,
          },
        });
        expect(resumed.isError).not.toBe(true);
        expect(
          toolContract("trace_nes_code").outputSchema.parse(
            resumed.structuredContent,
          ).normalized_result.code_trace,
        ).toMatchObject({
          final_cpu: { a: 0x77 },
          stop: { reason: "return" },
        });
        expect(await readFile(path)).toEqual(bytes);
      }
    for (const initial of [
      { mapper: 24, audio_registers: [0] },
      { mapper: 26, variant: "vrc4" },
      { mapper: 24, control: { mask: 1, value: 2 } },
    ]) {
      const input = { path: join(root, "invalid.nes"), initial };
      expect(validateInput(input)).toBe(false);
      expect(
        (await client.callTool({ name: "trace_nes_code", arguments: input }))
          .isError,
      ).toBe(true);
    }
  },
  180000,
);
