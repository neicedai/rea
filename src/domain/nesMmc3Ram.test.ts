import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { expect, it } from "vitest";
import type { NesByteValue } from "./nesByteValue.js";

import { mmc3RamCodeFixture } from "./nesCode.fixture.js";

const trace = async (
  fixture: ReturnType<typeof mmc3RamCodeFixture>,
  ramProtect: NesByteValue = 128,
  initialPrgRam: { bank: number; address: number; value: number }[] = [],
) => {
  const { trace: result } = await deriveNesFixtureTrace(
    fixture.bytes,
    fixture.bytes.subarray(
      fixture.prgOffset,
      fixture.prgOffset + fixture.prgSize,
    ),
    {
      path: "/mmc3.nes",
      initial_prg_ram: initialPrgRam,
      initial: { mapper: 4, ram_protect: ramProtect },
    },
  );
  return result;
};

it("preserves MMC3 RAM through protected RMW, disable/re-enable and PRG mode changes", async () => {
  const fixture = mmc3RamCodeFixture([
    0xa9, 0xa9, 0x8d, 0, 0x60, 0xa9, 0x55, 0x8d, 1, 0x60, 0xa9, 0x60, 0x8d, 2,
    0x60, 0xa9, 0xc0, 0x8d, 1, 0xa0, 0xee, 1, 0x60, 0xa9, 0, 0x8d, 0xff, 0xbf,
    0xa9, 0x77, 0x8d, 1, 0x60, 0xad, 1, 0x60, 0x85, 0x10, 0xa9, 0x80, 0x8d, 1,
    0xa0, 0xa9, 0x46, 0x8d, 0, 0x80, 0x4c, 0, 0x60,
  ]);
  const result = await trace(fixture);
  expect(
    result.instructions.find((instruction) => instruction.mnemonic === "INC")
      ?.writes,
  ).toMatchObject([{ value: 0x55 }, { value: 0x56 }]);
  expect(
    result.instructions.flatMap((instruction) => instruction.writes),
  ).toContainEqual({ address: 16, value: null, preceded_by_cpu_write: false });
  expect(result.instructions.at(-1)).toMatchObject({
    address: 0x6000,
    bytes_hex: "a955",
    ram_origins: [
      { region: "prg-ram", instruction_index: 1, ram_address: 0x6000 },
      { region: "prg-ram", instruction_index: 3, ram_address: 0x6001 },
    ],
  });
  expect(result.final_cpu.a).toBe(0x55);
  expect(result.stop).toMatchObject({ reason: "return", address: 0x6002 });
});

it.each([0x60, 0x02, null])(
  "joins an uncertain RAM write of %s with the retained value",
  async (value) => {
    const fixture = mmc3RamCodeFixture([
      0xa9,
      0x60,
      0x8d,
      0,
      0x60,
      0xad,
      2,
      0x20,
      0x8d,
      1,
      0xa0,
      ...(value === null ? [0xad, 2, 0x20] : [0xa9, value]),
      0x8d,
      0,
      0x60,
      0xa9,
      0x80,
      0x8d,
      1,
      0xa0,
      0x4c,
      0,
      0x60,
    ]);
    const result = await trace(fixture);
    expect(result.stop).toMatchObject({
      address: 0x6000,
      reason: value === 0x60 ? "return" : "unmapped-instruction",
    });
    if (value === 0x60)
      expect(result.stop.ram_origins).toMatchObject([
        { region: "prg-ram", instruction_index: 1, write_index: 0 },
      ]);
  },
);

it.each([null, 0, 0x40, 0xc0])(
  "does not establish new RAM bytes under control %s",
  async (control) => {
    const result = await trace(
      mmc3RamCodeFixture([
        0xa9, 0x60, 0x8d, 0, 0x60, 0xa9, 0x80, 0x8d, 1, 0xa0, 0x4c, 0, 0x60,
      ]),
      control,
    );
    expect(result.stop).toMatchObject({
      reason: "unmapped-instruction",
      address: 0x6000,
    });
  },
);

it("does not expose a retained byte while RAM readability is unknown", async () => {
  const result = await trace(
    mmc3RamCodeFixture([
      0xa9, 0x60, 0x8d, 0, 0x60, 0xad, 2, 0x20, 0x8d, 1, 0xa0, 0x4c, 0, 0x60,
    ]),
  );
  expect(result.stop).toMatchObject({
    reason: "unmapped-instruction",
    address: 0x6000,
    ram_origins: [],
  });
});

it.each([7, 0x70, 0, 8, 0x66])(
  "requires one declared 8 KiB RAM region, declaration=%s",
  async (declaration) => {
    const result = await trace(
      mmc3RamCodeFixture(
        [0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60],
        declaration,
      ),
    );
    expect(result.final_cpu.a).toBe(
      declaration === 7 || declaration === 0x70 ? 0x55 : null,
    );
  },
);

it("does not infer MMC3 RAM capacity from a legacy header", async () => {
  const fixture = mmc3RamCodeFixture([
    0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60,
  ]);
  fixture.bytes[7] = 0;
  fixture.bytes[10] = 0;
  expect((await trace(fixture)).final_cpu.a).toBeNull();
});

it.each([3, 4])(
  "keeps RAM authority specific to MMC3 variant %i",
  async (submapper) => {
    const fixture = mmc3RamCodeFixture([
      0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60,
    ]);
    fixture.bytes[8] = submapper << 4;
    const result = await trace(fixture);
    expect(result.final_cpu.a).toBe(submapper === 3 ? null : 0x55);
    expect(result.stop.reason).toBe("return");
  },
);

it("uses proven MMC3 enable and protection bits without requiring unrelated bits", async () => {
  const result = await trace(
    mmc3RamCodeFixture([0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60]),
    { mask: 192, value: 128 },
  );
  expect(result.final_cpu.a).toBe(0x55);
});
it.each([
  { mask: 64, value: 64 },
  { mask: 128, value: 128 },
])(
  "retains only RAM facts justified by partial protection %j",
  async (control) => {
    const result = await trace(
      mmc3RamCodeFixture([
        0xa9, 0x77, 0x8d, 0, 0x60, 0xa9, 0x80, 0x8d, 1, 0xa0, 0xad, 0, 0x60,
        0x60,
      ]),
      control,
      [{ bank: 0, address: 0x6000, value: 0x55 }],
    );
    expect(result.final_cpu.a).toBe(control.mask === 64 ? 0x55 : null);
  },
);
