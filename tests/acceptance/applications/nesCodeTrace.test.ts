import {
  createToolDelivery,
  createStdioToolClient,
} from "../../support/cliMcpDelivery.js";
import {
  createNesSourceCaller,
  traceNesThroughAdapters,
  replayNesThroughMcp,
  exploreNesThroughMcp,
  traceNesThroughMcp,
} from "../../support/nesSourceDelivery.js";
import type { NesMapperWrite } from "../../../src/domain/nesMapperTrace.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nesCodeExplorationReportSchema } from "../../../src/domain/nesCodeExploration.js";
import { nesCodeTraceReportSchema } from "../../../src/domain/nesCodeTrace.js";
import {
  nesCodeFixture,
  ninaRamCodeFixture,
  mmc3RamCodeFixture,
  mmc3HardwiredCodeFixture,
  mmc6RamCodeFixture,
  mmc4RamCodeFixture,
  mmc1RamCodeFixture,
  mmc1BankedRamCodeFixture,
  mmc1OuterCodeFixture,
  mmc1FixedCodeFixture,
  mmc1WriteProgram,
  mmc1SerialProgram,
  mmc3SwitchCodeFixture,
  nromRamCodeFixture,
  invertedUnromCodeFixture,
} from "../../../src/domain/nesCode.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const contract = toolContract("trace_nes_code");
const verifyInvertedUnrom = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const fixture = invertedUnromCodeFixture();
  const path = join(root, "inverted-unrom.nes");
  await writeFile(path, fixture.bytes);
  const input = { path, entry: 0x8000, initial: { mapper: 180 } };
  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.final_cpu.a).toBe(0x66);
  expect(trace.instructions.at(-1)).toMatchObject({
    address: 0xc005,
    bytes_hex: "a966",
    file_offsets: [16405, 16406],
  });

  const replay = await replayNesThroughMcp(client, {
    path,
    initial: input.initial,
    writes: trace.instructions.flatMap((i) => i.writes),
  });

  expect(replay.normalized_result).toMatchObject({ trace: trace.mapper_trace });

  const explored = await exploreNesThroughMcp(client, input);

  expect(explored.normalized_result).toMatchObject({
    code_exploration: { paths: [{ trace }] },
  });
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyNromRam = async (cli: TestCli, client: Client, root: string) => {
  for (const declaration of [5, 0x60, 7]) {
    const fixture = nromRamCodeFixture(declaration);
    const path = join(root, `nrom-ram-${declaration}.nes`);
    await writeFile(path, fixture.bytes);
    const input = { path, initial: { mapper: 0, prg_ram_write_enabled: true } };
    const { trace } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(trace.final_cpu.a).toBe(0x55);
    expect(trace.instructions.at(-1)).toMatchObject({
      address: 0x6000,
      file_offsets: [null, null],
      ram_origins: [
        { ram_address: 0x6000, bank: 0 },
        { ram_address: 0x6001, bank: 0 },
      ],
    });

    const explored = await exploreNesThroughMcp(client, input);

    expect(explored.normalized_result).toMatchObject({
      code_exploration: { paths: [{ trace }] },
    });
    const unknown = await traceNesThroughMcp(client, {
      path,
      initial: { mapper: 0 },
    });

    expect(unknown.normalized_result).toMatchObject({
      code_trace: { stop: { address: 0x6000, bytes_hex: "", ram_origins: [] } },
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
};

const verifyMmc3Hardwired = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  for (const vertical of [false, true]) {
    const fixture = mmc3HardwiredCodeFixture(vertical);
    const path = join(root, `mmc3-hardwired-${vertical}.nes`);
    await writeFile(path, fixture.bytes);
    const input = { path, initial: { mapper: 4 } };
    const { trace } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(trace.final_cpu.a).toBe(0x66);
    expect(trace.instructions.at(-1)).toMatchObject({
      address: 0x8000,
      file_offsets: [fixture.prgOffset + 16384, fixture.prgOffset + 16385],
    });
    if (trace.mapper_trace.status !== "derived")
      throw new Error(trace.mapper_trace.reason);
    expect(trace.mapper_trace.final).toMatchObject({ mirroring: null });
    expect(trace.mapper_trace.final_mapping.mirroring).toBe(
      vertical ? "vertical" : "horizontal",
    );
    const replay = await replayNesThroughMcp(client, {
      ...input,
      writes: trace.instructions.flatMap((item) => item.writes),
    });

    expect(replay.normalized_result).toMatchObject({
      trace: trace.mapper_trace,
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
};

const verifyMmc6 = async (cli: TestCli, client: Client, root: string) => {
  for (const zero of [false, true]) {
    const fixture = mmc6RamCodeFixture(zero);
    const path = join(root, `mmc6-${zero}.nes`);
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: zero
        ? {
            mapper: 4,
            bank_select: { mask: 32, value: 32 },
            ram_protect: { mask: 160, value: 32 },
          }
        : { mapper: 4 },
      ...(zero
        ? {
            entry: fixture.entry + 20,
            initial_prg_ram: [{ bank: 0, address: 0x71ff, value: 0xa9 }],
          }
        : {}),
    };
    const { trace } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(trace.final_cpu.a).toBe(zero ? 0 : 0x55);
    const instruction = trace.instructions.at(-1)!;
    if (zero) {
      expect(instruction).toMatchObject({
        address: 0x71ff,
        bytes_hex: "a900",
        ram_origins: [{ byte_index: 0, ram_address: 0x71ff }],
        mapper_origins: [
          {
            byte_index: 1,
            kind: "mmc6-disabled-half",
            ram_address: 0x7200,
            bank_select: { mask: 32, value: 32 },
            ram_protect: { mask: 160, value: 32 },
          },
        ],
      });
      expect(trace.stop).toMatchObject({
        reason: "unknown-stack",
        address: 0x7201,
        mapper_origins: [{ byte_index: 0, kind: "mmc6-disabled-half" }],
      });
    } else {
      expect(instruction).toMatchObject({
        address: 0x7400,
        bytes_hex: "a955",
        mapper_origins: [],
        ram_origins: [{ ram_address: 0x7000 }, { ram_address: 0x7001 }],
      });
      expect(
        trace.instructions
          .find((item) => item.mnemonic === "INC")!
          .writes.map((write) => write.value),
      ).toEqual([0x55, 0x56]);
      expect(trace.stop).toMatchObject({ reason: "return", address: 0x7402 });
    }
    const replay = await replayNesThroughMcp(client, {
      path,
      initial: input.initial,
      writes: trace.instructions
        .flatMap((item) => item.writes)
        .filter((write) => write.address >= 0x8000),
    });

    expect(replay.normalized_result).toMatchObject({
      trace: trace.mapper_trace,
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
};

const verifyMmc1Fixed = async (cli: TestCli, client: Client, root: string) => {
  const fixture = mmc1FixedCodeFixture();
  const path = join(root, "mmc1-fixed.nes");
  await writeFile(path, fixture.bytes);
  const input = { path, initial: { mapper: 1, shift_bits: [] } };
  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.final_cpu.a).toBe(0x66);
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  expect(trace.mapper_trace.final).toMatchObject({
    prg_bank: 1,
    prg_mode: 3,
    chr_bank_0: 2,
  });
  expect(trace.mapper_trace.nes_prg_views).toEqual([]);
  expect(
    trace.mapper_trace.final_mapping.chr_windows.map((window) => window.bank),
  ).toEqual([2, 3]);
  for (const instruction of trace.instructions)
    expect(instruction.file_offsets).toEqual(
      Array.from(
        { length: instruction.bytes_hex.length / 2 },
        (_, byte) => 16 + instruction.address - 0x8000 + byte,
      ),
    );
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyDeprecatedMmc1 = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  for (const submapper of [1, 2, 4]) {
    const fixture =
      submapper === 2
        ? mmc1BankedRamCodeFixture("SOROM")
        : mmc1OuterCodeFixture(submapper === 4 ? 3 : 0);
    fixture.bytes[8] = submapper << 4;
    const path = join(root, `mmc1-deprecated-${submapper}.nes`);
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: {
        mapper: 1,
        prg_mode: 3,
        prg_bank: 0,
        prg_ram_disable_bit: 0,
        chr_mode: 0,
        chr_bank_0: submapper === 4 ? 12 : 0,
        chr_bank_1: 0,
        shift_bits: [],
      },
    };
    const { trace } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(trace.stop.reason).toBe("return");
    expect(trace.final_cpu.a).toBe(submapper === 2 ? 0x55 : 0x66);
    for (const instruction of trace.instructions)
      for (const [index, offset] of instruction.file_offsets.entries()) {
        if (offset !== null)
          expect(fixture.bytes[offset]).toBe(
            parseInt(instruction.bytes_hex.slice(index * 2, index * 2 + 2), 16),
          );
      }
    expect(
      trace.instructions
        .flatMap((instruction) => instruction.ram_origins)
        .some((origin) => origin.region === "prg-ram"),
    ).toBe(true);

    const explored = await exploreNesThroughMcp(client, input);

    expect(explored.normalized_result).toMatchObject({
      code_exploration: { paths: [{ trace }] },
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
};

const verifyMmc1Outer = async (cli: TestCli, client: Client, root: string) => {
  const fixture = mmc1OuterCodeFixture();
  const path = join(root, "surom.nes");
  await writeFile(path, fixture.bytes);
  const input = {
    path,
    initial: {
      mapper: 1,
      prg_mode: 3,
      prg_bank: 0,
      chr_mode: 0,
      chr_bank_0: 0,
      chr_bank_1: 0,
      prg_ram_disable_bit: 0,
      shift_bits: [],
    },
  };
  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.final_cpu.a).toBe(0x66);
  expect(trace.instructions.at(-1)).toMatchObject({
    address: 0x8000,
    file_offsets: [0x40010, 0x40011],
  });
  if (trace.mapper_trace.status !== "derived")
    throw new Error(trace.mapper_trace.reason);
  expect(
    trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
  ).toEqual([16, 31]);
  expect(trace.mapper_trace.nes_prg_views).toEqual([
    { mapper: 1, prg_mode: 3, prg_bank: 0, prg_outer_bank: 0 },
    { mapper: 1, prg_mode: 3, prg_bank: 0, prg_outer_bank: 1 },
  ]);
  const explored = await exploreNesThroughMcp(client, input);

  const exploration = nesCodeExplorationReportSchema.parse(
    explored.normalized_result,
  ).code_exploration;
  if (exploration.status !== "derived") throw new Error(exploration.reason);
  expect(exploration.paths[0]!.trace).toEqual(trace);
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyMmc1BankedRam = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  for (const kind of ["SOROM", "SXROM", "SZROM"] as const) {
    const fixture = mmc1BankedRamCodeFixture(kind);
    if (kind === "SZROM") {
      fixture.bytes[10] = 0x77;
      fixture.bytes[6]! |= 2;
    }
    const path = join(root, `${kind}.nes`);
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: {
        mapper: 1,
        prg_mode: 3,
        prg_bank: 0,
        prg_ram_disable_bit: 0,
        chr_mode: 0,
        chr_bank_0: 0,
        chr_bank_1: 0,
        shift_bits: [],
      },
    };
    const { trace } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(trace.final_cpu.a).toBe(0x55);
    const instruction = trace.instructions.at(-1)!;
    expect(instruction.address).toBe(0x6000);
    expect(instruction.file_offsets).toEqual([null, null]);
    expect(instruction.ram_origins).toHaveLength(4);
    for (const origin of instruction.ram_origins) {
      expect(origin.region).toBe("prg-ram");
      if (origin.region !== "prg-ram")
        throw new Error("Expected cartridge RAM");
      expect([0, kind === "SXROM" ? 3 : 1]).toContain(origin.bank);
      if (!("instruction_index" in origin))
        throw new Error("Expected derived cartridge RAM writer");
      expect(
        trace.instructions[origin.instruction_index]!.writes[
          origin.write_index
        ],
      ).toMatchObject({
        address: origin.ram_address,
        value: Buffer.from(instruction.bytes_hex.replaceAll(" ", ""), "hex")[
          origin.byte_index
        ],
      });
    }
    expect(await readFile(path)).toEqual(fixture.bytes);
    if (kind === "SZROM") {
      fixture.bytes[11] = 7;
      await writeFile(path, fixture.bytes);
      const unsupported = await traceNesThroughMcp(client, input);

      const report = nesCodeTraceReportSchema.parse(
        unsupported.normalized_result,
      );
      expect(report.code_trace).toMatchObject({
        status: "unsupported",
        reason:
          "Combined CHR ROM and RAM declarations require a separate bank-source wiring model.",
      });
      expect(await readFile(path)).toEqual(fixture.bytes);
    }
  }
};

const verifyMmc1Ram = async (cli: TestCli, client: Client, root: string) => {
  for (const snrom of [false, true]) {
    const port = snrom ? 0xa000 : 0xe000;
    const fixture = mmc1RamCodeFixture(
      [
        0xa9,
        0xa9,
        0x8d,
        0,
        0x60,
        0xa9,
        0x55,
        0x8d,
        1,
        0x60,
        0xa9,
        0x60,
        0x8d,
        2,
        0x60,
        ...mmc1WriteProgram(port, 16),
        0xa9,
        0x77,
        0x8d,
        1,
        0x60,
        0xad,
        1,
        0x60,
        0x85,
        0x10,
        ...mmc1WriteProgram(port, 0),
        0x4c,
        0,
        0x60,
      ],
      snrom,
    );
    const path = join(root, `mmc1-ram-${snrom}.nes`);
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: {
        mapper: 1,
        prg_mode: 3,
        prg_bank: 0,
        prg_ram_disable_bit: 0,
        chr_mode: 0,
        chr_bank_0: 0,
        chr_bank_1: 0,
        shift_bits: [],
      },
    };
    const { trace } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(
      trace.instructions.flatMap((instruction) => instruction.writes),
    ).toContainEqual({
      address: 16,
      value: null,
      preceded_by_cpu_write: false,
    });
    expect(trace.final_cpu.a).toBe(0x55);
    expect(trace.stop).toMatchObject({ reason: "return", address: 0x6002 });
    expect(trace.instructions.at(-1)).toMatchObject({
      address: 0x6000,
      file_offsets: [null, null],
      ram_origins: [
        { region: "prg-ram", ram_address: 0x6000, instruction_index: 1 },
        { region: "prg-ram", ram_address: 0x6001, instruction_index: 3 },
      ],
    });

    const replay = await replayNesThroughMcp(client, {
      path,
      initial: input.initial,
      writes: trace.instructions
        .flatMap((instruction) => instruction.writes)
        .filter((write) => write.address >= 32768),
    });
    expect(replay.normalized_result).toMatchObject({
      trace: trace.mapper_trace,
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
};

const verifyMmc4Ram = async (cli: TestCli, client: Client, root: string) => {
  for (const declaration of [null, 7, 0x70]) {
    const fixture = mmc4RamCodeFixture(declaration);
    const path = join(root, `mmc4-ram-${declaration}.nes`);
    await writeFile(path, fixture.bytes);
    const input = { path, initial: { mapper: 10 } };
    const { trace } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(trace.final_cpu.a).toBe(0x66);
    expect(trace.stop.reason).toBe("return");
    expect(trace.mapper_trace).toMatchObject({
      final: { prg_bank: 2 },
      nes_prg_views: [
        { mapper: 10, prg_bank: 0 },
        { mapper: 10, prg_bank: 2 },
      ],
    });
    expect(
      trace.instructions.find((instruction) => instruction.address === 0x6002),
    ).toMatchObject({
      mnemonic: "STA",
      bytes_hex: "8d00a0",
      writes: [{ address: 0xa000, value: 2 }],
      file_offsets: [null, null, null],
      ram_origins: [
        { region: "prg-ram", ram_address: 0x6002, instruction_index: 5 },
        { region: "prg-ram", ram_address: 0x6003, instruction_index: 7 },
        { region: "prg-ram", ram_address: 0x6004, instruction_index: 9 },
      ],
    });
    expect(trace.instructions.at(-1)?.file_offsets).toEqual([
      fixture.prgOffset + 32768,
      fixture.prgOffset + 32769,
    ]);

    const replay = await replayNesThroughMcp(client, {
      path,
      initial: input.initial,
      writes: trace.instructions
        .flatMap((instruction) => instruction.writes)
        .filter((write) => write.address >= 32768),
    });
    expect(replay.normalized_result).toMatchObject({
      trace: trace.mapper_trace,
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
};

const verifyMmc3Ram = async (cli: TestCli, client: Client, root: string) => {
  const fixture = mmc3RamCodeFixture([
    0xa9, 0x80, 0x8d, 1, 0xa0, 0xa9, 0xa9, 0x8d, 0, 0x60, 0xa9, 0x55, 0x8d, 1,
    0x60, 0xa9, 0x60, 0x8d, 2, 0x60, 0xa9, 0xc0, 0x8d, 1, 0xa0, 0xee, 1, 0x60,
    0xa9, 0, 0x8d, 1, 0xa0, 0xad, 1, 0x60, 0x85, 0x10, 0xa9, 0x80, 0x8d, 1,
    0xa0, 0x4c, 0, 0x60,
  ]);
  const path = join(root, "mmc3-ram.nes");
  await writeFile(path, fixture.bytes);
  const input = { path, initial: { mapper: 4 } };
  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(
    trace.instructions.find((instruction) => instruction.mnemonic === "INC")
      ?.writes,
  ).toMatchObject([{ value: 0x55 }, { value: 0x56 }]);
  expect(
    trace.instructions.flatMap((instruction) => instruction.writes),
  ).toContainEqual({ address: 16, value: null, preceded_by_cpu_write: false });
  expect(trace.instructions.at(-1)).toMatchObject({
    address: 0x6000,
    bytes_hex: "a955",
    file_offsets: [null, null],
    ram_origins: [
      {
        region: "prg-ram",
        ram_address: 0x6000,
        instruction_index: 3,
        write_index: 0,
      },
      {
        region: "prg-ram",
        ram_address: 0x6001,
        instruction_index: 5,
        write_index: 0,
      },
    ],
  });
  expect(trace.final_cpu.a).toBe(0x55);
  expect(trace.stop.reason).toBe("return");

  const explored = await exploreNesThroughMcp(client, input);

  const report = nesCodeExplorationReportSchema.parse(
    explored.normalized_result,
  );
  if (report.code_exploration.status !== "derived")
    throw new Error(report.code_exploration.reason);
  expect(report.code_exploration.paths[0]?.trace).toEqual(trace);
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyNinaRam = async (cli: TestCli, client: Client, root: string) => {
  const fixture = ninaRamCodeFixture([
    0xa9, 0xf1, 0x8d, 0xfd, 0x7f, 0xad, 0xfd, 0x7f, 0x85, 0x10, 0xa9, 0xfe,
    0x8d, 0xfe, 0x7f, 0xad, 0xfe, 0x7f, 0x85, 0x11, 0xa9, 0xa9, 0x8d, 0xff,
    0x7f, 0x4c, 0xff, 0x7f,
  ]);
  fixture.bytes.set([0x55, 0x60], 32784);
  const path = join(root, "nina-ram.nes");
  await writeFile(path, fixture.bytes);
  const input = {
    path,
    entry: fixture.entry,
    initial: { mapper: 34, prg_bank: 0 },
  };
  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.instructions[3]?.writes).toMatchObject([
    { address: 16, value: 0xf1 },
  ]);
  expect(trace.instructions[7]?.writes).toMatchObject([
    { address: 17, value: 0xfe },
  ]);
  expect(trace.instructions.at(-1)).toMatchObject({
    address: 0x7fff,
    bytes_hex: "a955",
    file_offsets: [null, 32784],
    ram_origins: [
      {
        region: "prg-ram",
        byte_index: 0,
        ram_address: 0x7fff,
        instruction_index: 9,
        write_index: 0,
      },
    ],
  });
  expect(trace.final_cpu.a).toBe(0x55);
  expect(trace.mapper_trace).toMatchObject({
    final: { prg_bank: 1, chr_bank_0: 14, chr_bank_1: 9 },
  });
  expect(trace.stop.reason).toBe("return");

  const explored = await exploreNesThroughMcp(client, input);

  const report = nesCodeExplorationReportSchema.parse(
    explored.normalized_result,
  );
  if (report.code_exploration.status !== "derived")
    throw new Error(report.code_exploration.reason);
  expect(report.code_exploration.paths[0]?.trace).toEqual(trace);
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyMapper34 = async (cli: TestCli, client: Client, root: string) => {
  for (const [submapper, chrBanks, nina] of [
    [2, 0, false],
    [null, 1, false],
    [0, 2, true],
    [1, 1, true],
  ] as const) {
    const prgSize = nina ? 65536 : 131072;
    const bytes = Buffer.alloc(16 + prgSize + chrBanks * 8192);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      prgSize / 16384,
      chrBanks,
      0x20,
      submapper === null ? 0x20 : 0x28,
      (submapper ?? 0) << 4,
    ]);
    if (submapper !== null && chrBanks === 0) bytes[11] = 7;
    if (nina && submapper !== null) bytes[10] = 7;
    bytes.set(
      [0xa9, nina ? 0xf1 : 3, 0x8d, nina ? 0xfd : 0, nina ? 0x7f : 0x81],
      16,
    );
    bytes[272] = 2;
    const bank = nina ? 1 : 2;
    bytes.set(
      [
        0xa9, 0xfe, 0x8d, 0xfe, 0x7f, 0xa9, 0xfd, 0x8d, 0xff, 0x7f, 0xa9, 0x55,
        0x60,
      ],
      16 + bank * 32768 + 5,
    );
    const path = join(root, `mapper34-${submapper}-${chrBanks}.nes`);
    await writeFile(path, bytes);
    const input = { path, entry: 0x8000, initial: { mapper: 34, prg_bank: 0 } };
    const response = await (submapper === 1 || submapper === 2
      ? traceNesThroughAdapters(cli, client, input)
      : traceNesThroughMcp(client, input));

    const evidence = response;
    const { code_trace: trace } = nesCodeTraceReportSchema.parse(
      evidence.normalized_result,
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.stop.reason).toBe("return");
    expect(trace.final_cpu.a).toBe(0x55);
    expect(trace.instructions[2]?.file_offsets).toEqual([
      16 + bank * 32768 + 5,
      16 + bank * 32768 + 6,
    ]);
    expect(trace.mapper_trace).toMatchObject({
      final: {
        mapper: 34,
        prg_bank: bank,
        chr_bank_0: nina ? 14 : null,
        chr_bank_1: nina ? 13 : null,
      },
      nes_prg_views: [
        { mapper: 34, prg_bank: 0 },
        { mapper: 34, prg_bank: bank },
      ],
    });
    if (trace.mapper_trace.status !== "derived")
      throw new Error(trace.mapper_trace.reason);
    if ("initial_irq" in trace.mapper_trace)
      throw new Error("Expected write-only mapper trace for NINA/BNROM");
    expect(trace.mapper_trace.steps.map((step) => step.write.address)).toEqual(
      nina ? [0x7ffd, 0x7ffe, 0x7fff] : [0x8100],
    );
    expect(
      trace.mapper_trace.final_mapping.chr_windows.map((window) => window.bank),
    ).toEqual(
      chrBanks === 0
        ? [null, null]
        : nina
          ? [14 & (chrBanks * 2 - 1), 13 & (chrBanks * 2 - 1)]
          : [0, 1],
    );

    const replay = await replayNesThroughMcp(client, {
      path,
      initial: input.initial,
      writes: trace.mapper_trace.steps.map((step) => step.write),
    });
    expect(replay.normalized_result).toMatchObject({
      trace: trace.mapper_trace,
    });
    const ignored = await replayNesThroughMcp(client, {
      path,
      initial: trace.mapper_trace.final,
      writes: (nina ? [0x7ffc, 0x8000, 0xffff] : [0x7ffd, 0x7ffe, 0x7fff]).map(
        (address) => ({ address, value: 0 }),
      ),
    });
    expect(ignored.normalized_result).toMatchObject({
      trace: {
        final: trace.mapper_trace.final,
        steps: [
          { effect: "outside-mapper" },
          { effect: "outside-mapper" },
          { effect: "outside-mapper" },
        ],
      },
    });

    expect(await readFile(path)).toEqual(bytes);
  }
};

const verifyBrk = async (cli: TestCli, client: Client, root: string) => {
  const fixture = nesCodeFixture(4, [0, 0x02, 0x4c, 0, 0x80]);
  fixture.bytes.set(
    [0xa9, 6, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 1, 0x80, 0x40],
    fixture.programOffset + 256,
  );
  fixture.bytes.set([0xa9, 0x55, 0x60], fixture.prgOffset + 2 * 8192);
  fixture.bytes.writeUInt16LE(0xe100, fixture.prgOffset + fixture.prgSize - 2);
  const path = join(root, "brk-mmc3.nes");
  await writeFile(path, fixture.bytes);
  const input = {
    path,
    initial: { mapper: 4 },
    cpu: {
      sp: 253,
      c: false,
      z: false,
      i: false,
      d: false,
      v: false,
      n: false,
    },
  };
  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.instructions[0]).toMatchObject({
    mnemonic: "BRK",
    next_address: 0xe100,
    interrupt_vector: [
      {
        address: 65534,
        value: 0,
        file_offset: fixture.prgOffset + fixture.prgSize - 2,
      },
      {
        address: 65535,
        value: 0xe1,
        file_offset: fixture.prgOffset + fixture.prgSize - 1,
      },
    ],
    writes: [
      { address: 509, value: 0xe0 },
      { address: 508, value: 2 },
      { address: 507, value: 0x30 },
    ],
    cpu_after: { sp: 250, i: true },
  });
  expect(
    trace.instructions.find((instruction) => instruction.mnemonic === "RTI"),
  ).toMatchObject({ next_address: 0xe002, cpu_after: { sp: 253, i: false } });
  expect(trace.instructions.at(-1)?.file_offsets).toEqual([
    fixture.prgOffset + 16384,
    fixture.prgOffset + 16385,
  ]);
  expect(trace.final_cpu).toMatchObject({ a: 0x55, sp: 253, i: false });
  expect(trace.stop.reason).toBe("return");

  const replay = await replayNesThroughMcp(client, {
    path,
    initial: input.initial,
    writes: trace.instructions
      .flatMap((instruction) => instruction.writes)
      .filter((write) => write.address >= 32768),
  });
  expect(replay.normalized_result).toMatchObject({ trace: trace.mapper_trace });

  const explored = await exploreNesThroughMcp(client, input);

  const report = nesCodeExplorationReportSchema.parse(
    explored.normalized_result,
  );
  if (report.code_exploration.status !== "derived")
    throw new Error(report.code_exploration.reason);
  expect(report.code_exploration.paths[0]?.trace).toEqual(trace);
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyCamerica = async (cli: TestCli, client: Client, root: string) => {
  for (const submapper of [null, 0, 1]) {
    const bytes = Buffer.alloc(16 + 131072);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      8,
      0,
      0x70,
      submapper === null ? 0x40 : 0x48,
      (submapper ?? 0) << 4,
    ]);
    if (submapper !== null) bytes[11] = 7;
    bytes.set(
      [0xa9, 0x10, 0x8d, 0, 0x80, 0xa9, 3, 0x8d, 0, 0xc1, 0x4c, 0, 0x80],
      16 + 7 * 16384,
    );
    bytes.set([0xa9, 0x55, 0x60], 16 + 3 * 16384);
    const path = join(root, `camerica-${submapper}.nes`);
    await writeFile(path, bytes);
    const input = { path, entry: 0xc000, initial: { mapper: 71 } };
    const response = await (submapper === 1
      ? traceNesThroughAdapters(cli, client, input)
      : traceNesThroughMcp(client, input));
    const evidence = response;
    const { code_trace: trace } = nesCodeTraceReportSchema.parse(
      evidence.normalized_result,
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.stop.reason).toBe("return");
    expect(trace.final_cpu.a).toBe(0x55);
    expect(trace.instructions.at(-1)).toMatchObject({
      file_offsets: [49168, 49169],
    });
    expect(trace.mapper_trace).toMatchObject({
      final: { mapper: 71, prg_bank: 3, mirroring: submapper === 1 ? 1 : null },
      final_mapping: {
        mirroring:
          submapper === 1
            ? "one-screen-b"
            : submapper === 0
              ? "horizontal"
              : "unknown",
      },
      steps: [
        { effect: submapper === 1 ? "nametable" : "outside-mapper" },
        { effect: "prg-bank" },
      ],
    });

    const replay = await replayNesThroughMcp(client, {
      path,
      initial: input.initial,
      writes: trace.instructions.flatMap((instruction) => instruction.writes),
    });
    expect(replay.normalized_result).toMatchObject({
      trace: trace.mapper_trace,
    });

    expect(await readFile(path)).toEqual(bytes);
  }
};

const verifyColorDreams = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const bytes = Buffer.alloc(16 + 131072 + 131072);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 16, 0xb0, 0]);
  bytes.set([0xa9, 0xf3, 0x8d, 0, 0x81], 16);
  bytes[272] = 0xa2;
  for (const bank of [2, 3])
    bytes.set([0xa9, 0x77, 0x60], 16 + bank * 32768 + 5);
  const path = join(root, "color-dreams.nes");
  await writeFile(path, bytes);
  for (const bus_conflicts of ["and", "none", "unknown"] as const) {
    const input = {
      path,
      entry: 0x8000,
      initial: { mapper: 11, prg_bank: 0, chr_bank: 0, bus_conflicts },
    };
    const response = await (bus_conflicts === "and"
      ? traceNesThroughAdapters(cli, client, input)
      : traceNesThroughMcp(client, input));
    const evidence = response;
    const { code_trace: trace } = nesCodeTraceReportSchema.parse(
      evidence.normalized_result,
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    const prg =
      bus_conflicts === "and" ? 2 : bus_conflicts === "none" ? 3 : null;
    const chr =
      bus_conflicts === "and" ? 10 : bus_conflicts === "none" ? 15 : null;
    expect(trace.stop.reason).toBe(
      prg === null ? "unmapped-instruction" : "return",
    );
    expect(trace.mapper_trace).toMatchObject({
      final: { mapper: 11, prg_bank: prg, chr_bank: chr, bus_conflicts },
      steps: [{ write: { value: 0xf3 }, effect: "prg-chr-bank" }],
    });
    if (prg !== null)
      expect(trace.instructions[2]).toMatchObject({
        file_offsets: [21 + prg * 32768, 22 + prg * 32768],
        cpu_after: { a: 0x77 },
      });

    const replay = await replayNesThroughMcp(client, {
      path,
      initial: input.initial,
      writes: [{ address: 0x8100, value: 0xf3, preceded_by_cpu_write: false }],
    });
    expect(replay.normalized_result).toMatchObject({
      trace: trace.mapper_trace,
    });
  }
  expect(await readFile(path)).toEqual(bytes);
};

const verifyGxrom = async (cli: TestCli, client: Client, root: string) => {
  const bytes = Buffer.alloc(16 + 131072 + 32768);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 4, 0x20, 0x40]);
  bytes.set([0xa9, 0x33, 0x8d, 0, 0x81], 16);
  bytes[272] = 0x21;
  bytes.set([0xa9, 0x13, 0x8d, 0, 0x81], 16 + 65536 + 5);
  bytes[16 + 65536 + 256] = 0x12;
  bytes.set([0xa9, 0x44, 0x60], 16 + 32768 + 10);
  bytes.writeUInt16LE(0x8000, 16 + 32768 - 4);
  const path = join(root, "gxrom.nes");
  await writeFile(path, bytes);
  const input = { path, initial: { mapper: 66, prg_bank: 0 } };

  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.stop.reason).toBe("return");
  expect(trace.final_cpu.a).toBe(0x44);
  expect(trace.instructions[2]).toMatchObject({
    address: 0x8005,
    file_offsets: [65557, 65558],
  });
  expect(trace.instructions[4]).toMatchObject({
    address: 0x800a,
    file_offsets: [32794, 32795],
  });
  expect(trace.mapper_trace).toMatchObject({
    status: "derived",
    steps: [
      {
        effect: "prg-chr-bank",
        write: { value: 0x33 },
        state: { prg_bank: 2, chr_bank: 1 },
      },
      {
        effect: "prg-chr-bank",
        write: { value: 0x13 },
        state: { prg_bank: 1, chr_bank: 2 },
      },
    ],
    final_mapping: {
      mirroring: "horizontal",
      chr_windows: [
        { bank: 4, file_offset: 147472 },
        { bank: 5, file_offset: 151568 },
      ],
    },
    nes_prg_views: [0, 1, 2].map((prg_bank) => ({ mapper: 66, prg_bank })),
  });

  const replay = await replayNesThroughMcp(client, {
    ...input,
    writes: trace.instructions.flatMap((instruction) => instruction.writes),
  });
  expect(replay.normalized_result).toMatchObject({ trace: trace.mapper_trace });

  expect(await readFile(path)).toEqual(bytes);
};

const verifyAxrom = async (cli: TestCli, client: Client, root: string) => {
  for (const submapper of [0, 1, 2]) {
    const bytes = Buffer.alloc(16 + 4 * 32768);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 0, 0x70, 8, submapper << 4]);
    bytes[11] = 7;
    bytes.set([0xa9, 0x12, 0x8d, 0, 0x81], 16);
    bytes[16 + 256] = 2;
    bytes.set([0xa9, 0x11, 0x8d, 0, 0x81], 16 + 2 * 32768 + 5);
    bytes[16 + 2 * 32768 + 256] = 1;
    bytes.set([0xa9, 0x77, 0x60], 16 + 32768 + 10);
    bytes.writeUInt16LE(0x8000, 16 + 32768 - 4);
    const path = join(root, `axrom${submapper}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper: 7, prg_bank: 0 } };
    const response = await (submapper === 2
      ? traceNesThroughAdapters(cli, client, input)
      : traceNesThroughMcp(client, input));
    const evidence = response;
    const trace = nesCodeTraceReportSchema.parse(
      evidence.normalized_result,
    ).code_trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.stop.reason).toBe("return");
    expect(trace.final_cpu.a).toBe(0x77);
    expect(trace.instructions[2]).toMatchObject({
      address: 0x8005,
      file_offsets: [65557, 65558],
    });
    expect(trace.instructions[4]).toMatchObject({
      address: 0x800a,
      file_offsets: [32794, 32795],
    });
    expect(trace.mapper_trace).toMatchObject({
      status: "derived",
      final: {
        mapper: 7,
        prg_bank: 1,
        mirroring: submapper === 0 ? null : submapper === 1 ? 1 : 0,
      },
      final_mapping: {
        mirroring:
          submapper === 0
            ? "unknown"
            : submapper === 1
              ? "one-screen-b"
              : "one-screen-a",
        prg_windows: [
          { start: 32768, size: 32768, bank: 1, file_offset: 32784 },
        ],
      },
      nes_prg_views: [0, 1, 2].map((prg_bank) => ({ mapper: 7, prg_bank })),
    });

    const replay = await replayNesThroughMcp(client, {
      ...input,
      writes: trace.instructions.flatMap((instruction) => instruction.writes),
    });
    expect(replay.normalized_result).toMatchObject({
      trace: trace.mapper_trace,
    });

    expect(await readFile(path)).toEqual(bytes);
  }
};

const verifyUxrom = async (cli: TestCli, client: Client, root: string) => {
  for (const submapper of [0, 1, 2]) {
    const bytes = Buffer.alloc(16 + 65536);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 0, 0x20, 8, submapper << 4]);
    bytes[11] = 7;
    bytes.set(
      [0xa9, 1, 0x8d, 0, 0xc1, 0xa9, 3, 0x8d, 0, 0x81, 0x4c, 0, 0x80],
      16 + 3 * 16384 + 512,
    );
    bytes[16 + 3 * 16384 + 256] = 15;
    bytes[16 + 16384 + 256] = 2;
    bytes.set([0xa9, 0x55, 0x60], 16 + 2 * 16384);
    bytes.set([0xa9, 0x66, 0x60], 16 + 3 * 16384);
    bytes.writeUInt16LE(0xc200, 16 + 65536 - 4);
    const path = join(root, `uxrom${submapper}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper: 2 } };
    const response = await (submapper === 2
      ? traceNesThroughAdapters(cli, client, input)
      : traceNesThroughMcp(client, input));
    const evidence = response;
    const trace = nesCodeTraceReportSchema.parse(
      evidence.normalized_result,
    ).code_trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    const bank = submapper === 0 ? null : submapper === 1 ? 3 : 2;
    expect(trace.stop.reason).toBe(
      bank === null ? "unmapped-instruction" : "return",
    );
    expect(trace.mapper_trace).toMatchObject({
      status: "derived",
      final: { mapper: 2, prg_bank: bank },
      nes_prg_views:
        bank === null
          ? [{ mapper: 2, prg_bank: 1 }]
          : [
              { mapper: 2, prg_bank: 1 },
              { mapper: 2, prg_bank: bank },
            ],
      coverage: { unknown_prg_steps: bank === null ? 1 : 0 },
      final_mapping: { prg_windows: [{ bank }, { bank: 3 }] },
    });
    if (bank !== null)
      expect(trace.instructions.at(-1)).toMatchObject({
        address: 0x8000,
        file_offsets: [16 + bank * 16384, 17 + bank * 16384],
      });

    const replay = await replayNesThroughMcp(client, {
      ...input,
      writes: trace.instructions.flatMap((instruction) => instruction.writes),
    });
    expect(replay.normalized_result).toMatchObject({
      trace: trace.mapper_trace,
    });

    expect(await readFile(path)).toEqual(bytes);
  }
};

const verifyCnrom = async (client: Client, root: string) => {
  for (const [submapper, romValue, bank] of [
    [0, 2, null],
    [0, 3, 3],
    [1, 2, 3],
    [2, 2, 2],
    [2, 0, 0],
  ] as const) {
    const chrBanks = submapper === 0 && romValue === 2 ? 1 : 4;
    const physicalBank = chrBanks === 1 ? 0 : bank;
    const bytes = Buffer.alloc(16 + 16384 + chrBanks * 8192);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 1, chrBanks, 0x30, 8, submapper << 4]);
    bytes.set([0xa9, 3, 0x8d, 0, 0xc1, 0x60], 16);
    bytes[272] = romValue;
    bytes.writeUInt16LE(0x8000, 16 + 16384 - 4);
    const path = join(root, `cnrom-${submapper}-${romValue}.nes`);
    await writeFile(path, bytes);
    const response = await traceNesThroughMcp(client, {
      path,
      initial: { mapper: 3 },
    });

    const report = nesCodeTraceReportSchema.parse(response.normalized_result);
    expect(report.code_trace).toMatchObject({
      status: "derived",
      stop: { reason: "return" },
      mapper_trace: {
        status: "derived",
        final: { mapper: 3, chr_bank: bank },
        steps: [{ write: { address: 0xc100, value: 3 }, effect: "chr-bank" }],
        coverage: { unknown_prg_steps: 0 },
        nes_prg_views: [],
        final_mapping: {
          chr_windows: [
            {
              bank: physicalBank === null ? null : physicalBank * 2,
              file_offset:
                physicalBank === null ? null : 16400 + physicalBank * 8192,
            },
            {
              bank: physicalBank === null ? null : physicalBank * 2 + 1,
              file_offset:
                physicalBank === null ? null : 20496 + physicalBank * 8192,
            },
          ],
        },
      },
    });

    const supplied = await replayNesThroughMcp(client, {
      path,
      initial: { mapper: 3 },
      writes: [{ address: 0xc100, value: 3 }],
    });
    expect(supplied.normalized_result).toMatchObject({
      trace: {
        status: "derived",
        final: { chr_bank: bank },
      },
    });
    expect(await readFile(path)).toEqual(bytes);
  }
};

const verifyNromBranches = async (
  client: Client,
  path: string,
  banks: number,
) => {
  const entry = banks === 1 ? 0xc100 : 0x8100;

  const response = await exploreNesThroughMcp(client, {
    path,
    initial: { mapper: 0 },
    entry,
  });
  const report = nesCodeExplorationReportSchema.parse(
    response.normalized_result,
  ).code_exploration;
  if (report.status !== "derived") throw new Error(report.reason);
  expect(report.paths).toHaveLength(3);
  const traces = report.paths.map((path) => {
    if (path.trace.status !== "derived") throw new Error(path.trace.reason);
    return path.trace;
  });
  expect(traces[0]?.stop.reason).toBe("unknown-branch");
  expect(
    traces
      .slice(1)
      .map((trace) => trace.final_cpu.a)
      .sort(),
  ).toEqual([17, 34]);
  for (const trace of traces.slice(1)) {
    expect(trace.stop.reason).toBe("return");
    expect(trace.branch_choices_used).toBe(1);
    expect(trace.instructions[0]).toMatchObject({
      address: entry,
      file_offsets: [272, 273, 274],
    });
  }
  expect(report.paths.slice(1).map((path) => path.branch_choices)).toEqual([
    [{ address: entry + 3, taken: false }],
    [{ address: entry + 3, taken: true }],
  ]);
  if (banks === 1) {
    const seam = await traceNesThroughMcp(client, {
      path,
      initial: { mapper: 0 },
      entry: 0xbfff,
      max_instructions: 1,
    });
    const trace = nesCodeTraceReportSchema.parse(
      seam.normalized_result,
    ).code_trace;
    expect(trace).toMatchObject({
      status: "derived",
      final_cpu: { a: 169 },
      instructions: [
        { address: 0xbfff, bytes_hex: "a9a9", file_offsets: [16399, 16] },
      ],
    });
  }
};

const verifyRti = async (client: Client, root: string) => {
  const bytes = Buffer.alloc(16 + 16384 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 1, 1]);
  bytes.set([0xa9, 0x80, 0x48, 0xa9, 0x20, 0x48, 0xa9, 0xcf, 0x48, 0x40], 16);
  bytes.set(
    [
      0xa9, 0xa9, 0x8d, 0, 3, 0xa9, 0x55, 0x8d, 1, 3, 0xa9, 0x60, 0x8d, 2, 3,
      0x4c, 0, 3,
    ],
    48,
  );
  const path = join(root, "rti-frame.nes");
  await writeFile(path, bytes);

  const evidence = await traceNesThroughMcp(client, {
    path,
    initial: { mapper: 0 },
    entry: 0x8000,
    cpu: { sp: 0xfd },
  });
  const { code_trace: trace } = nesCodeTraceReportSchema.parse(
    evidence.normalized_result,
  );
  if (trace.status !== "derived")
    throw new Error("Expected RTI source derivation");
  expect(trace.stop.reason).toBe("return");
  expect(
    trace.instructions.find(({ mnemonic }) => mnemonic === "RTI"),
  ).toMatchObject({
    next_address: 0x8020,
    cpu_after: {
      sp: 0xfd,
      c: true,
      z: true,
      i: true,
      d: true,
      v: true,
      n: true,
    },
  });
  expect(trace.instructions.at(-1)).toMatchObject({
    file_offsets: [null, null],
    ram_origins: [
      {
        byte_index: 0,
        ram_address: 0x300,
        instruction_index: 8,
        write_index: 0,
      },
      {
        byte_index: 1,
        ram_address: 0x301,
        instruction_index: 10,
        write_index: 0,
      },
    ],
    cpu_after: { a: 0x55 },
  });
  expect(await readFile(path)).toEqual(bytes);
};

const verifyNrom = async (cli: TestCli, client: Client, root: string) => {
  for (const banks of [1, 2]) {
    const bytes = Buffer.alloc(16 + banks * 16384 + 8192);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, banks, 1, 1]);
    // The 16 KiB board aliases 8000/C000; writes to ROM cannot change mapping.
    bytes.set(
      [
        0xa9, 2, 0x8d, 0, 0x80, 0x1a, 0x80, 0x02, 0x0c, 0x02, 0x02, 0x38, 0xeb,
        1, 0x0b, 0xff, 0x4b, 0xff, 0xa2, 1, 0xcb, 0, 0xa9, 1, 0x85, 0x10, 0xc7,
        0x10, 0xe7, 0x10, 0x07, 0x10, 0x27, 0x10, 0x47, 0x10, 0x67, 0x10, 0x6b,
        0xff, 0xa9, 1, 0x85, 0x10, 0xa7, 0x10, 0xa2, 0xff, 0x9a, 0xa0, 0, 0xbb,
        0x10, 0, 0x8f, 0, 0x80, 0x60,
      ],
      16,
    );
    bytes.writeUInt16LE(0x8000, 16 + banks * 16384 - 4);
    bytes.set([0xad, 2, 0x20, 0xf0, 3, 0xa9, 17, 0x60, 0xa9, 34, 0x60], 272);
    if (banks === 1) bytes[16399] = 0xa9;
    const path = join(root, `nrom${banks}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper: 0 } };
    const evidence = await traceNesThroughAdapters(cli, client, input);
    const report = nesCodeTraceReportSchema.parse(evidence.normalized_result);
    expect(report.code_trace).toMatchObject({
      status: "derived",
      stop: { reason: "return" },
      mapper_trace: {
        status: "derived",
        final: { mapper: 0 },
        nes_prg_views: [],
        coverage: { unknown_prg_steps: 0 },
        final_mapping: {
          mirroring: "vertical",
          prg_windows: [
            { start: 0x8000, bank: 0, file_offset: 16 },
            {
              start: 0xc000,
              bank: banks === 1 ? 0 : 1,
              file_offset: banks === 1 ? 16 : 16400,
            },
          ],
        },
      },
    });
    if (report.code_trace.status !== "derived")
      throw new Error("Expected derived trace");
    expect(
      report.code_trace.instructions
        .slice(2, 5)
        .map(({ mnemonic, encoding }) => ({ mnemonic, encoding })),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        mnemonic: "NOP",
        encoding: "unofficial",
      })),
    );
    expect(
      report.code_trace.instructions.find(({ mnemonic }) => mnemonic === "SBC"),
    ).toMatchObject({
      mnemonic: "SBC",
      encoding: "unofficial",
      cpu_after: { a: 1 },
    });
    expect(report.code_trace.instructions.at(-1)).toMatchObject({
      mnemonic: "SAX",
      encoding: "unofficial",
      cpu_after: { a: 1, x: 1 },
      writes: [{ address: 0x8000, value: 1 }],
    });
    expect(
      report.code_trace.instructions.find(({ mnemonic }) => mnemonic === "AXS"),
    ).toMatchObject({
      encoding: "unofficial",
      cpu_after: { a: 0, x: 0, c: true, n: false, z: true },
    });
    expect(
      report.code_trace.instructions.find(({ mnemonic }) => mnemonic === "DCP"),
    ).toMatchObject({
      encoding: "unofficial",
      cpu_after: { a: 1, c: true, z: false },
    });
    expect(
      report.code_trace.instructions.find(({ mnemonic }) => mnemonic === "ISC"),
    ).toMatchObject({
      encoding: "unofficial",
      cpu_after: { a: 0, c: true, z: true },
    });
    expect(
      report.code_trace.instructions.find(({ mnemonic }) => mnemonic === "RRA"),
    ).toMatchObject({
      encoding: "unofficial",
      cpu_after: { a: 3, c: false, z: false },
    });
    expect(
      report.code_trace.instructions.find(({ mnemonic }) => mnemonic === "ARR"),
    ).toMatchObject({
      encoding: "unofficial",
      cpu_after: { a: 1, c: false, v: false },
    });
    expect(
      report.code_trace.instructions.find(({ mnemonic }) => mnemonic === "LAS"),
    ).toMatchObject({
      encoding: "unofficial",
      cpu_after: { a: 1, x: 1, sp: 1 },
    });

    const exploration = await exploreNesThroughMcp(client, input);

    expect(exploration.normalized_result).toMatchObject({
      code_exploration: { status: "derived", nes_prg_views: [] },
    });
    await verifyNromBranches(client, path, banks);
    expect(await readFile(path)).toEqual(bytes);
  }
};

const verifyCode = async (
  cli: TestCli,
  client: Client,
  root: string,
  mapper: 1 | 4,
  submapper?: 3 | 4,
) => {
  const fixture =
    mapper === 1
      ? nesCodeFixture(1, [
          // Unknown PPUSTATUS preserves clear carry/overflow after adding zero.
          // Both branches must resolve without user-provided branch choices.
          0xad,
          2,
          0x20,
          0x18,
          0x69,
          0,
          0xb0,
          0,
          0x70,
          0,
          ...mmc1SerialProgram,
        ])
      : mmc3SwitchCodeFixture();
  if (submapper !== undefined) {
    fixture.bytes[7] = 8;
    fixture.bytes[8] = submapper << 4;
  }
  const path = join(
    root,
    `mapper${mapper}${submapper === undefined ? "" : `-${submapper}`}.nes`,
  );
  await writeFile(path, fixture.bytes);
  const input = {
    path,
    // Every MMC1 PRG mode maps the last bank at C000 for selector 3.
    initial: mapper === 1 ? { mapper: 1, prg_bank: 3 } : { mapper: 4 },
  };
  const jsonPath = join(root, `request${mapper}.json`);
  await writeFile(jsonPath, JSON.stringify(input));
  const result = await cli.run({
    arguments: [
      "trace-nes-code",
      mapper === 1 ? jsonPath : JSON.stringify(input),
      "--json",
    ],
  });
  expect(result.exitCode).toBe(0);
  const evidence = contract.outputSchema.parse(result.json);
  expect(evidence.subject?.digest).toMatchObject({
    sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
  });
  const report = nesCodeTraceReportSchema.parse(evidence.normalized_result);
  const trace = report.code_trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.stop.reason).toBe("return");
  if (mapper === 4) {
    expect(
      trace.instructions.find((instruction) => instruction.address === 0x8000),
    ).toMatchObject({
      bytes_hex: "a903",
      file_offsets: [fixture.prgOffset + 16384, fixture.prgOffset + 16385],
    });
    expect(
      trace.instructions.find((instruction) => instruction.address === 0x8005),
    ).toMatchObject({
      bytes_hex: "a907",
      file_offsets: [fixture.prgOffset + 24581, fixture.prgOffset + 24582],
    });
  }
  for (const instruction of trace.instructions)
    expect(
      Buffer.from(
        instruction.file_offsets.map((offset) => {
          if (offset === null)
            throw new Error("Expected ROM-backed fixture instruction");
          return fixture.bytes[offset]!;
        }),
      ).toString("hex"),
    ).toBe(instruction.bytes_hex);
  expect(trace.mapper_trace).toMatchObject(
    mapper === 1
      ? { status: "derived", final: { prg_bank: 2 } }
      : {
          status: "derived",
          final: { banks: [null, null, null, null, null, null, 3, 1] },
        },
  );
  const response = await client.callTool({
    name: contract.name,
    arguments: input,
  });
  expect(response.isError).not.toBe(true);
  const mcp = contract.outputSchema.parse(response.structuredContent);
  expect(mcp.evidence_id).toBe(evidence.evidence_id);
  expect(mcp.normalized_result).toEqual(evidence.normalized_result);
  const text = response.content.find((item) => item.type === "text");
  if (text?.type !== "text") throw new Error("Missing text Evidence");
  expect(contract.outputSchema.parse(JSON.parse(text.text)).evidence_id).toBe(
    evidence.evidence_id,
  );
  // Independently replay the extracted mapper writes through the existing public contract.

  const replay = await replayNesThroughMcp(client, {
    ...input,
    writes: trace.instructions.flatMap((instruction) =>
      instruction.writes.filter((write) => write.address >= 32768),
    ),
  });
  const replayResult = replay.normalized_result;
  expect(replayResult).toMatchObject({ trace: trace.mapper_trace });
  const capped = await traceNesThroughMcp(client, {
    ...input,
    max_instructions: 1,
  });

  expect(
    nesCodeTraceReportSchema.parse(capped.normalized_result).code_trace,
  ).toMatchObject({
    status: "derived",
    instructions: [expect.any(Object)],
    stop: { reason: "instruction-budget" },
  });

  const exploration = await exploreNesThroughMcp(client, input);

  expect(exploration.normalized_result).toMatchObject({
    code_exploration: { status: "derived", paths: [{ trace }] },
  });
  expect(await readFile(path)).toEqual(fixture.bytes);
};

// Independent source requests share one validated SDK catalog; each board retains its own timeout.
const nesTest = cliTest.extend<{ $file: { nesClient: Client } }>({
  nesClient: [
    async ({ cliCompileCache }, use) => {
      const connection = createStdioToolClient("nes-code-acceptance", {
        NODE_COMPILE_CACHE: cliCompileCache,
      });
      const { client, transport } = connection;
      try {
        await client.connect(transport);
        await use(client);
      } finally {
        await connection.close();
      }
    },
    { scope: "file" },
  ],
});

nesTest(
  "extracts MMC1/MMC3 writes and conditional branches through real CLI and stdio MCP",
  async ({ cli, nesClient: client }) => {
    const root = await createTestTempDirectory("rea-nes-code-mmc-");
    expect((await client.listTools()).tools).toContainEqual(
      expect.objectContaining({
        name: contract.name,
        annotations: expect.objectContaining({
          readOnlyHint: false,
          openWorldHint: false,
        }),
      }),
    );
    await verifyCode(cli, client, root, 1);
    await verifyCode(cli, client, root, 4);
    const branchPath = join(root, "branches.nes");
    await writeFile(
      branchPath,
      nesCodeFixture(
        4,
        [
          0xad, 2, 0x20, 0xf0, 6, 0xa9, 2, 0x8d, 1, 0x80, 0x60, 0xa9, 3, 0x8d,
          1, 0x80, 0x60,
        ],
      ).bytes,
    );
    const branchIds = [];
    for (const taken of [false, true]) {
      const input = {
        path: branchPath,
        initial: { mapper: 4, bank_select: 6 },
        branch_choices: [{ address: 0xe003, taken }],
      };
      const mcpEvidence = await traceNesThroughAdapters(cli, client, input);
      expect(
        nesCodeTraceReportSchema.parse(mcpEvidence.normalized_result)
          .code_trace,
      ).toMatchObject({
        status: "derived",
        branch_choices_used: 1,
        stop: { reason: "return" },
        mapper_trace: {
          status: "derived",
          final: {
            banks: [null, null, null, null, null, null, taken ? 3 : 2, null],
          },
        },
      });
      branchIds.push(mcpEvidence.evidence_id);
    }
    expect(new Set(branchIds).size).toBe(2);
    const path = join(root, "mapper4.nes");
    for (const extra of [
      { cpu: { a: 256 } },
      { branch_choices: [{ address: 65536, taken: true }] },
      { branch_choices: [{ address: 0xe003, taken: "true" }] },
      { entry: -1 },
      { max_instructions: 0 },
      { initial: { mapper: 999 } },
    ])
      expect(
        (
          await client.callTool({
            name: contract.name,
            arguments: { path, initial: { mapper: 4 }, ...extra },
          })
        ).isError,
      ).toBe(true);
    const mismatchedInput = { path, initial: { mapper: 5 } };

    const mismatchedEvidence = await traceNesThroughMcp(
      client,
      mismatchedInput,
    );
    const original = await readFile(path);
    expect(mismatchedEvidence.parameters).toMatchObject({
      initial: { mapper: 5 },
    });
    expect(mismatchedEvidence.subject?.digest.sha256).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    expect(
      nesCodeTraceReportSchema.parse(mismatchedEvidence.normalized_result),
    ).toMatchObject({
      header: { mapper: 4, header: [...original.subarray(0, 16)] },
      code_trace: {
        status: "unsupported",
        reason: "Initial state mapper does not match the cartridge header.",
      },
    });
    const mismatchedCli = await cli.run({
      arguments: ["trace-nes-code", JSON.stringify(mismatchedInput), "--json"],
    });
    expect(mismatchedCli.exitCode, mismatchedCli.stderr).toBe(0);
    expect(mismatchedCli.json).toEqual(mismatchedEvidence);
    expect(await readFile(path)).toEqual(original);
    const unknown = await traceNesThroughMcp(client, {
      path: join(root, "mapper1.nes"),
      initial: { mapper: 1 },
    });
    expect(
      nesCodeTraceReportSchema.parse(unknown.normalized_result).code_trace,
    ).toMatchObject({
      status: "derived",
      stop: { reason: "unresolved-vector" },
      resolved_entry: null,
      instructions: [],
    });
    await client.ping();
  },
  60_000,
);

const verifyVectorEntries = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const fixture = nesCodeFixture(4, [0xa9, 0x11, 0x40]);
  fixture.bytes.set([0xa9, 0x22, 0x40], fixture.programOffset + 32);
  fixture.bytes.set([0xa9, 0x33, 0x40], fixture.programOffset + 64);
  fixture.bytes.writeUInt16LE(0xe020, fixture.prgOffset + fixture.prgSize - 6);
  fixture.bytes.writeUInt16LE(0xe040, fixture.prgOffset + fixture.prgSize - 2);
  const path = join(root, "interrupt-vector-entries.nes");
  await writeFile(path, fixture.bytes);

  for (const [entry, target, a, tail] of [
    ["nmi", 0xe020, 0x22, 6],
    ["irq", 0xe040, 0x33, 2],
  ] as const) {
    const input = {
      path,
      initial: { mapper: 4 },
      cpu: { sp: 255, i: false },
      entry,
    };

    const evidence = await traceNesThroughAdapters(cli, client, input);

    expect(evidence.subject?.digest).toMatchObject({
      sha256: createHash("sha256").update(fixture.bytes).digest("hex"),
    });
    const trace = nesCodeTraceReportSchema.parse(
      evidence.normalized_result,
    ).code_trace;
    expect(trace).toMatchObject({
      status: "derived",
      resolved_entry: target,
      final_cpu: { a, sp: 255, i: false },
      stop: { reason: "unknown-control-target", address: target + 2 },
    });
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.entry_vector).toEqual([
      {
        address: 65536 - tail,
        value: target & 255,
        file_offset: fixture.prgOffset + fixture.prgSize - tail,
      },
      {
        address: 65537 - tail,
        value: target >> 8,
        file_offset: fixture.prgOffset + fixture.prgSize - tail + 1,
      },
    ]);
    expect(trace.instructions).toHaveLength(1);
    expect(trace.instructions[0]!.file_offsets).toEqual([
      fixture.programOffset + target - 0xe000,
      fixture.programOffset + target - 0xe000 + 1,
    ]);
    expect(trace.instructions[0]!.writes).toEqual([]);
    const explored = await exploreNesThroughMcp(client, input);

    const exploration = nesCodeExplorationReportSchema.parse(
      explored.normalized_result,
    ).code_exploration;
    expect(exploration).toMatchObject({
      status: "derived",
      paths: [{ trace }],
    });
  }
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyInitialRam = async (cli: TestCli, client: Client, root: string) => {
  const fixture = nesCodeFixture(4, [0x40]);
  const path = join(root, "initial-ram-frame.nes");
  await writeFile(path, fixture.bytes);
  const initial_ram = [
    { address: 0x1fd, value: 0x21 },
    { address: 0x1fe, value: 0 },
    { address: 0x1ff, value: 0x0a },
    ...[0xa9, 0x60, 0x8d, 5, 0x0a, 0xea].map((value, index) => ({
      address: 0x200 + index,
      value,
    })),
  ];
  const input = {
    path,
    initial: { mapper: 4 },
    cpu: { sp: 0xfc, i: true },
    entry: "nmi",
    initial_ram,
  };

  const { trace, evidence } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.instructions.map((item) => item.mnemonic)).toEqual([
    "RTI",
    "LDA",
    "STA",
  ]);
  expect(trace.instructions[0]).toMatchObject({
    next_address: 0x0a00,
    writes: [],
    cpu_after: { sp: 255, i: false, c: true },
  });
  expect(trace.instructions[1]!.file_offsets).toEqual([null, null]);
  expect(trace.instructions[1]!.ram_origins).toEqual([
    {
      byte_index: 0,
      region: "internal-ram",
      ram_address: 0x200,
      initial_ram_index: 3,
    },
    {
      byte_index: 1,
      region: "internal-ram",
      ram_address: 0x201,
      initial_ram_index: 4,
    },
  ]);
  expect(trace.stop).toMatchObject({
    reason: "return",
    address: 0x0a05,
    bytes_hex: "60",
    ram_origins: [
      {
        byte_index: 0,
        region: "internal-ram",
        ram_address: 0x205,
        instruction_index: 2,
        write_index: 0,
      },
    ],
  });
  const explored = await exploreNesThroughMcp(client, input);

  expect(
    nesCodeExplorationReportSchema.parse(explored.normalized_result)
      .code_exploration,
  ).toMatchObject({ paths: [{ trace }] });

  const changedEvidence = await traceNesThroughMcp(client, {
    ...input,
    initial_ram: initial_ram.map((item, index) =>
      index === 4 ? { ...item, value: 2 } : item,
    ),
  });
  expect(changedEvidence.evidence_id).not.toBe(evidence.evidence_id);
  expect(changedEvidence.subject?.digest).toEqual(evidence.subject?.digest);
  expect(
    nesCodeTraceReportSchema.parse(changedEvidence.normalized_result)
      .code_trace,
  ).toMatchObject({ stop: { reason: "unsupported-opcode", bytes_hex: "02" } });
  for (const command of ["trace_nes_code", "explore_nes_code"]) {
    const invalid = {
      ...input,
      initial_ram: [
        { address: 0, value: 1 },
        { address: 0, value: 2 },
      ],
    };
    expect(
      (await client.callTool({ name: command, arguments: invalid })).isError,
    ).toBe(true);
    expect(
      (
        await cli.run({
          arguments: [
            command.replaceAll("_", "-"),
            JSON.stringify(invalid),
            "--json",
          ],
        })
      ).exitCode,
    ).not.toBe(0);
  }
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyInitialPrgRam = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const fixture = mmc1BankedRamCodeFixture("SXROM");
  const path = join(root, "initial-sxrom-storage.nes");
  await writeFile(path, fixture.bytes);
  const initial_prg_ram = [0, 1, 2, 3].flatMap((bank) =>
    [0xa9, 0x55, 0x60].map((value, index) => ({
      bank,
      address: 0x6000 + index,
      value,
    })),
  );
  const input = {
    path,
    entry: 0x6000,
    initial: { mapper: 1, prg_ram_disable_bit: 0 },
    initial_prg_ram,
  };
  const contract = toolContract("trace_nes_code");

  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.final_cpu.a).toBe(0x55);
  expect(trace.stop.reason).toBe("return");
  expect(trace.instructions[0]!.file_offsets).toEqual([null, null]);
  expect(trace.instructions[0]!.ram_origins).toEqual(
    [0, 1].flatMap((byte_index) =>
      [0, 1, 2, 3].map((bank) => ({
        byte_index,
        region: "prg-ram",
        bank,
        ram_address: 0x6000 + byte_index,
        initial_prg_ram_index: bank * 3 + byte_index,
      })),
    ),
  );

  const explored = await exploreNesThroughMcp(client, input);

  expect(
    nesCodeExplorationReportSchema.parse(explored.normalized_result)
      .code_exploration,
  ).toMatchObject({ paths: [{ trace }] });

  const missing = await traceNesThroughMcp(client, {
    ...input,
    initial_prg_ram: initial_prg_ram.slice(0, 9),
  });

  expect(
    nesCodeTraceReportSchema.parse(missing.normalized_result).code_trace,
  ).toMatchObject({
    instructions: [],
    stop: { reason: "unmapped-instruction" },
  });
  const invalid = {
    ...input,
    initial_prg_ram: [...initial_prg_ram, initial_prg_ram[0]],
  };
  expect(
    (await client.callTool({ name: contract.name, arguments: invalid }))
      .isError,
  ).toBe(true);
  expect(
    (
      await cli.run({
        arguments: ["trace-nes-code", JSON.stringify(invalid), "--json"],
      })
    ).exitCode,
  ).not.toBe(0);
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyDataReads = async (cli: TestCli, client: Client, root: string) => {
  const fixture = nesCodeFixture(
    4,
    [0xb1, 0xff, 0x91, 0xff, 0xad, 2, 0x20, 0x60],
  );
  const offset = fixture.prgOffset + 2 * 8192 + 3;
  fixture.bytes[offset] = 0x77;
  const path = join(root, "data-read-provenance.nes");
  await writeFile(path, fixture.bytes);
  const input = {
    path,
    initial: { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 2, 1] },
    cpu: { y: 3 },
    initial_ram: [
      { address: 255, value: 0 },
      { address: 0, value: 0x80 },
    ],
  };

  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  const pointers = [
    {
      address: 255,
      value: 0,
      file_offset: null,
      ram_origins: [
        {
          byte_index: 0,
          region: "internal-ram",
          ram_address: 255,
          initial_ram_index: 0,
        },
      ],
      mapper_origins: [],
    },
    {
      address: 0,
      value: 128,
      file_offset: null,
      ram_origins: [
        {
          byte_index: 0,
          region: "internal-ram",
          ram_address: 0,
          initial_ram_index: 1,
        },
      ],
      mapper_origins: [],
    },
  ];
  expect(
    trace.instructions.map((instruction) => instruction.data_reads),
  ).toEqual([
    [
      ...pointers,
      {
        address: 0x8003,
        value: 0x77,
        file_offset: offset,
        ram_origins: [],
        mapper_origins: [],
      },
    ],
    pointers,
    [
      {
        address: 0x2002,
        value: null,
        file_offset: null,
        ram_origins: [],
        mapper_origins: [],
      },
    ],
  ]);
  expect(trace.final_cpu.a).toBeNull();
  expect(trace.instructions[1]!.writes).toEqual([
    { address: 0x8003, value: 0x77, preceded_by_cpu_write: false },
  ]);

  const explored = await exploreNesThroughMcp(client, input);

  expect(
    nesCodeExplorationReportSchema.parse(explored.normalized_result)
      .code_exploration,
  ).toMatchObject({ paths: [{ trace }] });
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyAcceptedInterrupt = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  const fixture = nesCodeFixture(
    4,
    [0xa9, 6, 0x8d, 0, 0x80, 0xa9, 3, 0x8d, 1, 0x80, 0x40],
  );
  fixture.bytes.set(
    [0x90, 2, 0x02, 0x02, 0xa9, 0x55, 0x60],
    fixture.prgOffset + 3 * 8192,
  );
  const path = join(root, "accepted-irq-bank-switch.nes");
  await writeFile(path, fixture.bytes);
  const cpu = {
    sp: 255,
    c: false,
    z: false,
    i: false,
    d: false,
    n: false,
  };
  const input = {
    path,
    initial: { mapper: 4 },
    cpu,
    entry: { accepted_interrupt: "irq", return_address: 0x8000 },
  };
  const contract = toolContract("trace_nes_code");

  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.entry_interrupt).toMatchObject({
    kind: "irq",
    return_address: 0x8000,
    cpu_after: { sp: 252, i: true },
    writes: [
      { address: 511, value: 128, preceded_by_cpu_write: false },
      { address: 510, value: 0, preceded_by_cpu_write: true },
      {
        address: 509,
        value: null,
        preceded_by_cpu_write: true,
        known_bits: { mask: 0xbf, value: 0x20 },
      },
    ],
  });
  const rti = trace.instructions.find(
    (instruction) => instruction.mnemonic === "RTI",
  )!;
  expect(rti).toMatchObject({
    next_address: 0x8000,
    cpu_after: { ...cpu },
    writes: [],
  });
  expect(rti.data_reads.map((read) => read.ram_origins)).toEqual(
    [2, 1, 0].map((entry_interrupt_write_index, index) => [
      {
        byte_index: 0,
        region: "internal-ram",
        ram_address: 509 + index,
        entry_interrupt_write_index,
      },
    ]),
  );
  expect(trace.instructions.at(-1)).toMatchObject({
    address: 0x8004,
    file_offsets: [
      fixture.prgOffset + 3 * 8192 + 4,
      fixture.prgOffset + 3 * 8192 + 5,
    ],
  });
  expect(rti.cpu_after.v).toBeNull();
  expect(
    trace.instructions.some((instruction) => instruction.mnemonic === "BCC"),
  ).toBe(true);
  expect(trace.final_cpu).toMatchObject({ a: 0x55, sp: 255, i: false });

  const explored = await exploreNesThroughMcp(client, input);

  expect(
    nesCodeExplorationReportSchema.parse(explored.normalized_result)
      .code_exploration,
  ).toMatchObject({ paths: [{ trace }] });

  for (const entry of [
    { accepted_interrupt: "irq" },
    { accepted_interrupt: "reset", return_address: 0 },
    { accepted_interrupt: "nmi", return_address: 65536 },
  ])
    expect(
      (
        await client.callTool({
          name: contract.name,
          arguments: { ...input, entry },
        })
      ).isError,
    ).toBe(true);
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyPartialWriteReplay = async (
  cli: TestCli,
  client: Client,
  path: string,
  writes: NesMapperWrite[],
  finalState: unknown,
) => {
  const delivery = await createToolDelivery(client, cli);
  for (const name of [
    "trace_nes_mapper_writes",
    "trace_nes_mapper_events",
  ] as const) {
    const replayInput =
      name === "trace_nes_mapper_writes"
        ? { path, initial: { mapper: 4 }, writes }
        : {
            path,
            initial: { mapper: 4 },
            events: writes.map((write) => ({
              ...write,
              kind: "cpu-write",
            })),
          };
    const replayEvidence = toolContract(name).outputSchema.parse(
      await delivery.invoke(name, replayInput),
    );
    expect(replayEvidence.normalized_result).toMatchObject({
      trace: {
        status: "derived",
        final: finalState,
      },
    });
    const validateInput = delivery.contract(name).input;
    for (const invalidWrite of [
      { ...writes[0], value: 0x70 },
      { ...writes[0], known_bits: { mask: 0x10, value: 0x70 } },
    ]) {
      const invalidInput =
        name === "trace_nes_mapper_writes"
          ? { path, initial: { mapper: 4 }, writes: [invalidWrite] }
          : {
              path,
              initial: { mapper: 4 },
              events: [{ ...invalidWrite, kind: "cpu-write" }],
            };
      expect(
        (await client.callTool({ name, arguments: invalidInput })).isError,
      ).toBe(true);
      expect(validateInput(invalidInput)).toBe(false);
    }

    const first =
      name === "trace_nes_mapper_writes"
        ? { write: writes[0] }
        : { event: { ...writes[0], kind: "cpu-write" } };
    expect(replayEvidence.normalized_result).toMatchObject({
      trace: { steps: [first, {}, {}] },
    });
  }
};

const verifyPartialStatusBit = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  for (const overwritten of [false, true]) {
    const fixture = nesCodeFixture(4, [
      0x08, // PHP preserves N/V while other flags remain unknown.
      ...(overwritten ? [0xad, 2, 0x20, 0x8d, 0xff, 0x09] : []),
      0x2c,
      0xff,
      0x09, // BIT reads the same physical stack byte through a mirror.
      0x70,
      2,
      0x02,
      0x02,
      0xa9,
      6,
      0x8d,
      0,
      0x80,
      0xa9,
      3,
      0x8d,
      1,
      0x80,
      0x4c,
      0,
      0x80,
    ]);
    fixture.bytes.set([0xa9, 0x55, 0x02], fixture.prgOffset + 3 * 8192);
    const path = join(root, `partial-status-bit-${overwritten}.nes`);
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: { mapper: 4 },
      cpu: { sp: 255, a: 0x40, n: false, v: true },
    };
    const { trace } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    const bit = trace.instructions.find(
      (instruction) => instruction.mnemonic === "BIT",
    )!;
    expect(bit.data_reads).toHaveLength(1);
    if (overwritten) {
      expect(bit.data_reads[0]).toEqual({
        address: 0x09ff,
        value: null,
        file_offset: null,
        ram_origins: [],
        mapper_origins: [],
      });
      expect(bit.cpu_after).toMatchObject({ n: null, v: null, z: null });
      expect(trace.stop.reason).toBe("unknown-branch");
      expect(
        trace.instructions.some(
          (instruction) => instruction.address === 0x8000,
        ),
      ).toBe(false);
    } else {
      expect(bit.cpu_after).toMatchObject({
        a: 0x40,
        n: false,
        v: true,
        z: false,
      });
      expect(bit.data_reads[0]).toEqual({
        address: 0x09ff,
        value: null,
        file_offset: null,
        known_bits: { mask: 0xf0, value: 0x70 },
        mapper_origins: [],
        ram_origins: [
          {
            byte_index: 0,
            instruction_index: 0,
            write_index: 0,
            region: "internal-ram",
            ram_address: 0x01ff,
          },
        ],
      });
      expect(trace.instructions.at(-1)).toMatchObject({
        address: 0x8000,
        bytes_hex: "a955",
        file_offsets: [
          fixture.prgOffset + 3 * 8192,
          fixture.prgOffset + 3 * 8192 + 1,
        ],
      });
      expect(trace.final_cpu.a).toBe(0x55);
      const writes = trace.instructions.flatMap(
        (instruction) => instruction.writes,
      );
      await verifyPartialWriteReplay(
        cli,
        client,
        path,
        writes,
        trace.mapper_trace.status === "derived"
          ? trace.mapper_trace.final
          : null,
      );
      const explored = await exploreNesThroughMcp(client, input);

      expect(
        nesCodeExplorationReportSchema.parse(explored.normalized_result)
          .code_exploration,
      ).toMatchObject({ paths: [{ trace }] });
    }
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
};

const partialStatusOpcodes = {
  logic: 0x2d,
  compare: 0xcd,
  load: 0xad,
  pull: 0x68,
  add: 0x6d,
  subtract: 0xed,
  las: 0xbb,
  shift: 0x0e,
} as const;

const verifyPartialStatusAlu = async (
  cli: TestCli,
  client: Client,
  root: string,
  operation: keyof typeof partialStatusOpcodes = "logic",
) => {
  const arithmetic = operation === "add" || operation === "subtract";
  const opcode = partialStatusOpcodes[operation];
  const prefix =
    operation === "logic"
      ? [0x08, 0x2d, 0xff, 0x09, 0x09, 6]
      : [
          0x08,
          ...(operation === "pull"
            ? [0x68]
            : [opcode, operation === "las" ? 0x41 : 0xff, 0x09]),
          arithmetic || operation === "shift"
            ? 0x30
            : operation === "compare"
              ? 0x90
              : 0x10,
          1,
          0x02,
          0xa9,
          0x46,
        ];
  const fixture = nesCodeFixture(4, [
    ...prefix,
    0x8d,
    0,
    0x80,
    0xa9,
    2,
    0x8d,
    1,
    0x80,
    0x60,
  ]);
  const path = join(root, `partial-status-alu-${operation}.nes`);
  await writeFile(path, fixture.bytes);
  const input = {
    path,
    initial: { mapper: 4 },
    cpu: {
      sp: operation === "las" ? 65 : 255,
      ...(operation === "las" ? { y: 0 } : {}),
      a: operation === "add" ? 16 : 64,
      n: false,
      v: true,
      ...(arithmetic ? { c: operation === "subtract", d: true } : {}),
    },
  };
  const { trace } = await (
    await createNesSourceCaller(cli, client)
  ).code(input);
  expect(trace.instructions[1]).toMatchObject({
    cpu_after: arithmetic
      ? {
          a: null,
          c: false,
          n: true,
          z: false,
          v: operation === "add",
          d: true,
        }
      : operation === "compare"
        ? { a: 64, c: false, n: true, z: false, v: true }
        : operation === "load" || operation === "pull"
          ? { a: null, n: false, z: false, v: true }
          : { a: 64 },
    data_reads: [
      {
        known_bits: arithmetic
          ? { mask: 249, value: operation === "add" ? 120 : 121 }
          : { mask: 240, value: 112 },
        ram_origins: [{ instruction_index: 0 }],
      },
    ],
  });
  if (operation === "shift")
    expect(trace.instructions[1]).toMatchObject({
      cpu_after: { a: 64, n: true, z: false, c: false },
      writes: [
        {
          value: null,
          known_bits: { mask: 240, value: 112 },
          preceded_by_cpu_write: false,
        },
        {
          value: null,
          known_bits: { mask: 225, value: 224 },
          preceded_by_cpu_write: true,
        },
      ],
    });
  if (operation === "las")
    expect(trace.instructions[1]).toMatchObject({
      cpu_after: { a: 64, x: 64, sp: 64, n: false, z: false },
    });
  if (operation !== "logic")
    expect(trace.instructions[2]).toMatchObject({
      mnemonic:
        arithmetic || operation === "shift"
          ? "BMI"
          : operation === "compare"
            ? "BCC"
            : "BPL",
      next_address: fixture.entry + (operation === "pull" ? 5 : 7),
    });
  expect(trace.mapper_trace).toMatchObject({
    final: {
      bank_select: 70,
      banks: [null, null, null, null, null, null, 2, null],
    },
    final_mapping: {
      prg_windows: expect.arrayContaining([
        expect.objectContaining({ start: 0xc000, bank: 2 }),
      ]),
    },
  });
  expect(await readFile(path)).toEqual(fixture.bytes);
};

const verifyPartialIncDec = async (
  cli: TestCli,
  client: Client,
  root: string,
) => {
  for (const { opcode, readBack } of [
    { opcode: 0xee, readBack: true },
    { opcode: 0xce, readBack: true },
    { opcode: 0xee, readBack: false },
  ]) {
    const fixture = nesCodeFixture(4, [
      0x08,
      opcode,
      0xff,
      0x09,
      ...(readBack ? [0xad, 0xff, 0x09, 0x10] : [0xd0]),
      1,
      0x02,
      0xa9,
      0x46,
      0x8d,
      0,
      0x80,
      0xa9,
      2,
      0x8d,
      1,
      0x80,
      0x02,
    ]);
    const path = join(root, `partial-inc-dec-${opcode}-${readBack}.nes`);
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: { mapper: 4 },
      cpu: { sp: 255, n: false, v: true },
    };
    const { trace } = await (
      await createNesSourceCaller(cli, client)
    ).code(input);
    expect(trace.instructions[1]!.writes[0]).toMatchObject({
      value: null,
      known_bits: { mask: 240, value: 112 },
      preceded_by_cpu_write: false,
    });
    if (!readBack) {
      expect(trace.instructions[1]).toMatchObject({
        cpu_after: { n: null, z: false },
        writes: [{ known_bits: { mask: 240, value: 112 } }, { value: null }],
      });
      expect(trace.instructions[1]!.writes[1]).not.toHaveProperty("known_bits");
      expect(trace.instructions[2]).toMatchObject({
        mnemonic: "BNE",
        next_address: fixture.entry + 7,
      });
      expect(trace.mapper_trace).toMatchObject({
        final: {
          bank_select: 70,
          banks: [null, null, null, null, null, null, 2, null],
        },
      });
    } else if (opcode === 0xee) {
      expect(trace.instructions[1]!.writes[1]).toEqual({
        address: 0x09ff,
        value: null,
        preceded_by_cpu_write: true,
      });
      expect(trace.instructions[2]!.data_reads[0]).toMatchObject({
        value: null,
        ram_origins: [],
      });
      expect(trace.stop).toMatchObject({
        reason: "unknown-branch",
        address: fixture.entry + 7,
      });
    } else {
      expect(trace.instructions[1]!.writes[1]).toMatchObject({
        value: null,
        known_bits: { mask: 224, value: 96 },
        preceded_by_cpu_write: true,
      });
      expect(trace.instructions[2]!.data_reads[0]).toMatchObject({
        known_bits: { mask: 224, value: 96 },
        ram_origins: [{ instruction_index: 1, write_index: 1 }],
      });
      expect(trace.instructions[3]).toMatchObject({
        mnemonic: "BPL",
        next_address: fixture.entry + 10,
      });
      expect(trace.mapper_trace).toMatchObject({
        final: {
          bank_select: 70,
          banks: [null, null, null, null, null, null, 2, null],
        },
      });
    }
    expect(await readFile(path)).toEqual(fixture.bytes);
  }
};

const boardWorkflows: readonly {
  name: string;
  verify: (cli: TestCli, client: Client, root: string) => Promise<void>;
}[] = [
  {
    name: "partial status logic and MMC3 bank switching",
    verify: verifyPartialStatusAlu,
  },
  {
    name: "partial status comparison and MMC3 bank switching",
    verify: (cli, client, root) =>
      verifyPartialStatusAlu(cli, client, root, "compare"),
  },
  {
    name: "partial status load and MMC3 bank switching",
    verify: (cli, client, root) =>
      verifyPartialStatusAlu(cli, client, root, "load"),
  },
  {
    name: "partial status PLA and MMC3 bank switching",
    verify: (cli, client, root) =>
      verifyPartialStatusAlu(cli, client, root, "pull"),
  },
  {
    name: "partial status ADC and MMC3 bank switching",
    verify: (cli, client, root) =>
      verifyPartialStatusAlu(cli, client, root, "add"),
  },
  {
    name: "partial status SBC and MMC3 bank switching",
    verify: (cli, client, root) =>
      verifyPartialStatusAlu(cli, client, root, "subtract"),
  },
  {
    name: "partial status LAS and MMC3 bank switching",
    verify: (cli, client, root) =>
      verifyPartialStatusAlu(cli, client, root, "las"),
  },
  {
    name: "partial status RMW and MMC3 bank switching",
    verify: (cli, client, root) =>
      verifyPartialStatusAlu(cli, client, root, "shift"),
  },
  {
    name: "partial INC DEC writes and branch frontiers",
    verify: verifyPartialIncDec,
  },
  { name: "interrupt vector entries", verify: verifyVectorEntries },
  { name: "caller-selected internal RAM", verify: verifyInitialRam },
  { name: "caller-selected cartridge RAM", verify: verifyInitialPrgRam },
  { name: "data read provenance", verify: verifyDataReads },
  {
    name: "partial status BIT and MMC3 branch",
    verify: verifyPartialStatusBit,
  },
  {
    name: "accepted IRQ entry and bank-switched return",
    verify: verifyAcceptedInterrupt,
  },
  {
    name: "MC-ACC source bank switching",
    verify: (cli, client, root) => verifyCode(cli, client, root, 4, 3),
  },
  {
    name: "NEC MMC3 source bank switching",
    verify: (cli, client, root) => verifyCode(cli, client, root, 4, 4),
  },
  { name: "MMC3 hardwired mirroring", verify: verifyMmc3Hardwired },
  { name: "MMC6 RAM mirrors and permissions", verify: verifyMmc6 },
  { name: "MMC1 fixed PRG submapper", verify: verifyMmc1Fixed },
  { name: "deprecated MMC1 board headers", verify: verifyDeprecatedMmc1 },
  { name: "MMC1 outer ROM banking", verify: verifyMmc1Outer },
  { name: "MMC1 banked RAM provenance", verify: verifyMmc1BankedRam },
  { name: "MMC1B and SNROM RAM enable", verify: verifyMmc1Ram },
  { name: "MMC4 RAM trampoline and bank switching", verify: verifyMmc4Ram },
  { name: "MMC3 PRG RAM enable and protection", verify: verifyMmc3Ram },
  { name: "NINA-001 PRG RAM and register readback", verify: verifyNinaRam },
  { name: "BNROM and NINA-001 write decoders", verify: verifyMapper34 },
  { name: "BRK/RTI across MMC3 switching", verify: verifyBrk },
  { name: "NROM cartridge RAM mirrors", verify: verifyNromRam },
  { name: "NROM instructions and branches", verify: verifyNrom },
  {
    name: "RTI and RAM code provenance",
    verify: (_cli, client, root) => verifyRti(client, root),
  },
  {
    name: "CNROM bus conflicts",
    verify: (_cli, client, root) => verifyCnrom(client, root),
  },
  { name: "inverted UNROM bank switching", verify: verifyInvertedUnrom },
  { name: "UxROM bank switching", verify: verifyUxrom },
  { name: "AxROM bank switching and mirroring", verify: verifyAxrom },
  { name: "GxROM PRG/CHR switching", verify: verifyGxrom },
  { name: "Color Dreams conflict policies", verify: verifyColorDreams },
  { name: "Camerica submapper mirroring", verify: verifyCamerica },
];

for (const { name, verify } of boardWorkflows) {
  nesTest(
    `traces ${name} through the public adapters`,
    async ({ cli, nesClient: client }) => {
      const root = await createTestTempDirectory("rea-nes-code-board-");
      await verify(cli, client, root);
      await client.ping();
    },
    60_000,
  );
}
