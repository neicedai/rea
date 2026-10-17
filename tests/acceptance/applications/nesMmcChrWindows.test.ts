import {
  connectTestMcp,
  createToolDelivery,
  mcpContractsFor,
} from "../../support/cliMcpDelivery.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { mapperTraceFixture } from "../../../src/domain/nesMapperTrace.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const cases = [
  {
    mapper: 1 as const,
    initial: {
      mapper: 1,
      chr_mode: 0,
      shift_bits: [],
      chr_bank_0: { mask: 22, value: 18 },
      chr_bank_1: { mask: 7, value: 6 },
    },
    events: [
      { kind: "ppu-read", address: 0x0123 },
      { kind: "ppu-read", address: 0x1123 },
      ...[0, 0, 0, 0, 1].map((value) => ({
        kind: "cpu-write",
        address: 0x8000,
        value,
        preceded_by_cpu_write: false,
      })),
      { kind: "ppu-read", address: 0x0123 },
      { kind: "ppu-read", address: 0x1123 },
    ],
    bank_size: 4096,
    banks: [2, 3, null, 6],
  },
  {
    mapper: 4 as const,
    initial: {
      mapper: 4,
      bank_select: { mask: 128, value: 0 },
      banks: [
        { mask: 30, value: 18 },
        { mask: 30, value: 22 },
        5,
        6,
        7,
        8,
        0,
        1,
      ],
    },
    events: [
      { kind: "ppu-read", address: 0x0012 },
      { kind: "ppu-read", address: 0x0412 },
      { kind: "ppu-read", address: 0x1012 },
      { kind: "cpu-write", address: 0x8000, value: 128 },
      { kind: "ppu-read", address: 0x0012 },
      { kind: "ppu-read", address: 0x1012 },
      { kind: "ppu-read", address: 0x1412 },
      { kind: "cpu-write", address: 0x8001, value: 27 },
      { kind: "ppu-read", address: 0x1012 },
      { kind: "ppu-read", address: 0x1412 },
    ],
    bank_size: 1024,
    banks: [18, 19, 5, 5, 18, 19, 26, 27],
  },
];

async function verifyChrSources(cli: TestCli, client: Client, root: string) {
  const contract = toolContract("trace_nes_mapper_events");
  const { input: validateInput } = (await mcpContractsFor(client))(
    "trace_nes_mapper_events",
  );
  for (const scenario of cases) {
    const bytes = mapperTraceFixture(scenario.mapper);
    const path = join(root, `chr-mapper-${scenario.mapper}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: scenario.initial, events: scenario.events };
    expect(validateInput(input), JSON.stringify(validateInput.errors)).toBe(
      true,
    );
    const mcp = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await (
        await createToolDelivery(client, cli)
      ).invoke("trace-nes-mapper-events", input),
    );
    expect(mcp.subject?.digest?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = mcp.normalized_result.trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    const reads = trace.steps.filter((step) => step.event.kind === "ppu-read");
    expect(reads.map((step) => step.read_source?.bank)).toEqual(scenario.banks);
    for (const [index, step] of reads.entries()) {
      if (step.event.kind !== "ppu-read")
        throw new Error("Expected a PPU read");
      const bank = scenario.banks[index] ?? null;
      const offset =
        bank === null
          ? null
          : 528 +
            65536 +
            bank * scenario.bank_size +
            (step.event.address % scenario.bank_size);
      expect(step.read_source?.file_offset).toBe(offset);
      if (offset !== null)
        expect(bytes[offset]).toBe(
          Math.floor((bank! * scenario.bank_size) / 1024),
        );
    }
    const resumed = await client.callTool({
      name: contract.name,
      arguments: { path, initial: trace.final, events: [] },
    });
    expect(resumed.isError).not.toBe(true);
    expect(
      contract.outputSchema.parse(resumed.structuredContent).normalized_result
        .trace,
    ).toMatchObject({ final: trace.final, final_mapping: trace.final_mapping });
    expect(await readFile(path)).toEqual(bytes);
  }
}

cliTest(
  "retains exact MMC1/MMC3 CHR sources through mode and paired-bank switches",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc-chr-");
    const client = await connectTestMcp("mmc-chr-windows");
    await verifyChrSources(cli, client, root);
  },
  60_000,
);
