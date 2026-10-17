import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import { nesPrgViewSchema, nesPrgViewsSchema } from "./nesPrgViews.js";
import { nesPrgRamLayout } from "./nesPrgRamLayout.js";
import { nesPrgRamAccess } from "./nesPrgRam.js";
import { nesVrc3StateSchema } from "./nesVrc3.js";

const cartridge = (
  prgSize = 131072,
  {
    legacy = false,
    trainer = false,
    flags = 0,
    submapper = 0,
    prgStorage = 0,
    chrStorage = 7,
    chrSize = 0,
    legacyRam = 0,
  }: {
    legacy?: boolean;
    trainer?: boolean;
    flags?: number;
    submapper?: number;
    prgStorage?: number;
    chrStorage?: number;
    chrSize?: number;
    legacyRam?: number;
  } = {},
) => {
  const bytes = Buffer.alloc(16);
  bytes.set([78, 69, 83, 26, prgSize / 16384, chrSize / 8192]);
  bytes[6] = 0x90 | (trainer ? 4 : 0) | flags;
  bytes[7] = 0x40 | (legacy ? 0 : 8);
  bytes[8] = legacy ? legacyRam : submapper << 4;
  bytes[10] = prgStorage;
  bytes[11] = chrStorage;
  const parsed = parseNesHeader(
    bytes,
    16 + (trainer ? 512 : 0) + prgSize + chrSize,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

it("maps both 16 KiB windows to a single source while preserving distinct raw PRG view identities", () => {
  const metadata = cartridge(16384, { trainer: true }),
    views = nesPrgViewsSchema.parse([
      { mapper: 73, prg_bank: 7 },
      { mapper: 73, prg_bank: 0 },
    ]),
    result = resolveNesMapperLayout(metadata, views);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.contexts.map((context) => context.state)).toEqual(views);
  expect(
    result.value.mappings.map(({ start, size, bank, fileOffset, role }) => [
      start,
      size,
      bank,
      fileOffset,
      role,
    ]),
  ).toEqual([
    [0x8000, 16384, 0, 528, "switchable"],
    [0xc000, 16384, 0, 528, "fixed"],
    [0x8000, 16384, 0, 528, "switchable"],
    [0xc000, 16384, 0, 528, "fixed"],
  ]);
});

it("uses every PRG address line at 128 KiB and records the default context as an assumption", () => {
  const metadata = cartridge(131072, { trainer: true }),
    result = resolveNesMapperLayout(metadata, [{ mapper: 73, prg_bank: 6 }]);
  if (!result.ok) throw new Error(result.error);
  expect(
    result.value.mappings.map(({ bank, fileOffset, role }) => [
      bank,
      fileOffset,
      role,
    ]),
  ).toEqual([
    [6, 98832, "switchable"],
    [7, 115216, "fixed"],
  ]);
  const defaults = resolveNesMapperLayout(metadata);
  if (!defaults.ok) throw new Error(defaults.error);
  expect(defaults.value.contexts).toEqual([
    {
      addressSpace: "NES_M73_P00",
      state: { mapper: 73, prg_bank: 0 },
      selection: "default-assumption",
    },
  ]);
  for (const invalid of [
    { mapper: 73, prg_bank: 8 },
    { mapper: 73, prg_bank: -1 },
    { mapper: 73, prg_bank: 0.5 },
    { mapper: 73, prg_bank: 0, variant: "vrc4" },
    { mapper: 73, prg_bank: 0, prg_mode: 0 },
  ])
    expect(nesPrgViewSchema.safeParse(invalid).success).toBe(false);
});

it("resolves small-ROM physical aliases without inventing missing low-three-bit logical selectors", () => {
  const metadata = cartridge(32768, { trainer: true }),
    partial = nesVrc3StateSchema.parse({
      mapper: 73,
      prg_bank: { mask: 1, value: 1 },
    }),
    physical = mapperMapping(metadata, partial);
  expect(physical.prg_windows).toEqual([
    { start: 0x8000, size: 16384, bank: 1, file_offset: 16912 },
    { start: 0xc000, size: 16384, bank: 1, file_offset: 16912 },
  ]);
  expect(physical.prg_view).toBeNull();
  const logical = mapperMapping(
    metadata,
    nesVrc3StateSchema.parse({
      mapper: 73,
      prg_bank: { mask: 7, value: 7 },
    }),
  );
  expect(logical.prg_windows).toEqual(physical.prg_windows);
  expect(logical.prg_view).toEqual({ mapper: 73, prg_bank: 7 });
  expect(
    mapperMapping(
      metadata,
      nesVrc3StateSchema.parse({ mapper: 73, prg_bank: 0xf9 }),
    ).prg_view,
  ).toEqual({ mapper: 73, prg_bank: 1 });
});

it.each([0, 1])(
  "keeps CHR unbanked and header mirroring fixed despite raw IRQ and PRG writes (H/V flag %i)",
  (flags) => {
    const metadata = cartridge(131072, { flags }),
      state = nesVrc3StateSchema.parse({
        mapper: 73,
        prg_bank: 255,
        irq_latch_nibbles: [255, 128, 64, 32],
        irq_control: 255,
      }),
      mapping = mapperMapping(metadata, state, { chrRamSize: 8192 });
    expect(mapping.chr_source).toBe("ram-assumed");
    expect(mapping.chr_windows).toEqual([
      { start: 0, size: 8192, bank: 0, file_offset: null },
    ]);
    expect(mapping.mirroring).toBe(flags === 0 ? "horizontal" : "vertical");
  },
);

it("admits only the declared conventional capacities without changing rejected metadata", () => {
  for (const prgSize of [16384, 32768, 65536, 131072])
    expect(resolveNesMapperLayout(cartridge(prgSize)).ok).toBe(true);
  for (const chrStorage of [7, 0x70])
    expect(resolveNesMapperLayout(cartridge(131072, { chrStorage })).ok).toBe(
      true,
    );
  for (const metadata of [
    cartridge(49152),
    cartridge(262144),
    cartridge(131072, { chrSize: 8192 }),
    ...[0, 6, 8, 0x66, 0x80].map((chrStorage) =>
      cartridge(131072, { chrStorage }),
    ),
    ...[6, 8, 0x66, 0x80].map((prgStorage) =>
      cartridge(131072, { prgStorage }),
    ),
    cartridge(131072, { flags: 8 }),
    cartridge(131072, { submapper: 1 }),
  ]) {
    const before = structuredClone(metadata);
    expect(resolveNesMapperLayout(metadata).ok).toBe(false);
    expect(metadata).toEqual(before);
  }
});

it.each([7, 0x70])(
  "qualifies a single fixed 8 KiB PRG RAM/NVRAM chip without PRG or IRQ permission gates (storage byte %i)",
  (prgStorage) => {
    const metadata = cartridge(131072, { prgStorage });
    expect(resolveNesMapperLayout(metadata).ok).toBe(true);
    for (const prg_bank of [0, 255, null, { mask: 7, value: 3 }]) {
      const state = nesVrc3StateSchema.parse({
        mapper: 73,
        prg_bank,
        irq_control: null,
      });
      expect(nesPrgRamLayout(metadata, state)).toEqual({
        start: 0x6000,
        bank_size: 8192,
        bank_count: 1,
      });
      for (const address of [0x6000, 0x7fff])
        expect(nesPrgRamAccess(metadata, state, address)).toEqual({
          readable: true,
          writable: true,
          banks: [0],
        });
    }
  },
);

it("preserves legacy storage unknowns and requires explicit PPU backing for retained CHR bytes", () => {
  const metadata = cartridge(131072, {
      legacy: true,
      trainer: true,
      flags: 3,
      legacyRam: 1,
    }),
    before = structuredClone(metadata),
    state = nesVrc3StateSchema.parse({ mapper: 73, prg_bank: 7 }),
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
  });
  expect(metadata.header[8]).toBe(1);
  expect(nesPrgRamLayout(metadata, state)).toBeNull();
  expect(nesPrgRamAccess(metadata, state, 0x6000)).toBeNull();
  expect(mapperMapping(metadata, state).chr_source).toBe("ram-unobserved");
  expect(
    mapperMapping(metadata, state, { chrRamSize: 8192 }).chr_windows,
  ).toEqual([{ start: 0, size: 8192, bank: 0, file_offset: null }]);
  expect(metadata).toEqual(before);
  expect(nesPrgRamLayout(cartridge(), state)).toBeNull();
  expect(nesPrgRamAccess(cartridge(), state, 0x6000)).toBeNull();
});
