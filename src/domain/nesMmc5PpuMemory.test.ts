import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mmc5Fixture } from "./nesMmc5.fixture.js";
import { nesMmc5StateSchema } from "./nesMmc5.js";
import { nesPpuFixtureState, nesPpuFixtureOam } from "./nesPpu.fixture.js";
import {
  mmc5FrozenPatternPages,
  mmc5FrozenNametablePages,
  readMmc5FrozenNametablePage,
} from "./nesMmc5PpuMemory.js";
import { deriveNesPpuPatternTable } from "./nesPpuPatternDerivation.js";
import { deriveNesPpuNametable } from "./nesPpuNametableDerivation.js";
import { deriveNesPpuSprites } from "./nesPpuSpritesDerivation.js";
import { deriveNesPpuViewport } from "./nesPpuViewportDerivation.js";
import { nesPpuPatternTableSchema } from "./nesPpuPattern.js";
import { nesPpuViewportSchema } from "./nesPpuViewport.js";

const fixture = (chrSize = 8192) => {
  const base = mmc5Fixture();
  const bytes = Buffer.alloc(base.prgOffset + base.prgSize + chrSize);
  base.bytes.copy(bytes);
  bytes[5] = chrSize / 8192;
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const mapper = nesMmc5StateSchema.parse({
    mapper: 5,
    chr_mode: 3,
    chr_banks: [1, 1, 1, 1, 1, 1, 1, 1, 5, 5, 5, 5],
    chr_bank_modes: Array(12).fill(3),
    chr_bank_upper: Array(12).fill(0),
    ppu_control: 32,
    ppu_mask: 24,
    exram_mode: 0,
    exram_written: true,
    split: [0, 0, 0],
    nametable_control: 0,
    fill_tile: 0x73,
    fill_attribute: 2,
  });
  const chr = Buffer.alloc(chrSize);
  for (let tile = 0; tile < 64; tile++) {
    chr.fill(255, 1024 + tile * 16, 1024 + tile * 16 + 8);
    chr.fill(255, 5 * 1024 + tile * 16 + 8, 5 * 1024 + tile * 16 + 16);
  }
  const ppu = nesPpuFixtureState({
    chr_ram_size: null,
    nametable_layout: "ciram-2k",
    control: 32,
    mask: 30,
    nametable: { 0: 0, 960: 0 },
    palette: { 0: 0, 1: 1, 2: 2, 17: 17 },
    oam: nesPpuFixtureOam(),
  });
  return { header: parsed.value, mapper, ppu, chr };
};

it("uses independent ordinary sprite/background query roles and keeps unspecified pattern choices", async () => {
  const { header, mapper, ppu, chr } = fixture();
  const unspecified = await deriveNesPpuPatternTable(
    header,
    mapper,
    ppu,
    0,
    chr,
  );
  const background = await deriveNesPpuPatternTable(
    header,
    mapper,
    ppu,
    0,
    chr,
    undefined,
    "background",
  );
  const sprites = await deriveNesPpuSprites(header, mapper, ppu, {
    chr,
    patterns: new Map([[0, background]]),
  });
  expect(unspecified.tiles[0]!.rows[0]![0]).toEqual({ choices: [1, 2] });
  expect(background.tiles[0]!.rows[0]).toEqual(Array(8).fill(2));
  expect(sprites.sprites[0]!.modes[0]!.rows[0]).toEqual(Array(8).fill(1));
  expect(sprites.source_pages).toHaveLength(1);
  expect(sprites.source_pages[0]).toMatchObject({
    kind: "rom",
    file_offset: header.chrRom.offset + 1024,
  });
});

it("keeps CIRAM, shared ExRAM, captured raw fill and generated zero pages separate", () => {
  const { mapper } = fixture();
  mapper.nametable_control = 0xe4;
  expect(
    [0, 1, 2, 3].map((page) =>
      mmc5FrozenNametablePages(mapper, page, true, "background"),
    ),
  ).toEqual([
    [0],
    [1024],
    [{ kind: "mmc5-exram" }],
    [{ kind: "mmc5-fill", tile: 0x73, attribute: 2 }],
  ]);
  mapper.exram[4] = { value: 0x66, origin: { kind: "event-write", index: 7 } };
  expect(readMmc5FrozenNametablePage(mapper, { kind: "mmc5-exram" }, 4)).toBe(
    0x66,
  );
  expect(mapper.exram[4]).toEqual({
    value: 0x66,
    origin: { kind: "event-write", index: 7 },
  });
  const fill = {
    kind: "mmc5-fill" as const,
    tile: 0x73,
    attribute: { mask: 3, value: 2 },
  };
  expect(readMmc5FrozenNametablePage(mapper, fill, 0)).toBe(0x73);
  expect(readMmc5FrozenNametablePage(mapper, fill, 960)).toBe(0xaa);
  mapper.exram_mode = 2;
  expect(mmc5FrozenNametablePages(mapper, 2, true, "background")).toEqual([
    { kind: "mmc5-zero" },
  ]);
  expect(readMmc5FrozenNametablePage(mapper, { kind: "mmc5-zero" }, 4)).toBe(0);
});

it("preserves unknown CIRAM backing independently of available ExRAM/fill alternatives", () => {
  const { mapper } = fixture();
  mapper.nametable_control = { mask: 252, value: 0 };
  expect(mmc5FrozenNametablePages(mapper, 0, false, "ppudata")).toEqual([
    { kind: "unknown", reason: "unknown-nametable-wiring" },
    { kind: "mmc5-exram" },
    { kind: "mmc5-fill", tile: 0x73, attribute: 2 },
  ]);
  mapper.exram_written = false;
  mapper.exram[0] = 0x66;
  expect(
    readMmc5FrozenNametablePage(mapper, { kind: "mmc5-exram" }, 0),
  ).toBeNull();
});

it("does not reuse historical active extended/split tile facts as a frozen table", async () => {
  const { header, mapper, ppu, chr } = fixture();
  const extended = nesMmc5StateSchema.parse({
    ...mapper,
    exram_mode: 1,
    ppu: {
      model: "mmc5-background",
      pin92_high: true,
      phase: "pattern-low",
      paths: ["extended"],
      nametable_address: 0x2000,
      tile_column: 4,
      tile_y: 1,
      tile_value: 0,
      extended_attribute: { address: 0, value: 0 },
    },
  });
  expect(mmc5FrozenPatternPages(header, extended, 0, "background")).toEqual([
    { kind: "unknown", reason: "mmc5-rendering-context" },
  ]);
  const pattern = await deriveNesPpuPatternTable(
    header,
    extended,
    ppu,
    0,
    chr,
    undefined,
    "background",
  );
  expect(pattern.coverage.unknown_pixels).toBe(16384);
  expect(pattern.source_pages).toEqual([
    { kind: "unknown", reason: "mmc5-rendering-context" },
  ]);
  const sprite = await deriveNesPpuPatternTable(
    header,
    extended,
    ppu,
    0,
    chr,
    undefined,
    "sprite",
  );
  expect(sprite.tiles[0]!.rows[0]).toEqual(Array(8).fill(1));
  if (!("ppu" in extended))
    throw new Error("Expected captured MMC5 PPU context");
  expect(extended.ppu.phase).toBe("pattern-low");
});

it("excludes ordinary nametable sources under a definite background override while retaining possible ordinary paths", async () => {
  const { header, mapper, ppu, chr } = fixture();
  const extended = nesMmc5StateSchema.parse({
    ...mapper,
    exram_mode: 1,
    ppu: { model: "mmc5-background", pin92_high: true },
  });
  const unknown = { kind: "unknown", reason: "mmc5-rendering-context" };
  const page = await deriveNesPpuNametable(
    header,
    extended,
    ppu,
    0,
    undefined,
    chr,
  );
  expect(page.source_pages).toEqual([unknown]);
  expect(page.cells[0]!.tile_index).toBeNull();
  expect(page.coverage.unknown_tile_indices).toBe(960);
  expect(page.coverage.unknown_subpalettes).toBe(960);
  expect(mmc5FrozenNametablePages(extended, 0, true, "ppudata")).toEqual([0]);
  const possible = nesMmc5StateSchema.parse({
    ...extended,
    ppu: { model: "mmc5-background", pin92_high: null },
  });
  expect(mmc5FrozenNametablePages(possible, 0, true, "background")).toEqual([
    0,
    unknown,
  ]);
  expect(ppu.nametable[0]).toBe(0);
});

it("retains 1024 maximum ROM candidates plus an explicit unqualified override without clipping indices", async () => {
  const { header, mapper, ppu, chr } = fixture(1048576);
  const uncertain = nesMmc5StateSchema.parse({
    ...mapper,
    chr_banks: Array(12).fill(null),
    chr_bank_upper: Array(12).fill(null),
    exram_mode: 1,
  });
  const pattern = nesPpuPatternTableSchema.parse(
    await deriveNesPpuPatternTable(header, uncertain, ppu, 0, chr),
  );
  expect(pattern.source_pages).toHaveLength(1025);
  expect(pattern.blocks[0]!.sources).toHaveLength(1025);
  expect(pattern.blocks[0]!.sources.at(-1)).toBe(1024);
  expect(pattern.source_pages[1023]).toMatchObject({
    kind: "rom",
    file_offset: header.chrRom.offset + 1023 * 1024,
  });
  expect(pattern.source_pages[1024]).toEqual({
    kind: "unknown",
    reason: "mmc5-rendering-context",
  });
});

it("preserves distinct background and sprite blocks in one frozen viewport", async () => {
  const { header, mapper, ppu, chr } = fixture();
  const viewport = nesPpuViewportSchema.parse(
    await deriveNesPpuViewport(header, mapper, ppu, {
      chr,
      selection: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
    }),
  );
  const blocks = viewport.chr_blocks.filter((block) => block.ppu_address === 0);
  expect(blocks).toHaveLength(2);
  expect(
    blocks.map((block) => ("query_role" in block ? block.query_role : null)),
  ).toEqual(["background", "sprite"]);
  expect(
    blocks.map((block) =>
      block.sources.map((index) => viewport.chr_source_pages[index]),
    ),
  ).toEqual([
    [
      expect.objectContaining({
        kind: "rom",
        file_offset: header.chrRom.offset + 5 * 1024,
      }),
    ],
    [
      expect.objectContaining({
        kind: "rom",
        file_offset: header.chrRom.offset + 1024,
      }),
    ],
  ]);
  const pixel =
    viewport.modes[0]!.pixel_states[viewport.modes[0]!.rows[0]![0]!]!;
  expect(pixel.palette_mask).toBe(1 << 2);
  const page = await deriveNesPpuNametable(
    header,
    mapper,
    ppu,
    0,
    undefined,
    chr,
  );
  expect(page.source_pages).toEqual([0]);
});
