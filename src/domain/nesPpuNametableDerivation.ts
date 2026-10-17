import { isMmc5State } from "./nesMmc5.js";
import type { NesPpuMmc5BackgroundGeometry } from "./nesPpuMmc5BackgroundSelection.js";
import { deriveNesPpuMmc5Background } from "./nesPpuMmc5BackgroundDerivation.js";
import { mmc5ProjectedNametableSummary } from "./nesPpuMmc5Nametable.js";
import { nesPpuNametableMetadata } from "./nesPpuNametableMetadata.js";
import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesPpuState } from "./nesPpuState.js";
import type {
  NesPpuNametable,
  NesPpuNametablePage,
} from "./nesPpuNametable.js";
import {
  readNesPpuNametable,
  nesPpuNametablePages,
  captureNesPpuNametablePages,
  readNesPpuNametablePage,
} from "./nesPpuMemory.js";
import {
  joinNesBytes,
  nesTwoBitProof,
  type NesByteValue,
} from "./nesByteValue.js";
import { ppuBits } from "./nesPpuAddress.js";

/** Interpret a logical background map without advancing any mapper or PPU state. */
export const deriveNesPpuNametable = async (
  header: NesRomMetadata,
  mapper: NesMapperState,
  ppu: NesPpuState,
  page: NesPpuNametablePage,
  signal?: AbortSignal,
  chr?: Uint8Array,
  mmc5Background: NesPpuMmc5BackgroundGeometry | null = null,
): Promise<NesPpuNametable> => {
  const metadata = nesPpuNametableMetadata(ppu, page);
  if (mmc5Background !== null && isMmc5State(mapper)) {
    const projected = await deriveNesPpuMmc5Background({
      header,
      mapper,
      ppu,
      chr,
      signal,
      qualification: mmc5Background,
      originX: (page & 1) * 256,
      originY: page >= 2 ? 240 : 0,
    });
    return mmc5ProjectedNametableSummary(
      metadata,
      projected.projection,
      projected.chrSourcePages,
    );
  }
  const address = 8192 + page * 1024,
    read = readNesPpuNametable(header, mapper, ppu, address, chr, "background"),
    sources = captureNesPpuNametablePages(
      header,
      nesPpuNametablePages(header, mapper, ppu, page, "background"),
      chr,
    );
  const valuesAt = (offset: number) =>
    sources.map(
      (source) =>
        readNesPpuNametablePage(header, ppu, source, offset, chr, mapper).value,
    );
  const common = (values: NesByteValue[]): NesByteValue =>
    values.length === 0 ? null : values.reduce(joinNesBytes);
  const attributes: NesPpuNametable["attributes"] = [],
    cells: NesPpuNametable["cells"] = [];
  const coverage: NesPpuNametable["coverage"] = {
    examined_cells: 960,
    examined_attributes: 64,
    unresolved_source:
      sources.length !== 1 ||
      sources.some(
        (source) => typeof source !== "number" && source.kind === "unknown",
      ),
    unknown_tile_indices: 0,
    partial_tile_indices: 0,
    unknown_subpalettes: 0,
    partial_subpalettes: 0,
    ambiguous_subpalettes: 0,
    unknown_palette_codes: 0,
    partial_palette_codes: 0,
  };
  for (let index = 0; index < 64; index++) {
    if (index % 16 === 0) {
      await scheduler.yield();
      signal?.throwIfAborted();
    }
    const values = valuesAt(960 + index);
    const quadrants = Array.from({ length: 4 }, (_, quadrant) => {
      const shift = quadrant * 2,
        bits = ppuBits(common(values));
      const choices = [0, 1, 2, 3].filter(
        (choice) =>
          values.length === 0 ||
          values.some((value) => {
            const source = ppuBits(value),
              mask = (source.mask >> shift) & 3;
            return (choice & mask) === ((source.value >> shift) & mask);
          }),
      );
      return {
        value: nesTwoBitProof(bits.mask >> shift, bits.value >> shift),
        choices,
      };
    });
    attributes.push({ offset: 960 + index, value: common(values), quadrants });
  }
  for (let y = 0; y < 30; y++) {
    await scheduler.yield();
    signal?.throwIfAborted();
    for (let x = 0; x < 32; x++) {
      const value = common(valuesAt(y * 32 + x)),
        attribute = (y >> 2) * 8 + (x >> 2),
        quadrant = ((y >> 1) & 1) * 2 + ((x >> 1) & 1),
        palette = attributes[attribute]!.quadrants[quadrant]!;
      if (value === null) coverage.unknown_tile_indices++;
      else if (typeof value === "object") coverage.partial_tile_indices++;
      if (palette.value === null) coverage.unknown_subpalettes++;
      else if (typeof palette.value === "object")
        coverage.partial_subpalettes++;
      if (palette.choices.length !== 1) coverage.ambiguous_subpalettes++;
      cells.push({ x, y, tile_index: value, attribute, quadrant });
    }
  }
  coverage.unknown_palette_codes = metadata.palette_cells.filter(
    (cell) => cell.code === null,
  ).length;
  coverage.partial_palette_codes = metadata.palette_cells.filter(
    (cell) => cell.code !== null && typeof cell.code === "object",
  ).length;
  signal?.throwIfAborted();
  return {
    ...metadata,
    source_pages: sources,
    reason: read.reason,
    cells,
    attributes,
    coverage,
  };
};
