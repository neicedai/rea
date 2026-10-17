import { z } from "zod";
import { nesPpuMmc5BackgroundProjectionSchema } from "./nesPpuMmc5Background.js";
import {
  nesPpuPatternSourcePageSchema,
  NES_PPU_PATTERN_SOURCE_PAGES,
} from "./nesPpuPattern.js";
import { nesByteValueSchema, nesTwoBitValueSchema } from "./nesByteValue.js";

import { nesPpuColorCodeSchema } from "./nesPpuPalette.js";
import {
  nesPpuNametableSourcePageSchema,
  NES_PPU_NAMETABLE_SOURCE_PAGES,
} from "./nesPpuNametableSource.js";

export const nesPpuNametableSelectionSchema = z
  .union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)])
  .nullable()
  .default(null)
  .describe(
    "Optional final logical nametable page 0..3 at 2000/2400/2800/2C00. Requires initial_ppu model ppu-memory. Decodes 960 tile indices, 64 attribute bytes/quadrants and palette choices with source identity/provenance. Selecting this facet qualifies MMC5's frozen background query role; ordinary CIRAM/ExRAM/fill/zero alternatives remain separate and possible extended/split overrides stay explicitly unknown unless ppu_mmc5_background.nametable supplies explicit per-row query geometry. Historical active tile geometry cannot qualify the whole page. No device reads, scrolling, composition or rendering occur. PPUCTRL D4 supplies possible pattern tables; pixel zero selects the conventional backdrop.",
  );
export type NesPpuNametablePage = NonNullable<
  z.infer<typeof nesPpuNametableSelectionSchema>
>;
const selector = z.number().int().min(0).max(3);
const nametableSchema = z.strictObject({
  page: selector,
  ppu_address: z.number().int().min(8192).max(11264).multipleOf(1024),
  source_pages: z
    .array(nesPpuNametableSourcePageSchema)
    .max(NES_PPU_NAMETABLE_SOURCE_PAGES)
    .describe(
      "Every compatible 1 KiB nametable source: final CIRAM coordinates, original CHR ROM pages, mapper-owned MMC5 ExRAM, captured fill-register facts, generated zero or explicitly unresolved alternatives. Use the same candidate page for tile and attribute bytes to preserve their correlation. An empty list means unavailable wiring, not empty memory.",
    ),
  reason: z.string().min(1).nullable(),
  pattern_tables: z
    .array(z.union([z.literal(0), z.literal(1)]))
    .min(1)
    .max(2)
    .describe(
      "Possible background pattern tables derived from final PPUCTRL D4; no PPU fetch or tile usage is observed.",
    ),
  cells: z
    .array(
      z.strictObject({
        x: z.number().int().min(0).max(31),
        y: z.number().int().min(0).max(29),
        tile_index: nesByteValueSchema,
        attribute: z.number().int().min(0).max(63),
        quadrant: selector,
      }),
    )
    .length(960),
  attributes: z
    .array(
      z.strictObject({
        offset: z.number().int().min(960).max(1023),
        value: nesByteValueSchema,
        quadrants: z
          .array(
            z.strictObject({
              value: nesTwoBitValueSchema,
              choices: z
                .array(selector)
                .min(1)
                .max(4)
                .describe(
                  "Exact union of subpalette selectors allowed by each physical attribute source; a common-bit envelope alone may admit extra selectors.",
                ),
            }),
          )
          .length(4),
      }),
    )
    .length(64),
  palette_cells: z
    .array(
      z.strictObject({
        address: z.union([
          z.literal(0),
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(5),
          z.literal(6),
          z.literal(7),
          z.literal(9),
          z.literal(10),
          z.literal(11),
          z.literal(13),
          z.literal(14),
          z.literal(15),
        ]),
        value: nesPpuColorCodeSchema,
        code: nesPpuColorCodeSchema,
      }),
    )
    .length(13)
    .describe(
      "Canonical background palette cells. value is the raw six-bit proof; code applies final PPUMASK D0 grayscale or joins both possibilities when unknown. Origins remain in ppu_trace.final.palette at address. Codes are not RGB colors or a composed screen; emphasis/EXT/video timing are outside this query.",
    ),
  palettes: z
    .array(
      z.strictObject({
        subpalette: selector,
        cells: z.array(z.number().int().min(0).max(12)).length(4),
      }),
    )
    .length(4)
    .describe(
      "Per-subpalette indices into palette_cells for pattern pixel values 0..3. Index zero uses the conventional backdrop cell at physical palette address 0; background pixel zero is transparent and may be covered by a sprite.",
    ),
  coverage: z.strictObject({
    examined_cells: z.literal(960),
    examined_attributes: z.literal(64),
    unresolved_source: z.boolean(),
    unknown_tile_indices: z.number().int().min(0).max(960),
    partial_tile_indices: z.number().int().min(0).max(960),
    unknown_subpalettes: z.number().int().min(0).max(960),
    partial_subpalettes: z.number().int().min(0).max(960),
    ambiguous_subpalettes: z.number().int().min(0).max(960),
    unknown_palette_codes: z.number().int().min(0).max(13),
    partial_palette_codes: z.number().int().min(0).max(13),
  }),
});
export const nesPpuNametableSchema = z.union([
  nametableSchema,
  nametableSchema
    .extend({
      source_pages: nametableSchema.shape.source_pages.describe(
        "Marginal pool of storage sources participating in this qualified MMC5 projection. Tile and attribute may come from different entries; exact correlated pairings reside in mmc5_background.source_pairs, never in the Cartesian product of this pool.",
      ),
      pattern_tables: nametableSchema.shape.pattern_tables.describe(
        "PPUCTRL-qualified table alternatives for ordinary background paths only. Extended/split paths use mmc5_background.pattern_sets and its per-row branches.",
      ),
      attributes_model: z
        .literal("effective-quadrant-envelope")
        .describe(
          "For a qualified MMC5 background query, attributes are conservative effective selector envelopes across contributing per-cell rows, rather than physical attribute reads. Exact tile/attribute/CHR pairing resides in mmc5_background; source_pages is a marginal pool of participating storage sources.",
        ),
      chr_source_page_bytes: z.literal(1024),
      chr_source_pages: z
        .array(nesPpuPatternSourcePageSchema)
        .max(NES_PPU_PATTERN_SOURCE_PAGES),
      mmc5_background: nesPpuMmc5BackgroundProjectionSchema,
    })
    .superRefine((page, ctx) => {
      for (const [index, reference] of page.mmc5_background.chr_pages.entries())
        if (reference >= page.chr_source_pages.length)
          ctx.addIssue({
            code: "custom",
            path: ["mmc5_background", "chr_pages", index],
            message:
              "Projected CHR reference is outside the facet source-page pool",
          });
    }),
]);
export type NesPpuNametable = z.infer<typeof nesPpuNametableSchema>;
