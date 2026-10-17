import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
  traceNesThroughAdapters,
} from "../../support/nesSourceDelivery.js";
import {
  connectTestMcp,
  mcpContractsFor,
} from "../../support/cliMcpDelivery.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const wiring = [
  [21, 1, 1, 2],
  [21, 2, 6, 7],
  [23, 1, 0, 1],
  [23, 2, 2, 3],
  [25, 1, 1, 0],
  [25, 2, 3, 2],
] as const;

function cartridge(mapper: number, submapper: number, a0: number, a1: number) {
  const bytes = Buffer.alloc(528 + 131072 + 524288, 0x02);
  bytes.fill(0, 0, 16);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    8,
    64,
    ((mapper & 15) << 4) | 4,
    0x18,
    submapper << 4,
  ]);
  const port = (base: number, p: number) =>
    base | ((p & 1) << a0) | ((p >> 1) << a1);
  const program = [
    [0x8000, 0xe2],
    [0xa000, 0xe5],
    [port(0x9000, 2), 0],
    [port(0x9000, 0), 3],
    [port(0xb000, 1), 31],
    [port(0xb000, 0), 15],
    [port(0xf000, 0), 0xfe],
    [port(0xf000, 1), 0xff],
    [port(0xf000, 2), 2],
    [port(0xf000, 3), 255],
  ].flatMap(([address, value]) => [
    0xa9,
    value!,
    0x8d,
    address! & 255,
    address! >> 8,
  ]);
  bytes.set([...program, 0x4c, 0xff, 0x9f], 528 + 15 * 8192 + 0x100);
  bytes[528 + 3 * 8192 - 1] = 0xa9;
  const mode = port(0x9000, 2);
  bytes.set(
    [0x5a, 0xa9, 2, 0x8d, mode & 255, mode >> 8, 0x4c, 0x10, 0x80],
    528 + 5 * 8192,
  );
  bytes.set([0x4c, 0x10, 0xc0], 528 + 14 * 8192 + 16);
  bytes.set([0xa9, 0x77, 0x60], 528 + 2 * 8192 + 16);
  bytes.writeUInt16LE(0xe100, 528 + 131072 - 4);
  return bytes;
}

function verifySources(trace: NesCodePath, bytes: Buffer) {
  expect(trace.stop.reason).toBe("return");
  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.instructions.find((i) => i.address === 0x9fff)).toMatchObject({
    bytes_hex: "a95a",
    file_offsets: [528 + 3 * 8192 - 1, 528 + 5 * 8192],
  });
  expect(
    trace.instructions.find((i) => i.address === 0x8010)?.file_offsets,
  ).toEqual([528 + 14 * 8192 + 16, 528 + 14 * 8192 + 17, 528 + 14 * 8192 + 18]);
  for (const instruction of trace.instructions) {
    expect(instruction.ram_origins).toEqual([]);
    expect(instruction.file_offsets.every((offset) => offset !== null)).toBe(
      true,
    );
    expect(instruction.bytes_hex).toBe(
      Buffer.from(
        instruction.file_offsets.map((offset) => bytes[offset!]!),
      ).toString("hex"),
    );
  }
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  expect(trace.mapper_trace.final_mapping).toMatchObject({
    prg_windows: [{ bank: 14 }, { bank: 5 }, { bank: 2 }, { bank: 15 }],
    chr_windows: [
      { bank: 511 },
      ...Array.from({ length: 7 }, () => ({ bank: null })),
    ],
    mirroring: "one-screen-b",
  });
  expect(trace.mapper_trace.final).toMatchObject({
    irq_latch_low: 0xfe,
    irq_latch_high: 0xff,
    irq_control: 2,
    irq_enabled: false,
    last_irq_command: "acknowledge",
  });
}

async function verifyReplay(client: Client, path: string, trace: NesCodePath) {
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  const initial = trace.mapper_trace.initial;
  const writes = trace.instructions.flatMap((i) => i.writes);
  const response = await replayNesThroughMcp(client, { path, initial, writes });

  expect(response.normalized_result.trace).toEqual(trace.mapper_trace);
  const events = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial,
      events: [
        ...writes.map((write) => ({ ...write, kind: "cpu-write" })),
        { kind: "ppu-read", address: 0x3ff },
      ],
    },
  });
  expect(events.isError).not.toBe(true);
  const eventTrace = toolContract("trace_nes_mapper_events").outputSchema.parse(
    events.structuredContent,
  ).normalized_result.trace;
  if (eventTrace.status !== "derived") throw new Error(eventTrace.reason);
  expect(eventTrace.final).toEqual(trace.mapper_trace.final);
  expect(eventTrace.final_mapping).toEqual(trace.mapper_trace.final_mapping);
  expect(eventTrace.steps.at(-1)?.read_source).toEqual({
    status: "chr-rom",
    bank: 511,
    file_offset: 528 + 131072 + 524288 - 1,
  });
  const resumed = await client.callTool({
    name: "trace_nes_code",
    arguments: { path, initial: trace.mapper_trace.final, entry: 0xc010 },
  });
  expect(resumed.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_code").outputSchema.parse(resumed.structuredContent)
      .normalized_result.code_trace,
  ).toMatchObject({ final_cpu: { a: 0x77 }, stop: { reason: "return" } });
  const explored = await exploreNesThroughMcp(client, { path, initial });

  expect(explored.normalized_result.code_exploration).toMatchObject({
    paths: [{ trace }],
  });
}

cliTest(
  "traces all six explicit VRC4 wiring variants through bank swapping and ninth-bit CHR reads",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc4-");
    const client = await connectTestMcp("vrc4-banking");
    const { input: validateInput } = (await mcpContractsFor(client))(
      "trace_nes_code",
    );
    for (const [mapper, submapper, a0, a1] of wiring) {
      const bytes = cartridge(mapper, submapper, a0, a1);
      const path = join(root, `vrc4-${mapper}-${submapper}.nes`);
      await writeFile(path, bytes);
      const initial = { mapper, variant: "vrc4" };
      expect(validateInput({ path, initial })).toBe(true);
      const evidence = await traceNesThroughAdapters(cli, client, {
        path,
        initial,
      });
      expect(evidence.subject?.digest?.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      const trace = evidence.normalized_result.code_trace;
      if (trace.status !== "derived") throw new Error(trace.reason);
      verifySources(trace, bytes);
      await verifyReplay(client, path, trace);
      expect(await readFile(path)).toEqual(bytes);
    }
    for (const initial of [
      { mapper: 21 },
      { mapper: 21, variant: "vrc2" },
      { mapper: 21, variant: "vrc4", chr_high: [512] },
    ]) {
      const input = { path: join(root, "invalid.nes"), initial };
      expect(validateInput(input)).toBe(false);
      expect(
        (await client.callTool({ name: "trace_nes_code", arguments: input }))
          .isError,
      ).toBe(true);
    }
  },
  120000,
);
