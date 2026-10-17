import { mapperTraceFixture } from "./nesMapperTrace.fixture.js";

/** Executable synthetic cartridge with a fixed-bank entry and deliberately invalid filler. */
export const nesCodeFixture = (
  mapper: 1 | 4 | 9 | 10,
  program: readonly number[],
) => {
  const bytes = mapperTraceFixture(mapper);
  const prgOffset = 528;
  const prgSize = 65536;
  const entry = mapper === 1 || mapper === 10 ? 0xc000 : 0xe000;
  const programOffset = prgOffset + prgSize - (65536 - entry);
  bytes.fill(0x02, prgOffset, prgOffset + prgSize);
  bytes.set(program, programOffset);
  for (const offset of [6, 4, 2])
    bytes.writeUInt16LE(entry, prgOffset + prgSize - offset);
  return { bytes, prgOffset, prgSize, entry, programOffset };
};

export const mmc1SerialProgram = [
  0xa9, 128, 0x8d, 0x00, 0x80, 0xa9, 18, 0x8d, 0x00, 0xe0, 0x4a, 0x8d, 0x00,
  0xe0, 0x4a, 0x8d, 0x00, 0xe0, 0x4a, 0x8d, 0x00, 0xe0, 0x4a, 0x8d, 0x00, 0xe0,
  0x60,
] as const;

export const mmc3SwitchCodeFixture = () => {
  const fixture = nesCodeFixture(
    4,
    [
      0xa9, 7, 0x8d, 0, 0x80, 0xa9, 1, 0x8d, 1, 0x80, 0xa9, 6, 0x8d, 0, 0x80,
      0xa9, 2, 0x8d, 1, 0x80, 0x4c, 0, 0x80,
    ],
  );
  fixture.bytes.set([0xa9, 3, 0x8d, 1, 0x80], fixture.prgOffset + 2 * 8192);
  fixture.bytes.set(
    [0xa9, 7, 0x8d, 0, 0x80, 0x60],
    fixture.prgOffset + 3 * 8192 + 5,
  );
  return fixture;
};

/** Unknown PPU status selects two distinct RAM facts and MMC3 instruction banks. */
export const mmc3BranchCodeFixture = () => {
  const fixture = nesCodeFixture(
    4,
    [
      0xad, 2, 0x20, 0xf0, 10, 0xa9, 2, 0x85, 0x10, 0x8d, 1, 0x80, 0x4c, 0x16,
      0xe0, 0xa9, 3, 0x85, 0x10, 0x8d, 1, 0x80, 0xa5, 0x10, 0x8d, 1, 0x80, 0x4c,
      0, 0x80,
    ],
  );
  fixture.bytes.set([0xa9, 0x22, 0x60], fixture.prgOffset + 2 * 8192);
  fixture.bytes.set([0xa9, 0x33, 0x60], fixture.prgOffset + 3 * 8192);
  return fixture;
};

/** NINA code duplicated across both PRG banks, with an explicit unbanked RAM declaration. */
export const ninaRamCodeFixture = (
  program: readonly number[],
  ramDeclaration = 7,
) => {
  const prgOffset = 16,
    prgSize = 65536,
    entry = 0x8100,
    programOffset = 272;
  const bytes = Buffer.alloc(prgOffset + prgSize + 16384, 0x02);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 2, 0x20, 0x28, 0x10]);
  bytes[10] = ramDeclaration;
  bytes.set(program, programOffset);
  bytes.set(program, programOffset + 32768);
  return { bytes, prgOffset, prgSize, entry, programOffset };
};

/** Conventional MMC3 RAM is explicit; legacy headers do not establish its presence. */
export const mmc3RamCodeFixture = (
  program: readonly number[],
  ramDeclaration = 7,
) => {
  const fixture = nesCodeFixture(4, program);
  fixture.bytes[7] = 8;
  fixture.bytes[8] = 0;
  fixture.bytes[10] = ramDeclaration;
  return fixture;
};

/** MMC4 executes a RAM trampoline that switches PRG before jumping into the new bank. */
export const mmc4RamCodeFixture = (ramDeclaration: number | null = 7) => {
  const ramCode = [0xa9, 2, 0x8d, 0, 0xa0, 0x4c, 0, 0x80];
  const program = ramCode.flatMap((value, index) => [
    0xa9,
    value,
    0x8d,
    index,
    0x60,
  ]);
  program.push(0xa9, 0, 0x8d, 1, 0xa0, 0x4c, 0, 0x60);
  const fixture = nesCodeFixture(10, program);
  fixture.bytes.set([0xa9, 0x66, 0x60], fixture.prgOffset + 2 * 16384);
  if (ramDeclaration !== null) {
    fixture.bytes[7] = 8;
    fixture.bytes[10] = ramDeclaration;
  }
  return fixture;
};

/** Single-RAM MMC1B profiles: banked CHR ROM or SNROM's additional RAM enable. */
export const mmc1RamCodeFixture = (
  program: readonly number[],
  snrom = false,
) => {
  const fixture = nesCodeFixture(1, program);
  fixture.bytes[7] = 8;
  fixture.bytes[10] = 7;
  if (snrom) {
    fixture.bytes[5] = 0;
    fixture.bytes[11] = 7;
    fixture.bytes = fixture.bytes.subarray(
      0,
      fixture.prgOffset + fixture.prgSize,
    );
  }
  return fixture;
};

/** Five separated LSB-first stores; no assumed power-on shift alignment. */
export const mmc1WriteProgram = (address: number, value: number): number[] =>
  Array.from({ length: 5 }, (_, bit) => [
    0xa9,
    (value >> bit) & 1,
    0x8d,
    address & 255,
    address >> 8,
  ]).flat();

/** Two independently populated RAM banks, then an unobserved PPU A12 selection. */
export const mmc1BankedRamCodeFixture = (
  kind: "SOROM" | "SXROM" | "SZROM",
  sameValue = true,
  uncertainWrite: number | null = null,
) => {
  const selector = kind === "SOROM" ? 8 : kind === "SXROM" ? 12 : 16;
  const store = (value: number, offset: number) => [
    0xa9,
    value,
    0x8d,
    offset,
    0x60,
  ];
  const fixture = mmc1RamCodeFixture(
    [
      ...store(0xa9, 0),
      ...store(0x55, 1),
      ...store(0x60, 2),
      ...mmc1WriteProgram(0xa000, selector),
      ...store(0xa9, 0),
      ...store(sameValue ? 0x55 : 0x66, 1),
      ...store(0x60, 2),
      ...mmc1WriteProgram(0xc000, 0),
      ...mmc1WriteProgram(0x8000, 0x1c),
      ...(uncertainWrite === null ? [] : store(uncertainWrite, 1)),
      0x4c,
      0,
      0x60,
    ],
    kind !== "SZROM",
  );
  fixture.bytes[10] = kind === "SXROM" ? 9 : 8;
  return fixture;
};

/** SUROM/SXROM execute the outer-bank write from retained cartridge RAM. */
export const mmc1OuterCodeFixture = (ramBank: 0 | 1 | 2 | 3 = 0) => {
  const prgOffset = 16,
    prgSize = 0x80000,
    entry = 0xc000;
  const bytes = Buffer.alloc(prgOffset + prgSize, 2);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 32, 0, 0x10, 8, 0, 0, 7, 7]);
  if (ramBank !== 0) bytes[10] = 9;
  const trampoline = [
    ...mmc1WriteProgram(0xa000, 16 | (ramBank << 2)),
    0x4c,
    0,
    0x80,
  ];
  const program: number[] = [];
  for (const [offset, value] of trampoline.entries())
    program.push(0xa9, value, 0x8d, offset, 0x60);
  program.push(0x4c, 0, 0x60);
  const programOffset = prgOffset + 15 * 0x4000;
  bytes.set(program, programOffset);
  bytes.writeUInt16LE(entry, prgOffset + 0x40000 - 4);
  bytes.set([0xa9, 0x66, 0x60], prgOffset + 0x40000);
  return { bytes, prgOffset, prgSize, entry, programOffset };
};

/** Fixed PRG stays at the same CPU addresses while MMC1 registers change. */
export const mmc1FixedCodeFixture = () => {
  const prgOffset = 16,
    prgSize = 32768,
    entry = 0x8000,
    programOffset = 16;
  const bytes = Buffer.alloc(prgOffset + prgSize + 32768, 2);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 4, 0x10, 8, 0x50]);
  bytes.set(
    [
      ...mmc1WriteProgram(0xe000, 1),
      ...mmc1WriteProgram(0x8000, 12),
      ...mmc1WriteProgram(0xa000, 2),
      0xa9,
      0x66,
      0x60,
    ],
    programOffset,
  );
  bytes.writeUInt16LE(entry, prgOffset + prgSize - 4);
  return { bytes, prgOffset, prgSize, entry, programOffset };
};

export const mmc6RamCodeFixture = (zeroOperand = false) => {
  const store = (address: number, value: number) => [
    0xa9,
    value,
    0x8d,
    address & 255,
    address >> 8,
  ];
  const fixture = mmc3RamCodeFixture(
    [
      ...store(0x8000, 0x20),
      ...store(0xa001, 0xf0),
      ...(zeroOperand
        ? [...store(0x71ff, 0xa9), ...store(0xa001, 0x30), 0x4c, 0xff, 0x71]
        : [
            ...store(0x7c00, 0xa9),
            ...store(0x7401, 0x55),
            ...store(0x7802, 0x60),
            ...store(0xa001, 0xa0),
            0xee,
            1,
            0x74,
            ...store(0x8000, 0x60),
            0x4c,
            0,
            0x74,
          ]),
    ],
    4,
  );
  fixture.bytes[8] = 0x10;
  return fixture;
};

export const mmc3HardwiredCodeFixture = (vertical: boolean) => {
  const fixture = nesCodeFixture(
    4,
    [
      0xa9, 1, 0x8d, 0, 0xa0, 0xa9, 0, 0x8d, 0xfe, 0xbf, 0xad, 2, 0x20, 0x8d, 0,
      0xa0, 0xa9, 6, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 1, 0x80, 0x4c, 0, 0x80,
    ],
  );
  fixture.bytes[6] = (fixture.bytes[6]! & ~1) | Number(vertical);
  fixture.bytes[7] = 8;
  fixture.bytes[8] = 0x20;
  fixture.bytes.set([0xa9, 0x66, 0x60], fixture.prgOffset + 2 * 8192);
  return fixture;
};

/** Writes a RAM trampoline through upper NROM aliases, then executes at $6000. */
export const nromRamCodeFixture = (declaration = 5) => {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0, 8, 0, 0, declaration]);
  const size = 64 * 2 ** (declaration & 15 || declaration >> 4);
  const alias = size < 8192 ? 0x8000 - size : 0x6000;
  bytes.set(
    [
      0xa9,
      0xa9,
      0x8d,
      alias & 255,
      alias >> 8,
      0xa9,
      0x55,
      0x8d,
      (alias + 1) & 255,
      (alias + 1) >> 8,
      0xa9,
      0x60,
      0x8d,
      (alias + 2) & 255,
      (alias + 2) >> 8,
      0xa9,
      0x33,
      0x85,
      0,
      0x4c,
      0,
      0x60,
    ],
    16,
  );
  bytes.writeUInt16LE(0x8000, 16 + 32768 - 4);
  return {
    bytes,
    prgOffset: 16,
    prgSize: 32768,
    entry: 0x8000,
    programOffset: 16,
  };
};

export const invertedUnromCodeFixture = () => {
  const bytes = Buffer.alloc(16 + 65536, 2);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 0, 0x40, 0xb8, 0, 0, 0, 7]);
  bytes.set([0xa9, 3, 0x8d, 0, 0x81, 0x4c, 0, 0xc0], 16);
  bytes[16 + 256] = 2;
  bytes.set([0xa9, 3, 0x8d, 0, 0xc1], 16 + 32768);
  bytes[16 + 32768 + 256] = 1;
  bytes.set([0xa9, 0x66, 0x60], 16 + 16384 + 5);
  return { bytes, prgOffset: 16, prgSize: 65536, entry: 0x8000 };
};
