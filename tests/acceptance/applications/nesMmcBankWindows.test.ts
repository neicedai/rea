import {
  replayNesThroughMcp,
  exploreNesThroughMcp,
  createNesSourceCaller,
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
import {
  mmc1RamCodeFixture,
  mmc1OuterCodeFixture,
  mmc1WriteProgram,
  mmc3RamCodeFixture,
  nesCodeFixture,
} from "../../../src/domain/nesCode.fixture.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const mmc1Fixture = (missingAddressBit: boolean) => {
  // Resume four retained serial bits, then commit with a source-backed fifth write.
  const program = [0xa9, 0, 0x8d, 0, 0xe0, 0x4c, 0xff, 0xbf];
  const fixture = nesCodeFixture(1, []);
  fixture.bytes.set(program, fixture.prgOffset + 3 * 16384 + 0x100);
  fixture.bytes.set([0xa9, 0x77, 0x60], fixture.prgOffset + 16384);
  fixture.bytes[fixture.prgOffset + 2 * 16384 - 1] = 0xa9;
  fixture.bytes.set([0x5a, 0x4c, 0, 0x80], fixture.prgOffset + 3 * 16384);
  fixture.bytes.writeUInt16LE(0xc100, fixture.prgOffset + fixture.prgSize - 4);
  return {
    ...fixture,
    initial: {
      mapper: 1,
      prg_mode: 3,
      prg_bank: 0,
      shift_bits: [1, missingAddressBit ? null : 0, null, null],
    },
    banks: missingAddressBit ? [null, 3] : [1, 3],
  };
};

const mmc3Fixture = () => {
  const fixture = nesCodeFixture(
    4,
    [
      0xa9, 6, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 1, 0x80, 0xa9, 7, 0x8d, 0, 0x80,
      0xa9, 4, 0x8d, 1, 0x80, 0x4c, 0xff, 0x9f,
    ],
  );
  fixture.bytes[fixture.prgOffset + 3 * 8192 - 1] = 0xa9;
  fixture.bytes.set(
    [0x5a, 0xa9, 0x46, 0x8d, 0, 0x80, 0x4c, 0x10, 0x80],
    fixture.prgOffset + 4 * 8192,
  );
  fixture.bytes.set([0x4c, 0x10, 0xc0], fixture.prgOffset + 6 * 8192 + 16);
  fixture.bytes.set(
    [0xa9, 0x47, 0x8d, 0, 0x80, 0xa9, 5, 0x8d, 1, 0x80, 0x4c, 0xff, 0xbf],
    fixture.prgOffset + 2 * 8192 + 16,
  );
  fixture.bytes[fixture.prgOffset + 6 * 8192 - 1] = 0xa9;
  fixture.bytes.set([0x66, 0x4c, 0x10, 0xa0], fixture.prgOffset + 2 * 8192);
  fixture.bytes.set([0xa9, 0x77, 0x60], fixture.prgOffset + 5 * 8192 + 16);
  return {
    ...fixture,
    initial: {
      mapper: 4,
      bank_select: 0,
      banks: [null, null, null, null, null, null, 0, 1],
    },
    banks: [6, 5, 2, 7],
  };
};

const ramBitFixtures = () => {
  const cases = [
    { mapper: 1, name: "bank-agreement", second: 0xa7 },
    { mapper: 1, name: "uncertain-bank-store", second: 0xa7, store: 0xa7 },
    { mapper: 1, name: "missing-bank" },
    { mapper: 1, name: "different-bit", second: 0xa6 },
    { mapper: 1, name: "no-common-bits", second: 0x5a },
    { mapper: 4, name: "uncertain-permission", store: 0xa7 },
    { mapper: 4, name: "partial-rmw", store: 0xa7, rmw: true },
    { mapper: 4, name: "different-store-bit", store: 0xa6 },
    { mapper: 4, name: "unknown-store", store: null },
    { mapper: 4, name: "protected-store", store: 0xa7, protect: 0xc0 },
    { mapper: 4, name: "definite-store", store: 0xa7, protect: 0x80 },
  ] as const;
  return cases.map((scenario) => {
    const mapper = scenario.mapper;
    const store =
      "store" in scenario
        ? [
            ...(scenario.store === null
              ? [0xad, 2, 0x20]
              : [0xa9, scenario.store]),
            0x8d,
            0,
            0x65,
          ]
        : [];
    const switchBank =
      mapper === 1
        ? mmc1WriteProgram(0xe000, 1)
        : [0xa9, 6, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 1, 0x80];
    const body = [...switchBank, 0x4c, 0, 0x80];
    const program = [
      ...store,
      ...("rmw" in scenario ? [0xee, 0, 0x65] : []),
      ...(mapper === 4 ? [0xa9, 0x80, 0x8d, 1, 0xa0] : []),
      0xa9,
      "rmw" in scenario ? 0x80 : 1,
      0x2d,
      0,
      0x65,
      0xf0,
      body.length,
      ...body,
      0x60,
    ];
    const fixture =
      mapper === 1
        ? mmc1RamCodeFixture(program, true)
        : mmc3RamCodeFixture(program);
    if (mapper === 1) fixture.bytes[10] = 8; // SOROM: two physical RAM banks.
    fixture.bytes.set([0xa9, 0x77, 0x60], fixture.prgOffset + 16384);
    const initial_prg_ram = [{ bank: 0, address: 0x6500, value: 0xa5 }];
    if ("second" in scenario)
      initial_prg_ram.push({
        bank: 1,
        address: 0x6500,
        value: scenario.second,
      });
    const initial =
      mapper === 1
        ? {
            mapper,
            prg_mode: 3,
            prg_bank: 0,
            prg_ram_disable_bit: 0,
            chr_mode: 1,
            chr_bank_0: 0,
            chr_bank_1: 8,
            shift_bits: [],
          }
        : {
            mapper,
            ram_protect:
              "protect" in scenario
                ? scenario.protect
                : { mask: 128, value: 128 },
          };
    const complete =
      scenario.name === "protected-store"
        ? 0xa5
        : scenario.name === "definite-store"
          ? 0xa7
          : null;
    const known_bits =
      complete !== null ||
      ["missing-bank", "no-common-bits", "unknown-store"].includes(
        scenario.name,
      )
        ? undefined
        : {
            mask:
              "rmw" in scenario
                ? 240
                : scenario.name.startsWith("different-")
                  ? 252
                  : 253,
            value:
              "rmw" in scenario
                ? 160
                : scenario.name.startsWith("different-")
                  ? 164
                  : 165,
          };
    return {
      ...fixture,
      name: scenario.name,
      input: { initial, initial_prg_ram },
      complete,
      known_bits,
      resolves:
        complete !== null || known_bits?.mask === 253 || "rmw" in scenario,
    };
  });
};

function verifySources(
  trace: NesCodePath,
  bytes: Buffer,
  mapper: number,
  missing: boolean,
) {
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  if (missing) {
    expect(trace.stop).toMatchObject({
      reason: "unmapped-instruction",
      address: 0xbfff,
      bytes_hex: "",
    });
    expect(trace.mapper_trace.final).toMatchObject({
      prg_bank: { mask: 1, value: 1 },
    });
  } else {
    expect(
      trace.stop.reason,
      JSON.stringify({
        stop: trace.stop,
        state: trace.mapper_trace.final,
        writes: trace.instructions.flatMap((i) => i.writes),
      }),
    ).toBe("return");
    expect(trace.final_cpu.a).toBe(0x77);
    const boundary = trace.instructions.find(
      (i) => i.address === (mapper === 1 ? 0xbfff : 0x9fff),
    );
    expect(boundary).toMatchObject({
      bytes_hex: "a95a",
      file_offsets:
        mapper === 1
          ? [528 + 2 * 16384 - 1, 528 + 3 * 16384]
          : [528 + 3 * 8192 - 1, 528 + 4 * 8192],
    });
    if (mapper === 1) {
      expect(trace.mapper_trace.final).toMatchObject({
        prg_bank: { mask: 3, value: 1 },
      });
      expect(trace.mapper_trace.final_mapping.prg_view).toBeNull();
    } else {
      expect(
        trace.instructions.find((i) => i.address === 0x8010)?.file_offsets,
      ).toEqual([
        528 + 6 * 8192 + 16,
        528 + 6 * 8192 + 17,
        528 + 6 * 8192 + 18,
      ]);
      expect(
        trace.instructions.find((i) => i.address === 0xbfff),
      ).toMatchObject({
        bytes_hex: "a966",
        file_offsets: [528 + 6 * 8192 - 1, 528 + 2 * 8192],
      });
    }
  }
  for (const instruction of trace.instructions) {
    const code = Buffer.from(instruction.bytes_hex, "hex");
    expect(instruction.ram_origins).toEqual([]);
    for (const [index, offset] of instruction.file_offsets.entries()) {
      expect(offset).not.toBeNull();
      expect(bytes[offset!]).toBe(code[index]);
    }
  }
}

async function verifyMmc1ModeCalls(
  cli: TestCli,
  client: Client,
  root: string,
  validateOutput: (value: unknown) => boolean,
) {
  const modes = [0, 1, 2, 3];
  const program = [
    ...modes.flatMap((mode) => [
      ...mmc1WriteProgram(0x8000, mode << 2),
      0x20,
      0xff,
      0xbf,
    ]),
    0x60,
  ];
  const fixture = mmc1RamCodeFixture([], true);
  // The operand bytes live in bank 3, independently of the lower window.
  fixture.bytes.set([0x00, 0xc1, 0x60], fixture.prgOffset + 3 * 16384);
  fixture.bytes.set([0xa9, 0x77, 0x60], fixture.prgOffset + 3 * 16384 + 0x100);
  for (const bank of [0, 2, 3])
    fixture.bytes[fixture.prgOffset + (bank + 1) * 16384 - 1] = 0x20;
  const path = join(root, "mmc1-all-mode-calls.nes");
  await writeFile(path, fixture.bytes);
  const input = {
    path,
    initial_cpu_bus: { model: "nmos-6502-bus", dma_reads: "absent" },
    entry: 0x0200,
    cpu: { sp: 0xff },
    initial: {
      mapper: 1,
      prg_mode: 3,
      prg_bank: 3,
      prg_ram_disable_bit: 0,
      chr_mode: 0,
      chr_bank_0: 0,
      shift_bits: [],
    },
    initial_ram: program.map((value, index) => ({
      address: 0x0200 + index,
      value,
    })),
  };
  const { trace, evidence } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(validateOutput(evidence)).toBe(true);
  expect(trace.stop).toMatchObject({
    reason: "unknown-control-target",
    address: 0x0200 + program.length - 1,
  });
  expect(trace.final_cpu.a).toBe(0x77);
  expect(trace.final_cpu.sp).toBe(0xff);
  const calls = trace.instructions.filter((i) => i.address === 0xbfff);
  expect(calls).toHaveLength(4);
  for (const [mode, instruction] of calls.entries()) {
    if (!("cpu_bus_cycles" in instruction))
      throw new Error("Missing ordered JSR reads");
    expect(instruction.cpu_bus_cycles.map((cycle) => cycle.role)).toEqual([
      "opcode",
      "operand",
      "dummy",
      "stack",
      "stack",
      "operand",
    ]);
    const high = instruction.cpu_bus_cycles[5]!;
    expect(high).toMatchObject({
      kind: "read",
      read: { address: 0xc001, file_offset: instruction.file_offsets[2] },
    });
    const lowerBank = mode < 2 ? 2 : mode === 2 ? 0 : 3;
    expect(instruction).toMatchObject({
      mnemonic: "JSR",
      bytes_hex: "2000c1",
      file_offsets: [
        fixture.prgOffset + (lowerBank + 1) * 16384 - 1,
        fixture.prgOffset + 3 * 16384,
        fixture.prgOffset + 3 * 16384 + 1,
      ],
    });
  }
  expect(trace.instructions.filter((i) => i.address === 0xc002)).toHaveLength(
    4,
  );
  for (const instruction of trace.instructions) {
    const bytes = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries())
      if (offset !== null) expect(fixture.bytes[offset]).toBe(bytes[index]);
  }
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  expect(trace.mapper_trace.nes_prg_views).toEqual(
    modes.map((prg_mode) => ({ mapper: 1, prg_mode, prg_bank: 3 })),
  );
  const replay = await replayNesThroughMcp(client, {
    path,
    initial: input.initial,
    writes: trace.instructions
      .flatMap((i) => i.writes)
      .filter((write) => write.address >= 0x8000),
  });

  expect(replay.normalized_result.trace).toEqual(trace.mapper_trace);
  const explored = await exploreNesThroughMcp(client, input);

  expect(explored.normalized_result.code_exploration).toMatchObject({
    paths: [{ trace }],
  });
  expect(await readFile(path)).toEqual(fixture.bytes);
}

async function verifyPartialOuterBank(
  cli: TestCli,
  client: Client,
  root: string,
  validateInput: (value: unknown) => boolean,
  validateOutput: (value: unknown) => boolean,
) {
  const fixture = mmc1OuterCodeFixture(2);
  fixture.bytes.set([0xa9, 0x79, 0x60], fixture.prgOffset + 18 * 16384);
  const path = join(root, "mmc1-partial-outer-and-ram.nes");
  await writeFile(path, fixture.bytes);
  for (const knownOuter of [true, false]) {
    const program = [
      ...(knownOuter ? [0xa9, 1] : [0xad, 2, 0x20, 0x29, 1]),
      0x8d,
      0,
      0xa0,
      0x4c,
      0,
      0x65,
    ];
    const initial_prg_ram = [2, 3].flatMap((bank) =>
      [0x4c, 0, 0x80].map((value, index) => ({
        bank,
        address: 0x6500 + index,
        value,
      })),
    );
    const input = {
      path,
      entry: 0x0200,
      initial: {
        mapper: 1,
        prg_mode: 3,
        prg_bank: 2,
        prg_ram_disable_bit: 0,
        chr_mode: 0,
        chr_bank_0: { mask: 24, value: 0 },
        shift_bits: [null, null, null, 1],
      },
      initial_ram: program.map((value, index) => ({
        address: 0x0200 + index,
        value,
      })),
      initial_prg_ram,
    };
    expect(validateInput(input)).toBe(true);
    const { trace, evidence } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(validateOutput(evidence)).toBe(true);
    expect(trace.stop.reason).toBe(
      knownOuter ? "return" : "unmapped-instruction",
    );
    if (trace.mapper_trace.status !== "derived")
      throw new Error(trace.mapper_trace.reason);
    expect(trace.mapper_trace.final).toMatchObject({
      chr_bank_0: { mask: knownOuter ? 24 : 8, value: knownOuter ? 24 : 8 },
      shift_bits: [],
    });
    expect(
      trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
    ).toEqual(knownOuter ? [18, 31] : [null, null]);
    const ramJump = trace.instructions.find((i) => i.address === 0x6500)!;
    expect(ramJump.bytes_hex).toBe("4c0080");
    expect(ramJump.file_offsets).toEqual([null, null, null]);
    expect(ramJump.ram_origins).toEqual(
      [0, 1, 2].flatMap((byte_index) =>
        [2, 3].map((bank) => ({
          byte_index,
          region: "prg-ram",
          bank,
          ram_address: 0x6500 + byte_index,
          initial_prg_ram_index: (bank - 2) * 3 + byte_index,
        })),
      ),
    );
    if (knownOuter) {
      expect(trace.final_cpu.a).toBe(0x79);
      expect(
        trace.instructions.find((i) => i.address === 0x8000),
      ).toMatchObject({
        bytes_hex: "a979",
        file_offsets: [
          fixture.prgOffset + 18 * 16384,
          fixture.prgOffset + 18 * 16384 + 1,
        ],
      });
      const continued = await (
        await createNesSourceCaller(cli, client)
      ).code({
        ...input,
        entry: 0x6500,
        initial: trace.mapper_trace.final,
      });
      expect(continued.trace.final_cpu.a).toBe(0x79);
    } else expect(trace.stop.address).toBe(0x8000);
    const writes = trace.instructions.flatMap((i) => i.writes);
    for (const name of [
      "trace_nes_mapper_writes",
      "trace_nes_mapper_events",
    ] as const) {
      const replay = await client.callTool({
        name,
        arguments: {
          path,
          initial: input.initial,
          ...(name === "trace_nes_mapper_writes"
            ? { writes }
            : {
                events: writes.map((write) => ({
                  kind: "cpu-write",
                  ...write,
                })),
              }),
        },
      });
      expect(replay.isError).not.toBe(true);
      expect(
        toolContract(name).outputSchema.parse(replay.structuredContent)
          .normalized_result.trace,
      ).toMatchObject({
        final: trace.mapper_trace.final,
        final_mapping: trace.mapper_trace.final_mapping,
      });
    }
    const explored = await exploreNesThroughMcp(client, input);

    expect(explored.normalized_result.code_exploration).toMatchObject({
      paths: [{ trace }],
    });
    for (const instruction of trace.instructions)
      for (const [index, offset] of instruction.file_offsets.entries())
        if (offset !== null)
          expect(fixture.bytes[offset]).toBe(
            Buffer.from(instruction.bytes_hex, "hex")[index],
          );
    expect(
      toolContract("trace_nes_code").outputSchema.parse(evidence).subject
        ?.digest?.sha256,
    ).toBe(createHash("sha256").update(fixture.bytes).digest("hex"));
  }
  expect(await readFile(path)).toEqual(fixture.bytes);
}

async function verifyRamBits({
  cli,
  client,
  root,
  validateInput,
  validateOutput,
}: {
  cli: TestCli;
  client: Client;
  root: string;
  validateInput: (value: unknown) => boolean;
  validateOutput: (value: unknown) => boolean;
}) {
  for (const fixture of ramBitFixtures()) {
    const path = join(root, `${fixture.name}.nes`);
    await writeFile(path, fixture.bytes);
    const input = { path, ...fixture.input };
    expect(validateInput(input), fixture.name).toBe(true);
    const { trace, evidence } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(validateOutput(evidence), fixture.name).toBe(true);
    const read = trace.instructions.find((i) => i.mnemonic === "AND")!
      .data_reads[0]!;
    expect(read, fixture.name).toMatchObject({
      address: 0x6500,
      value: fixture.complete,
      file_offset: null,
      mapper_origins: [],
    });
    expect(
      "known_bits" in read ? read.known_bits : undefined,
      fixture.name,
    ).toEqual(fixture.known_bits);
    if (fixture.name === "partial-rmw")
      expect(trace.instructions[2]!.writes).toEqual([
        {
          address: 0x6500,
          value: null,
          known_bits: { mask: 253, value: 165 },
          preceded_by_cpu_write: false,
        },
        {
          address: 0x6500,
          value: null,
          known_bits: { mask: 241, value: 160 },
          preceded_by_cpu_write: true,
        },
      ]);
    const hasProof =
      fixture.complete !== null || fixture.known_bits !== undefined;
    expect(read.ram_origins, fixture.name).toEqual(
      !hasProof
        ? []
        : fixture.name === "definite-store"
          ? [
              {
                byte_index: 0,
                region: "prg-ram",
                bank: 0,
                ram_address: 0x6500,
                instruction_index: 1,
                write_index: 0,
              },
            ]
          : fixture.input.initial_prg_ram.map((item, index) => ({
              byte_index: 0,
              region: "prg-ram",
              bank: item.bank,
              ram_address: item.address,
              initial_prg_ram_index: index,
            })),
    );
    if (fixture.resolves) {
      expect(trace.stop.reason, fixture.name).toBe("return");
      expect(trace.final_cpu.a).toBe(0x77);
      expect(
        trace.instructions.find((i) => i.address === 0x8000),
      ).toMatchObject({
        bytes_hex: "a977",
        file_offsets: [fixture.prgOffset + 16384, fixture.prgOffset + 16385],
      });
      const explored = await exploreNesThroughMcp(client, input);

      expect(explored.normalized_result.code_exploration).toMatchObject({
        paths: [{ trace }],
      });
    } else expect(trace.stop.reason, fixture.name).toBe("unknown-branch");
    if (
      fixture.name.includes("store") ||
      fixture.name === "uncertain-permission"
    )
      expect(trace.instructions[1]!.writes[0]).toMatchObject({
        address: 0x6500,
        value:
          fixture.name === "unknown-store"
            ? null
            : fixture.name === "different-store-bit"
              ? 0xa6
              : 0xa7,
      });
    for (const instruction of trace.instructions)
      for (const [index, offset] of instruction.file_offsets.entries()) {
        expect(offset).not.toBeNull();
        expect(fixture.bytes[offset!]).toBe(
          Buffer.from(instruction.bytes_hex, "hex")[index],
        );
      }
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
}

async function verifyInvalidSelectors(
  client: Client,
  path: string,
  validateInput: (value: unknown) => boolean,
) {
  for (const field of ["prg_bank", "chr_bank_0"] as const) {
    const maximum = field === "prg_bank" ? 15 : 31;
    for (const bank of [
      { mask: 1, value: 2 },
      { mask: maximum + 1, value: 0 },
      maximum + 1,
    ]) {
      const invalid = { path, initial: { mapper: 1, [field]: bank } };
      expect(validateInput(invalid)).toBe(false);
      expect(
        toolContract("trace_nes_code").inputSchema.safeParse(invalid).success,
      ).toBe(false);
      expect(
        (await client.callTool({ name: "trace_nes_code", arguments: invalid }))
          .isError,
      ).toBe(true);
    }
  }
}

cliTest(
  "traces MMC1 and MMC3 multi-window sources and preserves partial selectors through replay",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc-windows-");
    const client = await connectTestMcp("mmc-windows");
    const { input: validateInput, output: validateOutput } = (
      await mcpContractsFor(client)
    )("trace_nes_code");
    for (const fixture of [
      mmc1Fixture(false),
      mmc1Fixture(true),
      mmc3Fixture(),
    ]) {
      const missing = fixture.banks[0] === null;
      const path = join(
        root,
        `mapper-${fixture.initial.mapper}-${missing}.nes`,
      );
      await writeFile(path, fixture.bytes);
      const input = { path, initial: fixture.initial };
      expect(validateInput(input)).toBe(true);
      const { trace, evidence } = await (
        await createNesSourceCaller(cli, client)
      ).code(input);
      const timed = await (
        await createNesSourceCaller(cli, client)
      ).code({
        ...input,
        initial_cpu_bus: { model: "nmos-6502-bus", dma_reads: "absent" },
      });
      expect(
        validateOutput(timed.evidence),
        JSON.stringify(validateOutput.errors),
      ).toBe(true);
      expect(
        timed.trace.instructions.map((instruction) => {
          if (!("cpu_bus_cycles" in instruction))
            throw new Error("Missing ordered bus");
          for (const cycle of instruction.cpu_bus_cycles)
            if (cycle.kind === "read" && cycle.read.file_offset !== null)
              expect(cycle.read.value).toBe(
                fixture.bytes[cycle.read.file_offset],
              );
          const { cpu_bus_cycles, ...semantic } = instruction;
          expect(cpu_bus_cycles.length).toBeGreaterThanOrEqual(2);
          return semantic;
        }),
      ).toEqual(trace.instructions);
      expect(timed.trace.mapper_trace).toEqual(trace.mapper_trace);
      expect(
        validateOutput(evidence),
        JSON.stringify(validateOutput.errors),
      ).toBe(true);
      expect(
        toolContract("trace_nes_code").outputSchema.parse(evidence).subject
          ?.digest?.sha256,
      ).toBe(createHash("sha256").update(fixture.bytes).digest("hex"));
      verifySources(trace, fixture.bytes, fixture.initial.mapper, missing);
      if (trace.mapper_trace.status !== "derived")
        throw new Error(trace.mapper_trace.reason);
      expect(
        trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
      ).toEqual(fixture.banks);
      const replay = await replayNesThroughMcp(client, {
        ...input,
        writes: trace.instructions.flatMap((i) => i.writes),
      });

      expect(replay.normalized_result.trace).toEqual(trace.mapper_trace);
      const events = await client.callTool({
        name: "trace_nes_mapper_events",
        arguments: {
          ...input,
          events: trace.instructions
            .flatMap((i) => i.writes)
            .map((write) => ({ ...write, kind: "cpu-write" })),
        },
      });
      expect(events.isError).not.toBe(true);
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
      const continued = await (
        await createNesSourceCaller(cli, client)
      ).code({
        ...input,
        initial: trace.mapper_trace.final,
        entry: fixture.initial.mapper === 1 ? 0x8000 : 0xa010,
      });
      if (!missing) expect(continued.trace.final_cpu.a).toBe(0x77);
      else expect(continued.trace.stop.reason).toBe("unmapped-instruction");
      expect(await readFile(path)).toEqual(fixture.bytes);
    }
    await verifyMmc1ModeCalls(cli, client, root, validateOutput);
    await verifyPartialOuterBank(
      cli,
      client,
      root,
      validateInput,
      validateOutput,
    );
    await verifyRamBits({ cli, client, root, validateInput, validateOutput });
    await verifyInvalidSelectors(
      client,
      join(root, "invalid.nes"),
      validateInput,
    );
  },
  180_000,
);
