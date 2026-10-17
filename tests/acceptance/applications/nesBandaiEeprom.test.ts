import {
  mcpContractsFor,
  connectTestMcp,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
  traceNesThroughAdapters,
} from "../../support/nesSourceDelivery.js";

import type { Client } from "@modelcontextprotocol/client";

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  eepromCases,
  eepromFixture,
  EepromBusFixture,
} from "../../../src/domain/nesBandaiEeprom.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";

type Input = {
  path: string;
  initial: ReturnType<typeof eepromFixture>["initial"];
};
async function checkSources(
  client: Client,
  input: Input,
  trace: NesCodePath,
  bytes: Buffer,
) {
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.stop.reason).toBe("return");
  expect(
    trace.instructions.find((i) => i.address === 0xbfff)?.file_offsets,
  ).toEqual([528 + 2 * 16384 - 1, 528 + 3 * 16384]);
  for (const instruction of trace.instructions)
    for (const [index, offset] of instruction.file_offsets.entries())
      expect(bytes[offset!]).toBe(
        Buffer.from(instruction.bytes_hex, "hex")[index],
      );
  const serialReads = trace.instructions.flatMap((i) => i.data_reads);
  expect(
    serialReads
      .filter((r) => r.address === 0x6000)
      .map((r) => ("known_bits" in r ? r.known_bits.value : undefined)),
  ).toEqual([16, 0, 0, 16, 0, 16, 16, 0, 16, 0, 16, 0, 0, 16, 0, 16]);
  for (const read of serialReads) {
    expect(read.value).toBeNull();
    const origin = read.mapper_origins[0];
    if (
      origin?.kind !== "bandai-eeprom" ||
      origin.control_source.kind !== "cpu-write"
    )
      throw new Error("Expected control writer");
    expect(
      trace.instructions[origin.control_source.instruction_index]?.writes[
        origin.control_source.write_index
      ]?.address,
    ).toBe(0x800d);
  }
  const replay = await replayNesThroughMcp(client, {
    ...input,
    writes: trace.instructions.flatMap((i) => i.writes),
  });

  expect(replay.normalized_result.trace).toEqual(trace.mapper_trace);
}
async function checkEvents(
  client: Client,
  cli: TestCli,
  context: {
    input: Input;
    board: (typeof eepromCases)[number];
    bus: EepromBusFixture;
    eventsInput: (value: unknown) => boolean;
    eventsOutput: (value: unknown) => boolean;
  },
) {
  const { input, board, bus, eventsInput, eventsOutput } = context;
  const eventInput = { ...input, events: bus.events };
  expect(eventsInput(eventInput)).toBe(true);
  const eventResult = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: eventInput,
  });
  expect(eventResult.isError).not.toBe(true);
  expect(eventsOutput(eventResult.structuredContent)).toBe(true);
  const events = toolContract("trace_nes_mapper_events").outputSchema.parse(
    eventResult.structuredContent,
  ).normalized_result.trace;
  if (events.status !== "derived") throw new Error(events.reason);
  expect(events.final).toMatchObject({
    eeprom: { phase: "idle", address: 1, busy: false },
  });
  const write = new EepromBusFixture();
  write.address(board.model, board.page_size - 1, false);
  write.send(0x12);
  write.send(0x34);
  write.stop();
  const pageInput = {
    ...input,
    events: [
      ...write.events,
      ...write.events,
      { kind: "eeprom-write-complete" },
    ],
  };
  const pageEvidence = toolContract(
    "trace_nes_mapper_events",
  ).outputSchema.parse(
    await (
      await createToolDelivery(client, cli)
    ).invoke("trace-nes-mapper-events", pageInput),
  );
  expect(pageEvidence.normalized_result.trace).toMatchObject({
    final: {
      eeprom: {
        busy: false,
        pending: [],
        bytes: expect.arrayContaining([
          { address: board.page_size - 1, value: 0x12 },
          { address: 0, value: 0x34 },
        ]),
      },
    },
  });
  const unknown = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      ...input,
      initial: {
        ...input.initial,
        eeprom: { ...input.initial.eeprom, busy: true },
      },
      events: [{ kind: "eeprom-write-complete" }],
    },
  });
  expect(unknown.isError).not.toBe(true);
  expect(eventsOutput(unknown.structuredContent)).toBe(true);
  expect(
    toolContract("trace_nes_mapper_events").outputSchema.parse(
      unknown.structuredContent,
    ).normalized_result.trace,
  ).toMatchObject({
    final: {
      eeprom: {
        bytes: input.initial.eeprom.bytes.map((b) => ({ ...b, value: null })),
      },
    },
  });
}

cliTest(
  "traces Xicor EEPROM reads and explicit page-write completion through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-eeprom-");
    const client = await connectTestMcp("eeprom");

    const contract = await mcpContractsFor(client);
    const codeInput = contract("trace_nes_code").input,
      eventsInput = contract("trace_nes_mapper_events").input,
      eventsOutput = contract("trace_nes_mapper_events").output;
    for (const board of eepromCases) {
      const { bytes, initial, bus } = eepromFixture(board),
        path = join(root, `${board.model}-${board.page_size}.nes`),
        input = { path, initial };
      await writeFile(path, bytes);
      expect(codeInput(input)).toBe(true);
      const evidence = await traceNesThroughAdapters(cli, client, input),
        trace = evidence.normalized_result.code_trace;
      expect(evidence.subject?.digest?.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      if (trace.status !== "derived" || trace.mapper_trace.status !== "derived")
        throw new Error(JSON.stringify(trace));
      await checkSources(client, input, trace, bytes);
      await checkEvents(client, cli, {
        input,
        board,
        bus,
        eventsInput,
        eventsOutput,
      });
      const missing = await client.callTool({
        name: "trace_nes_code",
        arguments: {
          ...input,
          initial: { ...initial, eeprom: { ...initial.eeprom, bytes: [] } },
        },
      });
      expect(missing.isError).not.toBe(true);
      expect(
        toolContract("trace_nes_code").outputSchema.parse(
          missing.structuredContent,
        ).normalized_result.code_trace,
      ).toMatchObject({ stop: { reason: "unknown-branch" } });
      const explored = await exploreNesThroughMcp(client, input);

      expect(explored.normalized_result.code_exploration).toMatchObject({
        paths: [{ trace }],
      });
      expect(await readFile(path)).toEqual(bytes);
    }
    for (const eeprom of [
      { model: "x24c02" },
      { model: "x24c01", bytes: [{ address: 128, value: 0 }] },
      { model: "x24c01", address: { mask: 1, value: 2 } },
      {
        model: "x24c01",
        bytes: [{ address: 0, value: { mask: 1, value: 2 } }],
      },
    ]) {
      const input = {
        path: join(root, "invalid.nes"),
        initial: { mapper: 159, eeprom },
      };
      expect(codeInput(input)).toBe(false);
      expect(
        (await client.callTool({ name: "trace_nes_code", arguments: input }))
          .isError,
      ).toBe(true);
    }
  },
  180000,
);
