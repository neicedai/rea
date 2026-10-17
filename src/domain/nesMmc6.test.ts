import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { expect, it } from "vitest";

import { mmc3RamCodeFixture } from "./nesCode.fixture.js";

const trace = async (
  program: number[],
  initial: unknown = { mapper: 4 },
  declaration = 4,
) => {
  const fixture = mmc3RamCodeFixture(program, declaration);
  fixture.bytes[8] = 0x10;
  const { trace: result } = await deriveNesFixtureTrace(
    fixture.bytes,
    fixture.bytes.subarray(
      fixture.prgOffset,
      fixture.prgOffset + fixture.prgSize,
    ),
    { path: "/mmc6.nes", initial },
  );
  return result;
};
const write = (address: number, value: number) => [
  0xa9,
  value,
  0x8d,
  address & 255,
  address >> 8,
];
const enable = [...write(0x8000, 0x20), ...write(0xa001, 0xf0)];

it.each([0, 4, 0x40])(
  "executes mirrored MMC6 RAM with declaration %s",
  async (declaration) => {
    const result = await trace(
      [
        ...enable,
        ...write(0x7c00, 0xa9),
        ...write(0x7401, 0x55),
        ...write(0x7802, 0x60),
        ...write(0xa001, 0xa0),
        ...write(0x7001, 0x99),
        0x4c,
        0,
        0x74,
      ],
      undefined,
      declaration,
    );
    expect(result.final_cpu.a).toBe(0x55);
    expect(result.instructions.at(-1)).toMatchObject({
      address: 0x7400,
      file_offsets: [null, null],
      ram_origins: [
        { ram_address: 0x7000, bank: 0 },
        { ram_address: 0x7001, bank: 0 },
      ],
    });
    expect(result.stop).toMatchObject({ reason: "return", address: 0x7402 });
  },
);

it("records zero-valued disabled-half operands independently of RAM writers", async () => {
  const result = await trace([
    ...enable,
    ...write(0x71ff, 0xa9),
    ...write(0xa001, 0x30),
    0x4c,
    0xff,
    0x71,
  ]);
  const instruction = result.instructions.find(
    (item) => item.address === 0x71ff,
  )!;
  expect(instruction).toMatchObject({
    bytes_hex: "a900",
    ram_origins: [{ byte_index: 0, ram_address: 0x71ff }],
    mapper_origins: [
      {
        byte_index: 1,
        kind: "mmc6-disabled-half",
        ram_address: 0x7200,
        bank_select: 0x20,
        ram_protect: 0x30,
      },
    ],
  });
  expect(result.final_cpu.a).toBe(0);
  expect(result.stop).toMatchObject({
    address: 0x7201,
    reason: "unknown-stack",
    bytes_hex: "00",
    ram_origins: [],
    mapper_origins: [{ byte_index: 0, ram_address: 0x7201 }],
  });
});

it("clears protect controls on master disable, ignores disabled control writes, and retains storage", async () => {
  const result = await trace([
    ...enable,
    ...write(0x7200, 0x55),
    ...write(0x8000, 0),
    ...write(0xa001, 0xf0),
    ...write(0x8000, 0x20),
    0xad,
    0,
    0x72,
    0x85,
    0x10,
    ...write(0xa001, 0xc0),
    0xad,
    0,
    0x72,
    0x60,
  ]);
  expect(result.instructions.flatMap((item) => item.writes)).toContainEqual({
    address: 16,
    value: null,
    preceded_by_cpu_write: false,
  });
  expect(result.final_cpu.a).toBe(0x55);
});

it.each([0x10, 0x40])(
  "write-only permissions %s never establish RAM contents",
  async (protect) => {
    const result = await trace([
      ...write(0x8000, 32),
      ...write(0xa001, protect),
      ...write(0x7000, 0x55),
      ...write(0x7200, 0x66),
      ...write(0xa001, 0xf0),
      0xad,
      0,
      protect === 0x10 ? 0x70 : 0x72,
      0x60,
    ]);
    expect(result.final_cpu.a).toBeNull();
  },
);

it.each([0x6000, 0x6fff])(
  "does not map MMC6 RAM below 7000 (%s)",
  async (address) => {
    const result = await trace([
      ...enable,
      ...write(address, 0x55),
      0xad,
      address & 255,
      address >> 8,
      0x60,
    ]);
    expect(result.final_cpu.a).toBeNull();
  },
);

it("does not resurrect inconsistent initial controls after enabling RAM", async () => {
  const result = await trace(
    [...write(0x8000, 32), ...write(0x7000, 0x55), 0xad, 0, 0x70, 0x60],
    { mapper: 4, bank_select: 0, ram_protect: 0xf0 },
  );
  expect(result.final_cpu.a).toBeNull();
});

it("zero readback does not erase the disabled half's retained bytes", async () => {
  const result = await trace([
    ...enable,
    ...write(0x7200, 0x66),
    ...write(0xa001, 0x30),
    0xad,
    0,
    0x7a,
    0x85,
    0x10,
    ...write(0x7e00, 0x99),
    ...write(0xa001, 0xf0),
    0xad,
    0,
    0x72,
    0x60,
  ]);
  expect(result.instructions.flatMap((item) => item.writes)).toContainEqual({
    address: 16,
    value: 0,
    preceded_by_cpu_write: false,
  });
  expect(result.final_cpu.a).toBe(0x66);
});

it.each([0x55, 0x66])(
  "joins RAM writes under unknown master control (%s)",
  async (value) => {
    const result = await trace([
      ...enable,
      ...write(0x7000, 0x55),
      0xad,
      2,
      0x20,
      0x8d,
      0,
      0x80,
      ...write(0x7000, value),
      ...enable,
      0xad,
      0,
      0x70,
      0x60,
    ]);
    expect(result.final_cpu.a).toBe(value === 0x55 ? 0x55 : null);
  },
);

it.each([7, 0x33])(
  "does not infer MMC6 RAM for contradictory capacity %s",
  async (declaration) => {
    const result = await trace(
      [...enable, ...write(0x7000, 0x55), 0xad, 0, 0x70, 0x60],
      undefined,
      declaration,
    );
    expect(result.final_cpu.a).toBeNull();
  },
);

it.each([
  { selector: { mask: 32, value: 32 }, expected: 0 },
  { selector: { mask: 32, value: 0 }, expected: null },
  { selector: { mask: 64, value: 0 }, expected: null },
])(
  "retains MMC6 master-enable proof with a partial selector: %j",
  async ({ selector, expected }) => {
    const result = await trace([0xad, 0, 0x72, 0x60], {
      mapper: 4,
      bank_select: selector,
      ram_protect: 0x30,
    });
    expect(result.final_cpu.a).toBe(expected);
    const read = result.instructions[0]!.data_reads[0]!;
    expect(read.value).toBe(expected);
    expect(read.mapper_origins).toEqual(
      expected === 0
        ? [
            {
              byte_index: 0,
              kind: "mmc6-disabled-half",
              ram_address: 0x7200,
              bank_select: selector,
              ram_protect: 0x30,
            },
          ]
        : [],
    );
  },
);

it.each([
  { mask: 160, value: 32 },
  { mask: 128, value: 0 },
  { mask: 32, value: 32 },
])(
  "requires both half-read proofs before deriving MMC6 zero %j",
  async (ram_protect) => {
    const result = await trace([0xad, 0, 0x72, 0x60], {
      mapper: 4,
      bank_select: { mask: 32, value: 32 },
      ram_protect,
    });
    expect(result.final_cpu.a).toBe(ram_protect.mask === 160 ? 0 : null);
  },
);
it("writes lower MMC6 RAM using only proven lower-half permissions", async () => {
  const result = await trace([...write(0x7000, 0x55), 0xad, 0, 0x70, 0x60], {
    mapper: 4,
    bank_select: { mask: 32, value: 32 },
    ram_protect: { mask: 48, value: 48 },
  });
  expect(result.final_cpu.a).toBe(0x55);
});

it("preserves disabled permission bits when an unknown master write may reset MMC6 RAM control", async () => {
  const result = await trace(
    [0xad, 2, 0x20, 0x8d, 0, 0x80, ...write(0x8000, 0x20), 0xad, 0, 0x72, 0x60],
    {
      mapper: 4,
      bank_select: { mask: 32, value: 32 },
      ram_protect: { mask: 240, value: 48 },
    },
  );
  if (result.mapper_trace.status !== "derived")
    throw new Error(result.mapper_trace.reason);
  expect(result.mapper_trace.final).toMatchObject({
    bank_select: 32,
    ram_protect: { mask: 192, value: 0 },
  });
  expect(result.final_cpu.a).toBeNull();
  const read = result.instructions.find((item) => item.bytes_hex === "ad0072")!;
  expect(read.data_reads[0]).toMatchObject({ value: null, mapper_origins: [] });
});

it("retains stored MMC6 RAM across uncertain master reset without inventing read authority", async () => {
  const result = await trace([
    ...enable,
    ...write(0x7000, 0x55),
    0xad,
    2,
    0x20,
    0x8d,
    0,
    0x80,
    ...write(0x8000, 0x20),
    0xad,
    0,
    0x70,
    ...write(0xa001, 0x30),
    0xad,
    0,
    0x70,
    0x60,
  ]);
  const reads = result.instructions.filter(
    (item) => item.bytes_hex === "ad0070",
  );
  expect(reads.map((item) => item.data_reads[0]?.value)).toEqual([null, 0x55]);
  expect(reads[0]?.data_reads[0]?.ram_origins).toEqual([]);
  expect(reads[1]?.data_reads[0]?.ram_origins).toMatchObject([
    { instruction_index: 5, ram_address: 0x7000 },
  ]);
  expect(result.final_cpu.a).toBe(0x55);
});
