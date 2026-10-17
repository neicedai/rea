import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
} from "../../support/nesSourceDelivery.js";
import {
  connectTestMcp,
  createToolDelivery,
  mcpContractsFor,
} from "../../support/cliMcpDelivery.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { mmc5CpuFixtures } from "../../../src/domain/nesMmc5Cpu.fixture.js";
import type {
  NesCodePath,
  NesMapperWriteSource,
} from "../../../src/domain/nesCodeTrace.js";
import { nesMmc5StateSchema } from "../../../src/domain/nesMmc5.js";
import { readMmc5ExramCell } from "../../../src/domain/nesMmc5Exram.js";
import type { NesByteValue } from "../../../src/domain/nesByteValue.js";
import type { NesMapperWrite } from "../../../src/domain/nesMapperTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

function writer(
  trace: NesCodePath,
  source: NesMapperWriteSource,
  before: number,
): NesMapperWrite | null {
  if (source.kind !== "cpu-write") return null;
  expect(source.instruction_index).toBeLessThan(before);
  return trace.instructions[source.instruction_index]!.writes[
    source.write_index
  ]!;
}

function supports(value: NesByteValue, proof: NesByteValue) {
  if (proof === null) throw new Error("Missing byte proof");
  const mask = typeof proof === "number" ? 255 : proof.mask,
    bits = typeof proof === "number" ? proof : proof.value;
  expect(
    typeof value === "number"
      ? (value & mask) === bits
      : value !== null &&
          (value.mask & mask) === mask &&
          (value.value & mask) === bits,
  ).toBe(true);
}

function verifyDeviceSources(
  trace: NesCodePath,
  fixture: ReturnType<typeof mmc5CpuFixtures>[number],
) {
  const initial = nesMmc5StateSchema.parse(fixture.input.initial);
  for (const instruction of trace.instructions) {
    const bytes = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries())
      if (offset !== null) expect(fixture.bytes[offset]).toBe(bytes[index]);
    for (const item of [
      {
        origins: instruction.mapper_origins,
        address: instruction.address,
        code: bytes,
      },
      ...instruction.data_reads.map((read) => ({
        origins: read.mapper_origins,
        address: read.address,
        code: null,
      })),
    ])
      for (const origin of item.origins) {
        if (origin.kind === "mmc5-multiply") {
          for (const [index, source] of origin.factor_sources.entries()) {
            const write = writer(trace, source, instruction.index);
            if (write !== null) {
              expect(write.address).toBe(0x5205 + index);
              expect(
                write.value ??
                  ("known_bits" in write ? write.known_bits : null),
              ).toEqual(index === 0 ? origin.multiplicand : origin.multiplier);
            } else
              expect(
                index === 0 ? origin.multiplicand : origin.multiplier,
              ).toEqual(initial.multiplier[index]);
          }
        } else if (origin.kind === "mmc5-exram") {
          expect(origin.cell_address).toBe(
            item.address! +
              (item.code === null ? 0 : origin.byte_index) -
              0x5c00,
          );
          const mode = writer(trace, origin.mode_source, instruction.index);
          if (mode !== null)
            expect(mode).toMatchObject({ address: 0x5104, value: origin.mode });
          else expect(origin.mode).toEqual(initial.exram_mode);
          const byte = writer(trace, origin.byte_source, instruction.index);
          if (byte !== null) {
            expect(byte.address).toBe(0x5c00 + origin.cell_address);
            supports(
              byte.value ?? ("known_bits" in byte ? byte.known_bits : null),
              origin.cell_value,
            );
          } else
            supports(
              readMmc5ExramCell(initial, origin.cell_address).value,
              origin.cell_value,
            );
          if (item.code !== null)
            expect(origin.cell_value).toBe(item.code[origin.byte_index]);
        } else throw new Error("Unexpected device origin");
      }
  }
  if (
    trace.mapper_trace.status !== "derived" ||
    trace.mapper_trace.final.mapper !== 5
  )
    throw new Error("Expected MMC5 trace");
  const final = trace.mapper_trace.final;
  if (fixture.name === "devices") {
    expect(final.multiplier).toEqual([16, 5]);
    expect(final.exram["64"]).toBe(0xa9);
    expect(
      trace.instructions
        .find((i) => i.address === 0xe00a)!
        .writes.map((w) => w.value),
    ).toEqual([15, 16]);
    expect(
      trace.instructions
        .find((i) => i.address === 0x5c45)!
        .writes.map((w) => w.value),
    ).toEqual([0xa9, 0xaa]);
    expect(
      trace.instructions.find((i) => i.address === 0x8000)!.file_offsets[0],
    ).toBe(fixture.prgOffset + 5 * 8192);
  } else if (fixture.name === "partial-product") {
    expect(trace.instructions[0]!.data_reads[0]).toMatchObject({
      value: null,
      known_bits: { mask: 3, value: 0 },
      mapper_origins: [{ kind: "mmc5-multiply" }],
    });
  } else if (fixture.name === "uncertain-ram") {
    expect(final.exram["0"]).toEqual({ mask: 253, value: 165 });
    expect(trace.instructions[2]!.data_reads[0]).toMatchObject({
      value: null,
      known_bits: { mask: 253, value: 165 },
      mapper_origins: [
        { kind: "mmc5-exram", byte_source: { kind: "initial-state" } },
      ],
    });
  } else if (fixture.name === "cleared-proof") {
    expect(trace.instructions[0]!.cpu_after).toMatchObject({
      register_bits: { a: { mask: 3, value: 0 } },
    });
    expect("register_bits" in trace.instructions[1]!.cpu_after).toBe(false);
    expect(trace.final_cpu).toMatchObject({
      register_bits: { a: { mask: 252, value: 0 } },
    });
  } else if (fixture.name === "restricted-ram")
    expect(final.exram["0"]).toBeNull();
  else expect(Object.keys(final.exram)).toHaveLength(1024);
}

async function replay(
  client: Client,
  path: string,
  fixture: ReturnType<typeof mmc5CpuFixtures>[number],
  trace: NesCodePath,
) {
  const writes = trace.instructions.flatMap((i) => i.writes);
  const mapped = await replayNesThroughMcp(client, {
    path,
    initial: fixture.input.initial,
    writes,
  });

  expect(mapped.normalized_result.trace).toEqual(trace.mapper_trace);
  const events = trace.instructions.flatMap((i) => [
    ...i.data_reads.map((read) => ({
      kind: "cpu-read",
      address: read.address,
    })),
    ...i.writes.map((write) => ({ kind: "cpu-write", ...write })),
  ]);
  const result = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: { path, initial: fixture.input.initial, events },
  });
  expect(result.isError).not.toBe(true);
  const eventTrace = toolContract("trace_nes_mapper_events").outputSchema.parse(
    result.structuredContent,
  ).normalized_result.trace;
  if (
    eventTrace.status !== "derived" ||
    trace.mapper_trace.status !== "derived"
  )
    throw new Error("Expected event trace");
  expect(eventTrace.final).toEqual(trace.mapper_trace.final);
  expect(eventTrace.final_mapping).toEqual(trace.mapper_trace.final_mapping);
  if (events.some((e) => e.kind === "cpu-read"))
    expect(eventTrace.coverage).toMatchObject({
      unknown_cpu_reads: trace.instructions
        .flatMap((i) => i.data_reads)
        .filter((r) => r.value === null && !("known_bits" in r)).length,
    });
  else expect("unknown_cpu_reads" in eventTrace.coverage).toBe(false);
  expect(
    eventTrace.steps.flatMap((s) =>
      "cpu_read" in s ? [s.cpu_read.value] : [],
    ),
  ).toEqual(
    trace.instructions.flatMap((i) => i.data_reads.map((r) => r.value)),
  );
  if (fixture.name === "devices") {
    const continued = await client.callTool({
      name: "trace_nes_code",
      arguments: { path, initial: eventTrace.final, entry: 0x5c40 },
    });
    expect(continued.isError).not.toBe(true);
    expect(
      toolContract("trace_nes_code").outputSchema.parse(
        continued.structuredContent,
      ).normalized_result.code_trace,
    ).toMatchObject({ stop: { reason: "return" }, final_cpu: { a: 0x77 } });
  }
}

async function verifyCpuContinuation(
  client: Client,
  root: string,
  validateInput: (value: unknown) => boolean,
  validateOutput: (value: unknown) => boolean,
) {
  const contract = toolContract("trace_nes_code");
  const partial = mmc5CpuFixtures().find((f) => f.name === "partial-product")!;
  const path = join(root, "partial-product.nes");
  const prefix = await client.callTool({
    name: contract.name,
    arguments: { path, ...partial.input, max_instructions: 1 },
  });
  expect(prefix.isError).not.toBe(true);
  const prefixTrace = contract.outputSchema.parse(prefix.structuredContent)
    .normalized_result.code_trace;
  if (
    prefixTrace.status !== "derived" ||
    prefixTrace.mapper_trace.status !== "derived"
  )
    throw new Error("Expected prefix");
  const resumed = {
    path,
    entry: prefixTrace.stop.address,
    initial: prefixTrace.mapper_trace.final,
    cpu: prefixTrace.final_cpu,
  };
  expect(validateInput(resumed)).toBe(true);
  const resumedResult = await client.callTool({
    name: contract.name,
    arguments: resumed,
  });
  expect(resumedResult.isError).not.toBe(true);
  expect(validateOutput(resumedResult.structuredContent)).toBe(true);
  expect(
    contract.outputSchema.parse(resumedResult.structuredContent)
      .normalized_result.code_trace,
  ).toMatchObject({ stop: { reason: "return" }, final_cpu: { a: 0x55 } });
  for (const cpu of [
    { a: 1, register_bits: { a: { mask: 3, value: 0 } } },
    { register_bits: {} },
    { register_bits: { pc: { mask: 3, value: 0 } } },
    { register_bits: { a: { mask: 3, value: 4 } } },
    { register_bits: { a: { mask: 255, value: 0 } } },
  ]) {
    const input = { path, ...partial.input, cpu };
    expect(validateInput(input)).toBe(false);
    expect(
      (await client.callTool({ name: contract.name, arguments: input }))
        .isError,
    ).toBe(true);
  }
}

cliTest(
  "traces MMC5 multiplier and ExRAM sources, modes, RMW and snapshots through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc5-cpu-");
    const client = await connectTestMcp("mmc5-cpu");
    const { input: validateInput, output: validateOutput } = (
      await mcpContractsFor(client)
    )("trace_nes_code");
    const contract = toolContract("trace_nes_code");
    for (const fixture of mmc5CpuFixtures()) {
      const path = join(root, `${fixture.name}.nes`);
      await writeFile(path, fixture.bytes);
      const input = { path, ...fixture.input };
      expect(validateInput(input)).toBe(true);
      const evidence = toolContract("trace_nes_code").outputSchema.parse(
        await (
          await createToolDelivery(client, cli)
        ).invoke("trace-nes-code", input),
      );
      expect(evidence.subject?.digest?.sha256).toBe(
        createHash("sha256").update(fixture.bytes).digest("hex"),
      );
      const trace = evidence.normalized_result.code_trace;
      if (trace.status !== "derived") throw new Error(trace.reason);
      expect(trace.stop.reason, fixture.name).toBe(fixture.stop);
      expect(trace.final_cpu.a).toBe(fixture.a);
      verifyDeviceSources(trace, fixture);
      await replay(client, path, fixture, trace);
      if (fixture.stop === "return") {
        const explored = await exploreNesThroughMcp(client, input);

        expect(explored.normalized_result.code_exploration).toMatchObject({
          paths: [{ trace }],
        });
      }
      expect(await readFile(path)).toEqual(fixture.bytes);
    }
    await verifyCpuContinuation(client, root, validateInput, validateOutput);
    for (const value of [256, { mask: 3, value: 4 }]) {
      const input = {
        path: join(root, "devices.nes"),
        initial: { mapper: 5, exram: { "0": value } },
      };
      expect(validateInput(input)).toBe(false);
      expect(
        (await client.callTool({ name: contract.name, arguments: input }))
          .isError,
      ).toBe(true);
    }
    for (const key of ["00", "-1", "1024", "1.0"]) {
      const input = {
        path: join(root, "devices.nes"),
        initial: { mapper: 5, exram: { [key]: 1 } },
      };
      expect(validateInput(input)).toBe(false);
      expect(
        (await client.callTool({ name: contract.name, arguments: input }))
          .isError,
      ).toBe(true);
    }
  },
  120_000,
);
