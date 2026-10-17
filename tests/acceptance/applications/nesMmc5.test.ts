import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
} from "../../support/nesSourceDelivery.js";
import {
  connectTestMcp,
  createToolDelivery,
  mcpContractsFor,
} from "../../support/cliMcpDelivery.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { mmc5Fixture } from "../../../src/domain/nesMmc5.fixture.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const ramProgram = (selfSwitch = false) => {
  const fixture = mmc5Fixture();
  const ram = [0xa9, 0x82, 0x8d, 0x16, 0x51, 0x4c, 0xff, 0xbf];
  const program = [
    0xa9,
    2,
    0x8d,
    2,
    0x51,
    0xa9,
    1,
    0x8d,
    3,
    0x51,
    ...ram.flatMap((value, index) => [0xa9, value, 0x8d, index, 0x80]),
    0xa9,
    0,
    0x8d,
    2,
    0x51,
    0xee,
    0,
    0x80,
    0x4c,
    0,
    selfSwitch ? 0xc0 : 0x80,
  ];
  fixture.bytes.set(program, fixture.prgOffset + 7 * 8192);
  fixture.bytes[fixture.prgOffset + 6 * 8192 - 1] = 0xa9;
  fixture.bytes.set([0x5a, 0x4c, 0x10, 0xa0], fixture.prgOffset + 2 * 8192);
  fixture.bytes.set([0x4c, 0xff, 0xbf], fixture.prgOffset + 2 * 8192 + 5);
  fixture.bytes.set([0xa9, 0x77, 0x60], fixture.prgOffset + 5 * 8192 + 16);
  return {
    ...fixture,
    name: selfSwitch ? "self-switch-ram" : "upper-ram",
    input: {
      entry: 0xe000,
      initial: {
        mapper: 5,
        prg_mode: 3,
        prg_banks: [0, 1, 0x85, selfSwitch ? 1 : 2, 7],
        ram_wiring: "ewrom",
      },
    },
    expected: 0x77,
  };
};

const mixedProgram = (capacity: boolean) => {
  const fixture = mmc5Fixture(capacity ? 11 : 7, capacity ? 128 : 8);
  const code = [0xa9, 0x44, 0x60];
  for (let bank = 0; bank < (capacity ? 128 : 1); bank++)
    fixture.bytes.set(code, fixture.prgOffset + bank * 8192 + 0x100);
  return {
    ...fixture,
    name: capacity ? "all-sources" : "mixed-source",
    input: {
      entry: 0x8100,
      initial: {
        mapper: 5,
        prg_mode: 3,
        prg_banks: [
          0,
          capacity ? null : { mask: 127, value: 0 },
          0x81,
          0x82,
          7,
        ],
        ram_wiring: capacity ? "linear-128k" : "ekrom",
      },
      initial_prg_ram: Array.from({ length: capacity ? 16 : 1 }, (_, bank) =>
        code.map((value, index) => ({ bank, address: 0x6100 + index, value })),
      ).flat(),
    },
    expected: 0x44,
  };
};

const uncertainStoreProgram = () => {
  const fixture = mmc5Fixture(7);
  fixture.bytes[fixture.prgOffset] = 0xa5;
  fixture.bytes.set(
    [
      0xa9, 0xa7, 0x8d, 0, 0x80, 0xa9, 1, 0x2d, 0, 0x80, 0xf0, 3, 0x4c, 0x10,
      0xa0, 0x60,
    ],
    fixture.prgOffset + 7 * 8192,
  );
  fixture.bytes.set([0xa9, 0x55, 0x60], fixture.prgOffset + 8192 + 16);
  return {
    ...fixture,
    name: "uncertain-store",
    expected: 0x55,
    input: {
      entry: 0xe000,
      initial: {
        mapper: 5,
        prg_mode: 3,
        prg_banks: [0, { mask: 127, value: 0 }, 129, 130, 7],
        ram_wiring: "ekrom",
        ram_protect: [2, 1],
      },
      initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0xa5 }],
    },
  };
};

function verifySources(trace: NesCodePath, bytes: Buffer) {
  for (const instruction of trace.instructions) {
    const code = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries())
      if (offset !== null) expect(bytes[offset]).toBe(code[index]);
    for (const origin of instruction.ram_origins) {
      expect(origin.region).toBe("prg-ram");
      if (origin.region !== "prg-ram")
        throw new Error("Expected cartridge RAM");
      expect(origin.bank).toBe(1);
      if (!("instruction_index" in origin))
        throw new Error("Expected source-backed upper RAM write");
      expect(origin.instruction_index).toBeLessThan(instruction.index);
      const write =
        trace.instructions[origin.instruction_index]!.writes[
          origin.write_index
        ]!;
      expect(write).toMatchObject({
        address: origin.ram_address + 0x2000,
        value: code[origin.byte_index],
      });
    }
    for (const origin of instruction.mapper_origins) {
      if (origin.kind !== "mmc5-window")
        throw new Error("Expected MMC5 source mux");
      for (const source of origin.source_candidates) {
        expect(source.value).toBe(code[origin.byte_index]);
        if (source.kind === "rom")
          expect(bytes[source.file_offset]).toBe(source.value);
        else
          expect(source).toMatchObject({
            ram_address:
              0x6100 + origin.byte_index + (instruction.address - 0x8100),
            source: { kind: "initial-prg-ram" },
          });
      }
    }
  }
}

function verifyScenario(
  trace: NesCodePath,
  fixture:
    | ReturnType<typeof ramProgram>
    | ReturnType<typeof mixedProgram>
    | ReturnType<typeof uncertainStoreProgram>,
) {
  if (fixture.name.endsWith("-ram")) {
    expect(trace.instructions.find((i) => i.address === 0xbfff)).toMatchObject({
      bytes_hex: "a95a",
      file_offsets: [
        fixture.prgOffset + 6 * 8192 - 1,
        fixture.prgOffset + 2 * 8192,
      ],
    });
    expect(
      trace.instructions
        .find((i) => i.mnemonic === "INC")!
        .writes.map((w) => w.value),
    ).toEqual([0xa9, 0xaa]);
    expect(
      trace.instructions.find(
        (i) => i.address === (fixture.name === "upper-ram" ? 0x8000 : 0xc000),
      )!.ram_origins,
    ).toHaveLength(2);
  } else if (fixture.name === "uncertain-store") {
    expect(
      trace.instructions.find((i) => i.mnemonic === "AND")!.data_reads[0],
    ).toMatchObject({
      address: 0x8000,
      value: null,
      known_bits: { mask: 253, value: 165 },
      file_offset: null,
      mapper_origins: [
        {
          kind: "mmc5-window",
          source_candidates: [
            {
              kind: "ram",
              bank: 0,
              ram_address: 0x6000,
              value: { mask: 253, value: 165 },
              source: { kind: "initial-prg-ram", index: 0 },
            },
            { kind: "rom", file_offset: fixture.prgOffset, value: 165 },
          ],
        },
      ],
    });
  } else
    expect(trace.instructions[0]!.mapper_origins[0]).toMatchObject({
      kind: "mmc5-window",
      source_candidates: expect.any(Array),
    });
  if (fixture.name === "all-sources") {
    const origin = trace.instructions[0]!.mapper_origins[0]!;
    if (origin.kind !== "mmc5-window") throw new Error("Missing mux origin");
    expect(origin.source_candidates).toHaveLength(144);
  }
}

cliTest(
  "traces MMC5 upper RAM, source mux candidates and bank switching through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc5-");
    const client = await connectTestMcp("mmc5");
    const { input: validateInput } = (await mcpContractsFor(client))(
      "trace_nes_code",
    );
    const contract = toolContract("trace_nes_code");
    for (const fixture of [
      ramProgram(),
      ramProgram(true),
      uncertainStoreProgram(),
      mixedProgram(false),
      mixedProgram(true),
    ]) {
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
      expect(trace.stop.reason).toBe("return");
      expect(trace.final_cpu.a).toBe(fixture.expected);
      verifySources(trace, fixture.bytes);
      verifyScenario(trace, fixture);
      const writes = trace.instructions.flatMap((i) => i.writes);
      const replay = await replayNesThroughMcp(client, {
        path,
        initial: input.initial,
        writes,
      });

      expect(replay.normalized_result.trace).toEqual(trace.mapper_trace);
      const events = await client.callTool({
        name: "trace_nes_mapper_events",
        arguments: {
          path,
          initial: input.initial,
          events: writes.map((write) => ({ kind: "cpu-write", ...write })),
        },
      });
      expect(events.isError).not.toBe(true);
      if (trace.mapper_trace.status !== "derived")
        throw new Error(trace.mapper_trace.reason);
      expect(
        toolContract("trace_nes_mapper_events").outputSchema.parse(
          events.structuredContent,
        ).normalized_result.trace,
      ).toMatchObject({
        final: trace.mapper_trace.final,
        final_mapping: trace.mapper_trace.final_mapping,
      });
      const explored = await exploreNesThroughMcp(client, input);

      expect(explored.normalized_result.code_exploration).toMatchObject({
        paths: [{ trace }],
      });
      expect(await readFile(path)).toEqual(fixture.bytes);
    }
  },
  120_000,
);
