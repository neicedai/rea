import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { decodeNes6502Opcode } from "./nes6502Opcodes.js";
import {
  nesCodeFixture,
  mmc1SerialProgram,
  mmc3SwitchCodeFixture,
} from "./nesCode.fixture.js";

const initial4 = { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 2, 1] };
const run = async (
  fixture: ReturnType<typeof nesCodeFixture>,
  selected: Record<string, unknown> = {},
) => {
  const { trace: result } = await deriveNesFixtureTrace(
    fixture.bytes,
    fixture.bytes.subarray(
      fixture.prgOffset,
      fixture.prgOffset + fixture.prgSize,
    ),
    {
      path: "/code.nes",
      initial: initial4,
      ...selected,
    },
  );
  return result;
};

it("traces all stable NOP aliases with original lengths and preserves flags before unofficial SBC", async () => {
  const nops = [
    0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa, 0x80, 0x82, 0x89, 0xc2, 0xe2, 0x04,
    0x44, 0x64, 0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4, 0x0c, 0x1c, 0x3c, 0x5c,
    0x7c, 0xdc, 0xfc,
  ];
  const program = [0xa9, 0x80, 0x38, 0xf8];
  const starts: number[] = [];
  for (const opcode of nops) {
    starts.push(program.length);
    const length = decodeNes6502Opcode(opcode)!.length;
    program.push(opcode, ...Array<number>(length - 1).fill(0x02));
  }
  program.push(0xeb, 1, 0x02);
  const fixture = nesCodeFixture(4, program);
  const result = await run(fixture);
  expect(result.stop.reason).toBe("unsupported-opcode");
  const before = result.instructions[2]!.cpu_after;
  for (const [index, offset] of starts.entries()) {
    const instruction = result.instructions[index + 3]!;
    expect(instruction).toMatchObject({
      mnemonic: "NOP",
      encoding: "unofficial",
      address: fixture.entry + offset,
      cpu_after: before,
      writes: [],
    });
    expect(instruction.file_offsets).toEqual(
      Array.from(
        { length: instruction.bytes_hex.length / 2 },
        (_, byte) => fixture.programOffset + offset + byte,
      ),
    );
  }
  expect(result.instructions.at(-1)).toMatchObject({
    mnemonic: "SBC",
    encoding: "unofficial",
    cpu_after: { a: 0x7f, c: true, v: true, n: false, z: false, d: true },
  });
});

it("uses LAX/SAX for RAM and mapper writes while retaining flags and unknown values", async () => {
  const fixture = nesCodeFixture(
    4,
    [
      0xa9, 0x86, 0x85, 0x10, 0xa7, 0x10, 0x8f, 0, 0x80, 0xa9, 2, 0x85, 0x11,
      0xa7, 0x11, 0x8f, 1, 0x80, 0xad, 2, 0x20, 0xa2, 0, 0x87, 0x12, 0xa7, 0x12,
      0xa7, 0x13, 0xab,
    ],
  );
  const result = await run(fixture);
  expect(result.stop.reason).toBe("unsupported-opcode");
  expect(result.instructions[2]).toMatchObject({
    mnemonic: "LAX",
    encoding: "unofficial",
    cpu_after: { a: 0x86, x: 0x86, n: true, z: false },
  });
  expect(result.instructions[3]).toMatchObject({
    mnemonic: "SAX",
    writes: [{ address: 0x8000, value: 0x86 }],
    cpu_after: result.instructions[2]!.cpu_after,
  });
  expect(result.mapper_trace).toMatchObject({
    final: { bank_select: 0x86, banks: [0, 2, 4, 5, 6, 7, 2, 1] },
  });
  expect(result.instructions.at(-2)).toMatchObject({
    mnemonic: "LAX",
    cpu_after: { a: 0, x: 0, z: true, n: false },
  });
  expect(result.instructions.at(-1)).toMatchObject({
    mnemonic: "LAX",
    cpu_after: { a: null, x: null, z: null, n: null },
  });
  const unknownAddress = await run(nesCodeFixture(4, [0x83, 0x10]));
  expect(unknownAddress.stop.reason).toBe("unknown-write-address");
});

it.each([
  [0xa3, "izx"],
  [0xa7, "zp"],
  [0xaf, "abs"],
  [0xb3, "izy"],
  [0xb7, "zpy"],
  [0xbf, "aby"],
  [0x83, "izx"],
  [0x87, "zp"],
  [0x8f, "abs"],
  [0x97, "zpy"],
] as const)("decodes stable transfer opcode %s using %s", (opcode, mode) => {
  expect(decodeNes6502Opcode(opcode)).toMatchObject({
    mode,
    encoding: "unofficial",
  });
});

it.each([
  [0x0b, 0xff, 0x80, 0x55, { a: 0x80, x: 0x55, c: true, n: true, z: false }],
  [0x2b, 0x7f, null, 0x55, { a: null, x: 0x55, c: false, n: false, z: null }],
  [0x4b, 0xff, 3, 0x55, { a: 1, x: 0x55, c: true, n: false, z: false }],
  [0x4b, 1, null, 0x55, { a: 0, x: 0x55, c: null, n: false, z: true }],
  [0xcb, 1, 0xf0, 0x0f, { a: 0xf0, x: 255, c: false, n: true, z: false }],
  [0xcb, 0, null, 0, { a: null, x: 0, c: true, n: false, z: true }],
  [0xcb, 128, null, 127, { a: null, x: null, c: false, n: true, z: false }],
] as const)(
  "traces immediate opcode %s with masked unknown inputs",
  async (opcode, operand, a, x, expected) => {
    const result = await run(nesCodeFixture(4, [opcode, operand, 0x60]), {
      cpu: { a, x, c: false, v: true, d: true },
    });
    expect(result.stop.reason).toBe("return");
    expect(result.instructions[0]).toMatchObject({
      encoding: "unofficial",
      addressing_mode: "imm",
      writes: [],
      cpu_after: { ...expected, v: true, d: true },
    });
  },
);

it.each([
  [0xc7, 0, 255, true, { a: 255, c: true, z: true, n: false, v: true }],
  [0xc7, 128, 0, false, { a: 0, c: false, z: false, n: true, v: true }],
  [0xe7, 255, 0, true, { a: 0, c: true, z: true, n: false, v: false }],
  [0xe7, 0, 128, true, { a: 127, c: true, z: false, n: false, v: true }],
  [0xe7, 0, 0, false, { a: 254, c: false, z: false, n: true, v: false }],
] as const)(
  "applies composite RMW opcode %s to latched RAM data",
  async (opcode, memory, accumulator, carry, expected) => {
    const result = await run(
      nesCodeFixture(4, [
        0xa9,
        memory,
        0x85,
        0x10,
        0xa9,
        accumulator,
        opcode,
        0x10,
        0x60,
      ]),
      { cpu: { c: carry, v: true, d: true } },
    );
    expect(result.stop.reason).toBe("return");
    expect(result.instructions.at(-1)).toMatchObject({
      encoding: "unofficial",
      cpu_after: { ...expected, d: true },
    });
  },
);

it.each([
  [0x07, 0x81, 1, false, 2, { a: 3, c: true, n: false, z: false, v: true }],
  [0x27, 0x80, 255, true, 1, { a: 1, c: true, n: false, z: false, v: true }],
  [0x47, 3, 1, true, 1, { a: 0, c: true, n: false, z: true, v: true }],
  [0x67, 1, 127, false, 0, { a: 128, c: false, n: true, z: false, v: true }],
  [0x67, 2, 255, true, 129, { a: 128, c: true, n: true, z: false, v: false }],
] as const)(
  "applies shift-composite opcode %s with the correct carry handoff",
  async (opcode, memory, accumulator, carry, modified, expected) => {
    const result = await run(
      nesCodeFixture(4, [
        0xa9,
        memory,
        0x85,
        0x10,
        0xa9,
        accumulator,
        opcode,
        0x10,
        0xa6,
        0x10,
        0x60,
      ]),
      { cpu: { c: carry, v: true, d: true } },
    );
    expect(result.stop.reason).toBe("return");
    expect(result.instructions[3]).toMatchObject({
      encoding: "unofficial",
      cpu_after: { ...expected, d: true },
    });
    expect(result.instructions.at(-1)).toMatchObject({
      cpu_after: { x: modified },
    });
  },
);

it.each([
  [0xff, 0x80, false, { a: 0x40, c: true, v: true, n: false, z: false }],
  [0xff, 0xc0, true, { a: 0xe0, c: true, v: false, n: true, z: false }],
  [0xff, 0x40, false, { a: 0x20, c: false, v: true, n: false, z: false }],
  [0, null, null, { a: null, c: false, v: false, n: null, z: null }],
  [0, null, false, { a: 0, c: false, v: false, n: false, z: true }],
] as const)(
  "derives binary ARR flags with operand %s",
  async (operand, a, c, expected) => {
    const result = await run(nesCodeFixture(4, [0x6b, operand, 0x60]), {
      cpu: { a, c, d: true },
    });
    expect(result.stop.reason).toBe("return");
    expect(result.instructions[0]).toMatchObject({
      mnemonic: "ARR",
      encoding: "unofficial",
      cpu_after: { ...expected, d: true },
    });
  },
);
it.each([
  [0xff, 0x80, 0x80],
  [null, 0, 0],
  [0, null, 0],
  [null, 0x7f, null],
] as const)(
  "loads LAS into A/X/SP with initial SP %s",
  async (sp, memory, expected) => {
    const program =
      memory === null
        ? [0xbb, 0xff, 0, 0x60]
        : [0xa9, memory, 0x8d, 0, 1, 0xbb, 0xff, 0, 0x60];
    const result = await run(nesCodeFixture(4, program), {
      cpu: { sp, y: 1, c: true, v: true },
    });
    expect(result.stop.reason).toBe("return");
    expect(result.instructions.at(-1)).toMatchObject({
      mnemonic: "LAS",
      cpu_after: { a: expected, x: expected, sp: expected, c: true, v: true },
    });
    if (memory === 0x7f)
      expect(result.instructions.at(-1)!.cpu_after.n).toBe(false);
  },
);

describe("composite memory addressing", () => {
  const modes = [
    { name: "zp", offset: 7, operands: [0x10], target: 0x10, setup: [] },
    { name: "zpx", offset: 0x17, operands: [0xff], target: 0, setup: [] },
    { name: "abs", offset: 0x0f, operands: [0, 1], target: 0x100, setup: [] },
    {
      name: "abx",
      offset: 0x1f,
      operands: [0xff, 0],
      target: 0x100,
      setup: [],
    },
    {
      name: "aby",
      offset: 0x1b,
      operands: [0xff, 0],
      target: 0x100,
      setup: [],
    },
    {
      name: "izx",
      offset: 3,
      operands: [0xfe],
      target: 0x100,
      setup: [0xa9, 0, 0x85, 0xff, 0xa9, 1, 0x85, 0],
    },
    {
      name: "izy",
      offset: 0x13,
      operands: [0xff],
      target: 0x100,
      setup: [0xa9, 0xff, 0x85, 0xff, 0xa9, 0, 0x85, 0],
    },
  ];
  for (const [name, base, modified, a, carry] of [
    ["SLO", 0, 2, 3, true],
    ["RLA", 0x20, 3, 3, true],
    ["SRE", 0x40, 0x40, 0x43, true],
    ["RRA", 0x60, 0xc0, 0xc4, false],
    ["DCP", 0xc0, 0x80, 3, false],
    ["ISC", 0xe0, 0x82, 0x81, false],
  ] as const) {
    it.each(modes)(
      `${name} resolves $name and writes only its effective address`,
      async ({ name: mode, offset, operands, target, setup }) => {
        const prefix = [
          0xa9,
          0x81,
          0x8d,
          target & 255,
          target >> 8,
          ...setup,
          0xa9,
          3,
        ];
        const fixture = nesCodeFixture(4, [
          ...prefix,
          base + offset,
          ...operands,
          0xae,
          target & 255,
          target >> 8,
          0x60,
        ]);
        const result = await run(fixture, { cpu: { x: 1, y: 1, c: true } });
        expect(result.stop.reason).toBe("return");
        const instruction = result.instructions.find(
          (entry) => entry.mnemonic === name,
        )!;
        expect(instruction).toMatchObject({
          addressing_mode: mode,
          cpu_after: { a, c: carry },
          writes: [
            { address: target, value: 0x81, preceded_by_cpu_write: false },
            { address: target, value: modified, preceded_by_cpu_write: true },
          ],
        });
        expect(instruction.file_offsets).toEqual(
          Array.from(
            { length: operands.length + 1 },
            (_, index) => fixture.programOffset + prefix.length + index,
          ),
        );
        expect(result.instructions.at(-1)!.cpu_after.x).toBe(modified);
      },
    );
  }
  it.each([0x03, 0x23, 0x43, 0x63, 0xc3, 0xe3])(
    "stops composite %s before writes when its pointer is unknown",
    async (opcode) => {
      const result = await run(nesCodeFixture(4, [opcode, 0x10]));
      expect(result.stop.reason).toBe("unknown-write-address");
      expect(result.instructions).toEqual([]);
      expect(result.mapper_trace).toMatchObject({ steps: [] });
    },
  );
});

it.each([true, false])(
  "restores a wrapped RTI frame with known status=%s",
  async (knownStatus) => {
    const prefix = knownStatus ? [0xa9, 0xcf, 0x8d, 0xff, 1] : [];
    const fixture = nesCodeFixture(4, [
      ...prefix,
      0xa9,
      0,
      0x8d,
      0,
      1,
      0xa9,
      0xe1,
      0x8d,
      1,
      1,
      0x40,
    ]);
    fixture.bytes.set([0xa9, 0x55, 0x60], fixture.programOffset + 0x100);
    const result = await run(fixture, { cpu: { sp: 0xfe } });
    expect(result.stop.reason).toBe("return");
    expect(
      result.instructions.find(({ mnemonic }) => mnemonic === "RTI"),
    ).toMatchObject({
      next_address: 0xe100,
      writes: [],
      cpu_after: {
        sp: 1,
        c: knownStatus ? true : null,
        z: knownStatus ? true : null,
        i: knownStatus ? true : null,
        d: knownStatus ? true : null,
        v: knownStatus ? true : null,
        n: knownStatus ? true : null,
      },
    });
    expect(result.instructions.at(-1)!.cpu_after.a).toBe(0x55);
  },
);
it("stops RTI before consuming an unresolved frame", async () => {
  const result = await run(nesCodeFixture(4, [0x40]), {
    cpu: { sp: 0xfd, c: true },
  });
  expect(result.stop.reason).toBe("unknown-control-target");
  expect(result.instructions).toEqual([]);
});

it.each([false, true])(
  "tracks mirrored RAM instruction bytes after unknown overwrite=%s",
  async (unknown) => {
    const overwrite = unknown ? [0xad, 2, 0x20] : [0xa9, 0x11];
    const result = await run(
      nesCodeFixture(4, [
        0xa9,
        0xa9,
        0x8d,
        0,
        3,
        0xa9,
        0x55,
        0x8d,
        1,
        3,
        0xa9,
        0x60,
        0x8d,
        2,
        3,
        ...overwrite,
        0x8d,
        1,
        0x0b,
        0x4c,
        0,
        0x0b,
      ]),
    );
    if (unknown) {
      expect(result.stop).toMatchObject({
        reason: "unmapped-instruction",
        address: 0x0b00,
        bytes_hex: "a9",
        file_offsets: [null],
        ram_origins: [
          {
            byte_index: 0,
            ram_address: 0x300,
            instruction_index: 1,
            write_index: 0,
          },
        ],
      });
    } else {
      expect(result.instructions.at(-1)).toMatchObject({
        address: 0x0b00,
        bytes_hex: "a911",
        file_offsets: [null, null],
        ram_origins: [
          {
            byte_index: 0,
            ram_address: 0x300,
            instruction_index: 1,
            write_index: 0,
          },
          {
            byte_index: 1,
            ram_address: 0x301,
            instruction_index: 7,
            write_index: 0,
          },
        ],
        cpu_after: { a: 0x11 },
      });
      expect(result.stop).toMatchObject({
        reason: "return",
        file_offsets: [null],
        ram_origins: [{ byte_index: 0, instruction_index: 5 }],
      });
    }
  },
);

it.each([0, 0xfd])(
  "follows a synthetic RTS dispatch frame with stack pointer %s",
  async (sp) => {
    const fixture = nesCodeFixture(
      4,
      [0xa9, 0xe0, 0x48, 0xa9, 0xff, 0x48, 0x60],
    );
    fixture.bytes.set([0xa9, 0x55, 0x60], fixture.programOffset + 0x100);
    const result = await run(fixture, { cpu: { sp } });
    expect(result.stop.reason).toBe("return");
    expect(
      result.instructions.find(({ mnemonic }) => mnemonic === "RTS"),
    ).toMatchObject({ next_address: 0xe100, cpu_after: { sp }, writes: [] });
    expect(result.instructions.at(-1)!.cpu_after.a).toBe(0x55);
  },
);
it("wraps RTS targets to RAM code without requiring an earlier JSR", async () => {
  const fixture = nesCodeFixture(
    4,
    [0xa9, 0x60, 0x85, 0, 0xa9, 255, 0x48, 0x48, 0x60],
  );
  const result = await run(fixture, { cpu: { sp: 0xfd } });
  expect(result.instructions.at(-1)).toMatchObject({
    mnemonic: "RTS",
    next_address: 0,
  });
  expect(result.stop).toMatchObject({
    reason: "return",
    address: 0,
    bytes_hex: "60",
    file_offsets: [null],
  });
});

describe("source instruction and mapper integration", () => {
  it("follows MMC3 code through a mode-independent aliased window", async () => {
    const fixture = nesCodeFixture(4, [0x4c, 0, 0x80]);
    fixture.bytes.set([0xa9, 0x55, 0x60], fixture.prgOffset + 6 * 8192);
    const result = await run(fixture, {
      initial: {
        mapper: 4,
        banks: [null, null, null, null, null, null, 62, null],
      },
    });
    expect(result.stop.reason).toBe("return");
    expect(result.instructions[1]).toMatchObject({
      address: 0x8000,
      bytes_hex: "a955",
      file_offsets: [
        fixture.prgOffset + 6 * 8192,
        fixture.prgOffset + 6 * 8192 + 1,
      ],
    });
    expect(result.mapper_trace).toMatchObject({
      final: { bank_select: null },
      nes_prg_views: [],
    });
  });

  it("extracts MMC1 LSR/STA serial bits from immutable code", async () => {
    const fixture = nesCodeFixture(1, mmc1SerialProgram);
    const result = await run(fixture, { initial: { mapper: 1, prg_mode: 3 } });
    expect(result.stop.reason).toBe("return");
    expect(result.mapper_trace).toMatchObject({
      status: "derived",
      final: { prg_bank: 2, prg_ram_disable_bit: 1, shift_bits: [] },
      nes_prg_views: [{ mapper: 1, prg_mode: 3, prg_bank: 2 }],
    });
    expect(
      result.instructions
        .flatMap((instruction) => instruction.writes)
        .map((write) => write.value),
    ).toEqual([128, 18, 9, 4, 2, 1]);
    expect(result.entry_vector?.map((byte) => byte.file_offset)).toEqual([
      fixture.prgOffset + 65536 - 4,
      fixture.prgOffset + 65536 - 3,
    ]);
  });

  it("fetches the next instruction from the bank selected by the preceding STA", async () => {
    const fixture = mmc3SwitchCodeFixture();
    const result = await run(fixture, { initial: { mapper: 4 } });
    expect(result.stop).toMatchObject({ reason: "return", address: 0x800a });
    const switched = result.instructions.find(
      (instruction) => instruction.address === 0x8005,
    );
    expect(switched).toMatchObject({
      bytes_hex: "a907",
      file_offsets: [
        fixture.prgOffset + 3 * 8192 + 5,
        fixture.prgOffset + 3 * 8192 + 6,
      ],
    });
    expect(result.mapper_trace).toMatchObject({
      status: "derived",
      final: { banks: [null, null, null, null, null, null, 3, 1] },
    });
  });

  it("keeps noncontiguous source offsets for instructions crossing PRG windows", async () => {
    const fixture = nesCodeFixture(4, [0x4c, 0xff, 0x9f]);
    fixture.bytes[fixture.prgOffset + 3 * 8192 - 1] = 0xa9;
    fixture.bytes.set([7, 0x8d, 0, 0x80, 0x60], fixture.prgOffset + 5 * 8192);
    const result = await run(fixture, {
      initial: { ...initial4, banks: [0, 2, 4, 5, 6, 7, 2, 5] },
    });
    expect(result.instructions[1]).toMatchObject({
      address: 0x9fff,
      bytes_hex: "a907",
      file_offsets: [
        fixture.prgOffset + 3 * 8192 - 1,
        fixture.prgOffset + 5 * 8192,
      ],
    });
    expect(result.stop.reason).toBe("return");
  });

  it.each([
    [1, 0xee],
    [4, 0xee],
    [1, 0xef],
    [4, 0xef],
    [1, 0xcf],
    [4, 0xcf],
  ] as const)(
    "preserves both RMW bus writes and operand latching for Mapper %s opcode %s",
    async (mapper, opcode) => {
      const fixture = nesCodeFixture(
        mapper,
        mapper === 1 ? [opcode, 0xf0, 0xff, 0x60] : [opcode, 1, 0x80, 0x60],
      );
      fixture.bytes[fixture.prgOffset + 65536 - 16] = 255;
      fixture.bytes[fixture.prgOffset + 2 * 8192 + 1] = 3;
      fixture.bytes[fixture.prgOffset + 3 * 8192 + 1] = 0xee;
      const result = await run(fixture, {
        initial: mapper === 1 ? { mapper: 1, prg_mode: 3 } : initial4,
      });
      expect(
        result.instructions[0]?.writes.map((write) => [
          write.value,
          write.preceded_by_cpu_write,
        ]),
      ).toEqual(
        mapper === 1
          ? [
              [255, false],
              [opcode === 0xcf ? 254 : 0, true],
            ]
          : [
              [3, false],
              [opcode === 0xcf ? 2 : 4, true],
            ],
      );
      expect(result.mapper_trace).toMatchObject(
        mapper === 1
          ? {
              status: "derived",
              steps: [
                { effect: "serial-reset" },
                {
                  effect:
                    opcode === 0xcf
                      ? "serial-reset"
                      : "ignored-consecutive-write",
                },
              ],
            }
          : {
              status: "derived",
              final: { banks: [0, 2, 4, 5, 6, 7, opcode === 0xcf ? 2 : 4, 1] },
            },
      );
    },
  );
});

describe("conditional 6502 data and control", () => {
  it("uses real stack RAM for nested JSR/PHA/PLA/RTS and stops at the outer return", async () => {
    const fixture = nesCodeFixture(
      4,
      [0xa2, 255, 0x9a, 0xa9, 2, 0x20, 0x30, 0xe0, 0x8d, 1, 0x80, 0x60],
    );
    fixture.bytes.set(
      [0x48, 0xa9, 99, 0x68, 0x60],
      fixture.programOffset + 0x30,
    );
    const result = await run(fixture);
    expect(result.final_cpu).toMatchObject({ a: 2, sp: 255 });
    expect(result.stop).toMatchObject({ reason: "return", address: 0xe00b });
    expect(
      result.instructions
        .find((instruction) => instruction.mnemonic === "JSR")
        ?.writes.map((write) => [write.address, write.value]),
    ).toEqual([
      [511, 224],
      [510, 7],
    ]);
    expect(result.instructions.at(-1)?.writes).toMatchObject([
      { address: 0x8001, value: 2 },
    ]);
  });

  it("wraps zero-page pointers and respects the NMOS indirect JMP page boundary", async () => {
    const indirect = await run(
      nesCodeFixture(
        4,
        [
          0xa9, 0, 0x85, 255, 0xa9, 128, 0x85, 0, 0xa0, 1, 0xa9, 3, 0x91, 255,
          0x60,
        ],
      ),
    );
    expect(indirect.instructions.at(-1)?.writes).toMatchObject([
      { address: 0x8001, value: 3 },
    ]);
    const fixture = nesCodeFixture(4, [0x6c, 255, 0x80]);
    fixture.bytes[fixture.prgOffset + 2 * 8192 + 255] = 240;
    fixture.bytes[fixture.prgOffset + 2 * 8192] = 224;
    fixture.bytes[fixture.prgOffset + 2 * 8192 + 256] = 144;
    fixture.bytes.set(
      [0xa9, 4, 0x8d, 1, 0x80, 0x60],
      fixture.programOffset + 240,
    );
    const result = await run(fixture);
    expect(result.instructions[0]?.next_address).toBe(0xe0f0);
    expect(result.instructions.at(-1)?.writes).toMatchObject([
      { address: 0x8001, value: 4 },
    ]);
  });

  it("follows arithmetic branches whose flags are certain despite unknown operands", async () => {
    // Unknown PPUSTATUS + zero cannot carry or overflow after CLC.
    // The accumulator remains unknown; the following BCS/BVS are nevertheless false.
    const fixture = nesCodeFixture(
      4,
      [0xad, 2, 0x20, 0x18, 0x69, 0, 0xb0, 2, 0x70, 2, 0x60, 0x02, 0x02],
    );
    const result = await run(fixture);
    expect(result.stop.reason).toBe("return");
    expect(result.instructions.map((i) => i.address)).toEqual([
      0xe000, 0xe003, 0xe004, 0xe006, 0xe008,
    ]);
  });

  it("preserves sign and nonzero across an unknown carry without choosing a result byte", async () => {
    const fixture = nesCodeFixture(
      4,
      [0xa9, 2, 0x69, 3, 0x30, 2, 0xf0, 2, 0x60, 0x02, 0x02],
    );
    const result = await run(fixture);
    expect(result.stop.reason).toBe("return");
    expect(result.instructions.map((i) => i.address)).toEqual([
      0xe000, 0xe002, 0xe004, 0xe006,
    ]);
  });

  it("derives SBC carry without inventing the unknown accumulator and stops on ambiguous ADC carry", async () => {
    const subtraction = await run(
      nesCodeFixture(4, [0x38, 0xe9, 0, 0x90, 2, 0x60, 0x02, 0x02]),
    );
    expect(subtraction.stop.reason).toBe("return");
    expect(subtraction.final_cpu).toMatchObject({
      a: null,
      c: true,
      v: false,
      n: null,
      z: null,
    });
    const addition = await run(
      nesCodeFixture(4, [0xa9, 255, 0x69, 0, 0xb0, 2, 0x60]),
    );
    expect(addition.stop.reason).toBe("unknown-branch");
    expect(addition.final_cpu).toMatchObject({
      a: null,
      c: null,
      v: false,
      n: null,
      z: null,
    });
  });

  it("uses Ricoh binary arithmetic even when the decimal flag is set", async () => {
    const result = await run(
      nesCodeFixture(4, [0xf8, 0xa9, 9, 0x18, 0x69, 1, 0x8d, 1, 0x80, 0x60]),
    );
    expect(result.final_cpu).toMatchObject({
      a: 10,
      d: true,
      c: false,
      n: false,
      z: false,
    });
    expect(result.instructions.at(-1)?.writes).toMatchObject([{ value: 10 }]);
  });

  it("follows counted loops and known comparisons without guessing unknown branches", async () => {
    const loop = await run(
      nesCodeFixture(4, [0xa2, 3, 0xca, 0xd0, 0xfd, 0x8e, 1, 0x80, 0x60]),
    );
    expect(
      loop.instructions.filter((instruction) => instruction.mnemonic === "DEX"),
    ).toHaveLength(3);
    expect(loop.instructions.at(-1)?.writes).toMatchObject([{ value: 0 }]);
    const unknown = await run(
      nesCodeFixture(4, [0xad, 2, 0x20, 0xf0, 5, 0xa9, 3, 0x8d, 1, 0x80, 0x60]),
    );
    expect(unknown.instructions).toHaveLength(1);
    expect(unknown.stop).toMatchObject({
      reason: "unknown-branch",
      address: 0xe003,
      successors: [0xe005, 0xe00a],
    });
  });
});

it.each([0, 253])(
  "pushes the pre-interrupt flags and returns through RTI with SP=%s",
  async (sp) => {
    const fixture = nesCodeFixture(4, [0x00, 0x02, 0x02]);
    fixture.bytes[fixture.programOffset + 256] = 0x40;
    fixture.bytes.writeUInt16LE(
      0xe100,
      fixture.prgOffset + fixture.prgSize - 2,
    );
    const cpu = {
      sp,
      c: true,
      z: false,
      i: false,
      d: true,
      v: true,
      n: true,
    };
    const result = await run(fixture, { cpu });
    expect(
      result.instructions.map((instruction) => instruction.mnemonic),
    ).toEqual(["BRK", "RTI"]);
    expect(result.instructions[0]).toMatchObject({
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
      cpu_after: { ...cpu, sp: (sp - 3) & 255, i: true },
      writes: [
        { address: 256 + sp, value: 0xe0, preceded_by_cpu_write: false },
        {
          address: 256 + ((sp - 1) & 255),
          value: 2,
          preceded_by_cpu_write: true,
        },
        {
          address: 256 + ((sp - 2) & 255),
          value: 0xf9,
          preceded_by_cpu_write: true,
        },
      ],
    });
    expect(result.final_cpu).toMatchObject(cpu);
    expect(result.stop).toMatchObject({
      reason: "unsupported-opcode",
      address: 0xe002,
    });
  },
);

it("retains unknown stacked flags while resolving the RTI return address", async () => {
  const fixture = nesCodeFixture(4, [0, 0x02, 0x02]);
  fixture.bytes[fixture.programOffset + 256] = 0x40;
  fixture.bytes.writeUInt16LE(0xe100, fixture.prgOffset + fixture.prgSize - 2);
  const result = await run(fixture, { cpu: { sp: 253 } });
  expect(result.instructions[0]?.writes[2]?.value).toBeNull();
  expect(result.instructions[0]?.cpu_after.i).toBe(true);
  expect(result.final_cpu.i).toBeNull();
  expect(result.stop.address).toBe(0xe002);
});

it("leaves an unresolved BRK unapplied and preserves its unknown vector sources", async () => {
  const fixture = nesCodeFixture(1, []);
  fixture.bytes[fixture.prgOffset] = 0;
  const result = await run(fixture, {
    entry: 0x8000,
    initial: { mapper: 1, prg_mode: 2 },
    cpu: { sp: 253, i: false },
  });
  expect(result.instructions).toEqual([]);
  expect(result.final_cpu).toMatchObject({ sp: 253, i: false });
  expect(result.stop).toMatchObject({
    reason: "unresolved-vector",
    interrupt_vector: [
      { address: 65534, value: null, file_offset: null },
      { address: 65535, value: null, file_offset: null },
    ],
  });
});

it("preserves the third BRK write as the source of a later RAM opcode", async () => {
  const fixture = nesCodeFixture(4, [0, 0x02, 0x4c, 0xfb, 1]);
  fixture.bytes[fixture.programOffset + 256] = 0x40;
  fixture.bytes.writeUInt16LE(0xe100, fixture.prgOffset + fixture.prgSize - 2);
  const result = await run(fixture, {
    cpu: {
      sp: 253,
      c: false,
      z: false,
      i: false,
      d: true,
      v: false,
      n: false,
    },
  });
  expect(result.instructions.at(-1)).toMatchObject({
    mnemonic: "SEC",
    address: 507,
    file_offsets: [null],
    ram_origins: [
      {
        byte_index: 0,
        ram_address: 507,
        instruction_index: 0,
        write_index: 2,
      },
    ],
  });
  expect(result.stop).toMatchObject({
    reason: "unsupported-opcode",
    address: 508,
  });
});

it("wraps BRK PC+2 at FFFF and returns through a RAM interrupt handler", async () => {
  const fixture = nesCodeFixture(
    4,
    [0xa9, 0x40, 0x85, 0xe1, 0xa9, 2, 0x85, 1, 0x4c, 0xff, 0xff],
  );
  fixture.bytes.writeUInt16LE(0x00e1, fixture.prgOffset + fixture.prgSize - 2);
  const result = await run(fixture, { cpu: { sp: 253 } });
  expect(
    result.instructions.find((instruction) => instruction.mnemonic === "BRK"),
  ).toMatchObject({
    address: 65535,
    next_address: 225,
    writes: [{ value: 0 }, { value: 1 }, { value: null }],
  });
  expect(result.instructions.at(-1)).toMatchObject({
    mnemonic: "RTI",
    address: 225,
    next_address: 1,
    file_offsets: [null],
  });
  expect(result.stop).toMatchObject({
    reason: "unsupported-opcode",
    address: 1,
  });
  expect(result.final_cpu.sp).toBe(253);
});

describe("code trace boundaries", () => {
  it.each([
    [[0x91, 16], "unknown-write-address"],
    [[0x20, 0, 0xe1], "unknown-stack"],
    [[0x02], "unsupported-opcode"],
    [[0x00], "unknown-stack"],
    [[0x40], "unknown-stack"],
  ] as const)(
    "stops before applying unresolved or unsupported instructions: %s",
    async (program, reason) => {
      const result = await run(nesCodeFixture(4, program));
      expect(result.stop.reason).toBe(reason);
      expect(result.instructions).toHaveLength(0);
    },
  );

  it("reports unresolved reset vectors and exhausted instruction budgets as partial paths", async () => {
    const unknown = await run(nesCodeFixture(1, [0x60]), {
      initial: { mapper: 1 },
    });
    expect(unknown.stop.reason).toBe("unresolved-vector");
    expect(unknown.resolved_entry).toBeNull();
    const capped = await run(nesCodeFixture(4, [0x4c, 0, 0xe0]), {
      max_instructions: 3,
    });
    expect(capped.instructions).toHaveLength(3);
    expect(capped.stop).toMatchObject({
      reason: "instruction-budget",
      address: 0xe000,
      bytes_hex: "",
    });
  });

  it("retains exactly the 151 official encodings and yields to cancellation during a long path", async () => {
    expect(
      Array.from({ length: 256 }, (_, opcode) =>
        decodeNes6502Opcode(opcode),
      ).filter((decoded) => decoded?.encoding === "official"),
    ).toHaveLength(151);
    expect(
      Array.from({ length: 256 }, (_, opcode) => opcode).filter(
        (opcode) => decodeNes6502Opcode(opcode) === undefined,
      ),
    ).toEqual([
      0x02, 0x12, 0x22, 0x32, 0x42, 0x52, 0x62, 0x72, 0x8b, 0x92, 0x93, 0x9b,
      0x9c, 0x9e, 0x9f, 0xab, 0xb2, 0xd2, 0xf2,
    ]);
    const fixture = nesCodeFixture(4, [0x4c, 0, 0xe0]);
    const header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const controller = new AbortController();
    const pending = deriveNesCode(
      header.value,
      fixture.bytes.subarray(
        fixture.prgOffset,
        fixture.prgOffset + fixture.prgSize,
      ),
      traceNesCodeInputSchema.parse({
        path: "/loop.nes",
        initial: initial4,
        max_instructions: 100000,
      }),
      { signal: controller.signal },
    );
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toThrow();
  });
});

describe("explicit conditional branch paths", () => {
  it.each([false, true])(
    "keeps bank selection conditional on the chosen path: %s",
    async (taken) => {
      const fixture = nesCodeFixture(
        4,
        [
          0xad, 2, 0x20, 0xf0, 6, 0xa9, 2, 0x8d, 1, 0x80, 0x60, 0xa9, 3, 0x8d,
          1, 0x80, 0x60,
        ],
      );
      const result = await run(fixture, {
        branch_choices: [{ address: 0xe003, taken }],
      });
      expect(result.stop.reason).toBe("return");
      expect(result.branch_choices_used).toBe(1);
      expect(result.instructions[1]).toMatchObject({
        address: 0xe003,
        branch_assumption: { choice_index: 0, taken },
        cpu_after: { z: taken },
        next_address: taken ? 0xe00b : 0xe005,
      });
      expect(result.mapper_trace).toMatchObject({
        status: "derived",
        final: { banks: [0, 2, 4, 5, 6, 7, taken ? 3 : 2, 1] },
      });
      for (const instruction of result.instructions)
        expect(
          Buffer.from(
            instruction.file_offsets.map((offset) => {
              if (offset === null)
                throw new Error("Expected ROM-backed fixture instruction");
              return fixture.bytes[offset]!;
            }),
          ).toString("hex"),
        ).toBe(instruction.bytes_hex);
    },
  );

  it("consumes ordered choices for repeated unknown branches, but not known branches", async () => {
    const result = await run(
      nesCodeFixture(4, [0xad, 2, 0x20, 0xf0, 0xfb, 0x60]),
      {
        branch_choices: [
          { address: 0xe003, taken: true },
          { address: 0xe003, taken: false },
        ],
      },
    );
    expect(result.stop.reason).toBe("return");
    expect(result.branch_choices_used).toBe(2);
    expect(
      result.instructions
        .filter((i) => i.branch_assumption !== null)
        .map((i) => i.branch_assumption),
    ).toEqual([
      { choice_index: 0, taken: true },
      { choice_index: 1, taken: false },
    ]);
    const known = await run(
      nesCodeFixture(4, [0xf0, 2, 0xea, 0xea, 0xf0, 2, 0xea, 0xea, 0x60]),
      {
        branch_choices: [
          { address: 0xe000, taken: true },
          { address: 0x8000, taken: false },
        ],
      },
    );
    expect(known.stop.reason).toBe("return");
    expect(known.branch_choices_used).toBe(1);
    expect(known.instructions[1]).toMatchObject({
      address: 0xe004,
      branch_assumption: null,
      next_address: 0xe008,
    });
  });

  it("stops before mismatched choices, exhausted choices or instruction budgets", async () => {
    const fixture = nesCodeFixture(4, [0xad, 2, 0x20, 0xf0, 0xfb, 0x60]);
    const mismatch = await run(fixture, {
      branch_choices: [{ address: 0xe004, taken: true }],
    });
    expect(mismatch).toMatchObject({
      branch_choices_used: 0,
      stop: {
        reason: "branch-choice-mismatch",
        address: 0xe003,
        successors: [0xe005, 0xe000],
      },
      final_cpu: { z: null },
    });
    expect(mismatch.instructions).toHaveLength(1);
    const choices = { branch_choices: [{ address: 0xe003, taken: true }] };
    const exhausted = await run(fixture, choices);
    expect(exhausted).toMatchObject({
      branch_choices_used: 1,
      stop: { reason: "unknown-branch", address: 0xe003 },
    });
    const budget = await run(fixture, { ...choices, max_instructions: 1 });
    expect(budget).toMatchObject({
      branch_choices_used: 0,
      stop: { reason: "instruction-budget" },
      final_cpu: { z: null },
    });
  });
});

describe("partial comparison, logic and rotation flags", () => {
  it.each([
    {
      name: "CMP zero",
      program: [0xc9, 0, 0x90, 0],
      flags: { c: true, z: null, n: null },
    },
    {
      name: "CPX zero",
      program: [0xe0, 0, 0x90, 0],
      flags: { c: true, z: null, n: null },
    },
    {
      name: "CPY zero",
      program: [0xc0, 0, 0x90, 0],
      flags: { c: true, z: null, n: null },
    },
    {
      name: "AND sign mask",
      program: [0x29, 0x7f, 0x30, 0],
      flags: { n: false, z: null, a: null },
    },
    {
      name: "ORA sign bit",
      program: [0x09, 0x80, 0x10, 0, 0xf0, 0],
      flags: { n: true, z: false, a: null },
    },
    {
      name: "ROL unknown carry",
      program: [0xa9, 0x41, 0x2a, 0x10, 0, 0xf0, 0],
      flags: { n: true, z: false, c: false, a: null },
    },
    {
      name: "ROR unknown carry",
      program: [0xa9, 2, 0x6a, 0xf0, 0],
      flags: { n: null, z: false, c: false, a: null },
    },
  ])("retains provable flags for $name", async ({ program, flags }) => {
    const result = await run(nesCodeFixture(4, [...program, 0x60]));
    expect(result.stop.reason).toBe("return");
    expect(result.final_cpu).toMatchObject(flags);
    expect(result.branch_choices_used).toBe(0);
  });
});

it.each([
  ["reset", 4, 0xe000, 0x11],
  ["nmi", 6, 0xe020, 0x22],
  ["irq", 2, 0xe040, 0x33],
] as const)(
  "selects the %s vector as an entry without fabricating an interrupt frame",
  async (entry, tail, target, accumulator) => {
    const fixture = nesCodeFixture(4, [0xa9, 0x11, 0x40]);
    fixture.bytes.set([0xa9, 0x22, 0x40], fixture.programOffset + 32);
    fixture.bytes.set([0xa9, 0x33, 0x40], fixture.programOffset + 64);
    fixture.bytes.writeUInt16LE(
      0xe020,
      fixture.prgOffset + fixture.prgSize - 6,
    );
    fixture.bytes.writeUInt16LE(
      0xe040,
      fixture.prgOffset + fixture.prgSize - 2,
    );
    const result = await run(fixture, { entry, cpu: { sp: 0xff, i: false } });
    expect(result.resolved_entry).toBe(target);
    expect(result.entry_vector).toEqual([
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
    expect(result.final_cpu).toMatchObject({
      a: accumulator,
      sp: 0xff,
      i: false,
    });
    expect(result.instructions).toHaveLength(1);
    expect(result.instructions[0]!.writes).toEqual([]);
    expect(result.stop).toMatchObject({
      address: target + 2,
      reason: "unknown-control-target",
      bytes_hex: "40",
    });
  },
);

it.each(["nmi", "irq"] as const)(
  "retains unresolved %s vector bytes under an unknown MMC1 upper window",
  async (entry) => {
    const fixture = nesCodeFixture(1, [0x60]);
    const result = await run(fixture, {
      entry,
      initial: { mapper: 1, prg_mode: 2 },
      cpu: { i: false },
    });
    expect(result.resolved_entry).toBeNull();
    expect(result.instructions).toEqual([]);
    expect(result.entry_vector).toEqual([
      {
        address: entry === "nmi" ? 0xfffa : 0xfffe,
        value: null,
        file_offset: null,
      },
      {
        address: entry === "nmi" ? 0xfffb : 0xffff,
        value: null,
        file_offset: null,
      },
    ]);
    expect(result.stop.reason).toBe("unresolved-vector");
  },
);

it("restores a caller-supplied interrupt frame and replaces mirrored RAM code assumptions with writer evidence", async () => {
  const initial_ram = [
    { address: 0x1fd, value: 0x21 },
    { address: 0x1fe, value: 0 },
    { address: 0x1ff, value: 0x0a },
    ...[0xa9, 0x60, 0x8d, 5, 0x0a, 0xea].map((value, index) => ({
      address: 0x200 + index,
      value,
    })),
  ];
  const before = structuredClone(initial_ram);
  const trace = await run(nesCodeFixture(4, [0x40]), {
    entry: "nmi",
    cpu: { sp: 0xfc, i: true },
    initial_ram,
  });
  expect(trace.instructions.map((instruction) => instruction.mnemonic)).toEqual(
    ["RTI", "LDA", "STA"],
  );
  expect(trace.instructions[0]).toMatchObject({
    next_address: 0x0a00,
    writes: [],
    cpu_after: { sp: 255, c: true, i: false },
  });
  expect(trace.instructions[1]).toMatchObject({
    file_offsets: [null, null],
    ram_origins: [
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
    ],
  });
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
  expect(initial_ram).toEqual(before);
});

it("keeps omitted RAM bytes unknown and reads supplied data through internal mirrors", async () => {
  const trace = await run(
    nesCodeFixture(4, [0xad, 0, 0x18, 0x85, 1, 0xa5, 2, 0x02]),
    {
      initial_ram: [{ address: 0, value: 0x55 }],
    },
  );
  expect(trace.instructions[0]!.cpu_after.a).toBe(0x55);
  expect(trace.instructions[1]!.writes).toEqual([
    { address: 1, value: 0x55, preceded_by_cpu_write: false },
  ]);
  expect(trace.final_cpu.a).toBeNull();
});

it.each([
  {
    initial_ram: [
      { address: 0, value: 1 },
      { address: 0, value: 2 },
    ],
  },
  { initial_ram: [{ address: 2048, value: 1 }] },
  { initial_ram: [{ address: 0x6000, value: 1 }] },
  { initial_ram: [{ address: 0, value: 256 }] },
])(
  "rejects ambiguous or nonphysical initial RAM assumptions %j",
  ({ initial_ram }) => {
    expect(
      traceNesCodeInputSchema.safeParse({
        path: "/code.nes",
        initial: initial4,
        initial_ram,
      }).success,
    ).toBe(false);
  },
);

it("records one immutable RMW operand before both bank-changing writes", async () => {
  const fixture = nesCodeFixture(4, [0xee, 1, 0x80, 0x60]);
  const offset = fixture.prgOffset + 2 * 8192 + 1;
  fixture.bytes[offset] = 3;
  const trace = await run(fixture);
  expect(trace.instructions[0]!.data_reads).toEqual([
    {
      address: 0x8001,
      value: 3,
      file_offset: offset,
      ram_origins: [],
      mapper_origins: [],
    },
  ]);
  expect(trace.instructions[0]!.writes.map((write) => write.value)).toEqual([
    3, 4,
  ]);
  expect(trace.mapper_trace).toMatchObject({
    final: { banks: [0, 2, 4, 5, 6, 7, 4, 1] },
  });
});

it("retains unresolved RTI stack dependencies without applying the incomplete frame", async () => {
  const trace = await run(nesCodeFixture(4, [0x40]), {
    cpu: { sp: 252, i: true },
    initial_ram: [
      { address: 253 + 256, value: 0x21 },
      { address: 254 + 256, value: 0 },
    ],
  });
  expect(trace.instructions).toEqual([]);
  expect(trace.final_cpu).toMatchObject({ sp: 252, i: true });
  expect(trace.stop.reason).toBe("unknown-control-target");
  expect(
    trace.stop.data_reads.map((read) => [read.address, read.value]),
  ).toEqual([
    [509, 0x21],
    [510, 0],
    [511, null],
  ]);
  expect(trace.stop.data_reads[2]!.ram_origins).toEqual([]);
});

it("distinguishes an unknown effective address from a known unknown I/O value", async () => {
  const trace = await run(
    nesCodeFixture(4, [0xbd, 0, 0x80, 0xad, 2, 0x20, 0x60]),
  );
  expect(
    trace.instructions.map((instruction) => instruction.data_reads),
  ).toEqual([
    [
      {
        address: null,
        value: null,
        file_offset: null,
        ram_origins: [],
        mapper_origins: [],
      },
    ],
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
});

it.each(["nmi", "irq"] as const)(
  "enters an explicitly accepted %s with a wrapped hardware frame and restores it through RTI",
  async (kind) => {
    const fixture = nesCodeFixture(4, [0x40]);
    const cpu = {
      a: 1,
      x: 2,
      y: 3,
      sp: 0,
      c: true,
      z: false,
      i: kind === "nmi",
      d: true,
      v: false,
      n: true,
    };
    const trace = await run(fixture, {
      entry: { accepted_interrupt: kind, return_address: 0xe020 },
      cpu,
    });
    expect(trace.entry_vector?.map((item) => item.address)).toEqual(
      kind === "nmi" ? [0xfffa, 0xfffb] : [0xfffe, 0xffff],
    );
    expect(trace.entry_interrupt).toEqual({
      kind,
      return_address: 0xe020,
      writes: [
        { address: 0x100, value: 0xe0, preceded_by_cpu_write: false },
        { address: 0x1ff, value: 0x20, preceded_by_cpu_write: true },
        {
          address: 0x1fe,
          value: kind === "nmi" ? 0xad : 0xa9,
          preceded_by_cpu_write: true,
        },
      ],
      cpu_after: { ...cpu, sp: 253, i: true },
    });
    expect(trace.instructions).toHaveLength(1);
    expect(trace.instructions[0]).toMatchObject({
      mnemonic: "RTI",
      next_address: 0xe020,
      writes: [],
    });
    expect(
      trace.instructions[0]!.data_reads.map((read) => read.ram_origins),
    ).toEqual(
      [2, 1, 0].map((entry_interrupt_write_index, index) => [
        {
          byte_index: 0,
          region: "internal-ram",
          ram_address: [0x1fe, 0x1ff, 0x100][index],
          entry_interrupt_write_index,
        },
      ]),
    );
    expect(trace.final_cpu).toEqual(cpu);
    expect(trace.stop).toMatchObject({
      reason: "unsupported-opcode",
      address: 0xe020,
    });
  },
);

it("leaves an accepted entry unapplied if its SP or mapped vector is unknown", async () => {
  const entry = { accepted_interrupt: "irq", return_address: 0x8000 };
  const unknownStack = await run(nesCodeFixture(4, [0x40]), {
    entry,
    cpu: { i: false },
  });
  expect(unknownStack).toMatchObject({
    resolved_entry: 0xe000,
    entry_interrupt: null,
    instructions: [],
    final_cpu: { i: false, sp: null },
    stop: { reason: "unknown-stack", address: 0xe000 },
  });
  const unknownVector = await run(nesCodeFixture(1, [0x40]), {
    entry,
    initial: { mapper: 1, prg_mode: 2 },
    cpu: { i: false, sp: 255 },
  });
  expect(unknownVector).toMatchObject({
    resolved_entry: null,
    entry_interrupt: null,
    instructions: [],
    final_cpu: { i: false, sp: 255 },
    stop: { reason: "unresolved-vector" },
  });
});

it("keeps an unknown saved status unknown while resolving the accepted interrupt return PC", async () => {
  const trace = await run(nesCodeFixture(4, [0x40]), {
    entry: { accepted_interrupt: "nmi", return_address: 0xe020 },
    cpu: { sp: 255 },
  });
  expect(trace.entry_interrupt?.writes[2]?.value).toBeNull();
  expect(trace.entry_interrupt?.cpu_after.i).toBe(true);
  expect(trace.instructions[0]!.next_address).toBe(0xe020);
  expect(trace.final_cpu).toMatchObject({ sp: 255, i: null });
});

it("preserves known status bits through PHP/PLP so a proven branch stays resolved", async () => {
  const trace = await run(
    nesCodeFixture(4, [0x08, 0x78, 0xd8, 0x28, 0x90, 2, 0x02]),
    { cpu: { sp: 255, c: true, i: false, d: true } },
  );
  expect(trace.instructions[0]!.writes).toEqual([
    {
      address: 511,
      value: null,
      preceded_by_cpu_write: false,
      known_bits: { mask: 0x3d, value: 0x39 },
    },
  ]);
  expect(trace.instructions[3]!.data_reads).toEqual([
    {
      address: 511,
      value: null,
      file_offset: null,
      known_bits: { mask: 0x3d, value: 0x39 },
      mapper_origins: [],
      ram_origins: [
        {
          byte_index: 0,
          region: "internal-ram",
          ram_address: 511,
          instruction_index: 0,
          write_index: 0,
        },
      ],
    },
  ]);
  expect(trace.final_cpu).toMatchObject({
    c: true,
    i: false,
    d: true,
    z: null,
    n: null,
    v: null,
    sp: 255,
  });
  expect(trace.instructions.at(-1)!.mnemonic).toBe("BCC");
  expect(trace.stop).toMatchObject({
    reason: "unsupported-opcode",
    address: 0xe006,
  });
});

it.each(["nmi", "irq"] as const)(
  "restores partially known flags after an accepted %s",
  async (accepted_interrupt) => {
    const trace = await run(nesCodeFixture(4, [0x78, 0xd8, 0x40]), {
      entry: { accepted_interrupt, return_address: 0xe020 },
      cpu: { sp: 255, c: true, i: false, d: true },
    });
    expect(trace.entry_interrupt?.writes[2]).toMatchObject({
      value: null,
      known_bits: { mask: 0x3d, value: 0x29 },
    });
    expect(trace.instructions[2]!.data_reads[0]).toMatchObject({
      value: null,
      known_bits: { mask: 0x3d, value: 0x29 },
      ram_origins: [{ entry_interrupt_write_index: 2 }],
    });
    expect(trace.final_cpu).toMatchObject({
      c: true,
      i: false,
      d: true,
      z: null,
      n: null,
      v: null,
      sp: 255,
    });
  },
);

it("restores partially known BRK flags without treating the status byte as a known number", async () => {
  const fixture = nesCodeFixture(4, [0x00, 0x02, 0x02]);
  fixture.bytes.set([0x78, 0xd8, 0x40], fixture.programOffset + 32);
  fixture.bytes.writeUInt16LE(0xe020, fixture.prgOffset + fixture.prgSize - 2);
  const trace = await run(fixture, {
    cpu: { sp: 255, c: true, i: false, d: true },
  });
  expect(trace.instructions[0]!.writes[2]).toMatchObject({
    value: null,
    known_bits: { mask: 0x3d, value: 0x39 },
  });
  expect(trace.final_cpu).toMatchObject({
    c: true,
    i: false,
    d: true,
    z: null,
    n: null,
    v: null,
    sp: 255,
  });
  expect(trace.stop).toMatchObject({
    reason: "unsupported-opcode",
    address: 0xe002,
  });
});

it("invalidates saved known status bits when an unknown store overwrites a stack mirror", async () => {
  const trace = await run(
    nesCodeFixture(4, [0x08, 0xad, 2, 0x20, 0x8d, 0xff, 9, 0x28, 0x60]),
    { cpu: { sp: 255, c: true, i: false, d: true } },
  );
  expect(trace.instructions[2]!.writes).toEqual([
    { address: 0x09ff, value: null, preceded_by_cpu_write: false },
  ]);
  expect(trace.instructions[3]!.data_reads[0]).toEqual({
    address: 511,
    value: null,
    file_offset: null,
    ram_origins: [],
    mapper_origins: [],
  });
  expect(trace.final_cpu).toMatchObject({
    c: null,
    i: null,
    d: null,
    z: null,
    n: null,
    v: null,
  });
});

it.each([
  { a: 0x40, z: false },
  { a: 0x80, z: true },
  { a: 1, z: null },
])(
  "derives BIT flags from a partially known saved status: %j",
  async ({ a, z }) => {
    const fixture = nesCodeFixture(
      4,
      [0x08, 0x2c, 0xff, 0x09, 0x70, 2, 0x02, 0x02, 0x02],
    );
    const result = await run(fixture, {
      cpu: { sp: 255, a, n: false, v: true },
    });
    expect(result.instructions[1]).toMatchObject({
      mnemonic: "BIT",
      cpu_after: { a, n: false, v: true, z },
      data_reads: [
        {
          address: 0x09ff,
          value: null,
          known_bits: { mask: 0xf0, value: 0x70 },
        },
      ],
    });
    expect(result.instructions[1]!.data_reads).toHaveLength(1);
    expect(result.instructions[2]).toMatchObject({
      mnemonic: "BVS",
      next_address: fixture.entry + 8,
    });
    expect(result.stop.reason).toBe("unsupported-opcode");
  },
);

it.each([
  { opcode: 0x2d, a: 0x40, expected: 0x40, n: false, z: false },
  { opcode: 0x2d, a: 0x80, expected: 0, n: false, z: true },
  { opcode: 0x0d, a: 0x8f, expected: 0xff, n: true, z: false },
  { opcode: 0x4d, a: 0x80, expected: null, n: true, z: false },
])(
  "uses saved partial status bits in logical memory operations %j",
  async ({ opcode, a, expected, n, z }) => {
    const fixture = nesCodeFixture(4, [
      0x08,
      opcode,
      0xff,
      0x09,
      0x8d,
      0,
      0x80,
      0x02,
    ]);
    const result = await run(fixture, {
      cpu: { sp: 255, a, n: false, v: true },
    });
    expect(result.instructions[1]).toMatchObject({
      cpu_after: { a: expected, n, z },
      data_reads: [
        {
          address: 0x09ff,
          value: null,
          known_bits: { mask: 0xf0, value: 0x70 },
          ram_origins: [{ instruction_index: 0 }],
        },
      ],
    });
    expect(result.instructions[1]!.data_reads).toHaveLength(1);
    expect(result.instructions[2]!.writes[0]?.value).toBe(expected);
  },
);

it.each([0xcd, 0xec, 0xcc])(
  "compares saved partial status without losing proven carry for opcode %i",
  async (opcode) => {
    const fixture = nesCodeFixture(4, [
      0x08,
      opcode,
      0xff,
      0x09,
      0x90,
      2,
      0x02,
      0x02,
      0x02,
    ]);
    const result = await run(fixture, {
      cpu: { sp: 255, a: 0x40, x: 0x40, y: 0x40, n: false, v: true },
    });
    expect(result.instructions[1]).toMatchObject({
      cpu_after: {
        a: 0x40,
        x: 0x40,
        y: 0x40,
        c: false,
        z: false,
        n: true,
        v: true,
      },
      data_reads: [
        {
          known_bits: { mask: 240, value: 112 },
          ram_origins: [{ instruction_index: 0 }],
        },
      ],
    });
    expect(result.instructions[1]!.data_reads).toHaveLength(1);
    expect(result.instructions[2]).toMatchObject({
      mnemonic: "BCC",
      next_address: fixture.entry + 8,
    });
    expect(result.stop.reason).toBe("unsupported-opcode");
  },
);

it.each([
  { opcode: 0xad, register: "a" },
  { opcode: 0xae, register: "x" },
  { opcode: 0xac, register: "y" },
  { opcode: 0xaf, register: "a" },
])(
  "retains load flags from saved status while keeping $register unknown: $opcode",
  async ({ opcode, register }) => {
    const fixture = nesCodeFixture(4, [
      0x08,
      opcode,
      0xff,
      0x09,
      0x10,
      2,
      0x02,
      0x02,
      0x02,
    ]);
    const result = await run(fixture, { cpu: { sp: 255, n: false, v: true } });
    expect(result.instructions[1]).toMatchObject({
      cpu_after: { [register]: null, n: false, z: false, v: true },
      data_reads: [
        {
          known_bits: { mask: 240, value: 112 },
          ram_origins: [{ instruction_index: 0 }],
        },
      ],
    });
    expect(result.instructions[1]!.data_reads).toHaveLength(1);
    expect(result.instructions[2]).toMatchObject({
      mnemonic: "BPL",
      next_address: fixture.entry + 8,
    });
  },
);

it.each([0, 255])(
  "keeps PLA partial status flags and stack provenance across SP=%i",
  async (sp) => {
    const fixture = nesCodeFixture(4, [0x08, 0x68, 0x10, 2, 0x02, 0x02, 0x02]);
    const result = await run(fixture, { cpu: { sp, n: false, v: true } });
    expect(result.instructions[1]).toMatchObject({
      mnemonic: "PLA",
      cpu_after: { a: null, n: false, z: false, v: true, sp },
      data_reads: [
        {
          address: 256 + sp,
          known_bits: { mask: 240, value: 112 },
          ram_origins: [{ instruction_index: 0 }],
        },
      ],
    });
    expect(result.instructions[1]!.data_reads).toHaveLength(1);
    expect(result.instructions[2]).toMatchObject({
      mnemonic: "BPL",
      next_address: fixture.entry + 6,
    });
  },
);

it("does not reuse PLA flag proof after the stacked status is overwritten", async () => {
  const fixture = nesCodeFixture(
    4,
    [0x08, 0xad, 2, 0x20, 0x8d, 0xff, 0x09, 0x68, 0x10, 2, 0x02, 0x02, 0x02],
  );
  const result = await run(fixture, { cpu: { sp: 255, n: false, v: true } });
  expect(result.instructions[3]).toMatchObject({
    mnemonic: "PLA",
    cpu_after: { a: null, n: null, z: null, sp: 255 },
    data_reads: [{ value: null, ram_origins: [] }],
  });
  expect(result.stop.reason).toBe("unknown-branch");
});

it.each([
  { opcode: 0x6d, a: 0x10, c: false, v: true, bits: 0x78 },
  { opcode: 0xed, a: 0x40, c: true, v: false, bits: 0x79 },
])(
  "derives binary arithmetic flags from partial saved status: $opcode",
  async ({ opcode, a, c, v, bits }) => {
    const fixture = nesCodeFixture(4, [
      0x08,
      opcode,
      0xff,
      0x09,
      0x30,
      2,
      0x02,
      0x02,
      0x02,
    ]);
    const result = await run(fixture, {
      cpu: { sp: 255, a, c, n: false, v: true, d: true },
    });
    expect(result.instructions[1]).toMatchObject({
      cpu_after: { a: null, c: false, n: true, z: false, v, d: true },
      data_reads: [
        {
          known_bits: { mask: 0xf9, value: bits },
          ram_origins: [{ instruction_index: 0 }],
        },
      ],
    });
    expect(result.instructions[1]!.data_reads).toHaveLength(1);
    expect(result.instructions[2]).toMatchObject({
      mnemonic: "BMI",
      next_address: fixture.entry + 8,
    });
  },
);

it.each([65, 66])(
  "uses partial status in LAS without inventing unknown SP bits, initial SP=%i",
  async (sp) => {
    const fixture = nesCodeFixture(4, [0x08, 0xbb, sp, 0x09, 0x02]);
    const result = await run(fixture, { cpu: { sp, y: 0, n: false, v: true } });
    const expected = sp === 65 ? 64 : null;
    expect(result.instructions[1]).toMatchObject({
      mnemonic: "LAS",
      cpu_after: {
        a: expected,
        x: expected,
        sp: expected,
        n: false,
        z: false,
        v: true,
      },
      data_reads: [
        {
          address: 0x900 + sp,
          known_bits: { mask: 240, value: 112 },
          ram_origins: [{ instruction_index: 0 }],
        },
      ],
    });
    expect(result.instructions[1]!.data_reads).toHaveLength(1);
  },
);

it.each([
  { opcode: 0x2d, n: false, z: null },
  { opcode: 0x0d, n: null, z: false },
  { opcode: 0x4d, n: null, z: null },
  { opcode: 0xcd, n: null, z: null },
  { opcode: 0xec, n: null, z: null },
  { opcode: 0xcc, n: null, z: null },
  { opcode: 0xad, n: null, z: null },
  { opcode: 0xae, n: null, z: null },
  { opcode: 0xac, n: null, z: null },
  { opcode: 0xaf, n: null, z: null },
  { opcode: 0xbb, n: null, z: null },
  { opcode: 0x6d, n: null, z: null },
  { opcode: 0xed, n: null, z: null },
])(
  "discards overwritten status proof before memory opcode $opcode",
  async ({ opcode, n, z }) => {
    const fixture = nesCodeFixture(4, [
      0x08,
      0xad,
      2,
      0x20,
      0x8d,
      0xff,
      0x09,
      0xa9,
      0x40,
      opcode,
      0xff,
      0x09,
      0x02,
    ]);
    const result = await run(fixture, {
      cpu: { sp: 255, x: 64, y: 0, n: false, v: true },
    });
    const consumer = result.instructions[4]!;
    expect(consumer.data_reads).toEqual([
      {
        address: 0x09ff,
        value: null,
        file_offset: null,
        ram_origins: [],
        mapper_origins: [],
      },
    ]);
    expect(consumer.cpu_after).toMatchObject({ n, z });
  },
);

it.each([
  { opcode: 0x0e, mask: 0xe1, bits: 0xe0, n: true, c: false },
  { opcode: 0x4e, mask: 0xf8, bits: 0x38, n: false, c: null },
  { opcode: 0x2e, mask: 0xe0, bits: 0xe0, n: true, c: false },
  { opcode: 0x6e, mask: 0x78, bits: 0x38, n: null, c: null },
])(
  "preserves both RMW bus writes and shifted status proof for opcode $opcode",
  async ({ opcode, mask, bits, n, c }) => {
    const fixture = nesCodeFixture(4, [
      0x08,
      opcode,
      0xff,
      0x09,
      0xad,
      0xff,
      0x09,
      0x02,
    ]);
    const result = await run(fixture, { cpu: { sp: 255, n: false, v: true } });
    expect(result.instructions[1]).toMatchObject({
      cpu_after: { n, z: false, c },
      writes: [
        {
          address: 0x09ff,
          value: null,
          known_bits: { mask: 240, value: 112 },
          preceded_by_cpu_write: false,
        },
        {
          address: 0x09ff,
          value: null,
          known_bits: { mask, value: bits },
          preceded_by_cpu_write: true,
        },
      ],
    });
    expect(result.instructions[2]).toMatchObject({
      cpu_after: { a: null, n, z: false },
      data_reads: [
        {
          known_bits: { mask, value: bits },
          ram_origins: [{ instruction_index: 1, write_index: 1 }],
        },
      ],
    });
  },
);

it.each([
  { opcode: 0xee, mask: 224, bits: 96 },
  { opcode: 0xce, mask: 224, bits: 96 },
])(
  "retains only common bits after partial INC/DEC: $opcode",
  async ({ opcode, mask, bits }) => {
    const fixture = nesCodeFixture(4, [
      0x08,
      opcode,
      0xff,
      0x09,
      0xad,
      0xff,
      0x09,
      0x02,
    ]);
    const result = await run(fixture, { cpu: { sp: 255, n: false, v: true } });
    expect(result.instructions[1]!.writes[0]).toMatchObject({
      value: null,
      known_bits: { mask: 240, value: 112 },
    });
    if (opcode === 0xee) {
      expect(result.instructions[1]!.writes[1]).toEqual({
        address: 0x09ff,
        value: null,
        preceded_by_cpu_write: true,
      });
      expect(result.instructions[2]!.data_reads[0]).toMatchObject({
        value: null,
        ram_origins: [],
      });
      return;
    }
    expect(result.instructions[1]!.writes[1]).toMatchObject({
      value: null,
      known_bits: { mask, value: bits },
    });
    expect(result.instructions[2]).toMatchObject({
      cpu_after: { a: null, n: false, z: false },
      data_reads: [
        {
          known_bits: { mask, value: bits },
          ram_origins: [{ instruction_index: 1, write_index: 1 }],
        },
      ],
    });
  },
);

it("keeps a proven nonzero INC result even when its writeback has no common bits", async () => {
  const fixture = nesCodeFixture(
    4,
    [0x08, 0xee, 0xff, 0x09, 0xd0, 2, 0x02, 0x02, 0x02],
  );
  const result = await run(fixture, { cpu: { sp: 255, n: false, v: true } });
  expect(result.instructions[1]).toMatchObject({
    cpu_after: { n: null, z: false, v: true, c: null },
    writes: [{ known_bits: { mask: 240, value: 112 } }, { value: null }],
  });
  expect(result.instructions[1]!.writes[1]).not.toHaveProperty("known_bits");
  expect(result.instructions[2]).toMatchObject({
    mnemonic: "BNE",
    next_address: fixture.entry + 8,
  });
});
