import type { NesPpuMmc5BackgroundProjection } from "./nesPpuMmc5Background.js";
import { mmc5ProjectedPalette } from "./nesPpuMmc5BackgroundDerivation.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesPpuState } from "./nesPpuState.js";
import type { NesPpuPatternTable } from "./nesPpuPattern.js";
import type { NesPpuViewport } from "./nesPpuViewport.js";
import {
  readNesPpuNametable,
  nesPpuNametablePages,
  captureNesPpuNametablePages,
  readNesPpuNametablePage,
} from "./nesPpuMemory.js";
import type { NesPpuNametableSourcePage } from "./nesPpuNametableSource.js";
import {
  nesByteBits,
  nesByteCandidates,
  type NesByteValue,
} from "./nesByteValue.js";
import { nesPpuPixelMask } from "./nesPpuPixel.js";
import { nesPpuPaletteIndex } from "./nesPpuPalette.js";
import { ppuBits } from "./nesPpuAddress.js";

type Cell = {
  tile: NesByteValue;
  palettes: number[];
  rows: (Uint16Array | undefined)[];
};
const tileIdentity = (tile: NesByteValue) =>
  typeof tile === "number"
    ? String(tile)
    : tile === null
      ? "?"
      : `${tile.mask}:${tile.value}`;
// Four subpalettes have twelve opaque entries plus their shared transparent zero.
const allBackgroundColors = [0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15].reduce(
  (mask, address) => mask | (1 << nesPpuPaletteIndex(address)),
  0,
);

/** Pair tile and attribute facts within one physical page before their colors join. */
export class NesPpuViewportBackground {
  readonly nametables: NesPpuViewport["nametables"];
  private readonly cells = new Map<number, Cell[]>();
  private readonly pixels = new Map<string, number>();
  private readonly cellPool = new Map<string, Cell>();
  private readonly tables: (0 | 1)[];
  constructor(
    private readonly context: {
      header: NesRomMetadata;
      mapper: NesMapperState;
      ppu: NesPpuState;
      patterns: ReadonlyMap<0 | 1, NesPpuPatternTable>;
      chr?: Uint8Array | undefined;
      mmc5Projection?: NesPpuMmc5BackgroundProjection | undefined;
    },
  ) {
    const { header, mapper, ppu } = context,
      bit = nesByteBits(ppu.control, 16);
    this.tables = bit === null ? [0, 1] : bit === 0 ? [0] : [1];
    const cache = new Map<
      number,
      Extract<NesPpuNametableSourcePage, { kind: "rom" }>
    >();
    this.nametables = [0, 1, 2, 3].map((page) => {
      const read = readNesPpuNametable(
        header,
        mapper,
        ppu,
        8192 + page * 1024,
        context.chr,
        "background",
      );
      return {
        page,
        source_pages: captureNesPpuNametablePages(
          header,
          nesPpuNametablePages(header, mapper, ppu, page, "background"),
          context.chr,
          cache,
        ),
        reason: read.reason,
      };
    });
  }
  sample(x: number, y: number, visibleX?: number, visibleY?: number): number {
    if (this.context.mmc5Projection !== undefined) {
      if (visibleX === undefined || visibleY === undefined)
        throw new Error(
          "Qualified MMC5 sampling requires visible query coordinates",
        );
      return mmc5ProjectedPalette(
        this.context.mmc5Projection,
        visibleX,
        visibleY,
      );
    }
    const page = (x >> 8) + (y >= 240 ? 2 : 0),
      cx = (x & 255) >> 3,
      cy = (y % 240) >> 3,
      key = page * 1024 + cy * 32 + cx;
    let cells = this.cells.get(key);
    if (cells === undefined) {
      const shift = (((cy >> 1) & 1) * 2 + ((cx >> 1) & 1)) * 2;
      const { header, ppu, chr } = this.context;
      cells = [
        ...new Set(
          this.nametables[page]!.source_pages.map((base) => {
            const attribute = ppuBits(
                readNesPpuNametablePage(
                  header,
                  ppu,
                  base,
                  960 + (cy >> 2) * 8 + (cx >> 2),
                  chr,
                  this.context.mapper,
                ).value,
              ),
              tile = readNesPpuNametablePage(
                header,
                ppu,
                base,
                cy * 32 + cx,
                chr,
                this.context.mapper,
              ).value,
              palettes = [0, 1, 2, 3].filter(
                (value) =>
                  (value & ((attribute.mask >> shift) & 3)) ===
                  ((attribute.value >> shift) & 3),
              ),
              key = `${tileIdentity(tile)}/${palettes.join(",")}`;
            let cell = this.cellPool.get(key);
            if (cell === undefined) {
              cell = { tile, palettes, rows: [] };
              this.cellPool.set(key, cell);
            }
            return cell;
          }),
        ),
      ];
      this.cells.set(key, cells);
    }
    if (cells.length === 0)
      return this.colors(
        this.pattern(null, x & 7, (y % 240) & 7),
        [0, 1, 2, 3],
      );
    let colors = 0;
    for (const cell of cells) {
      const sy = (y % 240) & 7;
      let row = cell.rows[sy];
      if (row === undefined) {
        row = Uint16Array.from({ length: 8 }, (_, sx) =>
          this.colors(this.pattern(cell.tile, sx, sy), cell.palettes),
        );
        cell.rows[sy] = row;
      }
      colors |= row[x & 7]!;
      if (colors === allBackgroundColors) break;
    }
    return colors;
  }
  private pattern(tile: NesByteValue, x: number, y: number): number {
    const identity = tileIdentity(tile),
      key = `${identity}/${x}/${y}`;
    const cached = this.pixels.get(key);
    if (cached !== undefined) return cached;
    let result = 0;
    for (const table of this.tables)
      for (const index of nesByteCandidates(tile)) {
        result |= nesPpuPixelMask(
          this.context.patterns.get(table)!.tiles[index]!.rows[y]![x]!,
        );
        if (result === 15) break;
      }
    this.pixels.set(key, result);
    return result;
  }
  private colors(pixels: number, palettes: number[]): number {
    let colors = pixels & 1;
    for (const palette of palettes)
      for (let pixel = 1; pixel < 4; pixel++)
        if (pixels & (1 << pixel))
          colors |= 1 << nesPpuPaletteIndex(palette * 4 + pixel);
    return colors;
  }
}
