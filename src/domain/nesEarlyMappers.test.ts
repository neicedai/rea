import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { nesPrgViewSchema, nesPrgViewsSchema } from "./nesPrgViews.js";

const cartridge = (
  mapper: 76 | 87,
  prgSize: number,
  chrSize: number,
  {
    nes2 = false,
    trainer = false,
    flags = 0,
    submapper = 0,
    prgStorage = 0,
    chrStorage = 0,
    legacyRam = 0,
  }: {
    nes2?: boolean;
    trainer?: boolean;
    flags?: number;
    submapper?: number;
    prgStorage?: number;
    chrStorage?: number;
    legacyRam?: number;
  } = {},
) => {
  const bytes = Buffer.alloc(16);
  bytes.set([78, 69, 83, 26, prgSize / 16384, chrSize / 8192]);
  bytes[6] = ((mapper & 15) << 4) | (trainer ? 4 : 0) | flags;
  bytes[7] = (mapper & 240) | (nes2 ? 8 : 0);
  bytes[8] = nes2 ? submapper << 4 : legacyRam;
  bytes[10] = prgStorage;
  bytes[11] = chrStorage;
  const parsed = parseNesHeader(
    bytes,
    16 + (trainer ? 512 : 0) + prgSize + chrSize,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

it.each([16384, 32768])(
  "maps J87's fixed %i-byte PRG with original trainer offsets and no selectable PRG contexts",
  (prgSize) => {
    const metadata = cartridge(87, prgSize, 32768, { trainer: true }),
      result = resolveNesMapperLayout(metadata);
    if (!result.ok) throw new Error(result.error);
    const primary = {
      name: "NES_PRG_ROM",
      addressSpace: "RAM",
      start: 0x8000,
      size: prgSize,
      fileOffset: 528,
      bank: 0,
      role: "fixed",
    };
    expect(result.value.board).toBe("J87");
    expect(result.value.contexts).toEqual([]);
    expect(result.value.mappings).toEqual(
      prgSize === 16384
        ? [
            primary,
            {
              ...primary,
              name: "NES_PRG_ROM_MIRROR",
              start: 0xc000,
              role: "mirror",
            },
          ]
        : [primary],
    );
    expect(resolveNesMapperLayout(metadata, [])).toMatchObject({
      ok: false,
      error: expect.stringContaining("target declares Mapper 87"),
    });
    expect(
      resolveNesMapperLayout(metadata, [{ mapper: 76, r6: 0, r7: 1 }]),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("target declares Mapper 87"),
    });
    expect(
      nesPrgViewSchema.safeParse({ mapper: 87, prg_bank: 0 }).success,
    ).toBe(false);
  },
);

it("keeps distinct Mapper 76 raw views while resolving all four 8 KiB windows on a 16 KiB ROM", () => {
  const metadata = cartridge(76, 16384, 131072, { trainer: true, nes2: true }),
    input = [
      { mapper: 76, r6: 15, r7: 14 },
      { mapper: 76, r6: 1, r7: 0 },
    ],
    before = structuredClone(input),
    views = nesPrgViewsSchema.parse(input),
    result = resolveNesMapperLayout(metadata, views);
  if (!result.ok) throw new Error(result.error);
  expect(input).toEqual(before);
  expect(result.value.contexts).toEqual([
    {
      addressSpace: "NES_M76_R01_S00",
      state: { mapper: 76, r6: 1, r7: 0 },
      selection: "caller-selected",
    },
    {
      addressSpace: "NES_M76_R0f_S0e",
      state: { mapper: 76, r6: 15, r7: 14 },
      selection: "caller-selected",
    },
  ]);
  const windows = result.value.mappings.map(
      ({ start, size, bank, fileOffset, role }) => ({
        start,
        size,
        bank,
        fileOffset,
        role,
      }),
    ),
    expected = [
      {
        start: 0x8000,
        size: 8192,
        bank: 1,
        fileOffset: 8720,
        role: "switchable",
      },
      {
        start: 0xa000,
        size: 8192,
        bank: 0,
        fileOffset: 528,
        role: "switchable",
      },
      { start: 0xc000, size: 8192, bank: 0, fileOffset: 528, role: "fixed" },
      { start: 0xe000, size: 8192, bank: 1, fileOffset: 8720, role: "fixed" },
    ];
  expect(windows).toEqual([...expected, ...expected]);
  expect(nesPrgViewsSchema.safeParse([views[0], views[0]]).success).toBe(false);
});

it("retains every connected Mapper 76 PRG/CHR line at 128 KiB and rejects expanded capacities", () => {
  const metadata = cartridge(76, 131072, 131072, { trainer: true, nes2: true }),
    views = nesPrgViewsSchema.parse([{ mapper: 76, r6: 15, r7: 14 }]),
    result = resolveNesMapperLayout(metadata, views);
  if (!result.ok) throw new Error(result.error);
  expect(result.value).toMatchObject({
    board: "Namco 109 / 3446",
    bankSize: 8192,
    prgBanks: 16,
    chrBanks: 16,
  });
  expect(result.value.contexts[0]?.state).toEqual({
    mapper: 76,
    r6: 15,
    r7: 14,
  });
  expect(
    result.value.mappings.map(({ bank, fileOffset, role }) => [
      bank,
      fileOffset,
      role,
    ]),
  ).toEqual([
    [15, 123408, "switchable"],
    [14, 115216, "switchable"],
    [14, 115216, "fixed"],
    [15, 123408, "fixed"],
  ]);
  expect(
    resolveNesMapperLayout(cartridge(76, 262144, 131072, { nes2: true })),
  ).toMatchObject({ ok: false, error: expect.stringContaining("PRG ROM") });
  expect(
    resolveNesMapperLayout(cartridge(76, 131072, 262144, { nes2: true })),
  ).toMatchObject({ ok: false, error: expect.stringContaining("CHR ROM") });
  for (const invalid of [
    { mapper: 76, r6: 16, r7: 0 },
    { mapper: 76, r6: 0, r7: -1 },
    { mapper: 76, r6: 0.5, r7: 0 },
    { mapper: 76, r6: 0 },
    { mapper: 76, r6: 0, r7: 1, prg_mode: 1 },
  ])
    expect(nesPrgViewSchema.safeParse(invalid).success).toBe(false);
});

it.each([76, 87] as const)(
  "rejects explicit RAM/CHR-RAM, four-screen and unsupported submappers for Mapper %s without rewriting metadata",
  (mapper) => {
    const valid = cartridge(mapper, 32768, 8192, { nes2: true });
    expect(resolveNesMapperLayout(valid).ok).toBe(true);
    const declarations = [
      cartridge(mapper, 32768, 8192, { nes2: true, prgStorage: 7 }),
      cartridge(mapper, 32768, 8192, { nes2: true, prgStorage: 0x70 }),
      cartridge(mapper, 32768, 8192, { nes2: true, chrStorage: 7 }),
      cartridge(mapper, 32768, 8192, { nes2: true, chrStorage: 0x70 }),
    ];
    for (const metadata of declarations) {
      const before = structuredClone(metadata);
      expect(resolveNesMapperLayout(metadata)).toMatchObject({
        ok: false,
        error: expect.stringContaining("RAM/NVRAM"),
      });
      expect(metadata).toEqual(before);
    }
    expect(
      resolveNesMapperLayout(cartridge(mapper, 32768, 0, { nes2: true })),
    ).toMatchObject({ ok: false, error: expect.stringContaining("CHR ROM") });
    expect(
      resolveNesMapperLayout(
        cartridge(mapper, 32768, 8192, { nes2: true, flags: 8 }),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("four-screen"),
    });
    expect(
      resolveNesMapperLayout(
        cartridge(mapper, 32768, 8192, { nes2: true, submapper: 1 }),
      ),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("submapper 1"),
    });
    if (mapper === 87) {
      expect(resolveNesMapperLayout(cartridge(87, 65536, 8192))).toMatchObject({
        ok: false,
        error: expect.stringContaining("PRG ROM"),
      });
      expect(resolveNesMapperLayout(cartridge(87, 32768, 65536))).toMatchObject(
        { ok: false, error: expect.stringContaining("CHR ROM") },
      );
    }
  },
);

it.each([76, 87] as const)(
  "preserves legacy header, mirroring and unknown RAM facts while deriving Mapper %s ROM mappings",
  (mapper) => {
    const metadata = cartridge(mapper, 32768, 8192, { flags: 3, legacyRam: 3 }),
      before = structuredClone(metadata),
      result = resolveNesMapperLayout(metadata);
    if (!result.ok) throw new Error(result.error);
    expect(metadata).toEqual(before);
    expect(metadata).toMatchObject({
      headerVersion: "ines",
      submapper: null,
      battery: true,
      mirroring: "vertical",
      prgRamSize: null,
      prgNvramSize: null,
      chrRamSize: null,
      chrNvramSize: null,
      prgRom: { offset: 16, size: 32768 },
      chrRom: { offset: 32784, size: 8192 },
    });
    expect(metadata.header[8]).toBe(3);
    expect(
      result.value.mappings.every((mapping) => mapping.fileOffset >= 16),
    ).toBe(true);
  },
);
