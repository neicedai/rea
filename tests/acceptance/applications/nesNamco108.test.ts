import { verifyNesPrgSwitch } from "../../support/nesPrgSwitch.js";

import {
  createStdioToolClient,
  connectTestMcp,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import type { NesMapperEventsTrace } from "../../../src/domain/nesMapperEvents.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "traces Namco 108 banked and fixed boards through compiled CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-namco108-");
    const client = await connectTestMcp("namco108");
    for (const submapper of [0, 1]) {
      const prgSize = submapper === 0 ? 131072 : 32768;
      const bytes = Buffer.alloc(16 + prgSize + 8192);
      bytes.set([
        0x4e,
        0x45,
        0x53,
        0x1a,
        prgSize / 16384,
        1,
        0xe0,
        0xc8,
        submapper << 4,
      ]);
      const entryOffset = 16 + prgSize - 8192;
      bytes.set(
        [
          0xa9, 0xc7, 0x8d, 0xfe, 0x9f, 0xa9, 5, 0x8d, 0xff, 0x9f, 0x4c, 0,
          0xa0,
        ],
        entryOffset,
      );
      const target = 16 + (submapper === 0 ? 5 : 1) * 8192;
      bytes.set([0xa9, 0x77, 0x60], target);
      bytes.writeUInt16LE(0xe000, 16 + prgSize - 4);
      const path = join(root, `namco-${submapper}.nes`);
      await writeFile(path, bytes);
      const input = { path, initial: { mapper: 206 } };
      await verifyNesPrgSwitch(cli, client, input, bytes, {
        limitation: "spurious writes",
        accumulator: 0x77,
        targetOffset: target,
      });
    }
  },
  60_000,
);

cliTest(
  "resolves Namco 108 CHR windows and partial selectors through supplied PPU events",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-namco108-chr-");
    const connection = createStdioToolClient("namco108-chr");
    const { client, transport } = connection;
    const contract = toolContract("trace_nes_mapper_events");
    try {
      await client.connect(transport);
      for (const submapper of [0, 1]) {
        const chrOffset = 528 + 32768;
        const bytes = Buffer.alloc(chrOffset + 65536);
        bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 8, 0xe4, 0xc8, submapper << 4]);
        for (let page = 0; page < 64; page++)
          bytes.fill(
            page,
            chrOffset + page * 1024,
            chrOffset + (page + 1) * 1024,
          );
        const path = join(root, `namco-chr-${submapper}.nes`);
        await writeFile(path, bytes);
        const cpuWrite = (address: number, value: number | null) => ({
          kind: "cpu-write",
          address,
          value,
        });
        const ppuRead = (address: number) => ({ kind: "ppu-read", address });
        const selected = [255, 27, 194, 63, 170, 21];
        const events = selected.flatMap((value, register) => [
          cpuWrite(0x9ffe, 0xc0 | register),
          cpuWrite(0x9fff, value),
        ]);
        const addresses = Array.from({ length: 8 }, (_, index) => [
          index * 1024,
          index * 1024 + 1023,
        ]).flat();
        const input = {
          path,
          initial: { mapper: 206 },
          events: [
            ...events,
            cpuWrite(0xa000, 0),
            ...addresses.map(ppuRead),
            cpuWrite(0x8000, 0),
            { ...cpuWrite(0x8001, null), known_bits: { mask: 62, value: 2 } },
            ppuRead(0),
            ppuRead(1024),
            cpuWrite(0x8000, 2),
            { ...cpuWrite(0x8001, null), known_bits: { mask: 62, value: 2 } },
            ppuRead(4096),
            cpuWrite(0x8001, 2),
            ppuRead(4096),
            ppuRead(8192),
          ],
        };
        const mcp = toolContract("trace_nes_mapper_events").outputSchema.parse(
          await (
            await createToolDelivery(client, cli)
          ).invoke("trace-nes-mapper-events", input),
        );
        expect(mcp.normalized_result.artifact.sha256).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        const trace = mcp.normalized_result.trace;
        if (trace.status !== "derived") throw new Error(trace.reason);
        verifyChrSources(trace, bytes, chrOffset, addresses);
        expect(trace.coverage).toEqual({
          supplied_events: input.events.length,
          processed_events: input.events.length,
          unknown_pattern_reads: 1,
        });
        expect(trace.steps[12]?.write_effect).toBe("outside-mapper");
        expect(trace.final_irq).toBe(null);
        expect(trace.final_mapping.mirroring).toBe("horizontal");
        expect(trace.final).toMatchObject({
          banks: [{ mask: 62, value: 2 }, 27, 2, 63, 170, 21, null, null],
        });
        if (submapper === 1)
          expect(
            trace.final_mapping.prg_windows.map((window) => window.bank),
          ).toEqual([0, 1, 2, 3]);
        const resumed = await client.callTool({
          name: contract.name,
          arguments: { path, initial: trace.final, events: [ppuRead(1024)] },
        });
        expect(resumed.isError).not.toBe(true);
        expect(
          contract.outputSchema.parse(resumed.structuredContent)
            .normalized_result,
        ).toMatchObject({
          trace: {
            initial_mapping: trace.final_mapping,
            steps: [
              { read_source: { bank: 3, file_offset: chrOffset + 3072 } },
            ],
          },
        });
        const rejected = await client.callTool({
          name: contract.name,
          arguments: {
            path,
            initial: { mapper: 206 },
            events: [{ kind: "mmc3-irq-clock" }],
          },
        });
        expect(rejected.isError).not.toBe(true);
        expect(
          contract.outputSchema.parse(rejected.structuredContent)
            .normalized_result,
        ).toMatchObject({
          trace: {
            status: "unsupported",
            reason: "MMC3 IRQ analysis requires Mapper 4.",
          },
        });
        expect(await readFile(path)).toEqual(bytes);
      }
    } finally {
      await connection.close();
    }
  },
  60_000,
);

const verifyChrSources = (
  trace: Extract<NesMapperEventsTrace, { status: "derived" }>,
  bytes: Buffer,
  chrOffset: number,
  addresses: readonly number[],
) => {
  const reads = trace.steps.filter((step) => step.event.kind === "ppu-read");
  const banks = [62, 63, 26, 27, 2, 63, 42, 21];
  for (const [index, address] of addresses.entries()) {
    const bank = banks[Math.floor(index / 2)]!;
    const offset = chrOffset + bank * 1024 + (address % 1024);
    expect(reads[index]?.read_source).toEqual({
      status: "chr-rom",
      bank,
      file_offset: offset,
    });
    expect(bytes[offset]).toBe(bank);
  }
  expect(reads.slice(16).map((step) => step.read_source)).toEqual([
    { status: "chr-rom", bank: 2, file_offset: chrOffset + 2048 },
    { status: "chr-rom", bank: 3, file_offset: chrOffset + 3072 },
    { status: "unknown-chr-bank", bank: null, file_offset: null },
    { status: "chr-rom", bank: 2, file_offset: chrOffset + 2048 },
    { status: "outside-pattern-tables", bank: null, file_offset: null },
  ]);
};
