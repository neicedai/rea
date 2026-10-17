import { verifyNesPrgSwitch } from "../../support/nesPrgSwitch.js";

import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "traces Taito PRG switching and address-line aliases through compiled CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-taito33-");
    const client = await connectTestMcp("taito33");
    for (const prgSize of [32768, 131072]) {
      const bytes = Buffer.alloc(16 + prgSize + 8192);
      bytes.set([0x4e, 0x45, 0x53, 0x1a, prgSize / 16384, 1, 0x10, 0x28, 0]);
      const entryOffset = 16 + prgSize - 8192;
      bytes.set(
        [
          0xa9, 0xc2, 0x8d, 0xfc, 0x9f, 0xa9, 0xe5, 0x8d, 0xfd, 0x9f, 0x4c, 0,
          0xa0,
        ],
        entryOffset,
      );
      const target = 16 + (5 & (prgSize / 8192 - 1)) * 8192;
      bytes.set([0xa9, 0x77, 0x60], target);
      bytes.writeUInt16LE(0xe000, 16 + prgSize - 4);
      const path = join(root, `taito33-${prgSize}.nes`);
      await writeFile(path, bytes);
      const input = { path, initial: { mapper: 33 } };
      await verifyNesPrgSwitch(cli, client, input, bytes, {
        limitation: "Mapper 33",
        accumulator: 0x77,
        targetOffset: target,
      });
    }
  },
  60_000,
);

cliTest(
  "retains Taito mixed CHR window sources at the 512 KiB boundary",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-taito33-chr-");
    const bytes = Buffer.alloc(528 + 32768 + 524288);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 64, 0x14, 0x28]);
    const chrOffset = 528 + 32768;
    for (let i = 0; i < 524288; i++)
      bytes[chrOffset + i] = (i * 7 + (i >> 10)) & 255;
    const path = join(root, "taito-chr.nes");
    await writeFile(path, bytes);
    const write = (address: number, value: number | null) => ({
      kind: "cpu-write",
      address,
      value,
    });
    const read = (address: number) => ({ kind: "ppu-read", address });
    const events = [
      write(0x9ffe, 255),
      write(0x9fff, 3),
      ...[255, 128, 2, 9].map((value, index) => write(0xbffc + index, value)),
      ...Array.from({ length: 8 }, (_, index) => [
        read(index * 1024),
        read(index * 1024 + 1023),
      ]).flat(),
      { ...write(0x8002, null), known_bits: { mask: 254, value: 2 } },
      read(0),
      read(1024),
      write(0x8002, 3),
      read(0),
      read(1024),
    ];
    const contract = toolContract("trace_nes_mapper_events");
    const input = { path, initial: { mapper: 33 }, events };
    const result = await cli.run({
      arguments: ["trace-nes-mapper-events", JSON.stringify(input), "--json"],
    });
    expect(result.exitCode).toBe(0);
    const evidence = contract.outputSchema.parse(result.json);
    const client = await connectTestMcp("taito33-chr");
    const response = await client.callTool({
      name: contract.name,
      arguments: input,
    });
    expect(response.isError).not.toBe(true);
    const mcp = contract.outputSchema.parse(response.structuredContent);
    expect(mcp.evidence_id).toBe(evidence.evidence_id);
    expect(mcp.normalized_result).toEqual(evidence.normalized_result);
    const trace = mcp.normalized_result.trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    if ("mapper_snapshots" in trace)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    expect(mcp.normalized_result.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const offsets = [510, 511, 6, 7, 255, 128, 2, 9].flatMap((bank) => [
      chrOffset + bank * 1024,
      chrOffset + bank * 1024 + 1023,
    ]);
    expect(
      trace.steps
        .filter((step) => step.event.kind === "ppu-read")
        .map((step) => step.read_source?.file_offset),
    ).toEqual([
      ...offsets,
      null,
      null,
      chrOffset + 6 * 1024,
      chrOffset + 7 * 1024,
    ]);
    expect(trace.coverage.unknown_pattern_reads).toBe(2);
    expect(trace.final_irq).toBeNull();
    const resumeInput = {
      path,
      initial: trace.steps[22]!.state,
      events: events.slice(23),
    };
    const resumed = await client.callTool({
      name: contract.name,
      arguments: resumeInput,
    });
    expect(resumed.isError).not.toBe(true);
    const continuation = contract.outputSchema.parse(resumed.structuredContent)
      .normalized_result.trace;
    if (continuation.status !== "derived") throw new Error(continuation.reason);
    if ("mapper_snapshots" in continuation)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    expect(continuation.final).toEqual(trace.final);
    expect(
      continuation.steps.map(({ index: _index, ...step }) => step),
    ).toEqual(trace.steps.slice(23).map(({ index: _index, ...step }) => step));
    await verifyAdvertisedTaitoSchema(
      client,
      [input, resumeInput],
      [result.json, response.structuredContent, resumed.structuredContent],
    );
    expect(await readFile(path)).toEqual(bytes);
  },
);

async function verifyAdvertisedTaitoSchema(
  client: Client,
  inputs: Record<string, unknown>[],
  outputs: unknown[],
) {
  const definition = (await client.listTools()).tools.find(
    (tool) => tool.name === "trace_nes_mapper_events",
  );
  if (!definition?.outputSchema)
    throw new Error("Mapper event output schema is missing");
  const inputSchema: Record<string, unknown> = definition.inputSchema;
  const outputSchema: Record<string, unknown> = definition.outputSchema;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validInput = ajv.compile(inputSchema);
  const validOutput = ajv.compile(outputSchema);
  for (const input of inputs)
    expect(validInput(input), JSON.stringify(validInput.errors)).toBe(true);
  for (const output of outputs)
    expect(validOutput(output), JSON.stringify(validOutput.errors)).toBe(true);
  // Malformed partial bytes and register counts must fail in the advertised
  // schema and at the public handler, not merely in a source-level parser.
  for (const fields of [
    { prg_banks: [{ mask: 3, value: 4 }, null] },
    { prg_banks: [{ mask: 0, value: 0 }, null] },
    { prg_banks: [256, null] },
    { prg_banks: [0, 1, 2] },
    { chr_banks: [0, 1, 2, 3, 4] },
    { chr_banks: [0, 1, 2, 3, 4, { mask: 254, value: 3 }] },
    { control: 0 },
  ]) {
    const input = { ...inputs[0], initial: { mapper: 33, ...fields } };
    expect(validInput(input)).toBe(false);
    const rejected = await client.callTool({
      name: definition.name,
      arguments: input,
    });
    expect(rejected.isError).toBe(true);
  }
}
