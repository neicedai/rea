import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { nesPrgViewSchema, nesPrgViewsSchema } from "./nesPrgViews.js";
import { nesSunsoft4StateSchema } from "./nesSunsoft4.js";
import { nesBoardSelection } from "./nesBoardSelection.js";
import { nesPrgRamLayout } from "./nesPrgRamLayout.js";
import { nesPrgRamAccess } from "./nesPrgRam.js";
import type { NesByteValue } from "./nesByteValue.js";

const cartridge = (
  prgSize = 131072,
  chrSize = 262144,
  {
    legacy = false,
    trainer = false,
    submapper = 0,
    flags = 0,
    prgStorage = 0,
    chrStorage = 0,
    legacyRam = 0,
  }: {
    legacy?: boolean;
    trainer?: boolean;
    submapper?: number;
    flags?: number;
    prgStorage?: number;
    chrStorage?: number;
    legacyRam?: number;
  } = {},
) => {
  const bytes = Buffer.alloc(16);
  bytes.set([78, 69, 83, 26, prgSize / 16384, chrSize / 8192]);
  bytes[6] = 0x40 | (trainer ? 4 : 0) | flags;
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
const normal = { family: "sunsoft4", variant: "normal" } as const;

it("uses NES 2.0 submapper 0 to qualify a normal default context without claiming reset state", () => {
  const metadata = cartridge(),
    result = resolveNesMapperLayout(metadata);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.contexts).toEqual([
    {
      addressSpace: "NES_M68_NORMAL_P00",
      state: { mapper: 68, variant: "normal", prg_bank: 0 },
      selection: "default-assumption",
    },
  ]);
  expect(result.value.limitations).toContainEqual(
    expect.stringContaining(
      "convenience choices, not hardware reset guarantees",
    ),
  );
  for (const invalid of [
    { mapper: 68, prg_bank: 0 },
    { mapper: 68, variant: "dual-cart", prg_bank: 0 },
    { mapper: 68, variant: "normal", prg_bank: 16 },
    { mapper: 68, variant: "normal", prg_bank: 1, prg_mode: 0 },
  ])
    expect(nesPrgViewSchema.safeParse(invalid).success).toBe(false);
});

it("requires an explicit normal choice for every supported ambiguous legacy size and preserves original observations", () => {
  for (const prgSize of [16384, 32768, 65536, 131072]) {
    const metadata = cartridge(prgSize, 131072, {
        legacy: true,
        trainer: true,
        flags: 3,
        legacyRam: 3,
      }),
      before = structuredClone(metadata);
    expect(resolveNesMapperLayout(metadata)).toMatchObject({
      ok: false,
      error: expect.stringContaining("does not distinguish"),
    });
    const selected = resolveNesMapperLayout(metadata, [
      { mapper: 68, variant: "normal", prg_bank: 15 },
    ]);
    if (!selected.ok) throw new Error(selected.error);
    const state = nesSunsoft4StateSchema.parse({
        mapper: 68,
        variant: "normal",
      }),
      selectedFromState = resolveNesMapperLayout(
        metadata,
        undefined,
        nesBoardSelection(state),
      );
    expect(selectedFromState.ok).toBe(true);
    expect(selected.value.contexts[0]).toMatchObject({
      state: { mapper: 68, variant: "normal", prg_bank: 15 },
      selection: "caller-selected",
    });
    expect(selected.value.limitations).toContainEqual(
      expect.stringContaining("Caller-selected normal Sunsoft 4 wiring"),
    );
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
    expect(metadata.header[8]).toBe(3);
    expect(metadata.prgRom.offset).toBe(528);
  }
});

it("qualifies a 256 KiB legacy capacity explicitly in limitations and never overrides Dual Cartridge System headers", () => {
  const metadata = cartridge(262144, 262144, { legacy: true }),
    before = structuredClone(metadata),
    result = resolveNesMapperLayout(metadata);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.contexts[0]?.state).toEqual({
    mapper: 68,
    variant: "normal",
    prg_bank: 0,
  });
  expect(result.value.limitations).toContainEqual(
    expect.stringContaining(
      "capacity-based interpretation, not an observation",
    ),
  );
  expect(metadata).toEqual(before);
  const dual = cartridge(131072, 131072, { submapper: 1 });
  for (const result of [
    resolveNesMapperLayout(dual),
    resolveNesMapperLayout(dual, [
      { mapper: 68, variant: "normal", prg_bank: 0 },
    ]),
    resolveNesMapperLayout(dual, undefined, normal),
  ])
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("Dual Cartridge System"),
    });
});

it("retains distinct raw selectors for 16 KiB aliases and maps normal 256 KiB fixed bank 15", () => {
  const small = cartridge(16384, 8192, { trainer: true }),
    views = nesPrgViewsSchema.parse([
      { mapper: 68, variant: "normal", prg_bank: 15 },
      { mapper: 68, variant: "normal", prg_bank: 0 },
    ]),
    aliases = resolveNesMapperLayout(small, views);
  if (!aliases.ok) throw new Error(aliases.error);
  expect(aliases.value.contexts.map((context) => context.state)).toEqual(views);
  expect(
    aliases.value.mappings.map(({ start, size, bank, fileOffset, role }) => [
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
  const maximum = resolveNesMapperLayout(
    cartridge(262144, 262144, { trainer: true }),
    [{ mapper: 68, variant: "normal", prg_bank: 9 }],
  );
  if (!maximum.ok) throw new Error(maximum.error);
  expect(
    maximum.value.mappings.map(({ bank, fileOffset, role }) => [
      bank,
      fileOffset,
      role,
    ]),
  ).toEqual([
    [9, 147984, "switchable"],
    [15, 246288, "fixed"],
  ]);
});

it("admits conventional CHR capacities and rejects unsupported ROM, storage and four-screen declarations", () => {
  for (const chrSize of [8192, 16384, 32768, 65536, 131072, 262144])
    expect(resolveNesMapperLayout(cartridge(262144, chrSize)).ok).toBe(true);
  for (const metadata of [
    cartridge(524288),
    cartridge(16384, 0),
    cartridge(16384, 524288),
    cartridge(16384, 8192, { chrStorage: 7 }),
    cartridge(16384, 8192, { chrStorage: 0x70 }),
    cartridge(16384, 8192, { prgStorage: 8 }),
    cartridge(16384, 8192, { prgStorage: 0x80 }),
    cartridge(16384, 8192, { prgStorage: 0x66 }),
    cartridge(16384, 8192, { flags: 8 }),
    cartridge(16384, 8192, { submapper: 2 }),
  ]) {
    const before = structuredClone(metadata);
    expect(resolveNesMapperLayout(metadata).ok).toBe(false);
    expect(metadata).toEqual(before);
  }
});

it.each([7, 0x70])(
  "keeps a declared single 8 KiB RAM/NVRAM chip separate from F000 D4 permissions (storage byte %i)",
  (prgStorage) => {
    const metadata = cartridge(131072, 131072, { prgStorage });
    expect(resolveNesMapperLayout(metadata).ok).toBe(true);
    const cases: readonly (readonly [NesByteValue, boolean | null])[] = [
      [31, true],
      [15, false],
      [null, null],
      [{ mask: 16, value: 16 }, true],
      [{ mask: 16, value: 0 }, false],
      [{ mask: 15, value: 15 }, null],
    ];
    for (const [prg_bank, permitted] of cases) {
      const state = nesSunsoft4StateSchema.parse({
        mapper: 68,
        variant: "normal",
        prg_bank,
      });
      expect(nesPrgRamLayout(metadata, state)).toEqual({
        start: 0x6000,
        bank_size: 8192,
        bank_count: 1,
      });
      for (const address of [0x6000, 0x7fff])
        expect(nesPrgRamAccess(metadata, state, address)).toEqual({
          readable: permitted,
          writable: permitted,
          banks: [0],
        });
    }
  },
);

it("preserves legacy unknown RAM even with battery/size hints and a proven enabled F000 bit", () => {
  const metadata = cartridge(131072, 131072, {
      legacy: true,
      flags: 2,
      legacyRam: 1,
    }),
    state = nesSunsoft4StateSchema.parse({
      mapper: 68,
      variant: "normal",
      prg_bank: 16,
    });
  expect(resolveNesMapperLayout(metadata, undefined, normal).ok).toBe(true);
  expect(nesPrgRamLayout(metadata, state)).toBeNull();
  expect(nesPrgRamAccess(metadata, state, 0x6000)).toBeNull();
  expect(nesPrgRamAccess(cartridge(), state, 0x6000)).toBeNull();
  expect(metadata).toMatchObject({
    battery: true,
    prgRamSize: null,
    prgNvramSize: null,
  });
  expect(metadata.header[8]).toBe(1);
});
