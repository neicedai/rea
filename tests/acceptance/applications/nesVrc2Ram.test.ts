import {
  traceNesThroughAdapters,
  replayNesThroughMcp,
  exploreNesThroughMcp,
} from "../../support/nesSourceDelivery.js";
import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const routine = [
  0xad, 0, 0x70, 0xa9, 255, 0x8d, 2, 0x90, 0xa9, 15, 0x8d, 2, 0xb0, 0xa9, 7,
  0x8d, 0, 0xb0, 0xa9, 2, 0x8d, 0, 0x80, 0x4c, 0, 0x80,
];

// Each declaration owns its client, cold schema compilation and both RAM workflows.
cliTest.for([7, 0x70])(
  "retains full VRC2c RAM declaration %i through mapper writes and caller-seeded execution",
  { timeout: 60_000 },
  async (declaration, { cli }) => {
    const root = await createTestTempDirectory("rea-vrc2c-ram-");
    const client = await connectTestMcp("vrc2c-ram");
    const bytes = Buffer.alloc(528 + 65536 + 262144);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 32, 0x96, 0x18, 0x30]);
    bytes[10] = declaration;
    bytes.fill(0xff, 16, 528);
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
    const path = join(root, `vrc2c-ram-${declaration}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper: 25 } };
    const trace = await traceThroughAdapters(cli, client, input, bytes);
    verifySources(trace, bytes, false);
    expect(trace.mapper_trace).toMatchObject({
      final_mapping: {
        prg_windows: [{ bank: 2 }, { bank: null }, { bank: 6 }, { bank: 7 }],
        chr_windows: [
          { bank: 247 },
          ...Array.from({ length: 7 }, () => ({ bank: null })),
        ],
        mirroring: "horizontal",
      },
    });
    const replay = await replayNesThroughMcp(client, {
      ...input,
      writes: trace.instructions.flatMap((instruction) => instruction.writes),
    });

    const replayTrace = replay.normalized_result.trace;
    if (
      trace.mapper_trace.status !== "derived" ||
      replayTrace.status !== "derived"
    )
      throw new Error("Expected mapped trace");
    expect(replayTrace.final).toEqual(trace.mapper_trace.final);
    expect(replayTrace.final_mapping).toEqual(trace.mapper_trace.final_mapping);
    expect(replayTrace.nes_prg_views).toEqual(trace.mapper_trace.nes_prg_views);
    expect(
      replayTrace.steps
        .slice(0, routine.length)
        .every((step) => step.effect === "outside-mapper"),
    ).toBe(true);
    const explored = await exploreNesThroughMcp(client, input);

    const exploration = explored.normalized_result.code_exploration;
    if (exploration.status !== "derived") throw new Error(exploration.reason);
    expect(exploration.paths[0]?.trace).toEqual(trace);
    const initial_prg_ram = routine.map((value, index) => ({
      bank: 0,
      address: 0x6000 + index,
      value,
    }));
    const seeded = await traceThroughAdapters(
      cli,
      client,
      { ...input, entry: 0x6000, initial_prg_ram },
      bytes,
    );
    verifySources(seeded, bytes, true);
    expect(await readFile(path)).toEqual(bytes);
  },
);

async function traceThroughAdapters(
  cli: TestCli,
  client: Client,
  input: Record<string, unknown>,
  bytes: Buffer,
): Promise<NesCodePath> {
  const mcp = await traceNesThroughAdapters(cli, client, input);
  expect(mcp.normalized_result.artifact.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = mcp.normalized_result.code_trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  return trace;
}

function verifySources(trace: NesCodePath, bytes: Buffer, seeded: boolean) {
  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.instructions.at(-1)?.file_offsets).toEqual([
    528 + 2 * 8192,
    529 + 2 * 8192,
  ]);
  const ram = trace.instructions.filter(
    (instruction) =>
      instruction.address >= 0x6000 && instruction.address < 0x8000,
  );
  expect(ram).toHaveLength(10);
  expect(ram[0]?.data_reads).toEqual([
    {
      address: 0x7000,
      value: null,
      file_offset: null,
      ram_origins: [],
      mapper_origins: [],
    },
  ]);
  for (const instruction of trace.instructions) {
    const code = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries())
      if (offset !== null) expect(bytes[offset]).toBe(code[index]);
  }
  for (const instruction of ram) {
    const offset = instruction.address - 0x6000;
    const size = instruction.file_offsets.length;
    expect(instruction.bytes_hex).toBe(
      Buffer.from(routine.slice(offset, offset + size)).toString("hex"),
    );
    expect(instruction.file_offsets).toEqual(Array(size).fill(null));
    expect(instruction.mapper_origins).toEqual([]);
    expect(instruction.ram_origins).toEqual(
      Array.from({ length: size }, (_, byte_index) => ({
        byte_index,
        region: "prg-ram",
        bank: 0,
        ram_address: instruction.address + byte_index,
        ...(seeded
          ? { initial_prg_ram_index: offset + byte_index }
          : {
              instruction_index: (offset + byte_index) * 2 + 1,
              write_index: 0,
            }),
      })),
    );
  }
}
