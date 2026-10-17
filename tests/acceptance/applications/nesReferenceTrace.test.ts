import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "@modelcontextprotocol/client";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect } from "vitest";
import type { z } from "zod";
import type {
  NesCodePath,
  NesDataRead,
  traceNesCodeInputSchema,
} from "../../../src/domain/nesCodeTrace.js";
import {
  assertNesReferenceCoverage,
  qualifyNesReferenceArtifacts,
} from "../../../scripts/lib/nes-reference-profile.mjs";
import {
  NesReferenceResponseBudgetError,
  verifyNesReferenceTrace,
  type NesReferenceTraceReport,
} from "../../../scripts/lib/nes-reference-workflow.mjs";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const romArgument = process.env.REA_NES_REFERENCE_ROM;
const logArgument = process.env.REA_NES_REFERENCE_LOG;
const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");
type TraceInput = z.input<typeof traceNesCodeInputSchema>;
type Definition = Awaited<ReturnType<Client["listTools"]>>["tools"][number];
type Accepted = { input: TraceInput; evidence_id: string; trace: NesCodePath };
type Writer = {
  evidence_id: string;
  segment: number;
  instruction_index: number;
  absolute_instruction_index: number;
  write_index: number;
};
type RamFact = { value: number; writer: Writer };
type Carried = Array<[number, RamFact]>;

// Independent of the shared reference client: both adapters validate their
// complete advertised payload, including CLI Evidence for rejected large calls.
const independentInvoke = (
  client: Client,
  definition: Definition,
  cli: TestCli,
  accepted: Accepted[],
): ((input: TraceInput) => Promise<unknown>) => {
  if (definition.outputSchema === undefined)
    throw new Error("Missing advertised trace_nes_code output schema");
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const { $schema, ...shape } = definition.outputSchema;
  if ($schema !== undefined && typeof $schema !== "string")
    throw new Error("Advertised output schema has a non-string dialect");
  const validInput = ajv.compile(definition.inputSchema),
    validOutput = ajv.compile<unknown>(
      $schema === undefined ? shape : { ...shape, $schema },
    );
  return async (input) => {
    expect(validInput(input), JSON.stringify(validInput.errors)).toBe(true);
    const response = await client.callTool({
      name: definition.name,
      arguments: input,
    });
    const compiled = await cli.run({
      arguments: ["trace-nes-code", JSON.stringify(input), "--json"],
    });
    expect(compiled.exitCode, compiled.stderr).toBe(0);
    expect(validOutput(compiled.json), JSON.stringify(validOutput.errors)).toBe(
      true,
    );
    const evidence = compiled.json as {
      evidence_id: string;
      normalized_result: { code_trace: NesCodePath };
    };
    if (response.isError === true) {
      const failure = parseMcpToolError(response).error;
      assert.ok(failure.code === "resource_constraint");
      expect(failure.details).toMatchObject({
        operation: "trace_nes_code",
        resource: "transport",
      });
      const limits = failure.details?.reported_limits;
      assert.ok(
        limits !== null && typeof limits === "object" && !Array.isArray(limits),
      );
      expect(limits).toMatchObject({
        boundary: "mcp-response",
        evidence_id: evidence.evidence_id,
        evidence_reference: {
          kind: "retained-evidence",
          evidence_id: evidence.evidence_id,
        },
      });
      expect(response.structuredContent).toBeUndefined();
      throw new NesReferenceResponseBudgetError({
        evidenceId: evidence.evidence_id,
        details: limits,
      });
    }
    expect(
      validOutput(response.structuredContent),
      JSON.stringify(validOutput.errors),
    ).toBe(true);
    expect(response.structuredContent).toEqual(compiled.json);
    accepted.push({
      input: structuredClone(input),
      evidence_id: evidence.evidence_id,
      trace: evidence.normalized_result.code_trace,
    });
    return response.structuredContent;
  };
};

const checkInputOrigin = (
  origin: NesDataRead["ram_origins"][number],
  value: number | null,
  carried: Carried,
): number => {
  if (!("initial_ram_index" in origin)) return 0;
  const source = carried[origin.initial_ram_index];
  assert.ok(source);
  expect(origin.ram_address).toBe(source[0]);
  expect(value).toBe(source[1].value);
  return 1;
};

const checkCarriedReads = (
  instruction: NesCodePath["instructions"][number],
  carried: Carried,
): number => {
  assert.ok("cpu_bus_cycles" in instruction);
  let count = 0;
  for (const origin of instruction.ram_origins)
    count += checkInputOrigin(
      origin,
      Number.parseInt(
        instruction.bytes_hex.slice(
          origin.byte_index * 2,
          origin.byte_index * 2 + 2,
        ),
        16,
      ),
      carried,
    );
  const reads = [
    ...instruction.data_reads,
    ...instruction.cpu_bus_cycles.flatMap((cycle) =>
      cycle.kind === "read" ? [cycle.read] : [],
    ),
  ];
  for (const read of reads)
    for (const origin of read.ram_origins)
      count += checkInputOrigin(origin, read.value, carried);
  return count;
};

const checkContinuation = (
  report: NesReferenceTraceReport,
  accepted: Accepted[],
): void => {
  expect(report.segments).toHaveLength(accepted.length);
  expect(report.segments.length).toBeGreaterThan(1);
  const ram = new Map<number, RamFact>();
  let nextRow = 0,
    priorSegmentReads = 0;
  for (const [index, segment] of report.segments.entries()) {
    const actual = accepted[index]!;
    assert.ok(actual.trace.cpu_bus);
    assert.ok(actual.trace.mapper_trace.status === "derived");
    expect(segment.start_row).toBe(nextRow);
    expect(segment.end_row - segment.start_row).toBe(
      actual.trace.instructions.length,
    );
    expect(segment.input).toEqual(actual.input);
    expect(segment.evidence_id).toBe(actual.evidence_id);
    expect(segment.previous_evidence_id).toBe(
      accepted[index - 1]?.evidence_id ?? null,
    );
    expect(segment.final_cpu).toEqual(actual.trace.final_cpu);
    expect(segment.final_mapper).toEqual(actual.trace.mapper_trace.final);
    expect(segment.final_cpu_bus).toEqual(actual.trace.cpu_bus.final);
    const carried = [...ram.entries()].sort(([a], [b]) => a - b);
    expect(segment.input.initial_ram ?? []).toEqual(
      carried.map(([address, fact]) => ({ address, value: fact.value })),
    );
    expect(segment.ram_handoff).toEqual(
      carried.map(([address, fact], initial_ram_index) => ({
        initial_ram_index,
        address,
        value: fact.value,
        writer: fact.writer,
      })),
    );
    if (index > 0) {
      const previous = accepted[index - 1]!;
      assert.ok(previous.trace.cpu_bus);
      assert.ok(previous.trace.mapper_trace.status === "derived");
      expect(segment.input.cpu).toEqual(previous.trace.final_cpu);
      expect(segment.input.initial).toEqual(previous.trace.mapper_trace.final);
      expect(segment.input.initial_cpu_bus).toEqual(
        previous.trace.cpu_bus.final,
      );
    }
    for (const [
      instruction_index,
      instruction,
    ] of actual.trace.instructions.entries()) {
      priorSegmentReads += checkCarriedReads(instruction, carried);
      for (const [write_index, write] of instruction.writes.entries()) {
        if (write.address >= 0x2000) continue;
        assert.ok(write.value !== null);
        ram.set(write.address & 0x7ff, {
          value: write.value,
          writer: {
            evidence_id: actual.evidence_id,
            segment: index,
            instruction_index,
            absolute_instruction_index: segment.start_row + instruction_index,
            write_index,
          },
        });
      }
    }
    nextRow = segment.end_row;
  }
  expect(nextRow).toBe(8990);
  expect(priorSegmentReads).toBeGreaterThan(0);
};

const rejectShortPrefix = async (
  invoke: (input: TraceInput) => Promise<unknown>,
  input: TraceInput,
): Promise<void> => {
  const evidence = (await invoke({ ...input, max_instructions: 933 })) as {
    normalized_result: { code_trace: NesCodePath };
  };
  const prefix = evidence.normalized_result.code_trace;
  assert.ok(prefix.cpu_bus);
  expect(prefix.instructions).toHaveLength(933);
  const cycle = prefix.cpu_bus.final.next_cycle_index;
  expect(() =>
    assertNesReferenceCoverage({
      compared_instructions: prefix.instructions.length,
      compared_after_states: prefix.instructions.length,
      compared_bus_cycles: cycle - 7,
      reference_rows_not_applied: 8991 - prefix.instructions.length,
      initial_ram_count: 0,
      initial_cycle: 7,
      final_committed_cycle: cycle,
      final_cpu: prefix.final_cpu,
      stop: prefix.stop,
    }),
  ).toThrow(/Applied instruction coverage/u);
};

// External artifacts are caller-provided. Either path enables this lane and
// requires both; ordinary CI explicitly skips it without any cache fallback.
cliTest.skipIf(romArgument === undefined && logArgument === undefined)(
  "requires every pinned nestest transition through continuous real CLI/default SDK segments and rejects a short matching prefix",
  async ({ cli }) => {
    if (romArgument === undefined || logArgument === undefined)
      throw new Error(
        "Provide both REA_NES_REFERENCE_ROM and REA_NES_REFERENCE_LOG",
      );
    const romPath = resolve(romArgument),
      logPath = resolve(logArgument);
    const [rom, log] = await Promise.all([
      readFile(romPath),
      readFile(logPath),
    ]);
    expect(sha256(rom)).toBe(
      "f67d55fd6b3cf0bad1cc85f1df0d739c65b53e79cecb7fea8f77ec0eadab0004",
    );
    expect(sha256(log)).toBe(
      "627c8e180b1a924dfa705c5dc6958fad7ab75a62de556173caf880ccc1337540",
    );
    qualifyNesReferenceArtifacts(rom, log);
    const client = await connectTestMcp(
      "nestest-reference-continuous-default-sdk",
    );
    const definition = (await client.listTools()).tools.find(
      (tool) => tool.name === "trace_nes_code",
    );
    if (definition === undefined)
      throw new Error("Missing advertised trace_nes_code schema");
    const accepted: Accepted[] = [];
    const invoke = independentInvoke(client, definition, cli, accepted);
    const report = await verifyNesReferenceTrace({
      romPath,
      logPath,
      invoke,
    });
    expect(report).toMatchObject({
      ok: true,
      profile: "nestest-nintendulator",
      compared_instructions: 8990,
      compared_after_states: 8990,
      compared_bus_cycles: 26547,
      reference_rows_not_applied: 1,
      initial_ram_count: 0,
      initial_cycle: 7,
      final_committed_cycle: 26554,
      full_rom_pass: false,
      reference_coverage: "complete-with-declared-unapplied-frontier",
      stop: {
        reason: "unknown-control-target",
        address: 0xc66e,
        bytes_hex: "60",
      },
    });
    assertNesReferenceCoverage(report);
    checkContinuation(report, accepted);
    expect(report.budget_attempts.length).toBeGreaterThan(0);
    expect(report.budget_attempts[0]).toMatchObject({
      start_row: 0,
      max_instructions: 8991,
    });
    await rejectShortPrefix(invoke, report.segments[0]!.input);
    const [retainedRom, retainedLog] = await Promise.all([
      readFile(romPath),
      readFile(logPath),
    ]);
    expect(retainedRom).toEqual(rom);
    expect(retainedLog).toEqual(log);
  },
  180000,
);
