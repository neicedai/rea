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
  "traces VRC1 source flow through all three switched PRG windows through compiled CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc1-");
    const client = await connectTestMcp("vrc1");
    for (const prgSize of [32768, 131072]) {
      const bytes = Buffer.alloc(16 + prgSize + 8192);
      bytes.set([0x4e, 0x45, 0x53, 0x1a, prgSize / 16384, 1, 0xb0, 0x48, 0]);
      const entryOffset = 16 + prgSize - 8192 + 256;
      bytes.set(
        [
          0xa9, 0xe2, 0x8d, 0xff, 0x8f, 0xa9, 0xe5, 0x8d, 0xff, 0xaf, 0xa9,
          0xe7, 0x8d, 0xff, 0xcf, 0x4c, 0, 0x80,
        ],
        entryOffset,
      );
      const mask = prgSize / 8192 - 1;
      bytes.set([0x4c, 0, 0xa0], 16 + (2 & mask) * 8192);
      bytes.set([0x4c, 0, 0xc0], 16 + (5 & mask) * 8192);
      const target = 16 + (7 & mask) * 8192;
      bytes.set([0xa9, 0x77, 0x60], target);
      bytes.writeUInt16LE(0xe100, 16 + prgSize - 4);
      const path = join(root, `vrc1-${prgSize}.nes`);
      await writeFile(path, bytes);
      const input = { path, initial: { mapper: 75 } };
      await verifyNesPrgSwitch(cli, client, input, bytes, {
        limitation: "VRC1",
        accumulator: 0x77,
        targetOffset: target,
      });
    }
  },
  60_000,
);

cliTest(
  "combines independently written VRC1 CHR bits and resumes partial state",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc1-chr-");
    const bytes = Buffer.alloc(528 + 32768 + 131072);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 16, 0xb4, 0x48]);
    const chrOffset = 528 + 32768;
    for (let i = 0; i < 131072; i++)
      bytes[chrOffset + i] = (i * 7 + (i >> 12)) & 255;
    const path = join(root, "vrc1-chr.nes");
    await writeFile(path, bytes);
    const write = (address: number, value: number | null) => ({
      kind: "cpu-write",
      address,
      value,
    });
    const read = (address: number) => ({ kind: "ppu-read", address });
    const events = [
      write(0x9fff, 7),
      write(0xefff, 0xf3),
      write(0xffff, 0xe4),
      read(0),
      read(8191),
      write(0x9000, 2),
      read(0),
      read(8191),
      write(0xf000, 9),
      read(4096),
      { ...write(0x9000, null), known_bits: { mask: 2, value: 2 } },
      read(0),
      read(4096),
      write(0x9000, 6),
      read(4096),
    ];
    const input = { path, initial: { mapper: 75 }, events };
    const contract = toolContract("trace_nes_mapper_events");
    const client = await connectTestMcp("vrc1-chr");
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
    const offsets = [
      19 * 4096,
      21 * 4096 - 1,
      19 * 4096,
      5 * 4096 - 1,
      9 * 4096,
      19 * 4096,
      null,
      25 * 4096,
    ];
    expect(
      trace.steps
        .filter((step) => step.event.kind === "ppu-read")
        .map((step) => step.read_source?.file_offset),
    ).toEqual(
      offsets.map((offset) => (offset === null ? null : chrOffset + offset)),
    );
    expect(trace.coverage.unknown_pattern_reads).toBe(1);
    expect(trace.final_irq).toBeNull();
    const resumed = await client.callTool({
      name: contract.name,
      arguments: {
        path,
        initial: trace.steps[10]!.state,
        events: events.slice(11),
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
    ).toEqual(trace.steps.slice(11).map(({ index: _index, ...step }) => step));
    expect(await readFile(path)).toEqual(bytes);
  },
);
