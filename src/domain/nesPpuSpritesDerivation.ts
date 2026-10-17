import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesPpuState } from "./nesPpuState.js";
import type { NesPpuSprites } from "./nesPpuSprites.js";
import type { NesPpuPatternTable } from "./nesPpuPattern.js";
import {
  nesPpuPatternSourceIdentity,
  nesPpuPatternBlockUnresolved,
} from "./nesPpuPattern.js";
import { deriveNesPpuPatternTable } from "./nesPpuPatternDerivation.js";
import { readNesPpuPaletteCell } from "./nesPpuPalette.js";
import {
  nesByteBits,
  nesByteCandidates,
  nesTwoBitProof,
  type NesByteValue,
} from "./nesByteValue.js";
import { ppuBits } from "./nesPpuAddress.js";
import { deriveNesPpuSpriteScanlines } from "./nesPpuSpriteScanlines.js";
import {
  nesPpuPixelFromMask,
  nesPpuPixelMask,
  type NesPpuPixel,
} from "./nesPpuPixel.js";

type Mode = NesPpuSprites["sprites"][number]["modes"][number];
const bitFlag = (value: NesByteValue, mask: number): boolean | null => {
  const bit = nesByteBits(value, mask);
  return bit === null ? null : bit !== 0;
};
const choices = (value: boolean | null): boolean[] =>
  value === null ? [false, true] : [value];
const oamValue = (ppu: NesPpuState, address: number): NesByteValue => {
  const fact = ppu.oam?.cells[String(address)];
  return typeof fact === "object" && fact !== null && "origin" in fact
    ? fact.value
    : (fact ?? null);
};
const rowsFor = (
  mode: Pick<Mode, "height" | "pattern_tables" | "first_tiles">,
  patterns: Map<0 | 1, NesPpuPatternTable>,
  horizontal: boolean | null,
  vertical: boolean | null,
): NesPpuPixel[][] => {
  const flips = choices(vertical).flatMap((flipY) =>
    choices(horizontal).map((flipX) => ({ flipY, flipX })),
  );
  return Array.from({ length: mode.height }, (_, y) =>
    Array.from({ length: 8 }, (_, x) => {
      let result = 0;
      for (const table of mode.pattern_tables)
        for (const tile of mode.first_tiles)
          for (const { flipY, flipX } of flips) {
            const sourceY = flipY ? mode.height - 1 - y : y,
              pixel =
                patterns.get(table)!.tiles[tile + (sourceY >> 3)]!.rows[
                  sourceY & 7
                ]![flipX ? 7 - x : x]!;
            result |= nesPpuPixelMask(pixel);
            if (result === 15) return null;
          }
      return nesPpuPixelFromMask(result);
    }),
  );
};

/** Decode committed physical OAM without changing registers, latches or event history. */
export const deriveNesPpuSprites = async (
  header: NesRomMetadata,
  mapper: NesMapperState,
  ppu: NesPpuState,
  {
    chr,
    signal,
    patterns: suppliedPatterns,
  }: {
    chr?: Uint8Array | undefined;
    signal?: AbortSignal | undefined;
    patterns?: ReadonlyMap<0 | 1, NesPpuPatternTable>;
  } = {},
): Promise<NesPpuSprites> => {
  const coverage: NesPpuSprites["coverage"] = {
    examined_sprites: 64,
    unknown_oam_bytes: 0,
    partial_oam_bytes: 0,
    unresolved_source_blocks: 0,
    unknown_pixels: 0,
    partial_pixels: 0,
    unknown_palette_codes: 0,
    partial_palette_codes: 0,
  };
  const sprites = decodeEntries(ppu, coverage),
    tables = new Set(
      sprites.flatMap((sprite) =>
        sprite.modes.flatMap((mode) => mode.pattern_tables),
      ),
    );
  const patterns = new Map<0 | 1, NesPpuPatternTable>(),
    sourcePages: NesPpuSprites["source_pages"] = [],
    pageIndices = new Map<string, number>(),
    blocks: NesPpuSprites["blocks"] = [];
  for (const table of [...tables].sort()) {
    const pattern =
      (mapper.mapper === 5 ? undefined : suppliedPatterns?.get(table)) ??
      (await deriveNesPpuPatternTable(
        header,
        mapper,
        ppu,
        table,
        chr,
        signal,
        "sprite",
      ));
    patterns.set(table, pattern);
    const indices = pattern.source_pages.map((source) => {
      const key = nesPpuPatternSourceIdentity(source);
      let index = pageIndices.get(key);
      if (index === undefined) {
        index = sourcePages.length;
        pageIndices.set(key, index);
        sourcePages.push(source);
      }
      return index;
    });
    blocks.push(
      ...pattern.blocks.map((block) => ({
        ...block,
        sources: block.sources.map((index) => indices[index]!),
      })),
    );
  }
  coverage.unresolved_source_blocks = blocks.filter((block) =>
    nesPpuPatternBlockUnresolved(block, sourcePages),
  ).length;
  await fillSpriteRows(sprites, patterns, coverage, signal);
  const paletteCells = Array.from(
    { length: 12 },
    (_, index) => 17 + Math.floor(index / 3) * 4 + (index % 3),
  ).map((address) => {
    const { value, code } = readNesPpuPaletteCell(ppu, address);
    if (code === null) coverage.unknown_palette_codes++;
    else if (typeof code === "object") coverage.partial_palette_codes++;
    return { address, value, code };
  });
  signal?.throwIfAborted();
  return {
    interpretation: "nes-oam-static-sprites",
    sprites_enabled: bitFlag(ppu.mask, 16),
    left_column_enabled: bitFlag(ppu.mask, 4),
    scanline_selection: deriveNesPpuSpriteScanlines(sprites),
    source_page_bytes: 1024,
    source_pages: sourcePages,
    blocks,
    sprites,
    palette_cells: paletteCells,
    palettes: Array.from({ length: 4 }, (_, subpalette) => ({
      subpalette,
      cells: [null, subpalette * 3, subpalette * 3 + 1, subpalette * 3 + 2],
    })),
    coverage,
  };
};

const decodeEntries = (
  ppu: NesPpuState,
  coverage: NesPpuSprites["coverage"],
): NesPpuSprites["sprites"] => {
  const sprites: NesPpuSprites["sprites"] = [],
    heights: (8 | 16)[] =
      bitFlag(ppu.control, 32) === null
        ? [8, 16]
        : nesByteBits(ppu.control, 32) === 0
          ? [8]
          : [16];
  for (let index = 0; index < 64; index++) {
    const address = index * 4,
      y = oamValue(ppu, address),
      tile = oamValue(ppu, address + 1),
      attributes = oamValue(ppu, address + 2),
      x = oamValue(ppu, address + 3),
      attributeBits = ppuBits(attributes),
      topRows = nesByteCandidates(y).map((byte) => byte + 1),
      offscreen = topRows.map((top) => top >= 240);
    for (const value of [y, tile, attributes, x])
      if (value === null) coverage.unknown_oam_bytes++;
      else if (typeof value === "object") coverage.partial_oam_bytes++;
    const modes = heights.map((height): Mode => {
      const tableBit = nesByteBits(
          height === 8 ? ppu.control : tile,
          height === 8 ? 8 : 1,
        ),
        patternTables: (0 | 1)[] =
          tableBit === null ? [0, 1] : tableBit === 0 ? [0] : [1];
      const firstTiles = [
        ...new Set(
          nesByteCandidates(tile).map((byte) =>
            height === 8 ? byte : byte & 254,
          ),
        ),
      ];
      return {
        height,
        pattern_tables: patternTables,
        first_tiles: firstTiles,
        rows: [],
      };
    });
    sprites.push({
      index,
      oam_address: address,
      y,
      x,
      tile_index: tile,
      attributes,
      top_rows: topRows,
      offscreen_y: offscreen.every((value) => value === offscreen[0])
        ? offscreen[0]!
        : null,
      subpalette: nesTwoBitProof(attributeBits.mask, attributeBits.value),
      behind_background: bitFlag(attributes, 32),
      horizontal_flip: bitFlag(attributes, 64),
      vertical_flip: bitFlag(attributes, 128),
      modes,
    });
  }
  return sprites;
};

const fillSpriteRows = async (
  sprites: NesPpuSprites["sprites"],
  patterns: Map<0 | 1, NesPpuPatternTable>,
  coverage: NesPpuSprites["coverage"],
  signal?: AbortSignal,
) => {
  const cachedRows = new Map<string, NesPpuPixel[][]>();
  for (const sprite of sprites) {
    await scheduler.yield();
    signal?.throwIfAborted();
    for (const mode of sprite.modes) {
      const key = JSON.stringify([
        mode.height,
        mode.pattern_tables,
        mode.first_tiles,
        sprite.horizontal_flip,
        sprite.vertical_flip,
      ]);
      let rows = cachedRows.get(key);
      if (rows === undefined) {
        rows = rowsFor(
          mode,
          patterns,
          sprite.horizontal_flip,
          sprite.vertical_flip,
        );
        cachedRows.set(key, rows);
      }
      mode.rows = rows;
      for (const pixel of rows.flat())
        if (pixel === null) coverage.unknown_pixels++;
        else if (typeof pixel === "object") coverage.partial_pixels++;
    }
  }
};
