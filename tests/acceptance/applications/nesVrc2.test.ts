import { verifyNesPrgSwitch } from "../../support/nesPrgSwitch.js";

import {
  connectTestMcp,
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
  "traces VRC2a PRG switching and address-line aliases through compiled CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc2a-");
    const client = await connectTestMcp("vrc2a");
    for (const prgSize of [32768, 131072]) {
      const bytes = Buffer.alloc(16 + prgSize + 8192);
      bytes.set([0x4e, 0x45, 0x53, 0x1a, prgSize / 16384, 1, 0x60, 0x18, 0]);
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
      const path = join(root, `vrc2a-${prgSize}.nes`);
      await writeFile(path, bytes);
      const input = { path, initial: { mapper: 22 } };
      await verifyNesPrgSwitch(cli, client, input, bytes, {
        limitation: "VRC2a",
        accumulator: 0x77,
        targetOffset: target,
      });
    }
  },
  60_000,
);

cliTest(
  "resolves VRC2a swapped CHR ports and preserves partial nibble snapshots",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc2a-chr-");
    const bytes = Buffer.alloc(528 + 32768 + 131072);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 16, 0x64, 0x18]);
    const chrOffset = 528 + 32768;
    for (let i = 0; i < 131072; i++)
      bytes[chrOffset + i] = (i * 7 + (i >> 10)) & 255;
    const path = join(root, "vrc2a-chr.nes");
    await writeFile(path, bytes);
    const write = (address: number, value: number | null) => ({
      kind: "cpu-write",
      address,
      value,
    });
    const read = (address: number) => ({ kind: "ppu-read", address });
    const events = [
      ...Array.from({ length: 8 }, (_, index) => {
        const base = 0xbffc + Math.floor(index / 2) * 4096 + (index % 2);
        return [
          write(base, 240 | (index * 2 + 1)),
          write(base + 2, 240 | (15 - index)),
        ];
      }).flat(),
      ...Array.from({ length: 8 }, (_, index) => [
        read(index * 1024),
        read(index * 1024 + 1023),
      ]).flat(),
      { ...write(0xb000, null), known_bits: { mask: 14, value: 6 } },
      read(0),
      { ...write(0xb000, null), known_bits: { mask: 12, value: 4 } },
      read(0),
      write(0xb000, 6),
      read(0),
    ];
    const input = { path, initial: { mapper: 22 }, events };
    const contract = toolContract("trace_nes_mapper_events");
    const client = await connectTestMcp("vrc2a-chr");
    const mcp = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await (
        await createToolDelivery(client, cli)
      ).invoke("trace-nes-mapper-events", input),
    );
    const trace = mcp.normalized_result.trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    if ("mapper_snapshots" in trace)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    expect(mcp.normalized_result.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const offsets = [120, 113, 106, 99, 92, 85, 78, 71].flatMap((bank) => [
      chrOffset + bank * 1024,
      chrOffset + bank * 1024 + 1023,
    ]);
    expect(
      trace.steps
        .filter((step) => step.event.kind === "ppu-read")
        .map((step) => step.read_source?.file_offset),
    ).toEqual([
      ...offsets,
      chrOffset + 123 * 1024,
      null,
      chrOffset + 123 * 1024,
    ]);
    expect(trace.coverage.unknown_pattern_reads).toBe(1);
    expect(trace.final_irq).toBeNull();
    const resumed = await client.callTool({
      name: contract.name,
      arguments: {
        path,
        initial: trace.steps[34]!.state,
        events: events.slice(35),
      },
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
    ).toEqual(trace.steps.slice(35).map(({ index: _index, ...step }) => step));
    expect(await readFile(path)).toEqual(bytes);
  },
  60_000,
);
