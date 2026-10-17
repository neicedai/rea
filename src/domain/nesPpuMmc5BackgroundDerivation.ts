import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import type { NesMmc5State } from "./nesMmc5.js";
import type { NesPpuState } from "./nesPpuState.js";
import type { NesPpuMmc5BackgroundGeometry } from "./nesPpuMmc5BackgroundSelection.js";
import type { NesPpuMmc5BackgroundProjection } from "./nesPpuMmc5Background.js";
import {
  createMmc5FrozenTileProjector,
  advanceMmc5FrozenSplitY,
  type NesMmc5FrozenTileBranch,
} from "./nesMmc5FrozenTile.js";
import {
  nesPpuNametablePages,
  captureNesPpuNametablePages,
  readNesPpuNametablePage,
} from "./nesPpuMemory.js";
import type { NesPpuPatternSourcePage } from "./nesPpuPattern.js";
import type { NesPpuNametableSourcePage } from "./nesPpuNametableSource.js";
import { nesByteBits } from "./nesByteValue.js";

type Projection = NesPpuMmc5BackgroundProjection;
type Pair = Projection["source_pairs"][number];
type Pattern = Projection["pattern_sets"][number];
type Branch = Projection["branches"][number];
const sorted = (values: Iterable<number>) =>
  [...new Set(values)].sort((a, b) => a - b);
class Pool<T> {
  readonly values: T[] = [];
  private readonly indices = new Map<string, number>();
  add(value: T): number {
    const key = JSON.stringify(value),
      existing = this.indices.get(key);
    if (existing !== undefined) return existing;
    const index = this.values.length;
    this.indices.set(key, index);
    this.values.push(structuredClone(value));
    return index;
  }
}
const sourcePair = (branch: NesMmc5FrozenTileBranch): Pair => ({
  tile_source: branch.tile_source,
  tile_address: branch.tile_address,
  tile: branch.tile,
  tile_origin: branch.tile_origin,
  attribute: branch.attribute,
  coupling: branch.coupling,
});
const patternSet = (branch: NesMmc5FrozenTileBranch): Pattern =>
  branch.pattern.kind === "4k"
    ? { kind: "4k", banks: branch.pattern.banks }
    : branch.pattern;
class BackgroundPools {
  readonly pairs = new Pool<Pair>();
  readonly patterns = new Pool<Pattern>();
  readonly branches = new Pool<Branch>();
  private readonly patternIndices = new WeakMap<object, number>();
  private readonly pairIndices = new Map<string, number>();
  private readonly rowIndices = new WeakMap<object, Map<number, number[]>>();
  private pattern(branch: NesMmc5FrozenTileBranch): number {
    const existing = this.patternIndices.get(branch.pattern);
    if (existing !== undefined) return existing;
    const index = this.patterns.add(patternSet(branch));
    this.patternIndices.set(branch.pattern, index);
    return index;
  }
  private pair(branch: NesMmc5FrozenTileBranch): number {
    // The producer owns one immutable query snapshot: physical coordinates and
    // generated register-source identities select the same captured facts.
    const key = JSON.stringify([
      branch.tile_source,
      branch.tile_address,
      branch.attribute.source,
      branch.attribute.address,
      branch.attribute.shift,
      branch.coupling,
    ]);
    const existing = this.pairIndices.get(key);
    if (existing !== undefined) return existing;
    const index = this.pairs.add(sourcePair(branch));
    this.pairIndices.set(key, index);
    return index;
  }
  add(branches: readonly NesMmc5FrozenTileBranch[], row: number): number[] {
    const rowKey = branches.some((branch) => branch.pattern.kind === "ordinary")
      ? row
      : -1;
    let cached = this.rowIndices.get(branches);
    const existing = cached?.get(rowKey);
    if (existing !== undefined) return existing;
    const groups = new Map<string, Branch>();
    for (const branch of branches) {
      const base = {
        path: branch.path,
        source_pair: this.pair(branch),
        pattern_set: this.pattern(branch),
        palette_choices: branch.palette_choices,
        unresolved_reason: branch.unresolved_reason,
        split_coarse_y: branch.split_y === null ? null : branch.split_y >> 3,
      };
      const key = JSON.stringify(base),
        fine = branch.pattern.kind === "4k" ? branch.pattern.rows : [row];
      const previous = groups.get(key);
      groups.set(key, {
        ...base,
        pattern_rows: sorted([...(previous?.pattern_rows ?? []), ...fine]),
      });
    }
    const result = sorted(
      [...groups.values()].map((branch) => this.branches.add(branch)),
    );
    if (cached === undefined) {
      cached = new Map();
      this.rowIndices.set(branches, cached);
    }
    cached.set(rowKey, result);
    return result;
  }
}
type Context = {
  header: NesRomMetadata;
  mapper: NesMmc5State;
  ppu: NesPpuState;
  qualification: NesPpuMmc5BackgroundGeometry;
  originX: number;
  originY: number;
  chr?: Uint8Array | undefined;
  signal?: AbortSignal | undefined;
};
const ordinaryReader = ({ header, mapper, ppu, chr }: Context) => {
  const pages = new Map<number, NesPpuNametableSourcePage[]>();
  return (address: number) => {
    const page = (address >> 10) & 3,
      offset = address & 1023;
    let sources = pages.get(page);
    if (sources === undefined) {
      sources = captureNesPpuNametablePages(
        header,
        nesPpuNametablePages(header, mapper, ppu, page, "ppudata"),
        chr,
      );
      pages.set(page, sources);
    }
    const attribute = 960 + ((offset >> 5) >> 2) * 8 + ((offset & 31) >> 2);
    return sources.map((source) => ({
      source,
      tile: readNesPpuNametablePage(header, ppu, source, offset, chr, mapper)
        .value,
      attribute: readNesPpuNametablePage(
        header,
        ppu,
        source,
        attribute,
        chr,
        mapper,
      ).value,
    }));
  };
};
const captureChrPages = (
  context: Context,
  offsets: Iterable<number>,
  unknownReason: string | null,
): NesPpuPatternSourcePage[] => {
  const { header, chr } = context;
  const pages: NesPpuPatternSourcePage[] = sorted(offsets).map(
    (file_offset) => ({
      kind: "rom",
      file_offset,
      bytes_hex:
        chr?.length === header.chrRom.size
          ? Buffer.from(
              chr.subarray(
                file_offset - header.chrRom.offset,
                file_offset - header.chrRom.offset + 1024,
              ),
            ).toString("hex")
          : null,
    }),
  );
  if (unknownReason !== null)
    pages.push({ kind: "unknown", reason: unknownReason });
  return pages;
};

/** One immutable per-query owner pairs source facts before any legacy summary joins. */
export const deriveNesPpuMmc5Background = async (
  context: Context,
): Promise<{
  projection: Projection;
  chrSourcePages: NesPpuPatternSourcePage[];
}> => {
  const { header, mapper, ppu, qualification, originX, originY, signal } =
    context;
  const bit = nesByteBits(ppu.control, 16),
    patternTables: (0 | 1)[] = bit === null ? [0, 1] : bit === 0 ? [0] : [1];
  const projector = createMmc5FrozenTileProjector({
    header,
    mapper,
    chr: context.chr,
    patternTables,
  });
  const ordinary = ordinaryReader(context),
    pools = new BackgroundPools(),
    states = new Pool<Projection["row_states"][number]>();
  const fineX = originX & 7,
    columns = fineX === 0 ? 32 : 33;
  const geometry: Projection["geometry_rows"] = [],
    rows: number[][] = [],
    chrPages = new Set<number>();
  let unknownReason: string | null = null;
  for (let y = 0; y < 240; y++) {
    await scheduler.yield();
    signal?.throwIfAborted();
    const worldY = (originY + y) % 480,
      cy = (worldY % 240) >> 3,
      row = worldY & 7;
    const splitY = advanceMmc5FrozenSplitY(qualification.split_y_at_origin, y);
    geometry.push({ query_y: y, ordinary_row: row, split_y: splitY });
    const references: number[] = [];
    for (let column = 0; column < columns; column++) {
      const worldX = ((originX & ~7) + column * 8) % 512;
      const page = (worldX >> 8) + (worldY >= 240 ? 2 : 0);
      const address = 0x2000 + page * 1024 + cy * 32 + ((worldX & 255) >> 3);
      const result = projector.projectRow({
        nametableAddress: address,
        row,
        ordinary: ordinary(address),
        screenColumn: (qualification.first_screen_column + column) & 31,
        splitY,
      });
      for (const page of result.chrPages) chrPages.add(page);
      for (const branch of result.branches)
        if (branch.pattern.kind === "unknown")
          unknownReason = "mmc5-background-unresolved";
      references.push(
        states.add({
          geometry: y,
          branches: pools.add(result.branches, row),
          pixel_index_masks: result.pixelIndexMasks,
          palette_index_masks: result.paletteIndexMasks,
        }),
      );
    }
    rows.push(references);
  }
  signal?.throwIfAborted();
  const chrSourcePages = captureChrPages(context, chrPages, unknownReason);
  return {
    chrSourcePages,
    projection: {
      interpretation: "mmc5-frozen-background",
      qualification: structuredClone(qualification),
      width: 256,
      height: 240,
      first_tile_fine_x: fineX,
      columns,
      chr_pages: chrSourcePages.map((_, index) => index),
      source_pairs: pools.pairs.values,
      pattern_sets: pools.patterns.values,
      branches: pools.branches.values,
      geometry_rows: geometry,
      row_states: states.values,
      rows,
    },
  };
};

export const mmc5ProjectedRow = (
  projection: Projection,
  x: number,
  y: number,
) =>
  projection.row_states[
    projection.rows[y]![(x + projection.first_tile_fine_x) >> 3]!
  ]!;
export const mmc5ProjectedPalette = (
  projection: Projection,
  x: number,
  y: number,
): number =>
  mmc5ProjectedRow(projection, x, y).palette_index_masks[
    (x + projection.first_tile_fine_x) & 7
  ]!;
