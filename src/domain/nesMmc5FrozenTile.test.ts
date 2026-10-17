import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mmc5Fixture } from "./nesMmc5.fixture.js";
import { nesMmc5StateSchema, type NesMmc5State } from "./nesMmc5.js";
import {
  advanceMmc5FrozenSplitY,
  createMmc5FrozenTileProjector,
} from "./nesMmc5FrozenTile.js";
import { nesByteProof, type NesByteValue } from "./nesByteValue.js";

const fixture = (chrSize = 32768) => {
  const f = mmc5Fixture(0),
    parsed = parseNesHeader(f.bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    header: {
      ...parsed.value,
      chrRom: { ...parsed.value.chrRom, size: chrSize },
    },
    chr: new Uint8Array(chrSize),
  };
};
const state = (extra: Record<string, unknown> = {}): NesMmc5State =>
  nesMmc5StateSchema.parse({
    mapper: 5,
    chr_mode: 3,
    chr_banks: Array<number>(12).fill(0),
    chr_bank_modes: Array<number>(12).fill(3),
    chr_bank_upper: Array<number>(12).fill(0),
    chr_upper: 0,
    exram_mode: 0,
    exram_written: true,
    nametable_control: 0,
    ppu_control: 32,
    ppu_mask: 24,
    split: [0, 0, 0],
    ppu: { model: "mmc5-background", pin92_high: true, split_wiring: "sl" },
    ...extra,
  });
const ordinary = (tile: NesByteValue = 1, attribute: NesByteValue = 0) => [
  { source: 0, tile, attribute },
];
const rowInput = (extra: Record<string, unknown> = {}) => ({
  nametableAddress: 0x2000,
  row: 0,
  ordinary: ordinary(),
  screenColumn: 0,
  splitY: [0],
  ...extra,
});
const setPixel = (
  chr: Uint8Array,
  bank: number,
  tile: number,
  [row, pixel]: readonly [number, number],
) => {
  const offset = bank * 4096 + tile * 16 + row;
  chr[offset] = (pixel & 1) !== 0 ? 255 : 0;
  chr[offset + 8] = (pixel & 2) !== 0 ? 255 : 0;
};

it("decodes paired ordinary bitplanes without crossing distinct bank alternatives", () => {
  const f = fixture(),
    mapper = state({ chr_banks: Array(12).fill({ mask: 254, value: 0 }) });
  f.chr[16] = 255;
  f.chr[1024 + 16 + 8] = 255;
  const result = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  }).projectRow(rowInput());
  expect(result.branches).toHaveLength(1);
  expect(result.pixelIndexMasks).toEqual(Array(8).fill(6));
  expect(result.paletteIndexMasks).toEqual(Array(8).fill(6));
  expect(result.chrPages).toEqual([
    f.header.chrRom.offset,
    f.header.chrRom.offset + 1024,
  ]);
});

it("uses live extended 4 KiB bank and per-tile palette while ignoring ordinary table and CHR mode", () => {
  const f = fixture(1024 * 1024),
    mapper = state({
      exram_mode: 1,
      chr_mode: null,
      chr_upper: 2,
      exram: {
        "0": { value: 0xc5, origin: { kind: "event-write", index: 91 } },
      },
    });
  setPixel(f.chr, 133, 1, [3, 2]);
  const result = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0, 1],
  }).projectRow(rowInput({ row: 3 }));
  expect(result.branches).toMatchObject([
    {
      path: "extended",
      tile: 1,
      palette_choices: [3],
      attribute: {
        address: 0,
        value: 197,
        origin: { kind: "event-write", index: 91 },
        shift: 6,
      },
      pattern: { kind: "4k", banks: [133], rows: [3] },
    },
  ]);
  expect(result.pixelIndexMasks).toEqual(Array(8).fill(4));
  expect(result.paletteIndexMasks).toEqual(Array(8).fill(1 << 14));
  expect(result.chrPages).toEqual([f.header.chrRom.offset + 133 * 4096]);
});

it("retains the same ExRAM byte as ordinary tile, extended bank bits and palette bits", () => {
  const f = fixture(),
    mapper = state({
      exram_mode: 1,
      nametable_control: 2,
      exram: { "0": { mask: 191, value: 1 } },
    });
  setPixel(f.chr, 1, 1, [0, 1]);
  setPixel(f.chr, 1, 65, [0, 2]);
  const result = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  }).projectRow(rowInput());
  expect(result.branches[0]).toMatchObject({
    path: "extended",
    tile_source: { kind: "mmc5-exram" },
    tile_origin: { kind: "initial-exram", address: 0 },
    coupling: "tile-extended-attribute",
    palette_choices: [0, 1],
  });
  expect(result.pixelIndexMasks).toEqual(Array(8).fill(6));
  expect(result.paletteIndexMasks).toEqual(Array(8).fill((1 << 1) | (1 << 6)));
});

it("conditions ExRAM versus generated zero on each rendering path's mode", () => {
  const f = fixture(),
    mapper = state({
      exram_mode: { mask: 253, value: 1 },
      nametable_control: 2,
      exram: { "0": 1 },
    });
  const result = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  }).projectRow(rowInput());
  expect(
    result.branches.map((branch) => [
      branch.path,
      branch.tile_source,
      branch.tile,
    ]),
  ).toEqual([
    ["extended", { kind: "mmc5-exram" }, 1],
    ["normal", { kind: "mmc5-zero" }, 0],
  ]);
});

it("keeps the split tile/attribute alias at cell 1023 correlated with its palette", () => {
  const f = fixture(),
    mapper = state({
      split: [0xc0, 0, 2],
      exram: { "1023": { mask: 191, value: 1 } },
    });
  setPixel(f.chr, 2, 1, [7, 1]);
  setPixel(f.chr, 2, 65, [7, 2]);
  const result = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  }).projectRow(rowInput({ screenColumn: 31, splitY: [255] }));
  expect(result.branches).toMatchObject([
    {
      path: "split",
      tile_address: 1023,
      attribute: { address: 1023, shift: 6 },
      pattern: { rows: [7] },
      coupling: "tile-split-attribute",
      split_y: 255,
      screen_column: 31,
    },
  ]);
  expect(result.paletteIndexMasks).toEqual(Array(8).fill((1 << 1) | (1 << 6)));
});

it("advances exact split coordinates through both wraps and pairs their tile with its own SL row", () => {
  expect(advanceMmc5FrozenSplitY({ mask: 253, value: 237 }, 1)).toEqual([
    0, 238,
  ]);
  expect(advanceMmc5FrozenSplitY(255, 1)).toEqual([0]);
  expect(advanceMmc5FrozenSplitY(240, 16)).toEqual([0]);
  const f = fixture(),
    mapper = state({ split: [159, 0, 2], exram: { "0": 1, "928": 2 } });
  setPixel(f.chr, 2, 1, [0, 1]);
  setPixel(f.chr, 2, 1, [6, 3]);
  setPixel(f.chr, 2, 2, [0, 3]);
  setPixel(f.chr, 2, 2, [6, 2]);
  const result = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  }).projectRow(rowInput({ splitY: [0, 238] }));
  expect(
    result.branches.map((branch) => [
      branch.split_y,
      branch.tile_address,
      branch.pattern,
    ]),
  ).toEqual([
    [0, 0, { kind: "4k", banks: [2], rows: [0] }],
    [238, 928, { kind: "4k", banks: [2], rows: [6] }],
  ]);
  expect(result.pixelIndexMasks).toEqual(Array(8).fill(6));
});

it("joins CL/SL fine rows only within the selected split coordinate", () => {
  const f = fixture(),
    mapper = state({
      split: [159, 0, 2],
      exram: { "32": 1 },
      ppu: { model: "mmc5-background", pin92_high: true, split_wiring: null },
    });
  setPixel(f.chr, 2, 1, [2, 1]);
  setPixel(f.chr, 2, 1, [3, 2]);
  const result = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  }).projectRow(rowInput({ row: 2, splitY: [11] }));
  expect(result.branches[0]?.pattern).toEqual({
    kind: "4k",
    banks: [2],
    rows: [2, 3],
  });
  expect(result.pixelIndexMasks).toEqual(Array(8).fill(6));
});

it("keeps missing geometry unresolved and never consumes historical captured positions", () => {
  const f = fixture(),
    mapper = state({
      split: [159, 0, 2],
      ppu: {
        model: "mmc5-background",
        pin92_high: true,
        split_y: 0,
        tile_y: 0,
        tile_column: 0,
        phase: "pattern-low",
        tile_value: 1,
      },
    });
  const before = structuredClone(mapper),
    result = createMmc5FrozenTileProjector({
      ...f,
      mapper,
      patternTables: [0],
    }).projectRow(rowInput({ screenColumn: null, splitY: null }));
  expect(
    result.branches.some(
      (branch) =>
        branch.path === "unknown" &&
        branch.pattern.kind === "unknown" &&
        branch.pattern.reason === "missing-split-coordinate",
    ),
  ).toBe(true);
  expect(result.pixelIndexMasks).toEqual(Array(8).fill(15));
  expect(mapper).toEqual(before);
});

it("snapshots mapper and CHR facts per operation without shared mutable caches", () => {
  const f = fixture(),
    mapper = state({ exram_mode: 1, exram: { "0": 1 } });
  setPixel(f.chr, 1, 1, [0, 1]);
  const projector = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  });
  mapper.exram["0"] = 2;
  f.chr.fill(0);
  const result = projector.projectRow(rowInput());
  expect(result.pixelIndexMasks).toEqual(Array(8).fill(2));
  expect(Object.isFrozen(result.branches[0])).toBe(true);
  expect(() => {
    result.branches[0]!.tile = 99;
  }).toThrow(TypeError);
  expect(projector.projectRow(rowInput()).branches[0]?.tile).toBe(1);
});

it("retains all compatible null-counter coordinates and physical CHR pages at maximum capacity", () => {
  const f = fixture(1024 * 1024),
    mapper = state({ split: [159, 0, null] });
  const projector = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  });
  const result = projector.projectRow(
    rowInput({ splitY: advanceMmc5FrozenSplitY(null, 0) }),
  );
  expect(result.branches).toHaveLength(256);
  expect(result.branches.every((branch) => branch.path === "split")).toBe(true);
  expect(result.chrPages).toHaveLength(1024);
  expect(result.pixelIndexMasks).toEqual(Array(8).fill(1));
  const settled = projector.projectRow(
    rowInput({ splitY: advanceMmc5FrozenSplitY(null, 16) }),
  );
  const repeated = projector.projectRow(
    rowInput({
      row: 7,
      nametableAddress: 0x2ffe,
      ordinary: [],
      splitY: advanceMmc5FrozenSplitY(null, 48),
    }),
  );
  expect(repeated.branches).toBe(settled.branches);
  expect(repeated.pixelIndexMasks).toBe(settled.pixelIndexMasks);
  expect(repeated.chrPages).toBe(result.chrPages);
  expect(repeated.branches).toHaveLength(240);
  expect(Object.isFrozen(repeated.branches)).toBe(true);
});

it("preserves a known palette when a CHR snapshot is absent or CHR RAM is unmodeled", () => {
  for (const chrSize of [0, 32768]) {
    const f = fixture(chrSize),
      mapper = state({ exram_mode: 1, exram: { "0": 0x81 } });
    const result = createMmc5FrozenTileProjector({
      header: f.header,
      mapper,
      patternTables: [0],
    }).projectRow(rowInput());
    expect(result.pixelIndexMasks).toEqual(Array(8).fill(15));
    expect(result.paletteIndexMasks).toEqual(Array(8).fill(1 | (14 << 8)));
    expect(result.branches[0]?.unresolved_reason).toBe(
      chrSize === 0 ? "mmc5-chr-ram-unmodeled" : "missing-snapshot",
    );
    expect(result.chrPages).toHaveLength(chrSize === 0 ? 0 : 1);
  }
});

it("does not infer same-cell equality from an unverified reset-mode ExRAM access", () => {
  const f = fixture(),
    mapper = state({
      exram_mode: 1,
      exram_written: false,
      nametable_control: 2,
      exram: { "0": 1 },
    });
  f.chr.fill(255);
  const result = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  }).projectRow(rowInput());
  expect(result.branches[0]).toMatchObject({
    tile: null,
    tile_origin: null,
    coupling: "independent",
    unresolved_reason: "mmc5-exram-access-unverified",
    attribute: { value: null, origin: null },
  });
  expect(result.paletteIndexMasks).toEqual(
    Array(8).fill((1 << 3) | (1 << 7) | (1 << 11) | (1 << 15)),
  );
});

it("retains a missing CIRAM backing reason while examining compatible physical CHR bytes", () => {
  const f = fixture(),
    mapper = state();
  const result = createMmc5FrozenTileProjector({
    ...f,
    mapper,
    patternTables: [0],
  }).projectRow(rowInput({ ordinary: [] }));
  expect(result.branches).toHaveLength(1);
  expect(result.branches[0]).toMatchObject({
    path: "normal",
    tile: null,
    tile_source: { kind: "unknown", reason: "unknown-nametable-wiring" },
    unresolved_reason: "unknown-nametable-wiring",
    pattern: { kind: "ordinary" },
  });
  expect(result.chrPages).toEqual([f.header.chrRom.offset]);
  expect(result.pixelIndexMasks).toEqual(Array(8).fill(1));
});

it("matches every ternary attribute proof against a concrete byte oracle with 8 KiB aliases", () => {
  const f = fixture(8192);
  f.chr[16] = 0xa5;
  f.chr[24] = 0x3c;
  f.chr[4096 + 16] = 0x69;
  f.chr[4096 + 24] = 0xd2;
  for (let mask = 0; mask < 256; mask++)
    for (let value = 0; value < 256; value++) {
      if ((value & ~mask) !== 0) continue;
      const mapper = state({
          exram_mode: 1,
          chr_upper: null,
          exram: { "0": nesByteProof(mask, value) },
        }),
        result = createMmc5FrozenTileProjector({
          ...f,
          mapper,
          patternTables: [0, 1],
        }).projectRow(rowInput()),
        pixels = Array<number>(8).fill(0),
        palettes = Array<number>(8).fill(0);
      for (let attribute = 0; attribute < 256; attribute++) {
        if ((attribute & mask) !== value) continue;
        const bank = attribute % 2,
          palette = Math.floor(attribute / 64),
          low = f.chr[bank * 4096 + 16]!,
          high = f.chr[bank * 4096 + 24]!;
        for (let x = 0; x < 8; x++) {
          const pixel = ((low >> (7 - x)) % 2) + 2 * ((high >> (7 - x)) % 2);
          pixels[x]! |= 2 ** pixel;
          palettes[x]! |= 2 ** (pixel === 0 ? 0 : palette * 4 + pixel);
        }
      }
      expect(result.pixelIndexMasks).toEqual(pixels);
      expect(result.paletteIndexMasks).toEqual(palettes);
    }
});
