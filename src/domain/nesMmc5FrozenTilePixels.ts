import type { NesRomMetadata } from "./nes.js";
import { nesByteCandidates } from "./nesByteValue.js";
import type {
  NesMmc5FrozenTileBranch,
  NesMmc5FrozenTileRow,
} from "./nesMmc5FrozenTile.js";
type Branch = NesMmc5FrozenTileBranch;
type Decoded = Omit<NesMmc5FrozenTileRow, "branches">;
const sorted = (values: Iterable<number>): number[] =>
  [...new Set(values)].sort((a, b) => a - b);
const freezeDecoded = (result: Decoded): Decoded => {
  Object.freeze(result.pixelIndexMasks);
  Object.freeze(result.paletteIndexMasks);
  Object.freeze(result.chrPages);
  return Object.freeze(result);
};
const unresolved = (
  palettes: readonly number[],
  chrPages: number[] = [],
): Decoded => ({
  pixelIndexMasks: Array<number>(8).fill(15),
  paletteIndexMasks: Array<number>(8).fill(
    palettes.reduce((mask, palette) => mask | (14 << (palette * 4)), 1),
  ),
  chrPages,
});
const includePixels = (
  result: Pick<Decoded, "pixelIndexMasks" | "paletteIndexMasks">,
  low: number,
  high: number,
  palettes: number[],
): void => {
  for (let x = 0; x < 8; x++) {
    const bit = 7 - x,
      pixel = ((low >> bit) & 1) | (((high >> bit) & 1) << 1);
    result.pixelIndexMasks[x]! |= 1 << pixel;
    for (const palette of palettes)
      result.paletteIndexMasks[x]! |=
        1 << (pixel === 0 ? 0 : palette * 4 + pixel);
  }
};
const offsetsFor = (
  branch: Branch,
  tile: number,
  row: number,
  header: NesRomMetadata,
): number[] => {
  if (branch.pattern.kind === "unknown") return [];
  if (branch.pattern.kind === "ordinary")
    return branch.pattern.groups
      .filter((group) => group.tile_page === tile >> 6)
      .flatMap((group) =>
        group.banks.map((bank) => bank * 1024 + (tile & 63) * 16 + row),
      );
  const lowMask = Math.min(63, header.chrRom.size / 4096 - 1);
  return branch.pattern.banks
    .filter(
      (bank) =>
        branch.coupling !== "tile-extended-attribute" ||
        (bank & lowMask) === (tile & lowMask),
    )
    .map((bank) => bank * 4096 + tile * 16 + row);
};
const decodePixels = (
  branch: Branch,
  row: number,
  snapshot: {
    header: NesRomMetadata;
    chr: Uint8Array | undefined;
    chrPages: number[];
  },
): Decoded => {
  const { header, chr, chrPages } = snapshot;
  if (
    branch.pattern.kind === "unknown" ||
    chr === undefined ||
    chr.length !== header.chrRom.size ||
    chrPages.length === 0
  )
    return unresolved(branch.palette_choices, chrPages);
  const result: Decoded = {
      pixelIndexMasks: Array<number>(8).fill(0),
      paletteIndexMasks: Array<number>(8).fill(0),
      chrPages,
    },
    rows = branch.pattern.kind === "4k" ? branch.pattern.rows : [row];
  for (const tile of nesByteCandidates(branch.tile)) {
    const palettes =
      branch.coupling === "independent"
        ? branch.palette_choices
        : [(tile >> branch.attribute.shift) & 3];
    for (const y of rows)
      for (const offset of offsetsFor(branch, tile, y, header))
        includePixels(result, chr[offset]!, chr[offset + 8]!, palettes);
  }
  return result;
};
const createPhysicalPages = (header: NesRomMetadata) => {
  const selectors = new Map<string, number[]>(),
    sets = new Map<string, number[]>(),
    identities = new WeakMap<object, number>();
  let nextIdentity = 0;
  const identity = (value: object): number => {
    let result = identities.get(value);
    if (result === undefined) {
      result = nextIdentity++;
      identities.set(value, result);
    }
    return result;
  };
  const intern = (pages: number[]): number[] => {
    const key = pages.join(":"),
      existing = sets.get(key);
    if (existing !== undefined) return existing;
    Object.freeze(pages);
    sets.set(key, pages);
    return pages;
  };
  return {
    identity,
    intern,
    forBranch(branch: Branch): number[] {
      const physical =
          branch.pattern.kind === "4k" ? branch.pattern.banks : branch.pattern,
        key = JSON.stringify([
          identity(physical),
          branch.tile,
          branch.coupling,
        ]),
        existing = selectors.get(key);
      if (existing !== undefined) return existing;
      const pages = new Set<number>();
      for (const tile of nesByteCandidates(branch.tile))
        for (const offset of offsetsFor(branch, tile, 0, header))
          pages.add(header.chrRom.offset + Math.floor(offset / 1024) * 1024);
      const result = intern(sorted(pages));
      selectors.set(key, result);
      return result;
    },
  };
};
const joinDecoded = (
  results: Iterable<Decoded>,
  physical: ReturnType<typeof createPhysicalPages>,
): Decoded => {
  const pixelIndexMasks = Array<number>(8).fill(0),
    paletteIndexMasks = Array<number>(8).fill(0),
    pageSets = new Set<number[]>();
  for (const result of new Set(results)) {
    for (let x = 0; x < 8; x++) {
      pixelIndexMasks[x]! |= result.pixelIndexMasks[x]!;
      paletteIndexMasks[x]! |= result.paletteIndexMasks[x]!;
    }
    pageSets.add(result.chrPages);
  }
  const pages = new Set<number>();
  for (const set of pageSets) for (const page of set) pages.add(page);
  return freezeDecoded({
    pixelIndexMasks,
    paletteIndexMasks,
    chrPages: physical.intern(sorted(pages)),
  });
};
/** Pixel results and row-independent physical page sets belong to one immutable operation. */
export const createMmc5FrozenTilePixels = (
  header: NesRomMetadata,
  chr: Uint8Array | undefined,
  patternId: (pattern: Branch["pattern"]) => number,
) => {
  const physical = createPhysicalPages(header),
    semantic = new Map<string, Decoded>(),
    direct = new WeakMap<Branch, Map<number, Decoded>>(),
    rows = new WeakMap<Branch[], Map<number, Decoded>>();
  const decode = (branch: Branch, row: number): Decoded => {
    const rowKey = branch.pattern.kind === "ordinary" ? row : -1;
    let retained = direct.get(branch),
      result = retained?.get(rowKey);
    if (result !== undefined) return result;
    const key = JSON.stringify([
      branch.tile,
      branch.attribute.value,
      branch.attribute.shift,
      branch.palette_choices,
      patternId(branch.pattern),
      branch.coupling,
      rowKey,
    ]);
    result = semantic.get(key);
    if (result === undefined) {
      result = freezeDecoded(
        decodePixels(branch, row, {
          header,
          chr,
          chrPages: physical.forBranch(branch),
        }),
      );
      semantic.set(key, result);
    }
    if (retained === undefined) {
      retained = new Map();
      direct.set(branch, retained);
    }
    retained.set(rowKey, result);
    return result;
  };
  return {
    project(branches: Branch[], row: number): Decoded {
      const rowKey = branches.some(
        (branch) => branch.pattern.kind === "ordinary",
      )
        ? row
        : -1;
      let retained = rows.get(branches),
        result = retained?.get(rowKey);
      if (result !== undefined) return result;
      result = joinDecoded(
        branches.map((branch) => decode(branch, row)),
        physical,
      );
      if (retained === undefined) {
        retained = new Map();
        rows.set(branches, retained);
      }
      retained.set(rowKey, result);
      return result;
    },
  };
};
