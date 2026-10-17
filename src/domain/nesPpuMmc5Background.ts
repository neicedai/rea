import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";
import { nesMmc5ExramOriginSchema } from "./nesMmc5Exram.js";
import { nesPpuNametableSourcePageSchema } from "./nesPpuNametableSource.js";
import { NES_PPU_PATTERN_SOURCE_PAGES } from "./nesPpuPattern.js";
import { nesPpuMmc5BackgroundGeometrySchema } from "./nesPpuMmc5BackgroundSelection.js";

const rows = 240,
  columns = 33,
  rowStates = rows * columns;
// Six ordinary sources, five extended tile sources and the split table share
// at most twelve source-pair interpretations per physical 1 KiB coordinate.
const sourcePairs = 12 * 1024 + 1;
// Low six-bit proofs have 3^6 shapes; ordinary tile-page subsets add at most16.
const patternSets = 729 + 16 + 2;
// Split fine-Y alternatives are combined within each of32 coarse tile rows.
const alternatives = 32 + 16 + 1;
const reference = (maximum: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(maximum - 1);
const fineRows = z.array(z.number().int().min(0).max(7)).max(8);
export const nesPpuMmc5BackgroundPatternSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("ordinary"),
    groups: z
      .array(
        z.strictObject({
          table: z.union([z.literal(0), z.literal(1)]),
          tile_page: z.number().int().min(0).max(3),
          banks: z.array(z.number().int().min(0).max(1023)).max(1024),
        }),
      )
      .max(8),
  }),
  z.strictObject({
    kind: z.literal("4k"),
    banks: z.array(z.number().int().min(0).max(255)).max(256),
  }),
  z.strictObject({ kind: z.literal("unknown"), reason: z.string().min(1) }),
]);
export const nesPpuMmc5BackgroundSourcePairSchema = z
  .strictObject({
    tile_source: nesPpuNametableSourcePageSchema,
    tile_address: z.number().int().min(0).max(1023),
    tile: nesByteValueSchema,
    tile_origin: nesMmc5ExramOriginSchema.nullable(),
    attribute: z.strictObject({
      source: nesPpuNametableSourcePageSchema,
      address: z.number().int().min(0).max(1023),
      value: nesByteValueSchema,
      origin: nesMmc5ExramOriginSchema.nullable(),
      shift: z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(6)]),
    }),
    coupling: z.enum([
      "independent",
      "tile-extended-attribute",
      "tile-split-attribute",
    ]),
  })
  .describe(
    "A paired frozen tile/attribute interpretation. Numeric page bases point to final.nametable; ExRAM origins refer to the sole committed mapper.exram store. Fill retains raw register facts. Coupling binds equal physical ExRAM bytes before tile, palette and CHR selectors are interpreted; these fields cannot be independently combined.",
  );
export const nesPpuMmc5BackgroundProjectionSchema = z
  .strictObject({
    interpretation: z.literal("mmc5-frozen-background"),
    qualification: nesPpuMmc5BackgroundGeometrySchema,
    width: z.literal(256),
    height: z.literal(240),
    first_tile_fine_x: z.number().int().min(0).max(7),
    columns: z.union([z.literal(32), z.literal(33)]),
    chr_pages: z
      .array(reference(NES_PPU_PATTERN_SOURCE_PAGES))
      .max(NES_PPU_PATTERN_SOURCE_PAGES),
    source_pairs: z
      .array(nesPpuMmc5BackgroundSourcePairSchema)
      .max(sourcePairs),
    pattern_sets: z.array(nesPpuMmc5BackgroundPatternSchema).max(patternSets),
    branches: z
      .array(
        z.strictObject({
          path: z.enum(["normal", "extended", "split", "unknown"]),
          source_pair: reference(sourcePairs),
          pattern_set: reference(patternSets),
          pattern_rows: fineRows,
          palette_choices: z
            .array(z.number().int().min(0).max(3))
            .min(1)
            .max(4),
          unresolved_reason: z.string().min(1).nullable(),
          split_coarse_y: z.number().int().min(0).max(31).nullable(),
        }),
      )
      .max(rowStates * alternatives),
    geometry_rows: z
      .array(
        z.strictObject({
          query_y: z.number().int().min(0).max(239),
          ordinary_row: z.number().int().min(0).max(7),
          split_y: z.array(z.number().int().min(0).max(255)).min(1).max(256),
        }),
      )
      .length(rows),
    row_states: z
      .array(
        z.strictObject({
          geometry: reference(rows),
          branches: z
            .array(reference(rowStates * alternatives))
            .min(1)
            .max(alternatives),
          pixel_index_masks: z.array(z.number().int().min(1).max(15)).length(8),
          palette_index_masks: z
            .array(z.number().int().min(1).max(65535))
            .length(8),
        }),
      )
      .min(1)
      .max(rowStates),
    rows: z
      .array(z.array(reference(rowStates)).min(32).max(columns))
      .length(rows),
  })
  .superRefine((projection, ctx) => {
    const invalid = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    for (const [index, branch] of projection.branches.entries()) {
      if (branch.source_pair >= projection.source_pairs.length)
        invalid(
          ["branches", index, "source_pair"],
          "Source-pair reference is outside its pool",
        );
      if (branch.pattern_set >= projection.pattern_sets.length)
        invalid(
          ["branches", index, "pattern_set"],
          "Pattern-set reference is outside its pool",
        );
    }
    for (const [index, state] of projection.row_states.entries())
      for (const branch of state.branches)
        if (branch >= projection.branches.length)
          invalid(
            ["row_states", index, "branches"],
            "Branch reference is outside its pool",
          );
    for (const [y, row] of projection.rows.entries()) {
      if (row.length !== projection.columns)
        invalid(
          ["rows", y],
          "Projection row must retain every intersecting tile column",
        );
      for (const [x, state] of row.entries())
        if (state >= projection.row_states.length)
          invalid(["rows", y, x], "Row-state reference is outside its pool");
    }
  })
  .describe(
    "Caller-qualified per-row MMC5 background projection over frozen memory. Source pairs, CHR sets and exact split-Y geometry are pooled separately to avoid tile×bank×counter expansion. Each row-state decodes paired low/high planes before joining pixel/palette masks; mask bits are raw background palette addresses. Coarse split rows select the matching exact Y candidates in geometry_rows, retaining CL/SL fine-row alternatives. Row records include partially cropped edge tiles; first_tile_fine_x identifies the visible256 pixels. Historical pipeline geometry is never reused, and no PPU accesses or clocks occur.",
  );
export type NesPpuMmc5BackgroundProjection = z.infer<
  typeof nesPpuMmc5BackgroundProjectionSchema
>;
