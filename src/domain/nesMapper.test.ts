import { describe, expect, it } from "vitest";
import { parseNesHeader, type NesRomMetadata } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import type { NesPrgView } from "./nesPrgViews.js";

const cartridge = (
  mapper: number,
  prgSize: number,
  chrSize: number,
  options: { trainer?: boolean; submapper?: number } = {},
): NesRomMetadata => {
  const header = Buffer.alloc(16);
  header.set([0x4e, 0x45, 0x53, 0x1a, prgSize / 0x4000, chrSize / 0x2000]);
  header[6] = ((mapper & 15) << 4) | (options.trainer ? 4 : 0);
  header[7] = (mapper & 0xf0) | (options.submapper === undefined ? 0 : 8);
  header[8] = (options.submapper ?? 0) << 4;
  const parsed = parseNesHeader(
    header,
    16 + (options.trainer ? 512 : 0) + prgSize + chrSize,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

it("retains all H3001 address lines at the maximum physical ROM capacities", () => {
  const metadata = cartridge(65, 524288, 262144, {
    trainer: true,
    submapper: 0,
  });
  const view: NesPrgView = {
    mapper: 65,
    prg_mode: 1,
    prg_bank_0: 63,
    prg_bank_1: 61,
  };
  const result = resolveNesMapperLayout(metadata, [view]);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.contexts).toEqual([
    {
      addressSpace: "NES_M65_M1_P3f_Q3d",
      state: view,
      selection: "caller-selected",
    },
  ]);
  expect(
    result.value.mappings.map(({ bank, fileOffset, role }) => [
      bank,
      fileOffset,
      role,
    ]),
  ).toEqual([
    [62, 528 + 62 * 8192, "fixed"],
    [61, 528 + 61 * 8192, "switchable"],
    [63, 528 + 63 * 8192, "switchable"],
    [63, 528 + 63 * 8192, "fixed"],
  ]);
});

it("rejects unsupported H3001 capacity, storage and board declarations before import", () => {
  const header = cartridge(65, 32768, 8192, { submapper: 0 });
  for (const invalid of [
    cartridge(65, 16384, 8192),
    cartridge(65, 1048576, 8192),
    cartridge(65, 32768, 0),
    cartridge(65, 32768, 524288),
    { ...header, submapper: 1 },
    { ...header, mirroring: "four-screen" as const },
    { ...header, chrRamSize: 8192 },
    { ...header, chrNvramSize: 8192 },
    { ...header, prgRamSize: 16384 },
    { ...header, prgRamSize: 4096, prgNvramSize: 4096 },
  ])
    expect(resolveNesMapperLayout(invalid).ok).toBe(false);
  for (const [prgRamSize, prgNvramSize] of [
    [0, 0],
    [8192, 0],
    [0, 8192],
  ] as const)
    expect(
      resolveNesMapperLayout({ ...header, prgRamSize, prgNvramSize }).ok,
    ).toBe(true);
});

it("keeps Sunsoft 3 selectors distinct from single-bank aliases and admits every connected PRG address line", () => {
  for (const size of [16384, 262144]) {
    const metadata = cartridge(67, size, 131072, {
      trainer: true,
      submapper: 0,
    });
    const result = resolveNesMapperLayout(metadata, [
      { mapper: 67, prg_bank: 15 },
    ]);
    if (!result.ok) throw new Error(result.error);
    const bank = size === 16384 ? 0 : 15;
    expect(result.value.contexts).toEqual([
      {
        addressSpace: "NES_M67_P0f",
        state: { mapper: 67, prg_bank: 15 },
        selection: "caller-selected",
      },
    ]);
    expect(
      result.value.mappings.map(({ start, size, bank, fileOffset, role }) => [
        start,
        size,
        bank,
        fileOffset,
        role,
      ]),
    ).toEqual([
      [0x8000, 16384, bank, 528 + bank * 16384, "switchable"],
      [0xc000, 16384, bank, 528 + bank * 16384, "fixed"],
    ]);
    for (const invalid of [
      { ...metadata, prgRom: { ...metadata.prgRom, size: 8192 } },
      cartridge(67, 524288, 131072),
      cartridge(67, 16384, 262144),
      cartridge(67, 16384, 0),
      { ...metadata, submapper: 1 },
    ])
      expect(resolveNesMapperLayout(invalid).ok).toBe(false);
  }
});

describe("NES static mapper layouts", () => {
  it("mirrors 16 KiB NROM and CNROM from the same source interval", () => {
    for (const mapper of [0, 3]) {
      const result = resolveNesMapperLayout(
        cartridge(mapper, 0x4000, 0x2000, { trainer: true }),
      );
      if (!result.ok) throw new Error(result.error);
      expect(result.value.mappings).toEqual([
        {
          name: "NES_PRG_ROM",
          addressSpace: "RAM",
          start: 0x8000,
          size: 0x4000,
          fileOffset: 528,
          bank: 0,
          role: "fixed",
        },
        {
          name: "NES_PRG_ROM_MIRROR",
          addressSpace: "RAM",
          start: 0xc000,
          size: 0x4000,
          fileOffset: 528,
          bank: 0,
          role: "mirror",
        },
      ]);
    }
  });

  it("preserves UxROM's fixed last bank and every candidate lower bank without choosing startup state", () => {
    const result = resolveNesMapperLayout(
      cartridge(2, 0x40000, 0, { trainer: true, submapper: 2 }),
    );
    if (!result.ok) throw new Error(result.error);
    const layout = result.value;
    expect(layout).toMatchObject({
      board: "UxROM",
      bankSize: 0x4000,
      prgBanks: 16,
      chrBanks: 0,
    });
    expect(layout.mappings[0]).toEqual({
      name: "NES_PRG_FIXED",
      addressSpace: "RAM",
      start: 0xc000,
      size: 0x4000,
      fileOffset: 528 + 15 * 0x4000,
      bank: 15,
      role: "fixed",
    });
    const candidates = layout.mappings.filter(
      (mapping) => mapping.role === "switchable",
    );
    expect(
      new Set(candidates.map((mapping) => mapping.addressSpace)).size,
    ).toBe(16);
    expect(candidates.at(-1)).toMatchObject({
      name: "NES_PRG_B00f",
      addressSpace: "NES_PRG_B00f",
      bank: 15,
      start: 0x8000,
    });
    expect(candidates.map((mapping) => mapping.fileOffset)).toEqual(
      Array.from({ length: 16 }, (_, bank) => 528 + bank * 0x4000),
    );
    expect(layout.limitations.join(" ")).toContain(
      "No selected bank, power-on bank",
    );
    expect(layout.limitations.join(" ")).toContain("bus conflicts");
  });

  it.each([
    [7, 0x40000, 0],
    [66, 0x20000, 0x8000],
    [11, 0x20000, 0x20000],
  ] as const)(
    "exposes all Mapper %i whole-window banks with qualified identity",
    (mapper, prgSize, chrSize) => {
      const result = resolveNesMapperLayout(
        cartridge(mapper, prgSize, chrSize),
      );
      if (!result.ok) throw new Error(result.error);
      const layout = result.value;
      expect(layout.bankSize).toBe(0x8000);
      expect(layout.chrBanks).toBe(chrSize / 0x2000);
      expect(layout.mappings).toHaveLength(prgSize / 0x8000);
      for (const mapping of layout.mappings) {
        expect(mapping.addressSpace).not.toBe("RAM");
        expect(mapping).toMatchObject({
          start: 0x8000,
          size: 0x8000,
          role: "switchable",
        });
        expect(mapping.fileOffset + mapping.size).toBeLessThanOrEqual(
          16 + prgSize,
        );
      }
      expect(
        new Set(layout.mappings.map((mapping) => mapping.fileOffset)).size,
      ).toBe(layout.prgBanks);
    },
  );

  it("keeps CNROM's CHR bank count separate from its fixed CPU PRG", () => {
    const result = resolveNesMapperLayout(
      cartridge(3, 0x8000, 0x8000, { submapper: 1 }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({
      board: "CNROM",
      prgBanks: 1,
      chrBanks: 4,
    });
    expect(result.value.mappings).toHaveLength(1);
    expect(result.value.mappings[0]).toMatchObject({
      addressSpace: "RAM",
      size: 0x8000,
      fileOffset: 16,
    });
    expect(result.value.limitations.join(" ")).toContain(
      "does not identify the selected",
    );
  });

  it("retains exceptional NES 2.0 RAM declarations without claiming reconstructed PPU wiring", () => {
    const metadata = {
      ...cartridge(7, 0x8000, 0, { submapper: 2 }),
      chrRamSize: 16384,
    };
    const result = resolveNesMapperLayout(metadata);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.limitations.join(" ")).toContain(
      "differs from the conventional 8 KiB",
    );
    expect(metadata.chrRamSize).toBe(16384);
  });
});

describe("NES mapper admission boundaries", () => {
  it.each([
    [6, 0x8000, 0x2000, "bank-switching"],
    [1, 0x4000, 0x2000, "PRG ROM"],
    [1, 0x100000, 0x2000, "PRG ROM"],
    [1, 0x80000, 0x4000, "8 KiB CHR"],
    [1, 0x8000, 0x40000, "CHR ROM"],
    [4, 0x4000, 0x2000, "PRG ROM"],
    [4, 0x100000, 0x2000, "PRG ROM"],
    [4, 0x8000, 0x80000, "CHR ROM"],
    [0, 0x10000, 0x2000, "PRG ROM"],
    [2, 0x80000, 0, "PRG ROM"],
    [2, 0xc000, 0, "power-of-two"],
    [2, 0x8000, 0x2000, "CHR ROM"],
    [3, 0x8000, 0, "CHR ROM"],
    [3, 0x8000, 0x10000, "CHR ROM"],
    [7, 0x4000, 0, "PRG ROM"],
    [7, 0x80000, 0, "PRG ROM"],
    [66, 0x40000, 0x2000, "PRG ROM"],
    [11, 0x40000, 0x2000, "PRG ROM"],
    [71, 0x10000, 0, "PRG ROM"],
    [71, 0x20000, 0x2000, "CHR ROM"],
    [11, 0x8000, 0x40000, "CHR ROM"],
    [66, 0x8000, 0x10000, "CHR ROM"],
  ] as const)(
    "refuses unsupported Mapper %i PRG=%i CHR=%i",
    (mapper, prg, chr, reason) => {
      expect(resolveNesMapperLayout(cartridge(mapper, prg, chr))).toEqual({
        ok: false,
        error: expect.stringContaining(reason),
      });
    },
  );

  it.each([
    [0, 1],
    [1, 6],
    [2, 3],
    [3, 3],
    [4, 5],
    [7, 3],
    [66, 1],
    [11, 1],
    [71, 2],
  ] as const)(
    "refuses unmodeled Mapper %i submapper %i",
    (mapper, submapper) => {
      const metadata = cartridge(
        mapper,
        0x8000,
        mapper === 2 || mapper === 7 ? 0 : 0x2000,
        { submapper },
      );
      expect(resolveNesMapperLayout(metadata)).toEqual({
        ok: false,
        error: expect.stringContaining("submapper"),
      });
    },
  );

  it.each([
    [{ consoleType: 1 }, "console type"],
    [{ miscRomCount: 1 }, "miscellaneous ROM"],
    [{ trailingData: { offset: 32784, size: 1 } }, "trailing data"],
  ] satisfies [Partial<NesRomMetadata>, string][])(
    "retains a refusal reason for unsupported container facts %j",
    (change, reason) => {
      expect(
        resolveNesMapperLayout({ ...cartridge(2, 0x8000, 0), ...change }),
      ).toEqual({ ok: false, error: expect.stringContaining(reason) });
    },
  );
});

describe("MMC1 and MMC3 complete PRG contexts", () => {
  it.each([
    [0, [2, 3], ["switchable", "switchable"]],
    [1, [2, 3], ["switchable", "switchable"]],
    [2, [0, 3], ["fixed", "switchable"]],
    [3, [3, 7], ["switchable", "fixed"]],
  ] as const)(
    "resolves MMC1 mode %i with raw odd bank and power-of-two ROM masking",
    (mode, banks, roles) => {
      const state: NesPrgView = { mapper: 1, prg_mode: mode, prg_bank: 11 };
      const result = resolveNesMapperLayout(
        cartridge(1, 0x20000, 0x2000, { trainer: true }),
        [state],
      );
      if (!result.ok) throw new Error(result.error);
      const space = `NES_M1_M${mode}_P0b`;
      expect(result.value.contexts).toEqual([
        { addressSpace: space, state, selection: "caller-selected" },
      ]);
      expect(result.value.mappings.map((mapping) => mapping.bank)).toEqual(
        banks,
      );
      expect(result.value.mappings.map((mapping) => mapping.role)).toEqual(
        roles,
      );
      expect(
        result.value.mappings.map((mapping) => [
          mapping.name,
          mapping.addressSpace,
          mapping.start,
          mapping.fileOffset,
          mapping.size,
        ]),
      ).toEqual([
        [space, space, 0x8000, 528 + banks[0] * 0x4000, 0x4000],
        [`${space}_Ac000`, space, 0xc000, 528 + banks[1] * 0x4000, 0x4000],
      ]);
    },
  );

  it.each([
    [0, [7, 5, 6, 7], ["switchable", "switchable", "fixed", "fixed"]],
    [1, [6, 5, 7, 7], ["fixed", "switchable", "switchable", "fixed"]],
  ] as const)(
    "resolves MMC3 mode %i without splitting mutually dependent windows across spaces",
    (mode, banks, roles) => {
      const state: NesPrgView = { mapper: 4, prg_mode: mode, r6: 63, r7: 61 };
      const result = resolveNesMapperLayout(cartridge(4, 0x10000, 0x40000), [
        state,
      ]);
      if (!result.ok) throw new Error(result.error);
      const space = `NES_M4_M${mode}_R3f_S3d`;
      expect(result.value.contexts).toEqual([
        { addressSpace: space, state, selection: "caller-selected" },
      ]);
      expect(result.value.mappings.map((mapping) => mapping.bank)).toEqual(
        banks,
      );
      expect(result.value.mappings.map((mapping) => mapping.role)).toEqual(
        roles,
      );
      expect(result.value.mappings.map((mapping) => mapping.start)).toEqual([
        0x8000, 0xa000, 0xc000, 0xe000,
      ]);
      expect(
        new Set(result.value.mappings.map((mapping) => mapping.addressSpace)),
      ).toEqual(new Set([space]));
      expect(
        result.value.mappings.map((mapping) => mapping.fileOffset),
      ).toEqual(banks.map((bank) => 16 + bank * 0x2000));
    },
  );

  it("distinguishes default assumptions from explicit identical selectors and preserves masked aliases", () => {
    const metadata = cartridge(1, 0x8000, 0x2000);
    const defaulted = resolveNesMapperLayout(metadata);
    const selected = resolveNesMapperLayout(metadata, [
      { mapper: 1, prg_mode: 3, prg_bank: 2 },
      { mapper: 1, prg_mode: 3, prg_bank: 0 },
    ]);
    if (!defaulted.ok) throw new Error(defaulted.error);
    if (!selected.ok) throw new Error(selected.error);
    expect(defaulted.value.contexts).toEqual([
      {
        addressSpace: "NES_M1_M3_P00",
        state: { mapper: 1, prg_mode: 3, prg_bank: 0 },
        selection: "default-assumption",
      },
    ]);
    expect(
      selected.value.contexts.map((context) => context.addressSpace),
    ).toEqual(["NES_M1_M3_P00", "NES_M1_M3_P02"]);
    expect(
      selected.value.contexts.every(
        (context) => context.selection === "caller-selected",
      ),
    ).toBe(true);
    expect(selected.value.mappings.map((mapping) => mapping.bank)).toEqual([
      0, 1, 0, 1,
    ]);
    expect(defaulted.value.limitations.join(" ")).toContain(
      "default analysis assumption",
    );
    expect(defaulted.value.limitations.join(" ")).toContain(
      "does not distinguish bankable SIROM",
    );
    expect(selected.value.limitations.join(" ")).toContain(
      "Coverage of source banks",
    );
  });

  it("uses an explicit default MMC3 context while admitting conventional capacity endpoints", () => {
    for (const [mapper, prg, chr] of [
      [1, 0x40000, 0x20000],
      [4, 0x8000, 0],
      [4, 0x80000, 0x40000],
    ] as const) {
      const result = resolveNesMapperLayout(
        cartridge(mapper, prg, chr, { submapper: 0 }),
      );
      if (!result.ok) throw new Error(result.error);
      expect(result.value.contexts[0]?.selection).toBe("default-assumption");
      if (mapper === 4) {
        expect(result.value.contexts[0]?.state).toEqual({
          mapper: 4,
          prg_mode: 0,
          r6: 0,
          r7: 1,
        });
        expect(result.value.mappings.map((mapping) => mapping.bank)).toEqual([
          0,
          1,
          prg / 0x2000 - 2,
          prg / 0x2000 - 1,
        ]);
      }
    }
  });

  it("rejects foreign, empty and duplicate state selections at the layout boundary", () => {
    const state: NesPrgView = { mapper: 1, prg_mode: 3, prg_bank: 0 };
    for (const [mapper, states] of [
      [0, [state]],
      [4, [state]],
      [1, []],
      [1, [state, state]],
    ] as const)
      expect(
        resolveNesMapperLayout(cartridge(mapper, 0x8000, 0x2000), states).ok,
      ).toBe(false);
  });
});

describe("MMC2 and MMC4 complete PRG contexts", () => {
  it.each([9, 10] as const)(
    "preserves raw selectors, source offsets and fixed windows for Mapper %i",
    (mapper) => {
      const metadata = cartridge(mapper, 0x10000, 0x20000, { trainer: true });
      const result = resolveNesMapperLayout(metadata, [
        { mapper, prg_bank: 15 },
        { mapper, prg_bank: 2 },
      ]);
      if (!result.ok) throw new Error(result.error);
      expect(result.value.contexts).toEqual(
        [2, 15].map((prg_bank) => ({
          addressSpace: `NES_M${mapper}_P${prg_bank.toString(16).padStart(2, "0")}`,
          state: { mapper, prg_bank },
          selection: "caller-selected",
        })),
      );
      const size = mapper === 9 ? 8192 : 16384;
      const expected = mapper === 9 ? [2, 5, 6, 7, 7, 5, 6, 7] : [2, 3, 3, 3];
      expect(result.value.mappings.map((m) => m.bank)).toEqual(expected);
      expect(result.value.mappings.map((m) => m.fileOffset)).toEqual(
        expected.map((bank) => 528 + bank * size),
      );
      for (const context of result.value.contexts) {
        const windows = result.value.mappings.filter(
          (m) => m.addressSpace === context.addressSpace,
        );
        expect(windows.map((m) => m.start)).toEqual(
          mapper === 9 ? [0x8000, 0xa000, 0xc000, 0xe000] : [0x8000, 0xc000],
        );
        expect(windows.map((m) => m.role)).toEqual(
          mapper === 9
            ? ["switchable", "fixed", "fixed", "fixed"]
            : ["switchable", "fixed"],
        );
        expect(windows.reduce((sum, m) => sum + m.size, 0)).toBe(32768);
      }
      expect(result.value.limitations.join(" ")).toContain(
        "PPU-read-triggered latches",
      );
      const defaulted = resolveNesMapperLayout(metadata);
      if (!defaulted.ok) throw new Error(defaulted.error);
      expect(defaulted.value.contexts[0]).toMatchObject({
        state: { mapper, prg_bank: 0 },
        selection: "default-assumption",
      });
    },
  );
  it.each([9, 10] as const)(
    "admits conventional endpoints but rejects oversize, undersize, CHR RAM and unknown submappers for %i",
    (mapper) => {
      const maximum = mapper === 9 ? 0x20000 : 0x40000;
      for (const prg of [0x8000, maximum])
        for (const chr of [0x2000, 0x20000])
          expect(
            resolveNesMapperLayout(
              cartridge(mapper, prg, chr, { submapper: 0 }),
            ).ok,
          ).toBe(true);
      for (const [prg, chr] of [
        [0x4000, 0x2000],
        [maximum * 2, 0x2000],
        [0x8000, 0],
        [0x8000, 0x40000],
      ])
        expect(resolveNesMapperLayout(cartridge(mapper, prg!, chr!)).ok).toBe(
          false,
        );
      expect(
        resolveNesMapperLayout(
          cartridge(mapper, 0x8000, 0x2000, { submapper: 1 }),
        ).ok,
      ).toBe(false);
      expect(
        resolveNesMapperLayout(cartridge(mapper, 0x8000, 0x2000), [
          { mapper: mapper === 9 ? 10 : 9, prg_bank: 0 },
        ]).ok,
      ).toBe(false);
    },
  );
});

describe("selected UxROM contexts", () => {
  it("maps selected and fixed windows together while retaining raw selectors", () => {
    const result = resolveNesMapperLayout(
      cartridge(2, 65536, 0, { trainer: true }),
      [
        { mapper: 2, prg_bank: 2 },
        { mapper: 2, prg_bank: 15 },
      ],
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.contexts).toEqual([
      {
        addressSpace: "NES_M2_P02",
        state: { mapper: 2, prg_bank: 2 },
        selection: "caller-selected",
      },
      {
        addressSpace: "NES_M2_P0f",
        state: { mapper: 2, prg_bank: 15 },
        selection: "caller-selected",
      },
    ]);
    expect(
      result.value.mappings.map(
        ({ addressSpace, start, bank, fileOffset }) => ({
          addressSpace,
          start,
          bank,
          fileOffset,
        }),
      ),
    ).toEqual([
      { addressSpace: "NES_M2_P02", start: 32768, bank: 2, fileOffset: 33296 },
      { addressSpace: "NES_M2_P02", start: 49152, bank: 3, fileOffset: 49680 },
      { addressSpace: "NES_M2_P0f", start: 32768, bank: 3, fileOffset: 49680 },
      { addressSpace: "NES_M2_P0f", start: 49152, bank: 3, fileOffset: 49680 },
    ]);
  });
});

it("keeps selected AxROM contexts at 32 KiB and omits candidate-only limitations", () => {
  const result = resolveNesMapperLayout(cartridge(7, 131072, 0), [
    { mapper: 7, prg_bank: 7 },
  ]);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.mappings).toEqual([
    {
      name: "NES_M7_P07",
      addressSpace: "NES_M7_P07",
      start: 32768,
      size: 32768,
      fileOffset: 98320,
      bank: 3,
      role: "switchable",
    },
  ]);
  expect(result.value.contexts[0]).toMatchObject({
    state: { mapper: 7, prg_bank: 7 },
    selection: "caller-selected",
  });
  expect(result.value.limitations.join(" ")).not.toContain("No selected bank");
});

it.each([
  [null, 0, "BNROM"],
  [0, 8192, "BNROM"],
  [0, 16384, "NINA-001"],
  [1, 8192, "NINA-001"],
  [2, 8192, "BNROM"],
] as const)(
  "resolves Mapper 34 submapper %s / CHR %s to %s",
  (submapper, chrSize, board) => {
    const header = cartridge(
      34,
      65536,
      chrSize,
      submapper === null ? {} : { submapper },
    );
    const result = resolveNesMapperLayout(header, [
      { mapper: 34, prg_bank: 1 },
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({
      board,
      bankSize: 32768,
      prgBanks: 2,
      mappings: [{ start: 32768, size: 32768, fileOffset: 32784, bank: 1 }],
    });
    expect(result.value.limitations.join(" ")).toContain(
      submapper === 1 || submapper === 2
        ? "explicit NES 2.0"
        : "CHR-size convention",
    );
  },
);

it.each([
  [1, 131072, 16384],
  [1, 65536, 0],
  [2, 65536, 16384],
  [2, 262144, 0],
  [3, 65536, 8192],
])(
  "rejects inconsistent or oversize Mapper 34 layouts (%s/%s/%s)",
  (submapper, prgSize, chrSize) => {
    expect(
      resolveNesMapperLayout(cartridge(34, prgSize, chrSize, { submapper })).ok,
    ).toBe(false);
  },
);

it.each([0, 1, 2, 3] as const)(
  "maps MMC1 mode %s inside the selected 256 KiB half",
  (mode) => {
    const header = cartridge(1, 0x80000, 0x2000);
    const result = resolveNesMapperLayout(header, [
      { mapper: 1, prg_mode: mode, prg_bank: 3, prg_outer_bank: 0 },
      { mapper: 1, prg_mode: mode, prg_bank: 3, prg_outer_bank: 1 },
    ]);
    if (!result.ok) throw new Error(result.error);
    const lower = mode < 2 ? [2, 3] : mode === 2 ? [0, 3] : [3, 15];
    expect(result.value.mappings.map((mapping) => mapping.bank)).toEqual([
      ...lower,
      ...lower.map((bank) => bank + 16),
    ]);
    expect(
      new Set(result.value.contexts.map((context) => context.addressSpace))
        .size,
    ).toBe(2);
    expect(
      resolveNesMapperLayout(header, [
        { mapper: 1, prg_mode: mode, prg_bank: 3 },
      ]).ok,
    ).toBe(false);
    expect(
      resolveNesMapperLayout(cartridge(1, 0x40000, 0x2000), [
        { mapper: 1, prg_mode: mode, prg_bank: 3, prg_outer_bank: 0 },
      ]).ok,
    ).toBe(false);
  },
);

it("imports explicit MMC1 fixed PRG as one window and rejects irrelevant bank views", () => {
  const header = cartridge(1, 0x8000, 0x8000, { submapper: 5 });
  const result = resolveNesMapperLayout(header);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.contexts).toEqual([]);
  expect(result.value.mappings).toEqual([
    {
      name: "NES_PRG_ROM",
      addressSpace: "RAM",
      start: 0x8000,
      size: 0x8000,
      fileOffset: 16,
      bank: 0,
      role: "fixed",
    },
  ]);
  expect(
    resolveNesMapperLayout(header, [{ mapper: 1, prg_mode: 3, prg_bank: 1 }])
      .ok,
  ).toBe(false);
  expect(
    resolveNesMapperLayout(cartridge(1, 0x10000, 0x8000, { submapper: 5 })).ok,
  ).toBe(false);
});

it.each([3, 4])(
  "maps MMC3 IRQ variant submapper %i without claiming timing",
  (submapper) => {
    const result = resolveNesMapperLayout(
      cartridge(4, 65536, 32768, { submapper }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.mappings).toHaveLength(4);
    expect(result.value.limitations.join(" ")).toContain(
      submapper === 3 ? "MC-ACC" : "NEC MMC3",
    );
    expect(result.value.limitations.join(" ")).toContain("not simulated");
  },
);

it.each([1, 2, 4])(
  "validates deprecated MMC1 submapper %i capacities",
  (submapper) => {
    const metadata = cartridge(1, submapper === 1 ? 524288 : 262144, 0, {
      submapper,
    });
    const valid = {
      ...metadata,
      chrRamSize: 8192,
      prgRamSize: submapper === 1 ? 8192 : submapper === 2 ? 16384 : 32768,
    };
    expect(resolveNesMapperLayout(valid).ok).toBe(true);
    for (const invalid of [
      { ...valid, prgRamSize: 0 },
      { ...valid, chrRamSize: 16384 },
      { ...valid, chrRamSize: 0, chrRom: { ...valid.chrRom, size: 8192 } },
      ...(submapper === 1
        ? [
            { ...valid, prgRom: { ...valid.prgRom, size: 262144 } },
            { ...valid, prgRamSize: 4096, prgNvramSize: 4096 },
          ]
        : []),
      ...(submapper === 2
        ? [{ ...valid, prgRom: { ...valid.prgRom, size: 524288 } }]
        : []),
    ])
      expect(resolveNesMapperLayout(invalid)).toMatchObject({
        ok: false,
        error: expect.stringContaining("must match"),
      });
  },
);
