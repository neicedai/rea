import {
  connectTestMcp,
  mcpContractsFor,
} from "../../support/cliMcpDelivery.js";
import {
  exploreNesThroughMcp,
  traceNesThroughAdapters,
} from "../../support/nesSourceDelivery.js";
import type { Client } from "@modelcontextprotocol/client";

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { namco163RamFixture } from "../../../src/domain/nesNamco163Ram.fixture.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

function verifyPortTrace(
  trace: NesCodePath,
  fixture: ReturnType<typeof namco163RamFixture>,
) {
  if (
    trace.mapper_trace.status !== "derived" ||
    !("initial_irq" in trace.mapper_trace)
  )
    throw new Error("Expected ordered mapper event trace");
  expect(trace.stop.reason).toBe("return");
  expect(trace.final_cpu.a).toBe(0x77);
  const steps = trace.mapper_trace.steps,
    ram = [...fixture.initial.chip_ram.bytes];
  let pointer = 0,
    auto = true,
    eventIndex = 0;
  const advance = () => {
    if (auto)
      pointer =
        fixture.initial.chip_ram.increment_model === "wrap"
          ? (pointer + 1) & 127
          : Math.min(pointer + 1, 127);
  };
  for (const step of steps) {
    const event = step.event;
    if (event.kind === "cpu-write") {
      if ((event.address & 0xf800) === 0xf800) {
        pointer = event.value! & 127;
        auto = (event.value! & 128) !== 0;
      } else if ((event.address & 0xf800) === 0x4800) {
        ram[pointer] = event.value;
        advance();
      }
    } else if (event.kind === "cpu-read") {
      expect(event.address).not.toBeNull();
      if (!("cpu_read" in step)) throw new Error("Missing port read evidence");
      expect(step.cpu_read).toMatchObject({
        value: ram[pointer],
        source: {
          kind: "namco163-chip-ram",
          address_port: (auto ? 128 : 0) | pointer,
          cells: [{ address: pointer, value: ram[pointer] }],
        },
      });
      advance();
    }
  }
  expect(trace.mapper_trace.final).toMatchObject({
    ram_control: 0x91,
    chip_ram: { address_port: 0x93, bytes: ram },
    prg_banks: [0x42, 1, 2],
  });
  for (const instruction of trace.instructions) {
    if (!("mapper_event_range" in instruction))
      throw new Error("Missing instruction event range");
    expect(instruction.mapper_event_range.start).toBe(eventIndex);
    eventIndex += instruction.mapper_event_range.count;
    expect(eventIndex).toBeLessThanOrEqual(steps.length);
    for (const [i, offset] of instruction.file_offsets.entries()) {
      expect(offset).not.toBeNull();
      expect(fixture.bytes[offset!]).toBe(
        Buffer.from(instruction.bytes_hex, "hex")[i],
      );
    }
    for (const read of instruction.data_reads)
      for (const origin of read.mapper_origins) {
        if (origin.kind !== "namco163-chip-ram")
          throw new Error("Unexpected device");
        expect(read.file_offset).toBeNull();
        expect(read.ram_origins).toEqual([]);
        for (const cell of origin.cells) {
          if (cell.source.kind === "initial-chip-ram")
            expect(fixture.initial.chip_ram.bytes[cell.source.index]).toEqual(
              cell.value,
            );
          else {
            expect(cell.source.instruction_index).toBeLessThan(
              instruction.index,
            );
            expect(
              trace.instructions[cell.source.instruction_index]!.writes[
                cell.source.write_index
              ],
            ).toMatchObject({ value: cell.value });
          }
        }
      }
  }
  expect(eventIndex).toBe(steps.length);
  const indexed = trace.instructions.find(
    (i) => i.mnemonic === "LDA" && i.addressing_mode === "abx",
  )!;
  if (!("mapper_event_range" in indexed))
    throw new Error("Missing indexed read range");
  expect(
    steps
      .slice(
        indexed.mapper_event_range.start,
        indexed.mapper_event_range.start + indexed.mapper_event_range.count,
      )
      .map((s) => s.event),
  ).toEqual([
    { kind: "cpu-read", address: 0x4800 },
    { kind: "cpu-read", address: 0x4900 },
  ]);
  expect(indexed.data_reads).toMatchObject([{ address: 0x4900, value: 0x88 }]);
  const rmw = trace.instructions.find((i) => i.mnemonic === "INC")!;
  if (!("mapper_event_range" in rmw)) throw new Error("Missing RMW range");
  expect(
    steps
      .slice(
        rmw.mapper_event_range.start,
        rmw.mapper_event_range.start + rmw.mapper_event_range.count,
      )
      .map((s) => s.event),
  ).toEqual([
    { kind: "cpu-read", address: 0x4800 },
    {
      kind: "cpu-write",
      address: 0x4800,
      value: 0x44,
      preceded_by_cpu_write: false,
    },
    {
      kind: "cpu-write",
      address: 0x4800,
      value: 0x45,
      preceded_by_cpu_write: true,
    },
  ]);
  return steps.map((s) => s.event);
}

async function verifyCommonBytes(
  client: Client,
  path: string,
  fixture: ReturnType<typeof namco163RamFixture>,
  validateOutput: (v: unknown) => boolean,
) {
  const contract = toolContract("trace_nes_code");
  const input = {
    path,
    initial: {
      ...fixture.initial,
      chip_ram: {
        ...fixture.initial.chip_ram,
        dma_reads: "unobserved",
        bytes: Array(128).fill(0xa5),
      },
    },
    max_instructions: 1,
  };
  const response = await client.callTool({
    name: contract.name,
    arguments: input,
  });
  expect(response.isError).not.toBe(true);
  expect(validateOutput(response.structuredContent)).toBe(true);
  const trace = contract.outputSchema.parse(response.structuredContent)
    .normalized_result.code_trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_cpu.a).toBe(0xa5);
  const origin = trace.instructions[0]!.data_reads[0]!.mapper_origins[0]!;
  if (origin.kind !== "namco163-chip-ram")
    throw new Error("Expected chip-RAM proof");
  expect(origin.cells).toEqual(
    Array.from({ length: 128 }, (_, address) => ({
      address,
      value: 0xa5,
      source: { kind: "initial-chip-ram", index: address },
    })),
  );
  const unknown = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial: {
        ...fixture.initial,
        chip_ram: {
          ...fixture.initial.chip_ram,
          address_port: 128,
          dma_reads: "absent",
        },
      },
      events: [{ kind: "cpu-read", address: null }],
    },
  });
  expect(unknown.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_mapper_events").outputSchema.parse(
      unknown.structuredContent,
    ).normalized_result.trace,
  ).toMatchObject({
    status: "derived",
    steps: [{ cpu_read: { address: null, value: null, source: null } }],
    final: { chip_ram: { address_port: { mask: 254, value: 128 } } },
    coverage: { unknown_cpu_reads: 1 },
  });
  for (const address_port of [121, 65]) {
    const phase = await client.callTool({
      name: "trace_nes_mapper_events",
      arguments: {
        path,
        initial: {
          ...input.initial,
          prg_banks: [0, 1, 2],
          chip_ram: { ...input.initial.chip_ram, address_port },
        },
        events: [{ kind: "cpu-read", address: 0x4800 }],
      },
    });
    expect(phase.isError).not.toBe(true);
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(
        phase.structuredContent,
      ).normalized_result.trace,
    ).toMatchObject({
      status: "derived",
      steps: [{ cpu_read: { value: address_port === 121 ? null : 0xa5 } }],
      coverage: { unknown_cpu_reads: address_port === 121 ? 1 : 0 },
    });
  }
}

async function verifyDmaEvents(
  client: Client,
  path: string,
  fixture: ReturnType<typeof namco163RamFixture>,
) {
  const dma = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial: {
        ...fixture.initial,
        chip_ram: { ...fixture.initial.chip_ram, address_port: 128 },
      },
      events: [
        { kind: "cpu-write", address: 0x4014, value: 0x48 },
        { kind: "cpu-read", address: 0x4800 },
      ],
    },
  });
  expect(dma.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_mapper_events").outputSchema.parse(
      dma.structuredContent,
    ).normalized_result.trace,
  ).toMatchObject({
    status: "derived",
    steps: [
      { write_effect: "oam-dma-request" },
      {
        cpu_read: {
          value:
            fixture.initial.chip_ram.increment_model === "wrap" ? 0x11 : 0xa7,
        },
      },
    ],
    final: {
      chip_ram: {
        address_port:
          fixture.initial.chip_ram.increment_model === "wrap" ? 129 : 255,
      },
    },
  });
  const overwritten = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial: fixture.initial,
      events: [
        { kind: "cpu-write", address: 0x4014, value: 0x48 },
        {
          kind: "cpu-write",
          address: 0x4014,
          value: 0,
          preceded_by_cpu_write: true,
        },
        { kind: "cpu-read", address: 0x4800 },
      ],
    },
  });
  expect(overwritten.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_mapper_events").outputSchema.parse(
      overwritten.structuredContent,
    ).normalized_result.trace,
  ).toMatchObject({
    status: "derived",
    steps: [
      { state: { chip_ram: { address_port: 128, oam_dma_pending: 72 } } },
      { state: { chip_ram: { address_port: 128, oam_dma_pending: 0 } } },
      { cpu_read: { value: 0x11 } },
    ],
    final: { chip_ram: { address_port: 129, oam_dma_pending: "none" } },
  });
}

cliTest(
  "preserves Namco chip RAM read effects, NMOS bus reads, byte origins and replay through public CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-n163-chip-");

    const contract = toolContract("trace_nes_code");
    const client = await connectTestMcp("namco163-chip");

    const { input: validateInput, output: validateOutput } = (
      await mcpContractsFor(client)
    )("trace_nes_code");
    for (const model of ["saturate", "wrap"] as const) {
      const fixture = namco163RamFixture(model),
        path = join(root, `chip-${model}.nes`);
      await writeFile(path, fixture.bytes);
      const input = {
        path,
        initial: fixture.initial,
        initial_ram: fixture.initial_ram,
      };
      expect(validateInput(input)).toBe(true);
      const evidence = await traceNesThroughAdapters(cli, client, input);
      expect(evidence.subject?.digest?.sha256).toBe(
        createHash("sha256").update(fixture.bytes).digest("hex"),
      );
      const trace = evidence.normalized_result.code_trace;
      if (trace.status !== "derived") throw new Error(trace.reason);
      const events = verifyPortTrace(trace, fixture);
      const replay = await client.callTool({
        name: "trace_nes_mapper_events",
        arguments: { path, initial: fixture.initial, events },
      });
      expect(replay.isError).not.toBe(true);
      expect(
        toolContract("trace_nes_mapper_events").outputSchema.parse(
          replay.structuredContent,
        ).normalized_result.trace,
      ).toEqual(trace.mapper_trace);
      const explored = await exploreNesThroughMcp(client, input);

      expect(explored.normalized_result.code_exploration).toMatchObject({
        paths: [{ trace }],
      });
      const stopped = await client.callTool({
        name: contract.name,
        arguments: {
          ...input,
          entry: fixture.bytes.readUInt16LE(
            fixture.prgOffset + fixture.prgSize - 4,
          ),
          initial: {
            ...fixture.initial,
            chip_ram: {
              ...fixture.initial.chip_ram,
              dma_reads: "unobserved",
            },
          },
          max_instructions: 1,
        },
      });
      expect(stopped.isError).not.toBe(true);
      expect(
        contract.outputSchema.parse(stopped.structuredContent).normalized_result
          .code_trace,
      ).toMatchObject({
        status: "derived",
        final_cpu: { a: null },
        mapper_trace: {
          final: { chip_ram: { address_port: { mask: 128, value: 128 } } },
        },
      });
      expect(await readFile(path)).toEqual(fixture.bytes);
      await verifyDmaEvents(client, path, fixture);
      if (model === "wrap")
        await verifyCommonBytes(client, path, fixture, validateOutput);
    }
    for (const bad of [
      { increment_model: "invented" },
      { bytes: Array(127).fill(null) },
      { address_port: { mask: 1, value: 2 } },
    ]) {
      const fixture = namco163RamFixture("saturate"),
        input = {
          path: join(root, "invalid.nes"),
          initial: {
            ...fixture.initial,
            chip_ram: { ...fixture.initial.chip_ram, ...bad },
          },
        };
      expect(validateInput(input)).toBe(false);
      expect(
        (await client.callTool({ name: contract.name, arguments: input }))
          .isError,
      ).toBe(true);
    }
  },
  120_000,
);
