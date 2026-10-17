import { isMmc5State } from "./nesMmc5.js";
import type { NesPpuMmc5BackgroundGeometry } from "./nesPpuMmc5BackgroundSelection.js";
import { deriveNesPpuMmc5Background } from "./nesPpuMmc5BackgroundDerivation.js";
import { scheduler } from "node:timers/promises";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesPpuState } from "./nesPpuState.js";
import type { NesPpuPatternTable } from "./nesPpuPattern.js";
import {
  nesPpuPatternSourceIdentity,
  nesPpuPatternBlockUnresolved,
} from "./nesPpuPattern.js";
import type { NesPpuSprites } from "./nesPpuSprites.js";
import type {
  NesPpuViewport,
  NesPpuViewportSelection,
} from "./nesPpuViewport.js";
import { deriveNesPpuPatternTable } from "./nesPpuPatternDerivation.js";
import { deriveNesPpuSprites } from "./nesPpuSpritesDerivation.js";
import { NesPpuViewportBackground } from "./nesPpuViewportBackground.js";
import {
  NesPpuViewportSprites,
  type NesPpuSpriteWinners,
} from "./nesPpuViewportSprites.js";
import {
  nesPpuPaletteAddresses,
  nesPpuPaletteIndex,
  readNesPpuPaletteCell,
} from "./nesPpuPalette.js";
import {
  nesByteBits,
  nesByteCandidates,
  type NesByteValue,
} from "./nesByteValue.js";

type Mode = NesPpuViewport["modes"][number];
const hex = (mask: bigint): string => mask.toString(16).padStart(16, "0");
const allCodes = (1n << 64n) - 1n;
const flags = (value: NesByteValue, bit: number): boolean[] => {
  const known = nesByteBits(value, bit);
  return known === null ? [false, true] : [known !== 0];
};
const forcedPalette = (ppu: NesPpuState): number => {
  let mask = 0;
  for (const high of new Set(
    nesByteCandidates(ppu.v.high).map((value) => value & 63),
  ))
    if (high === 63)
      for (const low of new Set(
        nesByteCandidates(ppu.v.low).map((value) => value & 31),
      ))
        mask |= 1 << nesPpuPaletteIndex(low);
    else mask |= 1;
  return mask;
};

type Blend = {
  palette: number;
  layers: number;
  front: bigint;
  visible: bigint;
};
class ViewportComposer {
  private readonly winners: NesPpuViewportSprites;
  private readonly codeCache = new Map<number, bigint>();
  private readonly blank: number;
  private readonly backgroundEnabled: boolean[];
  private readonly spritesEnabled: boolean[];
  private readonly leftBackground: boolean[];
  private readonly leftSprites: boolean[];
  constructor(
    private readonly context: {
      ppu: NesPpuState;
      sprites: NesPpuSprites;
      background: NesPpuViewportBackground;
      selection: NesPpuViewportSelection;
      paletteCodes: bigint[];
    },
  ) {
    this.winners = new NesPpuViewportSprites(context.sprites);
    this.blank = forcedPalette(context.ppu);
    this.backgroundEnabled = flags(context.ppu.mask, 8);
    this.spritesEnabled = flags(context.ppu.mask, 16);
    this.leftBackground = flags(context.ppu.mask, 2);
    this.leftSprites = flags(context.ppu.mask, 4);
  }
  async mode(spriteHeight: 8 | 16, signal?: AbortSignal): Promise<Mode> {
    const nomination = this.context.sprites.scanline_selection.modes.find(
        (mode) => mode.height === spriteHeight,
      )!,
      pixelStates: Mode["pixel_states"] = [],
      rows: number[][] = [],
      indices = new Map<string, number>(),
      coverage: Mode["coverage"] = {
        examined_pixels: 61440,
        ambiguous_palette_pixels: 0,
        ambiguous_code_pixels: 0,
        unknown_code_pixels: 0,
      };
    for (let y = 0; y < 240; y++) {
      await scheduler.yield();
      signal?.throwIfAborted();
      const row: number[] = [];
      for (let x = 0; x < 256; x++) {
        const background = this.context.background.sample(
            (this.context.selection.origin_x + x) % 512,
            (this.context.selection.origin_y + y) % 480,
            x,
            y,
          ),
          state = this.blend(background, x, () =>
            this.winners.sample(
              spriteHeight,
              nomination.lines[y]!.candidate_set,
              x,
            ),
          ),
          codes = this.codes(state.palette),
          key = `${state.palette}/${state.layers}/${state.front}/${state.visible}`;
        if ((state.palette & (state.palette - 1)) !== 0)
          coverage.ambiguous_palette_pixels++;
        if (codes === allCodes) coverage.unknown_code_pixels++;
        else if ((codes & (codes - 1n)) !== 0n)
          coverage.ambiguous_code_pixels++;
        let reference = indices.get(key);
        if (reference === undefined) {
          reference = pixelStates.length;
          indices.set(key, reference);
          pixelStates.push({
            palette_mask: state.palette,
            code_mask: hex(codes),
            layers: state.layers,
            front_sprites: hex(state.front),
            visible_sprites: hex(state.visible),
          });
        }
        row.push(reference);
      }
      rows.push(row);
    }
    return {
      sprite_height: spriteHeight,
      pixel_states: pixelStates,
      rows,
      coverage,
    };
  }
  private codes(palette: number): bigint {
    const cached = this.codeCache.get(palette);
    if (cached !== undefined) return cached;
    let result = 0n;
    for (let index = 0; index < 28; index++)
      if (palette & (1 << index)) result |= this.context.paletteCodes[index]!;
    this.codeCache.set(palette, result);
    return result;
  }
  private blend(
    background: number,
    x: number,
    sample: () => NesPpuSpriteWinners,
  ): Blend {
    const result: Blend = { palette: 0, layers: 0, front: 0n, visible: 0n };
    let winners: NesPpuSpriteWinners | undefined;
    for (const bg of this.backgroundEnabled)
      for (const sp of this.spritesEnabled) {
        if (!bg && !sp) {
          result.palette |= this.blank;
          result.layers |= 8;
          continue;
        }
        for (const drawBackground of bg
          ? x < 8
            ? this.leftBackground
            : [true]
          : [false])
          for (const drawSprites of sp
            ? x < 8
              ? this.leftSprites
              : [true]
            : [false]) {
            const colors = drawBackground ? background : 1;
            if (drawSprites) {
              winners ??= sample();
              this.spriteBlend(result, colors, winners);
            } else this.fallback(result, colors);
          }
      }
    return result;
  }
  private fallback(result: Blend, background: number): void {
    result.palette |= background;
    if (background & 1) result.layers |= 1;
    if (background & ~1) result.layers |= 2;
  }
  private spriteBlend(
    result: Blend,
    background: number,
    winners: NesPpuSpriteWinners,
  ): void {
    result.front |= winners.front_sprites | winners.back_sprites;
    if (background & 1) {
      const sprites = winners.front_palette | winners.back_palette;
      if (sprites !== 0) {
        result.palette |= sprites;
        result.layers |= 4;
        result.visible |= winners.front_sprites | winners.back_sprites;
      }
    }
    if (background & ~1) {
      if (winners.front_palette) {
        result.palette |= winners.front_palette;
        result.layers |= 4;
        result.visible |= winners.front_sprites;
      }
      if (winners.back_palette) {
        result.palette |= background & ~1;
        result.layers |= 2;
      }
    }
    if (winners.none) this.fallback(result, background);
  }
}

/** Interpret committed final facts; no mapper/PPU state or event history advances. */
export const deriveNesPpuViewport = async (
  header: NesRomMetadata,
  mapper: NesMapperState,
  ppu: NesPpuState,
  context: {
    selection: NesPpuViewportSelection;
    chr?: Uint8Array | undefined;
    signal?: AbortSignal | undefined;
    mmc5Background?: NesPpuMmc5BackgroundGeometry | null | undefined;
  },
): Promise<NesPpuViewport> => {
  const patterns = new Map<0 | 1, NesPpuPatternTable>(),
    bit = nesByteBits(ppu.control, 16),
    tables: (0 | 1)[] = bit === null ? [0, 1] : bit === 0 ? [0] : [1];
  for (const table of tables)
    patterns.set(
      table,
      await deriveNesPpuPatternTable(
        header,
        mapper,
        ppu,
        table,
        context.chr,
        context.signal,
        "background",
      ),
    );
  const projected =
    context.mmc5Background != null && isMmc5State(mapper)
      ? await deriveNesPpuMmc5Background({
          header,
          mapper,
          ppu,
          chr: context.chr,
          signal: context.signal,
          qualification: context.mmc5Background,
          originX: context.selection.origin_x,
          originY: context.selection.origin_y,
        })
      : null;
  const sprites = await deriveNesPpuSprites(header, mapper, ppu, {
      chr: context.chr,
      signal: context.signal,
      patterns,
    }),
    background = new NesPpuViewportBackground({
      header,
      mapper,
      ppu,
      patterns,
      chr: context.chr,
      mmc5Projection: projected?.projection,
    }),
    palette = nesPpuPaletteAddresses.map((address) =>
      readNesPpuPaletteCell(ppu, address),
    ),
    composer = new ViewportComposer({
      ppu,
      sprites,
      background,
      selection: context.selection,
      paletteCodes: palette.map((cell) => cell.code_mask),
    });
  const sourcePages: NesPpuViewport["chr_source_pages"] = [],
    indices = new Map<string, number>(),
    blockMap = new Map<string, NesPpuViewport["chr_blocks"][number]>();
  const views = [
    ...[...patterns.values()].map((view) => ({
      view,
      query_role: "background" as const,
    })),
    { view: sprites, query_role: "sprite" as const },
  ];
  for (const { view, query_role } of views) {
    const remap = view.source_pages.map((page) => {
      const key = nesPpuPatternSourceIdentity(page);
      let index = indices.get(key);
      if (index === undefined) {
        index = sourcePages.length;
        indices.set(key, index);
        sourcePages.push(page);
      }
      return index;
    });
    for (const block of view.blocks) {
      const key = `${mapper.mapper === 5 ? query_role : ""}:${block.ppu_address}`;
      if (!blockMap.has(key))
        blockMap.set(key, {
          ...block,
          sources: block.sources.map((index) => remap[index]!),
          ...(mapper.mapper === 5 ? { query_role } : {}),
        });
    }
  }
  let projection = projected?.projection;
  if (projected !== null) {
    const remap = projected.chrSourcePages.map((page) => {
      const key = nesPpuPatternSourceIdentity(page);
      let index = indices.get(key);
      if (index === undefined) {
        index = sourcePages.length;
        indices.set(key, index);
        sourcePages.push(page);
      }
      return index;
    });
    projection = {
      ...projected.projection,
      chr_pages: projected.projection.chr_pages.map((index) => remap[index]!),
    };
  }
  const modes: Mode[] = [];
  for (const mode of sprites.scanline_selection.modes)
    modes.push(await composer.mode(mode.height, context.signal));
  const blocks = [...blockMap.values()].sort(
    (left, right) =>
      left.ppu_address - right.ppu_address ||
      ("query_role" in left && "query_role" in right
        ? compareUnicodeCodePoints(left.query_role, right.query_role)
        : 0),
  );
  return {
    interpretation: "frozen-viewport-envelope",
    origin_x: context.selection.origin_x,
    origin_y: context.selection.origin_y,
    width: 256,
    height: 240,
    palette_cells: palette.map(({ address, value, code_mask }) => ({
      address,
      value,
      code_mask: hex(code_mask),
    })),
    chr_source_page_bytes: 1024,
    chr_source_pages: sourcePages,
    chr_blocks: blocks,
    nametables: background.nametables,
    modes,
    unresolved_chr_blocks: blocks.filter((block) =>
      nesPpuPatternBlockUnresolved(block, sourcePages),
    ).length,
    ...(projection === undefined ? {} : { mmc5_background: projection }),
  };
};
