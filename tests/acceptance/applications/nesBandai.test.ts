import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
  traceNesThroughAdapters,
} from "../../support/nesSourceDelivery.js";
import {
  connectTestMcp,
  mcpContractsFor,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import { nesMapperEventSnapshot } from "../../../src/domain/nesMapperEvents.js";

import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  bandaiCases,
  bandaiFixture,
} from "../../../src/domain/nesBandai.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";

type Board = (typeof bandaiCases)[number];
type Input = {
  path: string;
  initial: ReturnType<typeof bandaiFixture>["initial"];
};
async function checkTrace(
  client: Client,
  input: Input,
  trace: NesCodePath,
  context: {
    bytes: Buffer;
    board: Board;
    chr: number[];
    validateEvents: (value: unknown) => boolean;
  },
) {
  const { bytes, board, chr, validateEvents } = context,
    { path } = input;
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  if ("mapper_snapshots" in trace.mapper_trace)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  expect(trace.stop.reason).toBe("return");
  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.instructions.find((i) => i.address === 0xbfff)).toMatchObject({
    bytes_hex: "a95a",
    file_offsets: [528 + 2 * 16384 - 1, 528 + 3 * 16384],
  });
  for (const instruction of trace.instructions)
    for (const [index, offset] of instruction.file_offsets.entries()) {
      expect(offset).not.toBeNull();
      expect(bytes[offset!]).toBe(
        Buffer.from(instruction.bytes_hex, "hex")[index],
      );
    }
  expect(
    trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
  ).toEqual([1, 3]);
  expect(
    trace.mapper_trace.final_mapping.chr_windows.map((w) => w.bank),
  ).toEqual(chr);
  expect(trace.mapper_trace.final).toMatchObject({
    eeprom_control: board.variant === "fcg" ? null : 0x60,
  });
  const writes = trace.instructions.flatMap((i) => i.writes);
  const replay = await replayNesThroughMcp(client, { ...input, writes });

  expect(replay.normalized_result.trace).toMatchObject({
    final: trace.mapper_trace.final,
    final_mapping: trace.mapper_trace.final_mapping,
    nes_prg_views: trace.mapper_trace.nes_prg_views,
  });
  const explored = await exploreNesThroughMcp(client, input);

  expect(explored.normalized_result.code_exploration).toMatchObject({
    paths: [{ trace }],
  });
  const resumed = await client.callTool({
    name: "trace_nes_code",
    arguments: {
      path,
      initial: trace.mapper_trace.final,
      entry: 0x8010,
    },
  });
  expect(resumed.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_code").outputSchema.parse(resumed.structuredContent)
      .normalized_result.code_trace,
  ).toMatchObject({
    final_cpu: { a: 0x77 },
    stop: { reason: "return" },
  });
  const ppu = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      ...input,
      events: [
        ...writes.map((w) => ({ ...w, kind: "cpu-write" })),
        ...chr.map((_, i) => ({
          kind: "ppu-read",
          address: i * 1024 + 1023,
        })),
      ],
    },
  });
  expect(ppu.isError).not.toBe(true);
  expect(validateEvents(ppu.structuredContent)).toBe(true);
  const events = toolContract("trace_nes_mapper_events").outputSchema.parse(
    ppu.structuredContent,
  ).normalized_result.trace;
  if (events.status !== "derived") throw new Error(events.reason);
  if ("mapper_snapshots" in events)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  expect(events.steps.slice(writes.length).map((s) => s.read_source)).toEqual(
    chr.map((bank) => ({
      status: "chr-rom",
      bank,
      file_offset: 528 + 65536 + bank * 1024 + 1023,
    })),
  );
}
async function checkIrq(
  client: Client,
  cli: TestCli,
  context: {
    input: Input;
    base: number;
    board: Board;
  },
) {
  const { input, base, board } = context,
    { path } = input;
  const irqInput = {
    ...input,
    initial_irq: {
      model: board.variant === "fcg" ? "bandai-fcg" : "bandai-lz93d50",
    },
    events: [
      { kind: "cpu-write", address: base + 11, value: 1 },
      { kind: "cpu-write", address: base + 12, value: 0 },
      { kind: "cpu-write", address: base + 10, value: 1 },
      { kind: "ppu-read", address: 0 },
      { kind: "bandai-cpu-cycle" },
      { kind: "bandai-cpu-cycle" },
    ],
  };
  const irq = toolContract("trace_nes_mapper_events").outputSchema.parse(
    await (
      await createToolDelivery(client, cli)
    ).invoke("trace-nes-mapper-events", irqInput),
  ).normalized_result.trace;
  if (irq.status !== "derived") throw new Error(irq.reason);
  expect(nesMapperEventSnapshot(irq, irq.steps[3]!)?.irq).toMatchObject({
    counter_low: 1,
    counter_high: 0,
    asserted: false,
  });
  expect(irq.final_irq).toMatchObject({
    counter_low: 255,
    counter_high: 255,
    asserted: true,
  });
  const next = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial: irq.final,
      initial_irq: irq.final_irq,
      events: [
        { kind: "bandai-cpu-cycle" },
        { kind: "cpu-write", address: base + 10, value: 0 },
      ],
    },
  });
  expect(next.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_mapper_events").outputSchema.parse(
      next.structuredContent,
    ).normalized_result.trace,
  ).toMatchObject({
    final_irq: {
      asserted: false,
      counter_low: board.variant === "fcg" ? 254 : 1,
      counter_high: board.variant === "fcg" ? 255 : 0,
    },
  });
}

cliTest(
  "preserves Bandai chip choices, source banks, EEPROM boundaries and explicit IRQ clocks through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bandai-");
    const client = await connectTestMcp("bandai");
    const contract = await mcpContractsFor(client);
    const validateInput = contract("trace_nes_code").input,
      validateEvents = contract("trace_nes_mapper_events").output,
      validateViews = contract("open_binary").input;
    for (const board of bandaiCases)
      for (const version of ["nes2", "ines", "nes2-zero"] as const) {
        const { bytes, initial, base, chr } = bandaiFixture(board, version),
          path = join(
            root,
            `bandai-${board.mapper}-${board.variant}-${version}.nes`,
          ),
          input = { path, initial };
        await writeFile(path, bytes);
        expect(validateInput(input)).toBe(true);
        const evidence = await traceNesThroughAdapters(cli, client, input),
          trace = evidence.normalized_result.code_trace;
        expect(evidence.subject?.digest?.sha256).toBe(
          createHash("sha256").update(bytes).digest("hex"),
        );
        expect(evidence.normalized_result.header.header).toEqual([
          ...bytes.subarray(0, 16),
        ]);
        if (
          trace.status !== "derived" ||
          trace.mapper_trace.status !== "derived"
        )
          throw new Error(JSON.stringify(trace));
        expect(
          validateViews({
            path,
            nes_prg_views: trace.mapper_trace.nes_prg_views,
          }),
        ).toBe(true);
        if (board.mapper === 16)
          expect(
            trace.mapper_trace.nes_prg_views.every(
              (v) => "variant" in v && v.variant === board.variant,
            ),
          ).toBe(true);
        await checkTrace(client, input, trace, {
          bytes,
          board,
          chr,
          validateEvents,
        });
        if (version === "nes2")
          await checkIrq(client, cli, { input, base, board });
        const seeded = await client.callTool({
          name: "trace_nes_code",
          arguments: {
            ...input,
            entry: 0x6000,
            initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x60 }],
          },
        });
        expect(seeded.isError).not.toBe(true);
        expect(
          toolContract("trace_nes_code").outputSchema.parse(
            seeded.structuredContent,
          ).normalized_result.code_trace,
        ).toMatchObject({ status: "unsupported" });
        expect(await readFile(path)).toEqual(bytes);
      }
    for (const initial of [
      { mapper: 16 },
      { mapper: 159, variant: "fcg" },
      { mapper: 16, variant: "fcg", prg_bank: { mask: 1, value: 2 } },
    ]) {
      const input = { path: join(root, "invalid.nes"), initial };
      expect(validateInput(input)).toBe(false);
      expect(
        (await client.callTool({ name: "trace_nes_code", arguments: input }))
          .isError,
      ).toBe(true);
    }
  },
  180000,
);
