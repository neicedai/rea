import type { NesPpuNametableMetadata } from "./nesPpuNametableMetadata.js";
import type { NesPpuNametable } from "./nesPpuNametable.js";
import type { NesPpuMmc5BackgroundProjection } from "./nesPpuMmc5Background.js";
import type { NesPpuPatternSourcePage } from "./nesPpuPattern.js";
import {
  joinNesBytes,
  nesByteProof,
  nesTwoBitProof,
  type NesByteValue,
} from "./nesByteValue.js";
import { ppuBits } from "./nesPpuAddress.js";

const common = (values: NesByteValue[]): NesByteValue =>
  values.length === 0 ? null : values.reduce(joinNesBytes);
const paletteProof = (choices: number[]) => {
  const bits = ppuBits(common(choices));
  return nesTwoBitProof(bits.mask, bits.value);
};
/** Legacy summaries are effective envelopes; the row projection owns exact source correlation. */
export const mmc5ProjectedNametableSummary = (
  base: NesPpuNametableMetadata,
  projection: NesPpuMmc5BackgroundProjection,
  chrSourcePages: NesPpuPatternSourcePage[],
): NesPpuNametable => {
  const palettes: number[][] = [],
    cells = Array.from({ length: 960 }, (_, index) => {
      const x = index & 31,
        y = index >> 5;
      const cell = {
        x,
        y,
        attribute: (y >> 2) * 8 + (x >> 2),
        quadrant: ((y >> 1) & 1) * 2 + ((x >> 1) & 1),
      };
      const tiles: NesByteValue[] = [],
        choices = new Set<number>();
      for (let fine = 0; fine < 8; fine++) {
        const row =
          projection.row_states[projection.rows[cell.y * 8 + fine]![cell.x]!]!;
        for (const index of row.branches) {
          const branch = projection.branches[index]!;
          tiles.push(projection.source_pairs[branch.source_pair]!.tile);
          for (const palette of branch.palette_choices) choices.add(palette);
        }
      }
      palettes.push([...choices].sort((a, b) => a - b));
      return { ...cell, tile_index: common(tiles) };
    });
  const attributes = Array.from({ length: 64 }, (_, index) => {
    let mask = 0,
      value = 0;
    const quadrants = [0, 1, 2, 3].map((quadrant) => {
      const choices = [
        ...new Set(
          cells.flatMap((cell, cellIndex) =>
            cell.attribute === index && cell.quadrant === quadrant
              ? palettes[cellIndex]!
              : [],
          ),
        ),
      ].sort((a, b) => a - b);
      const proof = paletteProof(choices.length === 0 ? [0, 1, 2, 3] : choices),
        bits = ppuBits(proof);
      mask |= (bits.mask & 3) << (quadrant * 2);
      value |= (bits.value & 3) << (quadrant * 2);
      return {
        value: proof,
        choices: choices.length === 0 ? [0, 1, 2, 3] : choices,
      };
    });
    return { offset: 960 + index, value: nesByteProof(mask, value), quadrants };
  });
  const coverage = {
    examined_cells: 960 as const,
    examined_attributes: 64 as const,
    unknown_palette_codes: base.palette_cells.filter(
      (cell) => cell.code === null,
    ).length,
    partial_palette_codes: base.palette_cells.filter(
      (cell) => cell.code !== null && typeof cell.code === "object",
    ).length,
    unknown_tile_indices: 0,
    partial_tile_indices: 0,
    unknown_subpalettes: 0,
    partial_subpalettes: 0,
    ambiguous_subpalettes: 0,
    unresolved_source:
      projection.row_states.some((state) => state.branches.length !== 1) ||
      projection.branches.some((branch) => branch.unresolved_reason !== null) ||
      projection.pattern_sets.some(
        (pattern) =>
          pattern.kind === "unknown" ||
          (pattern.kind === "4k"
            ? pattern.banks.length !== 1
            : pattern.groups.some((group) => group.banks.length !== 1)),
      ),
  };
  for (const [index, cell] of cells.entries()) {
    if (cell.tile_index === null) coverage.unknown_tile_indices++;
    else if (typeof cell.tile_index === "object")
      coverage.partial_tile_indices++;
    const choices = palettes[index]!,
      proof = paletteProof(choices);
    if (proof === null) coverage.unknown_subpalettes++;
    else if (typeof proof === "object") coverage.partial_subpalettes++;
    if (choices.length !== 1) coverage.ambiguous_subpalettes++;
  }
  const source_pages = [
    ...new Map(
      projection.source_pairs
        .flatMap((pair) => [pair.tile_source, pair.attribute.source])
        .map((source) => [JSON.stringify(source), source]),
    ).values(),
  ];
  const reason =
    projection.branches.find((branch) => branch.unresolved_reason !== null)
      ?.unresolved_reason ?? null;
  return {
    ...base,
    cells,
    attributes,
    source_pages,
    reason,
    coverage,
    attributes_model: "effective-quadrant-envelope",
    chr_source_page_bytes: 1024,
    chr_source_pages: chrSourcePages,
    mmc5_background: projection,
  };
};
