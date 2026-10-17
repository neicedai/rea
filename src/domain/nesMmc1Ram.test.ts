import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import {
  mmc1BankedRamCodeFixture,
  mmc1OuterCodeFixture,
  mmc1FixedCodeFixture,
  mmc1RamCodeFixture,
  mmc1WriteProgram,
} from "./nesCode.fixture.js";

import { nesPrgRamAccess } from "./nesPrgRam.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";

const initial = {
  mapper: 1,
  prg_mode: 3,
  prg_bank: 0,
  prg_ram_disable_bit: 0,
  chr_mode: 0,
  chr_bank_0: 0,
  chr_bank_1: 0,
  shift_bits: [],
};
const trace = async (
  fixture: ReturnType<typeof mmc1RamCodeFixture>,
  state: unknown = initial,
) => {
  const { trace: result } = await deriveNesFixtureTrace(
    fixture.bytes,
    fixture.bytes.subarray(
      fixture.prgOffset,
      fixture.prgOffset + fixture.prgSize,
    ),
    { path: "/mmc1.nes", initial: state },
  );
  return result;
};

it.each([
  [0, 0, 16, 0, true],
  [0, 16, 0, 0, false],
  [1, 0, 16, 0, null],
  [1, 0, 1, 0, true],
  [1, 16, 17, 0, false],
  [null, 0, 1, 0, true],
  [null, 0, 16, 0, null],
  [1, null, 0, 1, false],
  [1, 16, 17, null, false],
  [0, { mask: 16, value: 0 }, null, 0, true],
  [1, { mask: 16, value: 0 }, { mask: 16, value: 16 }, 0, null],
  [null, { mask: 16, value: 16 }, { mask: 16, value: 16 }, 0, false],
] as const)(
  "joins SNROM enables for mode=%s CHR0=%s CHR1=%s PRG=%s",
  (mode, first, second, prgDisable, expected) => {
    const fixture = mmc1RamCodeFixture([], true);
    const header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const state = nesMapperStateSchema.parse({
      ...initial,
      chr_mode: mode,
      chr_bank_0: first,
      chr_bank_1: second,
      prg_ram_disable_bit: prgDisable,
    });
    expect(nesPrgRamAccess(header.value, state)).toEqual({
      readable: expected,
      writable: expected,
      banks: [0],
    });
  },
);

it("does not use CHR ROM selector bits as RAM enables on ordinary SxROM", async () => {
  const result = await trace(
    mmc1RamCodeFixture([0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60]),
    { ...initial, chr_bank_0: 16, chr_bank_1: 0, chr_mode: 1 },
  );
  expect(result.final_cpu.a).toBe(0x55);
});

it.each([null, 0, 10, 0x66])(
  "does not infer unsupported MMC1 RAM declaration %s",
  async (declaration) => {
    const fixture = mmc1RamCodeFixture([
      0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60,
    ]);
    fixture.bytes[10] = declaration ?? 0;
    if (declaration === null) fixture.bytes[7] = 0;
    expect((await trace(fixture)).final_cpu.a).toBeNull();
  },
);

it("applies SNROM enable wiring to its 8 KiB CHR ROM variant", async () => {
  const fixture = mmc1RamCodeFixture([
    0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60,
  ]);
  fixture.bytes[5] = 1;
  fixture.bytes = fixture.bytes.subarray(
    0,
    fixture.prgOffset + fixture.prgSize + 8192,
  );
  expect(
    (await trace(fixture, { ...initial, chr_bank_0: 16 })).final_cpu.a,
  ).toBeNull();
  expect((await trace(fixture)).final_cpu.a).toBe(0x55);
});

it.each([0, 8, 0x66])(
  "does not assume SNROM wiring for CHR RAM declaration %s",
  async (declaration) => {
    const fixture = mmc1RamCodeFixture(
      [0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60],
      true,
    );
    fixture.bytes[11] = declaration;
    expect((await trace(fixture)).final_cpu.a).toBeNull();
  },
);

it.each(["SOROM", "SXROM", "SZROM"] as const)(
  "retains distinct %s bank provenance when PPU selection is unknown",
  async (kind) => {
    const result = await trace(mmc1BankedRamCodeFixture(kind));
    expect(result.final_cpu.a).toBe(0x55);
    const instruction = result.instructions.at(-1)!;
    expect(instruction.address).toBe(0x6000);
    expect(instruction.file_offsets).toEqual([null, null]);
    expect(
      instruction.ram_origins.map((origin) => ({
        byte_index: origin.byte_index,
        bank: origin.region === "prg-ram" ? origin.bank : null,
        instruction_index:
          "instruction_index" in origin ? origin.instruction_index : null,
      })),
    ).toEqual([
      { byte_index: 0, bank: 0, instruction_index: 1 },
      { byte_index: 0, bank: kind === "SXROM" ? 3 : 1, instruction_index: 17 },
      { byte_index: 1, bank: 0, instruction_index: 3 },
      { byte_index: 1, bank: kind === "SXROM" ? 3 : 1, instruction_index: 19 },
    ]);
    expect(result.stop).toMatchObject({ reason: "return", address: 0x6002 });
  },
);

it.each([
  [false, null, false],
  [true, 0x55, true],
  [true, 0x66, false],
] as const)(
  "joins bank contents and uncertain stores (%s, %s)",
  async (same, write, known) => {
    const result = await trace(mmc1BankedRamCodeFixture("SOROM", same, write));
    expect(result.instructions.some(({ address }) => address === 0x6000)).toBe(
      known,
    );
    if (known) expect(result.final_cpu.a).toBe(0x55);
    else expect(result.stop.address).toBe(0x6000);
  },
);

it("keeps all four SXROM physical banks independent through serial selection", async () => {
  const program: number[] = [];
  for (let bank = 0; bank < 4; bank++)
    program.push(
      ...mmc1WriteProgram(0xa000, bank << 2),
      0xa9,
      0x40 + bank,
      0x8d,
      0,
      0x60,
    );
  for (let bank = 0; bank < 4; bank++)
    program.push(
      ...mmc1WriteProgram(0xa000, bank << 2),
      0xad,
      0,
      0x60,
      0x85,
      0x10 + bank,
    );
  program.push(0x60);
  const fixture = mmc1RamCodeFixture(program, true);
  fixture.bytes[10] = 9;
  const result = await trace(fixture);
  const writes = result.instructions.flatMap(({ writes }) => writes);
  for (let bank = 0; bank < 4; bank++)
    expect(writes).toContainEqual({
      address: 0x10 + bank,
      value: 0x40 + bank,
      preceded_by_cpu_write: false,
    });
});

it.each([3, 4])(
  "requires every unknown-selector candidate before fetching SXROM RAM (%s populated banks)",
  async (populated) => {
    const program: number[] = [];
    const code = [0xad, 0, 0x60, 0x60];
    for (let bank = 0; bank < populated; bank++) {
      program.push(...mmc1WriteProgram(0xa000, bank << 2));
      for (const [offset, value] of code.entries())
        program.push(0xa9, value, 0x8d, offset, 0x60);
    }
    // MMIO is unobserved. Five writes commit an unknown CHR/RAM selector.
    program.push(0xad, 2, 0x20);
    for (let bit = 0; bit < 5; bit++) program.push(0x8d, 0, 0xa0);
    program.push(0x4c, 0, 0x60);
    const fixture = mmc1RamCodeFixture(program, true);
    fixture.bytes[10] = 9;
    const result = await trace(fixture);
    if (populated === 3) {
      expect(result.stop).toMatchObject({
        reason: "unmapped-instruction",
        address: 0x6000,
        ram_origins: [],
      });
      return;
    }
    expect(result.final_cpu.a).toBe(0xad);
    const instruction = result.instructions.at(-1)!;
    expect(instruction).toMatchObject({
      address: 0x6000,
      bytes_hex: "ad0060",
      file_offsets: [null, null, null],
    });
    expect(instruction.ram_origins).toHaveLength(12);
    for (let byte = 0; byte < 3; byte++) {
      const origins = instruction.ram_origins.filter(
        (origin) => origin.byte_index === byte,
      );
      expect(
        origins.map((origin) =>
          origin.region === "prg-ram" ? origin.bank : null,
        ),
      ).toEqual([0, 1, 2, 3]);
      for (const origin of origins) {
        if (!("instruction_index" in origin))
          throw new Error("Expected derived RAM writer");
        expect(
          result.instructions[origin.instruction_index]!.writes[
            origin.write_index
          ],
        ).toMatchObject({ address: 0x6000 + byte, value: code[byte] });
      }
    }
    expect(result.stop).toMatchObject({ reason: "return", address: 0x6003 });
  },
);

it.each(["SOROM", "SZROM"] as const)(
  "retains separate banks for mixed volatile/battery RAM on %s",
  async (kind) => {
    const fixture = mmc1BankedRamCodeFixture(kind);
    fixture.bytes[10] = 0x77;
    fixture.bytes[6]! |= 2;
    const result = await trace(fixture);
    expect(result.final_cpu.a).toBe(0x55);
    expect(result.instructions.at(-1)!.ram_origins).toHaveLength(4);
    expect(result.stop).toMatchObject({ reason: "return", address: 0x6002 });
  },
);

it.each([0, 1, 2, 3] as const)(
  "switches outer ROM halves while retaining RAM bank %s",
  async (ramBank) => {
    const fixture = mmc1OuterCodeFixture(ramBank);
    const result = await trace(fixture, {
      ...initial,
      chr_bank_0: ramBank << 2,
    });
    const origins = result.instructions.flatMap(
      (instruction) => instruction.ram_origins,
    );
    expect(origins.length).toBeGreaterThan(0);
    for (const origin of origins)
      expect(origin).toMatchObject({ region: "prg-ram", bank: ramBank });
    expect(result.final_cpu.a).toBe(0x66);
    expect(result.instructions.at(-1)).toMatchObject({
      address: 0x8000,
      file_offsets: [16 + 0x40000, 17 + 0x40000],
    });
    if (result.mapper_trace.status !== "derived")
      throw new Error(result.mapper_trace.reason);
    expect(
      result.mapper_trace.final_mapping.prg_windows.map(
        (window) => window.bank,
      ),
    ).toEqual([16, 31]);
    expect(result.mapper_trace.nes_prg_views).toEqual([
      { mapper: 1, prg_mode: 3, prg_bank: 0, prg_outer_bank: 0 },
      { mapper: 1, prg_mode: 3, prg_bank: 0, prg_outer_bank: 1 },
    ]);
    const unknown = await trace(fixture, {
      ...initial,
      chr_mode: 1,
      chr_bank_1: 16,
    });
    expect(unknown.stop.reason).toBe("unresolved-vector");
    if (unknown.mapper_trace.status !== "derived")
      throw new Error(unknown.mapper_trace.reason);
    expect(
      unknown.mapper_trace.final_mapping.prg_windows.map(
        (window) => window.bank,
      ),
    ).toEqual([null, null]);
  },
);

it("traces submapper 5 without assumed PRG selectors and preserves CHR writes", async () => {
  const fixture = mmc1FixedCodeFixture();
  const result = await trace(fixture, { mapper: 1, shift_bits: [] });
  expect(result.final_cpu.a).toBe(0x66);
  expect(result.instructions[0]!.address).toBe(0x8000);
  for (const instruction of result.instructions)
    expect(instruction.file_offsets).toEqual(
      Array.from(
        { length: instruction.bytes_hex.length / 2 },
        (_, byte) => 16 + instruction.address - 0x8000 + byte,
      ),
    );
  if (result.mapper_trace.status !== "derived")
    throw new Error(result.mapper_trace.reason);
  expect(result.mapper_trace.final).toMatchObject({
    prg_bank: 1,
    prg_mode: 3,
    chr_bank_0: 2,
  });
  expect(
    result.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
  ).toEqual([0, 1]);
  expect(
    result.mapper_trace.final_mapping.chr_windows.map((window) => window.bank),
  ).toEqual([2, 3]);
  expect(result.mapper_trace.nes_prg_views).toEqual([]);
});

it("does not apply ordinary MMC1 PRG RAM wiring to fixed-PRG boards", async () => {
  const fixture = mmc1FixedCodeFixture();
  fixture.bytes[10] = 7;
  fixture.bytes.set([0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60], 16);
  const result = await trace(fixture, { mapper: 1, prg_ram_disable_bit: 0 });
  expect(result.final_cpu.a).toBeNull();
  expect(result.stop.reason).toBe("return");
});

it.each([1, 2, 4] as const)(
  "accepts capacity-consistent deprecated MMC1 submapper %i",
  async (submapper) => {
    const fixture =
      submapper === 2
        ? mmc1BankedRamCodeFixture("SOROM")
        : mmc1OuterCodeFixture(submapper === 4 ? 3 : 0);
    fixture.bytes[8] = submapper << 4;
    const result = await trace(fixture, {
      ...initial,
      chr_bank_0: submapper === 4 ? 12 : 0,
    });
    expect(result.stop.reason).toBe("return");
    expect(result.final_cpu.a).toBe(submapper === 2 ? 0x55 : 0x66);
    expect(
      result.instructions.some(
        (instruction) => instruction.ram_origins.length > 0,
      ),
    ).toBe(true);
  },
);
