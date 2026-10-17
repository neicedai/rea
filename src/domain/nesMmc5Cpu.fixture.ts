import { mmc5Fixture } from "./nesMmc5.fixture.js";

const cartridge = (
  name: string,
  program: readonly number[],
  initial: Record<string, unknown>,
  entry = 0xe000,
  stop = "return",
  a: number | null = 0x55,
) => {
  const fixture = mmc5Fixture(0);
  fixture.bytes.set(program, fixture.prgOffset + 7 * 8192);
  fixture.bytes.set([0xa9, 0x55, 0x60], fixture.prgOffset);
  return {
    ...fixture,
    name,
    input: {
      entry,
      initial: {
        mapper: 5,
        prg_mode: 3,
        prg_banks: [0, 128, 129, 130, 7],
        ram_wiring: "none",
        ...initial,
      },
    },
    stop,
    a,
  };
};

export const mmc5CpuFixtures = () => {
  const code = [
    0xa9, 3, 0x8d, 4, 0x51, 0xee, 0x40, 0x5c, 0xa9, 0x83, 0x8d, 0x15, 0x51,
    0x4c, 0x10, 0xa0,
  ];
  const devices = cartridge(
    "devices",
    [
      0xa9, 3, 0x8d, 5, 0x52, 0xa9, 5, 0x8d, 6, 0x52, 0xee, 5, 0x52, 0xad, 5,
      0x52, 0x4a, 0x4a, 0x4a, 0x4a, 0x09, 0x80, 0x8d, 0x14, 0x51, 0x4c, 0, 0x80,
    ],
    {},
    0xe000,
    "return",
    0x77,
  );
  devices.bytes.set(
    [
      0xa9,
      2,
      0x8d,
      4,
      0x51,
      ...code.flatMap((value, index) => [
        0xa9,
        value,
        0x8d,
        0x40 + index,
        0x5c,
      ]),
      0x4c,
      0x40,
      0x5c,
    ],
    devices.prgOffset + 5 * 8192,
  );
  devices.bytes.set(
    [0xad, 6, 0x52, 0xf0, 1, 0x02, 0xa9, 0x77, 0x60],
    devices.prgOffset + 3 * 8192 + 16,
  );
  const full = Object.fromEntries(
    Array.from({ length: 1024 }, (_, address) => [
      String(address),
      address & 255,
    ]),
  );
  Object.assign(full, { "0": 0xa9, "1": 0x55, "2": 0x60 });
  return [
    devices,
    cartridge(
      "partial-product",
      [0xad, 5, 0x52, 0x29, 3, 0xf0, 1, 0x02, 0x4c, 0, 0x80],
      {
        multiplier: [
          { mask: 1, value: 0 },
          { mask: 1, value: 0 },
        ],
      },
    ),
    cartridge(
      "cleared-proof",
      [0xad, 5, 0x52, 0xad, 2, 0x20, 0x29, 3, 0xf0, 1, 0x60, 0x60],
      {
        multiplier: [
          { mask: 1, value: 0 },
          { mask: 1, value: 0 },
        ],
      },
      0xe000,
      "unknown-branch",
      null,
    ),
    cartridge(
      "uncertain-ram",
      [
        0xa9, 0xa7, 0x8d, 0, 0x5c, 0xad, 0, 0x5c, 0x29, 1, 0xf0, 3, 0x4c, 0,
        0x80, 0x60,
      ],
      {
        exram_mode: { mask: 2, value: 2 },
        exram_written: true,
        exram: { "0": 0xa5 },
      },
    ),
    cartridge(
      "restricted-ram",
      [
        0xa9, 0xa7, 0x8d, 0, 0x5c, 0xa9, 2, 0x8d, 4, 0x51, 0xad, 0, 0x5c, 0x29,
        1, 0xf0, 1, 0x60, 0x60,
      ],
      { exram_mode: 1, exram: { "0": 0xa5 } },
      0xe000,
      "unknown-branch",
      null,
    ),
    cartridge("all-cells", [], { exram_mode: 2, exram: full }, 0x5c00),
  ];
};
