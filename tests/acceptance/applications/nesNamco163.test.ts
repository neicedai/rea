import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
} from "../../support/nesSourceDelivery.js";
import {
  createStdioToolClient,
  createToolDelivery,
  mcpContractsFor,
} from "../../support/cliMcpDelivery.js";
import { nesMapperEventSnapshot } from "../../../src/domain/nesMapperEvents.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { namco163Fixture } from "../../../src/domain/nesNamco163.fixture.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

function verifyCode(
  trace: NesCodePath,
  fixture: ReturnType<typeof namco163Fixture>,
) {
  expect(trace.stop.reason).toBe("return");
  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.instructions.find((i) => i.address === 0x9fff)).toMatchObject({
    bytes_hex: "a95a",
    file_offsets: [528 + 3 * 8192 - 1, 528 + 5 * 8192],
  });
  expect(trace.instructions.find((i) => i.address === 0xbfff)).toMatchObject({
    bytes_hex: "a933",
    file_offsets: [528 + 6 * 8192 - 1, 528 + 3 * 8192],
  });
  expect(trace.instructions.find((i) => i.address === 0xa010)).toMatchObject({
    bytes_hex: "a977",
    file_offsets: [528 + 6 * 8192 + 16, 528 + 6 * 8192 + 17],
  });
  const reads = trace.instructions
    .flatMap((i) => i.data_reads)
    .filter((r) => fixture.addresses.includes(r.address!));
  expect(reads.map((r) => r.value)).toEqual([0xa0, 0xa1, 0xb2, 0xa3]);
  expect(
    trace.instructions
      .find((i) => i.mnemonic === "INC")
      ?.writes.map((w) => w.value),
  ).toEqual([0x66, 0x67]);
  for (const instruction of trace.instructions) {
    for (const [i, offset] of instruction.file_offsets.entries()) {
      const byte = Buffer.from(instruction.bytes_hex, "hex")[i];
      if (offset !== null) expect(fixture.bytes[offset]).toBe(byte);
      else {
        const origin = instruction.ram_origins.find((o) => o.byte_index === i)!;
        expect(origin).toMatchObject({
          region: "prg-ram",
          bank: 0,
          ram_address: instruction.address + i,
        });
        if (!("instruction_index" in origin))
          throw new Error("Expected definite writer");
        expect(
          trace.instructions[origin.instruction_index]!.writes[
            origin.write_index
          ],
        ).toMatchObject({ address: instruction.address + i, value: byte });
      }
    }
    for (const read of instruction.data_reads.filter((r) =>
      fixture.addresses.includes(r.address!),
    )) {
      const origin = read.ram_origins[0]!;
      if (!("instruction_index" in origin))
        throw new Error("Expected RAM data writer");
      expect(
        trace.instructions[origin.instruction_index]!.writes[
          origin.write_index
        ],
      ).toMatchObject({ address: read.address, value: read.value });
    }
  }
  expect(trace.mapper_trace).toMatchObject({
    status: "derived",
    final: {
      audio_data_port: 0x55,
      ram_control: 0x4b,
      irq_low: 254,
      irq_high: 255,
      prg_banks: [0x42, 6, 0x83],
    },
    final_mapping: { chr_source: "rom-ciram", mirroring: "custom" },
  });
}

async function verifyEvents(client: Client, cli: TestCli, path: string) {
  const contract = toolContract("trace_nes_mapper_events");
  const initial = {
    mapper: 19,
    variant: "namco163",
    prg_banks: [0, 0x40, 3],
    chr_banks: [224, 225, 7, 255, 224, 225, 7, 255],
    nametable_banks: [224, 225, 7, 255],
    irq_high: 128,
  };
  const events = [
    ...Array.from({ length: 12 }, (_, i) => [
      { kind: "ppu-read", address: i * 1024 },
      { kind: "ppu-read", address: i * 1024 + 1023 },
    ]).flat(),
    { kind: "ppu-read", address: 0x3807 },
    { kind: "ppu-read", address: 0x3f00 },
    { kind: "namco163-cpu-cycle" },
    { kind: "namco163-cpu-cycle" },
    { kind: "cpu-read", address: 0x57ff },
    { kind: "cpu-write", address: 0x5fff, value: 255 },
    { kind: "namco163-cpu-cycle" },
    { kind: "cpu-write", address: 0x57ff, value: 254 },
    { kind: "namco163-cpu-cycle" },
    { kind: "cpu-write", address: 0xf7ff, value: 63 },
    { kind: "ppu-read", address: 7 },
    { kind: "ppu-read", address: 0x2007 },
  ];
  const input = {
    path,
    initial,
    initial_irq: {
      model: "namco163",
      counter_low: 254,
      counter_high: 127,
      asserted: false,
    },
    events,
  };
  const fromCli = await cli.run({
    arguments: ["trace-nes-mapper-events", JSON.stringify(input), "--json"],
  });
  expect(fromCli.exitCode).toBe(0);
  const response = await client.callTool({
    name: contract.name,
    arguments: input,
  });
  expect(response.isError).not.toBe(true);
  const evidence = contract.outputSchema.parse(response.structuredContent),
    cliEvidence = contract.outputSchema.parse(fromCli.json);
  expect(evidence.evidence_id).toBe(cliEvidence.evidence_id);
  expect(evidence.normalized_result).toEqual(cliEvidence.normalized_result);
  const trace = evidence.normalized_result.trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  const chr = 528 + 131072;
  const banks = [224, 225, 7, 255, null, null, 7, null, null, null, 7, null];
  expect(
    trace.steps.slice(0, 24).map((s) => s.read_source?.file_offset),
  ).toEqual(
    banks.flatMap((bank) =>
      bank === null
        ? [null, null]
        : [chr + bank * 1024, chr + bank * 1024 + 1023],
    ),
  );
  expect(trace.steps[8]!.read_source).toEqual({
    status: "ciram-unobserved",
    bank: 0,
    file_offset: null,
  });
  expect(trace.steps[24]!.read_source).toEqual({
    status: "chr-rom",
    bank: 7,
    file_offset: chr + 7 * 1024 + 7,
  });
  expect(trace.steps[26]).toMatchObject({
    irq_clock: true,
    irq: { counter_low: 255, counter_high: 127, asserted: true },
  });
  expect(trace.steps[27]).toMatchObject({
    irq_clock: false,
    irq: { asserted: true },
  });
  verifyCounterRead(trace.steps[28]);
  expect(trace.steps[29]).toMatchObject({ irq: { asserted: false } });
  expect(trace.steps[30]).toMatchObject({
    irq_clock: false,
    irq: { asserted: false },
  });
  expect(trace.steps[32]).toMatchObject({
    irq_clock: true,
    irq: { asserted: true },
  });
  expect(trace.steps.slice(-2).map((s) => s.read_source?.status)).toEqual([
    "unknown-chr-bank",
    "unknown-nametable-bank",
  ]);
  expect(trace.coverage).toMatchObject({
    unknown_pattern_reads: 7,
    unknown_nametable_reads: 7,
    unknown_cpu_reads: 0,
  });
  const resumed = await client.callTool({
    name: contract.name,
    arguments: {
      path,
      initial: nesMapperEventSnapshot(trace, trace.steps[29]!)!.state,
      initial_irq: nesMapperEventSnapshot(trace, trace.steps[29]!)!.irq,
      events: events.slice(30),
    },
  });
  expect(resumed.isError).not.toBe(true);
  expect(
    contract.outputSchema.parse(resumed.structuredContent).normalized_result
      .trace,
  ).toMatchObject({
    final: trace.final,
    final_irq: trace.final_irq,
    final_mapping: trace.final_mapping,
  });
  const ajv = new Ajv2020({ strict: false });
  const advertised = (await client.listTools()).tools.find(
    (t) => t.name === contract.name,
  )!;
  const inputSchema: Record<string, unknown> = advertised.inputSchema;
  const outputSchema: Record<string, unknown> = advertised.outputSchema!;
  expect(ajv.compile(inputSchema)(input)).toBe(true);
  expect(ajv.compile(outputSchema)(response.structuredContent)).toBe(true);
  for (const invalid of [
    { ...input, initial_irq: { model: "fme7" } },
    { ...input, events: [{ kind: "vrc-cpu-cycle" }] },
    { ...input, initial_irq: undefined },
  ]) {
    const result = await client.callTool({
      name: contract.name,
      arguments: invalid,
    });
    expect(result.isError).not.toBe(true);
    expect(
      contract.outputSchema.parse(result.structuredContent).normalized_result
        .trace.status,
    ).toBe("unsupported");
  }
}

cliTest(
  "traces Namco 163 multi-window code, external RAM protection, PPU sources and explicit IRQ clocks through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-namco163-");
    const connection = createStdioToolClient("namco163");
    const { client, transport } = connection;
    const contract = toolContract("trace_nes_code");
    try {
      await client.connect(transport);
      const { input: validateInput } = (await mcpContractsFor(client))(
        "trace_nes_code",
      );
      for (const storage of [7, 0x70]) {
        const fixture = namco163Fixture(storage),
          path = join(root, `n163-${storage}.nes`);
        await writeFile(path, fixture.bytes);
        const input = { path, initial: fixture.initial, cpu: fixture.cpu };
        expect(validateInput(input)).toBe(true);
        const evidence = toolContract("trace_nes_code").outputSchema.parse(
          await (
            await createToolDelivery(client, cli)
          ).invoke("trace-nes-code", input),
        );
        expect(evidence.normalized_result.limitations.join(" ")).toContain(
          "Namco 129/163",
        );
        expect(evidence.subject?.digest?.sha256).toBe(
          createHash("sha256").update(fixture.bytes).digest("hex"),
        );
        const trace = evidence.normalized_result.code_trace;
        if (trace.status !== "derived") throw new Error(trace.reason);

        verifyCode(trace, fixture);
        const writes = trace.instructions
          .flatMap((i) => i.writes)
          .filter(
            (w) =>
              w.address >= 0x8000 ||
              (w.address >= 0x4800 && w.address <= 0x5fff),
          );
        const replay = await replayNesThroughMcp(client, {
          path,
          initial: fixture.initial,
          writes,
        });

        expect(replay.normalized_result.trace).toEqual(trace.mapper_trace);
        const explored = await exploreNesThroughMcp(client, input);

        expect(explored.normalized_result.code_exploration).toMatchObject({
          paths: [{ trace }],
        });
        if (storage === 7) await verifyEvents(client, cli, path);
        expect(await readFile(path)).toEqual(fixture.bytes);
      }
      const invalid = {
        path: join(root, "invalid.nes"),
        initial: { mapper: 19 },
      };
      expect(validateInput(invalid)).toBe(false);
      expect(
        (await client.callTool({ name: contract.name, arguments: invalid }))
          .isError,
      ).toBe(true);
    } finally {
      await connection.close();
    }
  },
  120_000,
);

function verifyCounterRead(step: unknown) {
  expect(step).toMatchObject({
    irq: { asserted: true },
    cpu_read: {
      value: 255,
      source: {
        kind: "namco163-irq-counter",
        counter_low: 255,
        counter_high: 127,
        irq_high: 128,
      },
    },
  }); // Reads never acknowledge.
}
