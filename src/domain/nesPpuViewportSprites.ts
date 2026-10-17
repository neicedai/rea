import type { NesPpuSprites } from "./nesPpuSprites.js";
import { nesByteCandidates } from "./nesByteValue.js";
import { nesPpuPixelMask } from "./nesPpuPixel.js";
import { nesPpuPaletteIndex } from "./nesPpuPalette.js";

export type NesPpuSpriteWinners = {
  front_palette: number;
  back_palette: number;
  front_sprites: bigint;
  back_sprites: bigint;
  none: boolean;
};
const spriteBits = Array.from(
  { length: 64 },
  (_, index) => 1n << BigInt(index),
);
const popcount = (mask: number): number => {
  let result = 0;
  for (; mask; mask &= mask - 1) result++;
  return result;
};

/** Counts survive transparent/off-pixel nominees; the first opaque nominee wins. */
export class NesPpuViewportSprites {
  private readonly xValues: Set<number>[];
  private readonly cache = new Map<string, NesPpuSpriteWinners>();
  private readonly colors = new Map<number, number>();
  constructor(private readonly sprites: NesPpuSprites) {
    this.xValues = sprites.sprites.map(
      (sprite) => new Set(nesByteCandidates(sprite.x)),
    );
  }
  sample(height: 8 | 16, candidateSet: number, x: number): NesPpuSpriteWinners {
    const key = `${height}/${candidateSet}/${x}`,
      cached = this.cache.get(key);
    if (cached !== undefined) return cached;
    const mode = this.sprites.scanline_selection.modes.find(
        (mode) => mode.height === height,
      )!,
      result: NesPpuSpriteWinners = {
        front_palette: 0,
        back_palette: 0,
        front_sprites: 0n,
        back_sprites: 0n,
        none: false,
      };
    let states = 1;
    for (const candidate of mode.candidate_sets[candidateSet]!) {
      if (states === 0 || states === 256) break;
      const sprite = this.sprites.sprites[candidate.sprite]!,
        canMiss = popcount(candidate.row_mask) !== sprite.top_rows.length,
        pixels = this.footprint(sprite.index, height, candidate.row_mask, x);
      if ((states & 255) !== 0 && (pixels & 14) !== 0) {
        const colors = this.palette(sprite.index, pixels & 14),
          bit = spriteBits[sprite.index]!;
        if (sprite.behind_background !== true) {
          result.front_palette |= colors;
          result.front_sprites |= bit;
        }
        if (sprite.behind_background !== false) {
          result.back_palette |= colors;
          result.back_sprites |= bit;
        }
      }
      states =
        (states & 256) |
        (canMiss ? states : 0) |
        (pixels & 1 ? (states & 255) << 1 : 0);
    }
    result.none = states !== 0;
    this.cache.set(key, result);
    return result;
  }
  private footprint(
    index: number,
    height: 8 | 16,
    rows: number,
    x: number,
  ): number {
    const sprite = this.sprites.sprites[index]!,
      mode = sprite.modes.find((mode) => mode.height === height)!,
      positions = this.xValues[index]!;
    let covered = 0,
      pixels = 0;
    for (let column = 0; column < 8; column++)
      if (positions.has(x - column)) {
        covered++;
        for (let row = 0; row < height; row++)
          if (rows & (1 << row))
            pixels |= nesPpuPixelMask(mode.rows[row]![column]!);
      }
    return pixels | (covered < positions.size ? 1 : 0);
  }
  private palette(index: number, pixels: number): number {
    const key = (index << 4) | pixels,
      cached = this.colors.get(key);
    if (cached !== undefined) return cached;
    const subpalettes = nesPpuPixelMask(
      this.sprites.sprites[index]!.subpalette,
    );
    let colors = 0;
    for (let palette = 0; palette < 4; palette++)
      if (subpalettes & (1 << palette))
        for (let pixel = 1; pixel < 4; pixel++)
          if (pixels & (1 << pixel))
            colors |= 1 << nesPpuPaletteIndex(16 + palette * 4 + pixel);
    this.colors.set(key, colors);
    return colors;
  }
}
