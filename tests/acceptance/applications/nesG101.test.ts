import { verifyNesPrgSwitch } from "../../support/nesPrgSwitch.js";
import {
  traceNesThroughAdapters,
  exploreNesThroughMcp,
} from "../../support/nesSourceDelivery.js";
import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "traces G-101 mode switching and hardwired boards through compiled CLI and stdio MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-g101-");
    const client = await connectTestMcp("g101");
    for (const submapper of [0, 1]) {
      const prgSize = 131072;
      const bytes = Buffer.alloc(16 + prgSize + 8192);
      bytes.set([
        0x4e,
        0x45,
        0x53,
        0x1a,
        prgSize / 16384,
        1,
        0,
        0x28,
        submapper << 4,
      ]);
      const entryOffset = 16 + prgSize - 8192;
      bytes.set(
        [0xa9, 2, 0x8d, 0xff, 0x8f, 0xa9, 2, 0x8d, 0xff, 0x9f, 0x4c, 0, 0xc0],
        entryOffset,
      );
      const target = 16 + (submapper === 0 ? 2 : 14) * 8192;
      bytes.set([0xa9, 0x77, 0x60], target);
      bytes.writeUInt16LE(0xe000, 16 + prgSize - 4);
      const path = join(root, `g101-${submapper}.nes`);
      await writeFile(path, bytes);
      const input = { path, initial: { mapper: 32 } };
      await verifyNesPrgSwitch(cli, client, input, bytes, {
        limitation: "Irem G-101",
        accumulator: 0x77,
        targetOffset: target,
      });
    }
  },
  120_000,
);

cliTest(
  "resolves independent G-101 CHR windows and partial register snapshots",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-g101-chr-");
    const bytes = Buffer.alloc(528 + 32768 + 65536);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 8, 4, 0x28]);
    const chrOffset = 528 + 32768;
    for (let i = 0; i < 65536; i++) bytes[chrOffset + i] = Math.floor(i / 1024);
    const path = join(root, "g101-chr.nes");
    await writeFile(path, bytes);
    const banks = [63, 17, 2, 51, 5, 6, 28, 45];
    const write = (address: number, value: number | null) => ({
      kind: "cpu-write",
      address,
      value,
    });
    const read = (address: number) => ({ kind: "ppu-read", address });
    const events = [
      ...banks.map((bank, index) => write(0xbff8 + index, bank | 192)),
      ...banks.flatMap((_, index) => [
        read(index * 1024),
        read(index * 1024 + 1023),
      ]),
      { ...write(0xb003, null), known_bits: { mask: 63, value: 21 } },
      read(3072),
      { ...write(0xb003, null), known_bits: { mask: 62, value: 20 } },
      read(3072),
    ];
    const result = await cli.run({
      arguments: [
        "trace-nes-mapper-events",
        JSON.stringify({ path, initial: { mapper: 32 }, events }),
        "--json",
      ],
    });
    expect(result.exitCode).toBe(0);
    const report = toolContract("trace_nes_mapper_events").outputSchema.parse(
      result.json,
    ).normalized_result;
    expect(report.artifact.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = report.trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    if ("mapper_snapshots" in trace)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    const reads = trace.steps.filter((step) => step.event.kind === "ppu-read");
    expect(reads.map((step) => step.read_source?.file_offset)).toEqual([
      ...banks.flatMap((bank) => [
        chrOffset + bank * 1024,
        chrOffset + bank * 1024 + 1023,
      ]),
      chrOffset + 21 * 1024,
      null,
    ]);
    expect(trace.coverage.unknown_pattern_reads).toBe(1);
    expect(trace.final).toMatchObject({
      chr_banks: [255, 209, 194, { mask: 62, value: 20 }, 197, 198, 220, 237],
    });
    const resumed = await cli.run({
      arguments: [
        "trace-nes-mapper-events",
        JSON.stringify({
          path,
          initial: trace.steps[24]!.state,
          events: events.slice(25),
        }),
        "--json",
      ],
    });
    expect(resumed.exitCode).toBe(0);
    const continuation = toolContract(
      "trace_nes_mapper_events",
    ).outputSchema.parse(resumed.json).normalized_result.trace;
    if (continuation.status !== "derived") throw new Error(continuation.reason);
    if ("mapper_snapshots" in continuation)
      throw new Error("Unexpected PPU profile in this legacy mapper workflow");
    expect(continuation.final).toEqual(trace.final);
    expect(
      continuation.steps.map(({ index: _index, ...step }) => step),
    ).toEqual(trace.steps.slice(25).map(({ index: _index, ...step }) => step));
    expect(await readFile(path)).toEqual(bytes);
  },
);

cliTest(
  "retains G-101 cartridge RAM instruction origins across PRG mode changes",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-g101-ram-");

    const client = await connectTestMcp("g101-ram");
    for (const declaration of [7, 0x70]) {
      const bytes = Buffer.alloc(528 + 65536 + 8192);
      bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 6, 0x28]);
      bytes[10] = declaration;
      bytes.fill(0xff, 16, 528);
      // RAM routine changes both selector and mode, then jumps into bank 2 at C000.
      const routine = [
        0xa9, 2, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 0, 0x90, 0x4c, 0, 0xc0,
      ];
      const program = routine.flatMap((byte, index) => [
        0xa9,
        byte,
        0x8d,
        index,
        0x60,
      ]);
      program.push(0x4c, 0, 0x60);
      bytes.set(program, 528 + 7 * 8192);
      bytes.set([0xa9, 0x77, 0x60], 528 + 2 * 8192);
      bytes.writeUInt16LE(0xe000, 528 + 65536 - 4);
      const path = join(root, `g101-ram-${declaration}.nes`);
      await writeFile(path, bytes);
      const input = { path, initial: { mapper: 32 } };
      const mcp = await traceNesThroughAdapters(cli, client, input);
      expect(mcp.normalized_result.artifact.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      const trace = mcp.normalized_result.code_trace;
      if (trace.status !== "derived") throw new Error(trace.reason);

      expect(trace.final_cpu.a).toBe(0x77);
      expect(trace.instructions.at(-1)?.file_offsets).toEqual([
        528 + 2 * 8192,
        529 + 2 * 8192,
      ]);
      const ram = trace.instructions.filter(
        (instruction) =>
          instruction.address >= 0x6000 && instruction.address < 0x8000,
      );
      expect(ram).toHaveLength(5);
      for (const instruction of ram) {
        const offset = instruction.address - 0x6000;
        const size = instruction.file_offsets.length;
        expect(instruction.bytes_hex).toBe(
          Buffer.from(routine.slice(offset, offset + size)).toString("hex"),
        );
        expect(instruction.file_offsets).toEqual(Array(size).fill(null));
        expect(instruction.ram_origins).toEqual(
          Array.from({ length: size }, (_, index) =>
            expect.objectContaining({
              region: "prg-ram",
              ram_address: instruction.address + index,
              bank: 0,
              instruction_index: (offset + index) * 2 + 1,
              write_index: 0,
            }),
          ),
        );
      }
      const response2 = await exploreNesThroughMcp(client, input);

      const exploration = response2.normalized_result.code_exploration;
      if (exploration.status !== "derived") throw new Error(exploration.reason);

      expect(exploration.paths[0]?.trace).toEqual(trace);
      expect(await readFile(path)).toEqual(bytes);
    }
  },
  120_000,
);
