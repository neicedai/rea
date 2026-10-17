import { verifyNesPrgSwitch } from "../../support/nesPrgSwitch.js";

import {
  createStdioToolClient,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "traces explicit VRC2b/VRC2c PRG switching through compiled CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc2-variants-");
    const connection = createStdioToolClient("vrc2-variants");
    const { client, transport } = connection;
    const contract = toolContract("trace_nes_code");
    try {
      await client.connect(transport);
      for (const mapper of [23, 25]) {
        const prgSize = 131072;
        const bytes = Buffer.alloc(16 + prgSize + 8192);
        bytes.set([
          0x4e,
          0x45,
          0x53,
          0x1a,
          prgSize / 16384,
          1,
          (mapper & 15) << 4,
          0x18,
          0x30,
        ]);
        const entryOffset = 16 + prgSize - 8192;
        bytes.set(
          [
            0xa9, 0xe2, 0x8d, 0xff, 0x8f, 0xa9, 0xe5, 0x8d, 0xff, 0xaf, 0x4c, 0,
            0xa0,
          ],
          entryOffset,
        );
        const target = 16 + (5 & (prgSize / 8192 - 1)) * 8192;
        bytes.set([0xa9, 0x77, 0x60], target);
        bytes.writeUInt16LE(0xe000, 16 + prgSize - 4);
        const path = join(root, `vrc2-variants-${mapper}.nes`);
        await writeFile(path, bytes);
        const input = { path, initial: { mapper } };
        await verifyNesPrgSwitch(cli, client, input, bytes, {
          limitation: mapper === 23 ? "VRC2b" : "VRC2c",
          accumulator: 0x77,
          targetOffset: target,
        });
        const legacy = Buffer.from(bytes);
        legacy[7] = 0x10;
        legacy[8] = 0;
        const legacyPath = join(root, `legacy-vrc-${mapper}.nes`);
        await writeFile(legacyPath, legacy);
        const rejected = await cli.run({
          arguments: [
            "trace-nes-code",
            JSON.stringify({ path: legacyPath, initial: { mapper } }),
            "--json",
          ],
        });
        expect(rejected.exitCode).toBe(0);
        const unsupported = contract.outputSchema.parse(rejected.json)
          .normalized_result.code_trace;
        expect(unsupported.status).toBe("unsupported");
        if (unsupported.status !== "unsupported")
          throw new Error("Expected ambiguous board rejection");
        expect(unsupported.reason).toContain("explicit NES 2.0 submapper");
      }
    } finally {
      await connection.close();
    }
  },
  60_000,
);

cliTest(
  "preserves all eight VRC2b/c CHR bits and board-specific ports through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc2-variants-chr-");
    const connection = createStdioToolClient("vrc2-variants-chr");
    const { client, transport } = connection;
    const contract = toolContract("trace_nes_mapper_events");
    try {
      await client.connect(transport);
      for (const mapper of [23, 25]) {
        const bytes = Buffer.alloc(528 + 32768 + 262144);
        bytes.set([
          0x4e,
          0x45,
          0x53,
          0x1a,
          2,
          32,
          ((mapper & 15) << 4) | 4,
          0x18,
          0x30,
        ]);
        const chrOffset = 528 + 32768;
        for (let i = 0; i < 262144; i++)
          bytes[chrOffset + i] = (i * 7 + (i >> 10)) & 255;
        const path = join(root, `vrc2-${mapper}-chr.nes`);
        await writeFile(path, bytes);
        const write = (address: number, value: number | null) => ({
          kind: "cpu-write",
          address,
          value,
        });
        const read = (address: number) => ({ kind: "ppu-read", address });
        const high0 = mapper === 23 ? 0xb001 : 0xb002;
        const events = [
          ...Array.from({ length: 8 }, (_, index) => {
            const base = 0xbffc + Math.floor(index / 2) * 4096;
            const lowPort = mapper === 23 ? (index % 2) * 2 : index % 2;
            return [
              write(base + lowPort, 240 | (index * 2 + 1)),
              write(
                base + lowPort + (mapper === 23 ? 1 : 2),
                240 | (15 - index),
              ),
            ];
          }).flat(),
          ...Array.from({ length: 8 }, (_, index) => [
            read(index * 1024),
            read(index * 1024 + 1023),
          ]).flat(),
          { ...write(0xb000, null), known_bits: { mask: 14, value: 6 } },
          read(0),
          write(0xb000, 15),
          write(high0, 15),
          read(1023),
        ];
        const input = { path, initial: { mapper }, events };
        const mcp = toolContract("trace_nes_mapper_events").outputSchema.parse(
          await (
            await createToolDelivery(client, cli)
          ).invoke("trace-nes-mapper-events", input),
        );
        const trace = mcp.normalized_result.trace;
        if (trace.status !== "derived") throw new Error(trace.reason);
        if ("mapper_snapshots" in trace)
          throw new Error(
            "Unexpected PPU profile in this legacy mapper workflow",
          );
        expect(mcp.normalized_result.artifact.sha256).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        const offsets = [241, 227, 213, 199, 185, 171, 157, 143].flatMap(
          (bank) => [chrOffset + bank * 1024, chrOffset + bank * 1024 + 1023],
        );
        expect(
          trace.steps
            .filter((step) => step.event.kind === "ppu-read")
            .map((step) => step.read_source?.file_offset),
        ).toEqual([...offsets, null, chrOffset + 262143]);
        expect(trace.coverage.unknown_pattern_reads).toBe(1);
        expect(trace.final_irq).toBeNull();
        const resumed = await client.callTool({
          name: contract.name,
          arguments: {
            path,
            initial: trace.steps[32]!.state,
            events: events.slice(33),
          },
        });
        expect(resumed.isError).not.toBe(true);
        const continuation = contract.outputSchema.parse(
          resumed.structuredContent,
        ).normalized_result.trace;
        if (continuation.status !== "derived")
          throw new Error(continuation.reason);
        if ("mapper_snapshots" in continuation)
          throw new Error(
            "Unexpected PPU profile in this legacy mapper workflow",
          );
        expect(continuation.final).toEqual(trace.final);
        expect(
          continuation.steps.map(({ index: _index, ...step }) => step),
        ).toEqual(
          trace.steps.slice(33).map(({ index: _index, ...step }) => step),
        );
        expect(await readFile(path)).toEqual(bytes);
      }
    } finally {
      await connection.close();
    }
  },
  60_000,
);
