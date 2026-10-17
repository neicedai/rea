import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
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
import { vrc4RamFixture } from "../../../src/domain/nesVrc4Ram.fixture.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const contract = toolContract("trace_nes_code");
const cases = [
  [21, 1, 2, "internal-2k", 5],
  [21, 2, 7, "external-8k", 0x70],
  [23, 1, 1, "internal-2k", 0x50],
  [23, 2, 3, "external-8k", 7],
  [25, 1, 0, "internal-2k", 5],
  [25, 2, 2, "external-8k", 0x70],
] as const;

async function throughAdapters(
  cli: TestCli,
  client: Client,
  input: Record<string, unknown>,
  bytes: Buffer,
) {
  const result = await cli.run({
    arguments: ["trace-nes-code", JSON.stringify(input), "--json"],
  });
  expect(result.exitCode).toBe(0);
  const response = await client.callTool({
    name: contract.name,
    arguments: input,
  });
  expect(response.isError).not.toBe(true);
  const evidence = contract.outputSchema.parse(response.structuredContent);
  const fromCli = contract.outputSchema.parse(result.json);
  expect(evidence.evidence_id).toBe(fromCli.evidence_id);
  expect(evidence.normalized_result).toEqual(fromCli.normalized_result);
  expect(evidence.subject?.digest?.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  return { trace, raw: response.structuredContent };
}

function verifySources(
  trace: NesCodePath,
  fixture: ReturnType<typeof vrc4RamFixture>,
  seeded: boolean,
) {
  expect(trace.stop.reason).toBe("return");
  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.instructions.at(-1)?.file_offsets).toEqual([
    528 + 2 * 8192,
    528 + 2 * 8192 + 1,
  ]);
  expect(trace.stop.file_offsets).toEqual([528 + 2 * 8192 + 2]);
  const internal = fixture.initial.prg_ram_wiring === "internal-2k";
  const base = internal ? 0x6000 : 0x6800;
  const ram = trace.instructions.filter(
    (i) => i.address >= 0x6800 && i.address < 0x6800 + fixture.routine.length,
  );
  expect(ram).toHaveLength(7);
  for (const instruction of trace.instructions) {
    if (instruction.address >= 0x8000) {
      expect(instruction.file_offsets.every((offset) => offset !== null)).toBe(
        true,
      );
      expect(instruction.ram_origins).toEqual([]);
    }
    const code = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries())
      if (offset !== null) expect(fixture.bytes[offset]).toBe(code[index]);
  }
  for (const instruction of ram) {
    const offset = instruction.address - 0x6800;
    const size = instruction.file_offsets.length;
    expect(instruction.bytes_hex).toBe(
      Buffer.from(fixture.routine.slice(offset, offset + size)).toString("hex"),
    );
    expect(instruction.file_offsets).toEqual(Array(size).fill(null));
    expect(instruction.mapper_origins).toEqual([]);
    expect(instruction.ram_origins).toEqual(
      Array.from({ length: size }, (_, byte_index) => ({
        byte_index,
        region: "prg-ram",
        bank: 0,
        ram_address: base + offset + byte_index,
        ...(seeded
          ? { initial_prg_ram_index: offset + byte_index }
          : {
              instruction_index: 11 + 2 * (offset + byte_index),
              write_index: 0,
            }),
      })),
    );
  }
  expect(ram[0]?.data_reads[0]).toMatchObject({
    address: 0x6700,
    value: seeded ? null : internal ? 0x56 : 0x44,
  });
  expect(ram[1]?.data_reads[0]).toMatchObject({
    address: 0x7000,
    value: seeded || internal ? null : 0x66,
  });
  if (!seeded) {
    expect(ram[0]?.data_reads[0]?.ram_origins).toEqual([
      {
        byte_index: 0,
        region: "prg-ram",
        bank: 0,
        ram_address: 0x6700,
        instruction_index: internal ? 55 : 5,
        write_index: internal ? 1 : 0,
      },
    ]);
    expect(trace.instructions[54]?.data_reads[0]).toMatchObject({
      address: 0x6f00,
      value: 0x55,
      ram_origins: [
        {
          ram_address: internal ? 0x6700 : 0x6f00,
          instruction_index: 7,
          write_index: 0,
        },
      ],
    });
    expect(trace.instructions[55]?.writes.map((w) => w.value)).toEqual([
      0x55, 0x56,
    ]);
  }
  if (seeded || internal)
    expect(ram[1]?.data_reads[0]?.ram_origins).toEqual([]);
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  expect(trace.mapper_trace.final).toMatchObject({
    prg_ram_wiring: fixture.initial.prg_ram_wiring,
    prg_control: 3,
  });
  expect(
    trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
  ).toEqual([6, 1, 2, 7]);
}

async function verifyReplay(
  client: Client,
  input: Record<string, unknown>,
  trace: NesCodePath,
) {
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  const replay = await replayNesThroughMcp(client, {
    ...input,
    writes: trace.instructions.flatMap((i) => i.writes),
  });

  const derived = replay.normalized_result.trace;
  if (derived.status !== "derived") throw new Error(derived.reason);
  expect(derived.final).toEqual(trace.mapper_trace.final);
  expect(derived.final_mapping).toEqual(trace.mapper_trace.final_mapping);
  expect(derived.nes_prg_views).toEqual(trace.mapper_trace.nes_prg_views);
  const explored = await exploreNesThroughMcp(client, input);

  expect(explored.normalized_result.code_exploration).toMatchObject({
    paths: [{ trace }],
  });
}

cliTest(
  "traces VRC4 RAM mirrors, gating, RMW origins and bank-switching code across six board profiles",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc4-ram-");
    const client = await connectTestMcp("vrc4-ram");
    const { input: validateInput, output: validateOutput } = (
      await mcpContractsFor(client)
    )("trace_nes_code");
    for (const [mapper, submapper, a1, wiring, declaration] of cases) {
      const fixture = vrc4RamFixture(
        wiring,
        declaration,
        mapper,
        submapper,
        a1,
      );
      const path = join(root, `vrc4-ram-${mapper}-${submapper}.nes`);
      await writeFile(path, fixture.bytes);
      const input = { path, initial: fixture.initial };
      expect(validateInput(input)).toBe(true);
      const { trace, raw } = await throughAdapters(
        cli,
        client,
        input,
        fixture.bytes,
      );
      expect(validateOutput(raw), JSON.stringify(validateOutput.errors)).toBe(
        true,
      );
      verifySources(trace, fixture, false);
      await verifyReplay(client, input, trace);
      const initial_prg_ram = fixture.routine.map((value, index) => ({
        bank: 0,
        address: (wiring === "internal-2k" ? 0x6000 : 0x6800) + index,
        value,
      }));
      const seededInput = {
        path,
        initial: {
          ...fixture.initial,
          prg_control: { mask: 1, value: 1 },
          prg_banks: [0, 1],
        },
        entry: 0x6800,
        initial_prg_ram,
      };
      const seeded = await throughAdapters(
        cli,
        client,
        seededInput,
        fixture.bytes,
      );
      expect(validateOutput(seeded.raw)).toBe(true);
      verifySources(seeded.trace, fixture, true);
      expect(await readFile(path)).toEqual(fixture.bytes);
    }
    const invalid = {
      path: join(root, "invalid.nes"),
      initial: { mapper: 21, variant: "vrc4", prg_ram_wiring: "internal-4k" },
    };
    expect(validateInput(invalid)).toBe(false);
    expect(
      (await client.callTool({ name: contract.name, arguments: invalid }))
        .isError,
    ).toBe(true);
    for (const item of [
      { bank: 0, address: 0x6800, value: 0x60 },
      { bank: 1, address: 0x6000, value: 0x60 },
    ]) {
      const response = await client.callTool({
        name: contract.name,
        arguments: {
          path: join(root, "vrc4-ram-21-1.nes"),
          initial: {
            mapper: 21,
            variant: "vrc4",
            prg_ram_wiring: "internal-2k",
          },
          initial_prg_ram: [item],
        },
      });
      expect(response.isError).not.toBe(true);
      const result = contract.outputSchema.parse(
        response.structuredContent,
      ).normalized_result;
      expect(result.code_trace).toMatchObject({
        status: "unsupported",
        reason: expect.stringContaining("initial_prg_ram"),
      });
      expect(result.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  },
  120000,
);
