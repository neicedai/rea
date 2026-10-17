import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import {
  ninaRamCodeFixture,
  nromRamCodeFixture,
  mmc3RamCodeFixture,
  mmc6RamCodeFixture,
  mmc1BankedRamCodeFixture,
  mmc1WriteProgram,
} from "./nesCode.fixture.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { nesCodeTraceSchema, traceNesCodeInputSchema } from "./nesCodeTrace.js";

const trace = async (fixture: ReturnType<typeof ninaRamCodeFixture>) => {
  const { trace: result } = await deriveNesFixtureTrace(
    fixture.bytes,
    fixture.bytes.subarray(
      fixture.prgOffset,
      fixture.prgOffset + fixture.prgSize,
    ),
    {
      path: "/nina.nes",
      entry: fixture.entry,
      initial: { mapper: 34, prg_bank: 0 },
    },
  );
  return result;
};

it.each([7, 0x70, 0, 0x66, 8, 0x77])(
  "keeps NINA register selectors distinct from RAM declaration %s",
  async (declaration) => {
    const result = await trace(
      ninaRamCodeFixture(
        [0xa9, 0xf1, 0x8d, 0xfd, 0x7f, 0xad, 0xfd, 0x7f, 0x60],
        declaration,
      ),
    );
    expect(result.final_cpu.a).toBe(
      declaration === 7 || declaration === 0x70 ? 0xf1 : null,
    );
    expect(result.mapper_trace).toMatchObject({ final: { prg_bank: 1 } });
    expect(result.stop.reason).toBe("return");
  },
);

it("uses legacy NINA wiring without pretending the header declares RAM sizes", async () => {
  const fixture = ninaRamCodeFixture([
    0xa9, 0xfe, 0x8d, 0xfe, 0x7f, 0xad, 0xfe, 0x7f, 0x60,
  ]);
  fixture.bytes[7] = 0x20;
  fixture.bytes[8] = 0;
  fixture.bytes[10] = 0;
  const result = await trace(fixture);
  expect(result.final_cpu.a).toBe(0xfe);
  expect(result.mapper_trace).toMatchObject({ final: { chr_bank_0: 14 } });
});

it("keeps PRG RAM and internal RAM distinct across a PRG switch", async () => {
  const fixture = ninaRamCodeFixture([
    0xa9, 0xa9, 0x8d, 0, 0x60, 0xa9, 0x55, 0x8d, 1, 0x60, 0xa9, 0x60, 0x8d, 2,
    0x60, 0xa9, 0x44, 0x85, 0, 0xa9, 1, 0x8d, 0xfd, 0x7f, 0x4c, 0, 0x60,
  ]);
  const result = await trace(fixture);
  expect(result.final_cpu.a).toBe(0x55);
  expect(result.instructions.at(-1)).toMatchObject({
    address: 0x6000,
    bytes_hex: "a955",
    file_offsets: [null, null],
    ram_origins: [
      {
        region: "prg-ram",
        byte_index: 0,
        ram_address: 0x6000,
        instruction_index: 1,
        write_index: 0,
      },
      {
        region: "prg-ram",
        byte_index: 1,
        ram_address: 0x6001,
        instruction_index: 3,
        write_index: 0,
      },
    ],
  });
  expect(result.stop).toMatchObject({
    reason: "return",
    address: 0x6002,
    ram_origins: [{ region: "prg-ram", instruction_index: 5 }],
  });
});

it("fetches one instruction across a NINA register RAM byte and selected PRG ROM", async () => {
  const fixture = ninaRamCodeFixture([
    0xa9, 0xf1, 0x8d, 0xfd, 0x7f, 0xa9, 0xa9, 0x8d, 0xff, 0x7f, 0x4c, 0xff,
    0x7f,
  ]);
  fixture.bytes.set([0x55, 0x60], 32784);
  const result = await trace(fixture);
  expect(result.instructions.at(-1)).toMatchObject({
    address: 0x7fff,
    bytes_hex: "a955",
    file_offsets: [null, 32784],
    ram_origins: [
      {
        region: "prg-ram",
        byte_index: 0,
        ram_address: 0x7fff,
        instruction_index: 3,
        write_index: 0,
      },
    ],
  });
  expect(result.final_cpu.a).toBe(0x55);
  expect(result.mapper_trace).toMatchObject({
    final: { prg_bank: 1, chr_bank_1: 9 },
  });
});

it("invalidates a known PRG RAM opcode when overwritten with an unknown value", async () => {
  const result = await trace(
    ninaRamCodeFixture([
      0xa9, 0x60, 0x8d, 0, 0x60, 0xad, 2, 0x20, 0x8d, 0, 0x60, 0x4c, 0, 0x60,
    ]),
  );
  expect(result.stop).toMatchObject({
    reason: "unmapped-instruction",
    address: 0x6000,
  });
  expect(result.instructions).toHaveLength(5);
});

it("does not seed RAM from a mapper selector or extend NINA wiring to BNROM", async () => {
  const unwritten = await trace(ninaRamCodeFixture([0xad, 0xfd, 0x7f, 0x60]));
  expect(unwritten.final_cpu.a).toBeNull();
  const fixture = ninaRamCodeFixture([
    0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60,
  ]);
  fixture.bytes[8] = 0x20;
  fixture.bytes[5] = 0;
  fixture.bytes = fixture.bytes.subarray(0, 16 + 65536);
  expect((await trace(fixture)).final_cpu.a).toBeNull();
});

it.each([5, 6, 7, 0x50, 0x60, 0x70])(
  "executes NROM RAM declaration %i through physical aliases",
  async (declaration) => {
    const fixture = nromRamCodeFixture(declaration);
    const header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    for (const permission of [true, false, null]) {
      const result = nesCodeTraceSchema.parse(
        await deriveNesCode(
          header.value,
          fixture.bytes.subarray(16, 32784),
          traceNesCodeInputSchema.parse({
            path: "/nrom.nes",
            initial: { mapper: 0, prg_ram_write_enabled: permission },
          }),
        ),
      );
      if (result.status !== "derived") throw new Error(result.reason);
      if (permission === true) {
        expect(result.final_cpu.a).toBe(0x55);
        expect(result.stop.reason).toBe("return");
        expect(result.instructions.at(-1)).toMatchObject({
          address: 0x6000,
          file_offsets: [null, null],
          ram_origins: [
            { region: "prg-ram", ram_address: 0x6000, bank: 0 },
            { region: "prg-ram", ram_address: 0x6001, bank: 0 },
          ],
        });
      } else {
        expect(result.stop.address).toBe(0x6000);
        expect(result.stop.bytes_hex).toBe("");
        expect(result.stop.ram_origins).toEqual([]);
      }
    }
  },
);

it.each([0, 4, 8, 0x55])(
  "does not invent NROM RAM wiring for declaration %i",
  async (declaration) => {
    const fixture = nromRamCodeFixture(declaration);
    for (const legacy of [false, true]) {
      fixture.bytes[7] = legacy ? 0 : 8;
      const header = parseNesHeader(fixture.bytes);
      if (!header.ok) throw new Error(header.error);
      const result = nesCodeTraceSchema.parse(
        await deriveNesCode(
          header.value,
          fixture.bytes.subarray(16, 32784),
          traceNesCodeInputSchema.parse({
            path: "/nrom.nes",
            initial: { mapper: 0, prg_ram_write_enabled: true },
          }),
        ),
      );
      expect(result).toMatchObject({
        status: "derived",
        stop: { address: 0x6000, bytes_hex: "", ram_origins: [] },
      });
    }
  },
);

it.each([5, 6, 7])(
  "keeps per-byte provenance across NROM RAM boundary declaration %i",
  async (declaration) => {
    const fixture = nromRamCodeFixture(declaration);
    const size = 64 * 2 ** declaration;
    const boundary = 0x6000 + size - 1;
    fixture.bytes.fill(2, 16, 32784);
    // For 8 KiB RAM, the operand and RTS come from ROM instead of a RAM mirror.
    fixture.bytes.set([0x55, 0x60], 16);
    const program = [0xa9, 0xa9, 0x8d, 0xff, 0x7f];
    if (size < 8192)
      program.push(
        0xa9,
        0x54,
        0x8d,
        0,
        0x60,
        0xee,
        0,
        (0x8000 - size) >> 8,
        0xa9,
        0x60,
        0x8d,
        1,
        0x60,
      );
    program.push(0x4c, boundary & 255, boundary >> 8);
    fixture.bytes.set(program, 16 + 256);
    fixture.bytes.writeUInt16LE(0x8100, 16 + 32768 - 4);
    const header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const result = nesCodeTraceSchema.parse(
      await deriveNesCode(
        header.value,
        fixture.bytes.subarray(16, 32784),
        traceNesCodeInputSchema.parse({
          path: "/boundary.nes",
          initial: { mapper: 0, prg_ram_write_enabled: true },
        }),
      ),
    );
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.final_cpu.a).toBe(0x55);
    expect(result.instructions.at(-1)).toMatchObject({
      address: boundary,
      bytes_hex: "a955",
      file_offsets: [null, size === 8192 ? 16 : null],
      ram_origins: [
        {
          byte_index: 0,
          region: "prg-ram",
          bank: 0,
          ram_address: boundary,
          instruction_index: 1,
          write_index: 0,
        },
        ...(size === 8192
          ? []
          : [
              {
                byte_index: 1,
                region: "prg-ram",
                bank: 0,
                ram_address: 0x6000,
                instruction_index: 4,
                write_index: 1,
              },
            ]),
      ],
    });
    expect(result.stop).toMatchObject({
      reason: "return",
      address: boundary + 2,
      file_offsets: [size === 8192 ? 17 : null],
    });
    if (size < 8192)
      expect(
        result.instructions[4]?.writes.map((write) => write.value),
      ).toEqual([0x54, 0x55]);
  },
);

it.each([5, 6])(
  "retains partial opcode proof at unwritten NROM mirror %i",
  async (declaration) => {
    const fixture = nromRamCodeFixture(declaration);
    const boundary = 0x6000 + 64 * 2 ** declaration - 1;
    fixture.bytes.fill(2, 16, 32784);
    fixture.bytes.set(
      [0xa9, 0xa9, 0x8d, 0xff, 0x7f, 0x4c, boundary & 255, boundary >> 8],
      16,
    );
    fixture.bytes.writeUInt16LE(0x8000, 16 + 32768 - 4);
    const header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const result = nesCodeTraceSchema.parse(
      await deriveNesCode(
        header.value,
        fixture.bytes.subarray(16, 32784),
        traceNesCodeInputSchema.parse({
          path: "/partial.nes",
          initial: { mapper: 0, prg_ram_write_enabled: true },
        }),
      ),
    );
    expect(result).toMatchObject({
      status: "derived",
      stop: {
        address: boundary,
        bytes_hex: "a9",
        file_offsets: [null],
        ram_origins: [
          { byte_index: 0, ram_address: boundary, instruction_index: 1 },
        ],
      },
    });
  },
);

const seededTrace = async (
  fixture: { bytes: Buffer; prgOffset: number; prgSize: number },
  extra: Record<string, unknown>,
) => {
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  return nesCodeTraceSchema.parse(
    await deriveNesCode(
      header.value,
      fixture.bytes.subarray(
        fixture.prgOffset,
        fixture.prgOffset + fixture.prgSize,
      ),
      traceNesCodeInputSchema.parse({
        path: "/seeded.nes",
        initial: { mapper: 4 },
        ...extra,
      }),
    ),
  );
};
const seededCode = (bank = 0, address = 0x6000) =>
  [0xa9, 0x55, 0x60].map((value, index) => ({
    bank,
    address: address + index,
    value,
  }));

it.each([0x80, 0xc0])(
  "retains initial PRG RAM or replaces its provenance according to MMC3 protection %s",
  async (ram_protect) => {
    const result = await seededTrace(
      mmc3RamCodeFixture([0xa9, 2, 0x8d, 1, 0x60, 0x4c, 0, 0x60]),
      { initial: { mapper: 4, ram_protect }, initial_prg_ram: seededCode() },
    );
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.final_cpu.a).toBe(ram_protect === 0x80 ? 2 : 0x55);
    expect(result.instructions.at(-1)!.ram_origins).toEqual([
      {
        byte_index: 0,
        region: "prg-ram",
        bank: 0,
        ram_address: 0x6000,
        initial_prg_ram_index: 0,
      },
      ram_protect === 0x80
        ? {
            byte_index: 1,
            region: "prg-ram",
            bank: 0,
            ram_address: 0x6001,
            instruction_index: 1,
            write_index: 0,
          }
        : {
            byte_index: 1,
            region: "prg-ram",
            bank: 0,
            ram_address: 0x6001,
            initial_prg_ram_index: 1,
          },
    ]);
  },
);

it.each([null, 0])(
  "does not bypass MMC3 read permission %s with initial storage",
  async (ram_protect) => {
    const fixture = mmc3RamCodeFixture([
      0xa9, 0x80, 0x8d, 1, 0xa0, 0x4c, 0, 0x60,
    ]);
    const input = {
      initial: { mapper: 4, ram_protect },
      initial_prg_ram: seededCode(),
    };
    expect(
      await seededTrace(fixture, { ...input, entry: 0x6000 }),
    ).toMatchObject({
      stop: { reason: "unmapped-instruction", ram_origins: [] },
    });
    expect(await seededTrace(fixture, input)).toMatchObject({
      final_cpu: { a: 0x55 },
      stop: { reason: "return" },
    });
  },
);

it.each([true, false])(
  "joins all initialized SXROM physical banks without assuming a selector (agree=%s)",
  async (agree) => {
    const initial_prg_ram = [0, 1, 2, 3].flatMap((bank) => seededCode(bank));
    if (!agree) initial_prg_ram[10]!.value = 0x66;
    const result = await seededTrace(mmc1BankedRamCodeFixture("SXROM"), {
      entry: 0x6000,
      initial: { mapper: 1, prg_ram_disable_bit: 0 },
      initial_prg_ram,
    });
    if (result.status !== "derived") throw new Error(result.reason);
    if (agree) {
      expect(result.final_cpu.a).toBe(0x55);
      expect(result.instructions[0]!.ram_origins).toHaveLength(8);
      expect(
        result.instructions[0]!.ram_origins.filter(
          (origin) => origin.byte_index === 1,
        ),
      ).toEqual(
        [0, 1, 2, 3].map((bank) => ({
          byte_index: 1,
          region: "prg-ram",
          bank,
          ram_address: 0x6001,
          initial_prg_ram_index: bank * 3 + 1,
        })),
      );
    } else {
      expect(result.instructions).toEqual([]);
      expect(result.stop).toMatchObject({
        reason: "unmapped-instruction",
        bytes_hex: "a9",
      });
      expect(result.stop.ram_origins).toHaveLength(4);
    }
  },
);

it("uses NROM and MMC6 canonical physical storage through CPU mirrors", async () => {
  expect(
    await seededTrace(nromRamCodeFixture(), {
      initial: { mapper: 0 },
      entry: 0x7800,
      initial_prg_ram: seededCode(),
    }),
  ).toMatchObject({ final_cpu: { a: 0x55 }, stop: { reason: "return" } });
  expect(
    await seededTrace(mmc6RamCodeFixture(), {
      initial: { mapper: 4, bank_select: 0x20, ram_protect: 0xa0 },
      entry: 0x7c00,
      initial_prg_ram: seededCode(0, 0x7000),
    }),
  ).toMatchObject({ final_cpu: { a: 0x55 }, stop: { reason: "return" } });
  for (const [fixture, initial, initial_prg_ram] of [
    [nromRamCodeFixture(), { mapper: 0 }, seededCode(0, 0x7800)],
    [mmc6RamCodeFixture(), { mapper: 4 }, seededCode(0, 0x7400)],
    [mmc3RamCodeFixture([]), { mapper: 4 }, seededCode(1)],
    [mmc3RamCodeFixture([], 0), { mapper: 4 }, seededCode()],
  ] as const) {
    expect(
      await seededTrace(fixture, { initial, initial_prg_ram }),
    ).toMatchObject({ status: "unsupported" });
  }
});

it("rejects duplicate physical PRG RAM bytes but preserves distinct banks", () => {
  const input = { path: "/seeded.nes", initial: { mapper: 1 } };
  expect(
    traceNesCodeInputSchema.safeParse({
      ...input,
      initial_prg_ram: [...seededCode(), ...seededCode()],
    }).success,
  ).toBe(false);
  expect(
    traceNesCodeInputSchema.safeParse({
      ...input,
      initial_prg_ram: [...seededCode(), ...seededCode(1)],
    }).success,
  ).toBe(true);
});

it("retains initialized SXROM storage while another physical bank is selected", async () => {
  const fixture = mmc1BankedRamCodeFixture("SXROM");
  fixture.bytes.set(
    [...mmc1WriteProgram(0xa000, 12), 0x4c, 0, 0x60],
    fixture.programOffset,
  );
  const result = await seededTrace(fixture, {
    initial: {
      mapper: 1,
      prg_mode: 3,
      prg_bank: 0,
      prg_ram_disable_bit: 0,
      chr_mode: 0,
      chr_bank_0: 0,
      shift_bits: [],
    },
    initial_prg_ram: seededCode(3),
  });
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.final_cpu.a).toBe(0x55);
  expect(result.stop.reason).toBe("return");
  expect(result.instructions.at(-1)!.ram_origins).toEqual([
    {
      byte_index: 0,
      region: "prg-ram",
      bank: 3,
      ram_address: 0x6000,
      initial_prg_ram_index: 0,
    },
    {
      byte_index: 1,
      region: "prg-ram",
      bank: 3,
      ram_address: 0x6001,
      initial_prg_ram_index: 1,
    },
  ]);
});

it("retains all candidate cartridge RAM input origins on a data read", async () => {
  const fixture = mmc1BankedRamCodeFixture("SXROM");
  fixture.bytes.set([0xad, 0, 0x60, 0x60], fixture.programOffset);
  const result = await seededTrace(fixture, {
    initial: { mapper: 1, prg_mode: 3, prg_bank: 0, prg_ram_disable_bit: 0 },
    initial_prg_ram: [0, 1, 2, 3].flatMap((bank) => seededCode(bank)),
  });
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.instructions[0]!.data_reads).toEqual([
    {
      address: 0x6000,
      value: 0xa9,
      file_offset: null,
      mapper_origins: [],
      ram_origins: [0, 1, 2, 3].map((bank) => ({
        byte_index: 0,
        region: "prg-ram",
        bank,
        ram_address: 0x6000,
        initial_prg_ram_index: bank * 3,
      })),
    },
  ]);
});

it("identifies MMC6 constant-zero data reads without fabricating storage writers", async () => {
  const fixture = mmc6RamCodeFixture();
  fixture.bytes.set([0xad, 0, 0x72, 0x60], fixture.programOffset);
  const result = await seededTrace(fixture, {
    initial: { mapper: 4, bank_select: 0x20, ram_protect: 0x20 },
  });
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.instructions[0]!.data_reads).toEqual([
    {
      address: 0x7200,
      value: 0,
      file_offset: null,
      ram_origins: [],
      mapper_origins: [
        {
          byte_index: 0,
          kind: "mmc6-disabled-half",
          ram_address: 0x7200,
          bank_select: 0x20,
          ram_protect: 0x20,
        },
      ],
    },
  ]);
});
