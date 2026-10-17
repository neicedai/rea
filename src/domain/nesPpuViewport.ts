import { z } from "zod";
import { nesPpuMmc5BackgroundProjectionSchema } from "./nesPpuMmc5Background.js";
import {
  nesPpuColorCodeSchema,
  nesPpuPaletteAddresses,
} from "./nesPpuPalette.js";
import {
  nesPpuPatternSourcePageSchema,
  nesPpuPatternBlockSchema,
  NES_PPU_PATTERN_SOURCE_PAGES,
} from "./nesPpuPattern.js";
import {
  nesPpuNametableSourcePageSchema,
  NES_PPU_NAMETABLE_SOURCE_PAGES,
} from "./nesPpuNametableSource.js";

const origin = {
  origin_x: z.number().int().min(0).max(511),
  origin_y: z.number().int().min(0).max(479),
};
export const nesPpuViewportSelectionSchema = z
  .strictObject({
    model: z.literal("frozen-viewport"),
    ...origin,
  })
  .nullable()
  .default(null)
  .describe(
    "Optional 256x240 frozen viewport over the logical 512x480 four-nametable atlas. Explicit origin is a caller assumption independent of v/t/fine_x or PPUCTRL base bits. Requires ppu-memory and oam-memory. MMC5 selection qualifies separate static background and sprite query roles; source caches and blocks remain distinct, and possible extended/split background overrides are explicitly unknown unless ppu_mmc5_background.viewport supplies explicit per-row query geometry. Historical active tile geometry cannot qualify the whole viewport. Composes conservative code/palette/source envelopes with first-eight nomination, priority and clipping. Assumes the conventional EXT-zero backdrop; no observed frame, RGB, collision status or scrolling reload is inferred.",
  );
export type NesPpuViewportSelection = NonNullable<
  z.infer<typeof nesPpuViewportSelectionSchema>
>;
const hex = z.string().regex(/^[a-f0-9]{16}$/u);
const codeMask = hex
  .regex(/[a-f1-9]/u)
  .describe(
    "Nonempty 64-bit set of six-bit PPU codes; bit c admits code c. Lowercase, most significant hex digit first. Grayscale alternatives are retained exactly within each palette cell; no RGB/emphasis/video conversion is inferred.",
  );
const viewportSchema = z
  .strictObject({
    interpretation: z.literal("frozen-viewport-envelope"),
    ...origin,
    width: z.literal(256),
    height: z.literal(240),
    palette_cells: z
      .array(
        z.strictObject({
          address: z
            .number()
            .int()
            .min(0)
            .max(31)
            .refine((address) =>
              nesPpuPaletteAddresses.some((candidate) => address === candidate),
            )
            .meta({ enum: nesPpuPaletteAddresses }),
          value: nesPpuColorCodeSchema,
          code_mask: codeMask,
        }),
      )
      .length(28)
      .meta({
        allOf: [
          {
            prefixItems: nesPpuPaletteAddresses.map((address) => ({
              properties: { address: { const: address } },
              required: ["address"],
            })),
          },
        ],
      })
      .describe(
        "Canonical physical palette addresses 0..15,17..19,21..23,25..27,29..31 in ascending order. Origins reside in final.palette. Unused color-zero cells remain available for forced blanking through v. Each pixel palette_mask indexes this list, not raw PPU addresses.",
      ),
    chr_source_page_bytes: z.literal(1024),
    chr_source_pages: z
      .array(nesPpuPatternSourcePageSchema)
      .max(NES_PPU_PATTERN_SOURCE_PAGES),
    chr_blocks: z
      .array(
        z.union([
          nesPpuPatternBlockSchema,
          nesPpuPatternBlockSchema.extend({
            query_role: z.enum(["background", "sprite"]),
          }),
        ]),
      )
      .min(4)
      .max(16)
      .describe(
        "MMC5 background/sprite query roles retain separate logical blocks even at the same PPU address; physical source pages remain deduplicated. Other mappers retain the existing untagged blocks.",
      ),
    nametables: z
      .array(
        z.strictObject({
          page: z.number().int().min(0).max(3),
          source_pages: z
            .array(nesPpuNametableSourcePageSchema)
            .max(NES_PPU_NAMETABLE_SOURCE_PAGES),
          reason: z.string().min(1).nullable(),
        }),
      )
      .length(4)
      .describe(
        "Compatible CIRAM, CHR ROM, MMC5 ExRAM/fill/zero or unresolved alternatives for each logical nametable. Tile and attribute bytes are paired within one candidate page. Numeric page facts/origins reside in final.nametable; ExRAM refers to the unique final mapper.exram store, fill captures raw register proofs, and ROM candidates retain original offsets and bytes.",
      ),
    modes: z
      .array(
        z.strictObject({
          sprite_height: z.union([z.literal(8), z.literal(16)]),
          pixel_states: z
            .array(
              z.strictObject({
                palette_mask: z.number().int().min(1).max(268435455),
                code_mask: codeMask,
                layers: z
                  .number()
                  .int()
                  .min(1)
                  .max(15)
                  .describe(
                    "Bit 0 backdrop, 1 background, 2 sprite, 3 forced-blank output.",
                  ),
                front_sprites: hex.describe(
                  "64-bit OAM-index mask of compatible first opaque nominees before background priority, while sprite output is enabled.",
                ),
                visible_sprites: hex.describe(
                  "64-bit OAM-index mask of compatible visible sprite contributors after background priority. A hidden back-priority nominee can still occlude later sprites.",
                ),
              }),
            )
            .min(1)
            .max(61440),
          rows: z
            .array(z.array(z.number().int().min(0).max(61439)).length(256))
            .length(240)
            .describe(
              "Pixel-state references, indexed by visible y then x. Identical complete state envelopes share one record.",
            ),
          coverage: z.strictObject({
            examined_pixels: z.literal(61440),
            ambiguous_palette_pixels: z.number().int().min(0).max(61440),
            ambiguous_code_pixels: z
              .number()
              .int()
              .min(0)
              .max(61440)
              .describe(
                "Pixels with 2..63 candidate codes; all-64 results are counted separately as unknown.",
              ),
            unknown_code_pixels: z.number().int().min(0).max(61440),
          }),
        }),
      )
      .min(1)
      .max(2),
    unresolved_chr_blocks: z.number().int().min(0).max(16),
  })
  .superRefine((viewport, ctx) => {
    for (const [index, cell] of viewport.palette_cells.entries())
      if (cell.address !== nesPpuPaletteAddresses[index])
        ctx.addIssue({
          code: "custom",
          path: ["palette_cells", index, "address"],
          message: "Viewport palette cells must retain canonical address order",
        });
    for (const [blockIndex, block] of viewport.chr_blocks.entries())
      for (const source of block.sources)
        if (source >= viewport.chr_source_pages.length)
          ctx.addIssue({
            code: "custom",
            path: ["chr_blocks", blockIndex, "sources"],
            message: "Viewport CHR reference is outside chr_source_pages",
          });
    for (const [modeIndex, mode] of viewport.modes.entries())
      for (const [y, row] of mode.rows.entries())
        for (const [x, reference] of row.entries())
          if (reference >= mode.pixel_states.length)
            ctx.addIssue({
              code: "custom",
              path: ["modes", modeIndex, "rows", y, x],
              message: "Viewport pixel reference is outside pixel_states",
            });
  })
  .describe(
    "Conditional per-pixel envelopes from one frozen final memory/mapper snapshot. Source/selector alternatives can be correlated; masks are conservative covers, not independently selectable physical frames. Separate global sprite heights prevent mixed-height nominations. All pixel and source records are retained without PPU reads, latch changes, IRQ clocks or event-index changes.",
  );
export const nesPpuViewportSchema = z.union([
  viewportSchema,
  viewportSchema
    .safeExtend({
      chr_blocks: viewportSchema.shape.chr_blocks.describe(
        "Separate table-wide background and sprite query blocks. These summaries retain their static role interpretation; qualified extended/split background tile, row and bank pairing resides in mmc5_background.pattern_sets and row_states. Physical pages are shared with the per-row projection through chr_source_pages.",
      ),
      nametables: viewportSchema.shape.nametables.describe(
        "Table-wide ordinary background source alternatives for each logical nametable. Per-row extended/split tile and attribute pairing resides in mmc5_background.source_pairs; these page summaries do not substitute for that qualification. Numeric CIRAM facts reside in final.nametable and ExRAM facts in the unique final mapper.exram store.",
      ),
      mmc5_background: nesPpuMmc5BackgroundProjectionSchema,
    })
    .superRefine((view, ctx) => {
      for (const [index, reference] of view.mmc5_background.chr_pages.entries())
        if (reference >= view.chr_source_pages.length)
          ctx.addIssue({
            code: "custom",
            path: ["mmc5_background", "chr_pages", index],
            message:
              "Projected CHR reference is outside the facet source-page pool",
          });
    }),
]);
export type NesPpuViewport = z.infer<typeof nesPpuViewportSchema>;
