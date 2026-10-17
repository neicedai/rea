import {
  mcpContractsFor,
  connectTestMcp,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
  traceNesThroughAdapters,
} from "../../support/nesSourceDelivery.js";
import { nesMapperEventSnapshot } from "../../../src/domain/nesMapperEvents.js";

import type { Client } from "@modelcontextprotocol/client";

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { fme7Fixture } from "../../../src/domain/nesFme7.fixture.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

function sources(trace: NesCodePath, bytes: Buffer) {
  expect(trace.stop.reason).toBe("return");
  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.instructions.find((i) => i.address === 0x7fff)).toMatchObject({
    bytes_hex: "a95a",
    file_offsets: [528 + 4 * 8192 - 1, 528 + 8192],
  });
  expect(trace.instructions.find((i) => i.address === 0xbfff)).toMatchObject({
    bytes_hex: "a933",
    file_offsets: [528 + 5 * 8192 - 1, 528 + 2 * 8192],
  });
  for (const instruction of trace.instructions)
    for (const [index, offset] of instruction.file_offsets.entries()) {
      const value = Buffer.from(instruction.bytes_hex, "hex")[index];
      if (offset !== null) expect(bytes[offset]).toBe(value);
      else {
        const origin = instruction.ram_origins.find(
          (o) => o.byte_index === index,
        )!;
        expect(origin).toMatchObject({
          region: "prg-ram",
          bank: 0,
          ram_address: instruction.address + index,
        });
        if (!("instruction_index" in origin))
          throw new Error("Expected RAM writer");
        expect(
          trace.instructions[origin.instruction_index]?.writes[
            origin.write_index
          ],
        ).toMatchObject({ address: instruction.address + index, value });
      }
    }
  expect(
    trace.instructions
      .flatMap((i) => i.data_reads)
      .filter((r) => r.address === 0x6500)
      .map((r) => r.value),
  ).toEqual([0x44, 0x44]);
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  if ("mapper_snapshots" in trace.mapper_trace)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  expect(
    trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
  ).toEqual([3, 1, 4, 2, 7]);
  expect(trace.mapper_trace.final_mapping).toMatchObject({
    lower_window: { source: "rom", bank: 3, file_offset: 528 + 3 * 8192 },
  });
}
async function irq(
  client: Client,
  cli: TestCli,
  path: string,
  variant: string,
) {
  const command = (n: number, value: number) => [
    { kind: "cpu-write", address: 0x9fff, value: n },
    { kind: "cpu-write", address: 0xbfff, value },
  ];
  const input = {
    path,
    initial: { mapper: 69, variant },
    initial_irq: { model: "fme7" },
    events: [
      ...command(14, 1),
      ...command(15, 0),
      ...command(13, 0x81),
      { kind: "ppu-read", address: 0 },
      { kind: "fme7-cpu-cycle" },
      { kind: "fme7-cpu-cycle" },
      ...command(13, 0x80),
      { kind: "fme7-cpu-cycle" },
    ],
  };
  const trace = toolContract("trace_nes_mapper_events").outputSchema.parse(
    await (
      await createToolDelivery(client, cli)
    ).invoke("trace-nes-mapper-events", input),
  ).normalized_result.trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(nesMapperEventSnapshot(trace, trace.steps[6]!)?.irq).toMatchObject({
    counter_low: 1,
    counter_high: 0,
    asserted: false,
  });
  expect(nesMapperEventSnapshot(trace, trace.steps[8]!)?.irq).toMatchObject({
    counter_low: 255,
    counter_high: 255,
    asserted: true,
  });
  expect(trace.final_irq).toMatchObject({
    counter_low: 254,
    counter_high: 255,
    asserted: false,
  });
  const resumed = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial: trace.final,
      initial_irq: trace.final_irq,
      events: [{ kind: "fme7-cpu-cycle" }],
    },
  });
  expect(resumed.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_mapper_events").outputSchema.parse(
      resumed.structuredContent,
    ).normalized_result.trace,
  ).toMatchObject({
    final_irq: { counter_low: 253, counter_high: 255, asserted: false },
  });
}

async function mixed(
  client: Client,
  root: string,
  validate: (v: unknown) => boolean,
) {
  const { bytes } = fme7Fixture("fme7", 13),
    path = join(root, "mixed.nes"),
    code = [0xa9, 0x77, 0x60];
  bytes.set(code, 528);
  await writeFile(path, bytes);
  const input = {
    path,
    entry: 0x6000,
    initial: {
      mapper: 69,
      variant: "fme7",
      prg_ram_enable: "ungated",
      bank_6000: { mask: 191, value: 128 },
    },
    initial_prg_ram: code.map((value, i) => ({
      bank: 0,
      address: 0x6000 + i,
      value,
    })),
  };
  const result = await client.callTool({
    name: "trace_nes_code",
    arguments: input,
  });
  expect(result.isError).not.toBe(true);
  expect(validate(result.structuredContent)).toBe(true);
  const trace = toolContract("trace_nes_code").outputSchema.parse(
    result.structuredContent,
  ).normalized_result.code_trace;
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.instructions[0]?.mapper_origins).toEqual(
    code.slice(0, 2).map((value, i) => ({
      byte_index: i,
      kind: "fme7-window",
      variant: "fme7",
      bank_control: { mask: 191, value: 128 },
      source_candidates: [
        { kind: "rom", file_offset: 528 + i, value },
        {
          kind: "ram",
          bank: 0,
          ram_address: 0x6000 + i,
          value,
          source: { kind: "initial-prg-ram", index: i },
        },
      ],
    })),
  );
  const ram = await client.callTool({
    name: "trace_nes_code",
    arguments: {
      ...input,
      initial: { ...input.initial, bank_6000: { mask: 64, value: 64 } },
      initial_prg_ram: Array.from({ length: 64 }, (_, bank) => ({
        bank,
        address: 0x6000,
        value: 0x60,
      })),
    },
  });
  expect(ram.isError).not.toBe(true);
  expect(validate(ram.structuredContent)).toBe(true);
  expect(
    toolContract("trace_nes_code").outputSchema.parse(ram.structuredContent)
      .normalized_result.code_trace,
  ).toMatchObject({
    stop: {
      reason: "return",
      ram_origins: Array.from({ length: 64 }, (_, bank) => ({
        byte_index: 0,
        region: "prg-ram",
        bank,
        ram_address: 0x6000,
        initial_prg_ram_index: bank,
      })),
    },
  });
}

cliTest(
  "traces Sunsoft ROM/RAM sources, five windows, all physical RAM origins and explicit IRQs through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-fme7-");
    const client = await connectTestMcp("fme7");

    const contract = await mcpContractsFor(client);
    const inputSchema = contract("trace_nes_code").input,
      outputSchema = contract("trace_nes_code").output,
      eventsSchema = contract("trace_nes_mapper_events").output,
      viewsSchema = contract("open_binary").input;
    for (const variant of ["fme7", "5a", "5b"] as const)
      for (const storage of [7, 0x70]) {
        const { bytes, initial, cpu, chr } = fme7Fixture(variant, storage),
          path = join(root, `${variant}-${storage}.nes`),
          input = { path, initial, cpu };
        await writeFile(path, bytes);
        expect(inputSchema(input)).toBe(true);
        const evidence = await traceNesThroughAdapters(cli, client, input),
          trace = evidence.normalized_result.code_trace;
        expect(evidence.subject?.digest?.sha256).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        if (
          trace.status !== "derived" ||
          trace.mapper_trace.status !== "derived"
        )
          throw new Error(JSON.stringify(trace));
        sources(trace, bytes);
        expect(
          viewsSchema({
            path,
            nes_prg_views: trace.mapper_trace.nes_prg_views,
          }),
        ).toBe(true);
        const writes = trace.instructions.flatMap((i) => i.writes);
        const replay = await replayNesThroughMcp(client, {
          path,
          initial,
          writes,
        });

        expect(replay.normalized_result.trace).toMatchObject({
          final: trace.mapper_trace.final,
          final_mapping: trace.mapper_trace.final_mapping,
          nes_prg_views: trace.mapper_trace.nes_prg_views,
        });
        const ppu = await client.callTool({
          name: "trace_nes_mapper_events",
          arguments: {
            path,
            initial,
            events: [
              ...writes.map((w) => ({ ...w, kind: "cpu-write" })),
              ...chr.map((_, i) => ({
                kind: "ppu-read",
                address: i * 1024 + 1023,
              })),
            ],
          },
        });
        expect(ppu.isError).not.toBe(true);
        expect(eventsSchema(ppu.structuredContent)).toBe(true);
        const events = toolContract(
          "trace_nes_mapper_events",
        ).outputSchema.parse(ppu.structuredContent).normalized_result.trace;
        if (events.status !== "derived") throw new Error(events.reason);
        expect(
          events.steps.slice(writes.length).map((s) => s.read_source),
        ).toEqual(
          chr.map((bank) => ({
            status: "chr-rom",
            bank,
            file_offset: 528 + 65536 + bank * 1024 + 1023,
          })),
        );
        const explored = await exploreNesThroughMcp(client, input);

        expect(explored.normalized_result.code_exploration).toMatchObject({
          paths: [{ trace }],
        });
        if (storage === 7) await irq(client, cli, path, variant);
        expect(await readFile(path)).toEqual(bytes);
      }
    await mixed(client, root, outputSchema);
    for (const initial of [
      { mapper: 69 },
      { mapper: 69, variant: "5b", audio_registers: [1] },
      { mapper: 69, variant: "fme7", command: { mask: 1, value: 2 } },
    ]) {
      const input = { path: join(root, "invalid.nes"), initial };
      expect(inputSchema(input)).toBe(false);
      expect(
        (await client.callTool({ name: "trace_nes_code", arguments: input }))
          .isError,
      ).toBe(true);
    }
  },
  240000,
);
