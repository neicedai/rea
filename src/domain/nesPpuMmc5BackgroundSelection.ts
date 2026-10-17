import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";

export const nesPpuMmc5BackgroundGeometrySchema = z.strictObject({
  first_screen_column: z
    .number()
    .int()
    .min(0)
    .max(31)
    .describe(
      "Caller-qualified MMC5 fetch column of the first logical tile intersecting the query's left edge. Subsequent tiles advance modulo 32. For a viewport, origin_x's low three bits place the first partial tile; an atlas address alone does not establish a screen column.",
    ),
  split_y_at_origin: nesByteValueSchema
    .default(null)
    .describe(
      "Caller-qualified frozen split counter at the query's first pixel row. Each later query row applies the MMC5 239/255 wrap rule without advancing any device state. Null/partial values retain every compatible counter coordinate. This does not reuse historical mapper.ppu.split_y or infer a frame event from 5201.",
    ),
});
export type NesPpuMmc5BackgroundGeometry = z.infer<
  typeof nesPpuMmc5BackgroundGeometrySchema
>;

export const nesPpuMmc5BackgroundSelectionSchema = z
  .strictObject({
    nametable: nesPpuMmc5BackgroundGeometrySchema.nullable().default(null),
    viewport: nesPpuMmc5BackgroundGeometrySchema.nullable().default(null),
  })
  .nullable()
  .default(null)
  .describe(
    "Optional MMC5 frozen per-row background projection qualifications for the selected nametable and/or viewport facets. Nametable geometry begins at that page's upper-left pixel; viewport geometry begins at its explicit origin. Registers and memory remain frozen. Tile, attribute, CHR and palette alternatives remain correlated within each interpretation, including extended attributes and CL/SL split row wiring. Omission preserves unresolved table-wide overrides. Requires Mapper 5 and the corresponding selected graphics facets; no fetches, scanline clocks or observed frame are implied.",
  );
export type NesPpuMmc5BackgroundSelection = NonNullable<
  z.infer<typeof nesPpuMmc5BackgroundSelectionSchema>
>;

export const admitNesPpuMmc5Background = (
  selection: NesPpuMmc5BackgroundSelection | null,
  facets: { mapper: number; nametable: boolean; viewport: boolean },
): string | null => {
  if (selection === null) return null;
  if (facets.mapper !== 5)
    return "Frozen MMC5 background qualifications require Mapper 5.";
  if (selection.nametable !== null && !facets.nametable)
    return "MMC5 nametable geometry requires the ppu_nametable facet.";
  if (selection.viewport !== null && !facets.viewport)
    return "MMC5 viewport geometry requires the ppu_viewport facet.";
  return null;
};
