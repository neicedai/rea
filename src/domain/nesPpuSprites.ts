import { z } from "zod";
import { nesPpuColorCodeSchema } from "./nesPpuPalette.js";
import { nesByteValueSchema, nesTwoBitValueSchema } from "./nesByteValue.js";
import {
  nesPpuPatternSourcePageSchema,
  nesPpuPatternBlockSchema,
  NES_PPU_PATTERN_SOURCE_PAGES,
} from "./nesPpuPattern.js";
import { nesPpuSpriteScanlinesSchema } from "./nesPpuSpriteScanlines.js";
import { nesPpuPixelSchema } from "./nesPpuPixel.js";

export const nesPpuSpritesSelectionSchema = z
  .boolean()
  .default(false)
  .describe(
    "Decode all 64 final physical OAM entries and their conditional 8x8/8x16 pattern rows, sprite palettes, flips and background-priority bits. Includes frozen-OAM first-eight nomination, separate height alternatives and uncertain Y/slot proofs. Requires initial_ppu.oam model oam-memory. Selecting this facet qualifies MMC5's static sprite query role; it does not establish observed fetch recognition or rendering. Partial selectors and pooled CHR sources are retained without device reads, evaluation timing, overflow flags, collision or screen composition.",
  );
const table = z.union([z.literal(0), z.literal(1)]);
const mode = {
  pattern_tables: z.array(table).min(1).max(2),
};
const row = z.array(nesPpuPixelSchema).length(8);
export const nesPpuSpritesSchema = z.strictObject({
  interpretation: z.literal("nes-oam-static-sprites"),
  sprites_enabled: z.boolean().nullable(),
  left_column_enabled: z.boolean().nullable(),
  scanline_selection: nesPpuSpriteScanlinesSchema,
  source_page_bytes: z.literal(1024),
  source_pages: z
    .array(nesPpuPatternSourcePageSchema)
    .max(NES_PPU_PATTERN_SOURCE_PAGES),
  blocks: z
    .array(nesPpuPatternBlockSchema)
    .min(4)
    .max(8)
    .describe(
      "Logical 1 KiB blocks in all compatible sprite pattern tables. Source indices refer to the shared physical page pool. ROM bytes retain offsets; CHR RAM and CIRAM values/origins reside in final.chr_ram and final.nametable respectively. MMC5 blocks qualify the static sprite query role. No mapper latch or IRQ is advanced.",
    ),
  sprites: z
    .array(
      z.strictObject({
        index: z.number().int().min(0).max(63),
        oam_address: z.number().int().min(0).max(252).multipleOf(4),
        y: nesByteValueSchema,
        x: nesByteValueSchema,
        tile_index: nesByteValueSchema,
        attributes: nesByteValueSchema,
        top_rows: z
          .array(z.number().int().min(1).max(256))
          .min(1)
          .max(256)
          .describe(
            "Compatible conventional top coordinates are stored Y + 1, without byte wrap. Values 240..256 are offscreen; this does not establish sprite evaluation or visibility.",
          ),
        offscreen_y: z.boolean().nullable(),
        subpalette: nesTwoBitValueSchema,
        behind_background: z.boolean().nullable(),
        horizontal_flip: z.boolean().nullable(),
        vertical_flip: z.boolean().nullable(),
        modes: z
          .array(
            z.discriminatedUnion("height", [
              z.strictObject({
                ...mode,
                height: z.literal(8),
                first_tiles: z
                  .array(z.number().int().min(0).max(255))
                  .min(1)
                  .max(256),
                rows: z.array(row).length(8),
              }),
              z.strictObject({
                ...mode,
                height: z.literal(16),
                first_tiles: z
                  .array(z.number().int().min(0).max(254).multipleOf(2))
                  .min(1)
                  .max(128),
                rows: z.array(row).length(16),
              }),
            ]),
          )
          .min(1)
          .max(2)
          .describe(
            "Separate compatible PPUCTRL D5 heights. In 8x8 mode D3 selects the table and the raw tile selects one tile. In 8x16 mode raw tile D0 selects the table and raw tile & FE selects an adjacent pair. first_tiles are unflipped base tiles; rows apply all compatible flips, including whole-pair vertical reversal. Pixels retain compatible two-bit sets across selectors and physical sources, using canonical choices when common bits are insufficient; zero is transparent. Original OAM facts and origins remain in final.oam.cells.",
          ),
      }),
    )
    .length(64),
  palette_cells: z
    .array(
      z.strictObject({
        address: z
          .number()
          .int()
          .min(17)
          .max(31)
          .refine((address) => address % 4 !== 0)
          .meta({ enum: [17, 18, 19, 21, 22, 23, 25, 26, 27, 29, 30, 31] }),
        value: nesPpuColorCodeSchema,
        code: nesPpuColorCodeSchema,
      }),
    )
    .length(12)
    .describe(
      "Physical sprite palette cells and grayscale-filtered six-bit codes. Origins remain in final.palette. Pixel zero is transparent and has no sprite palette cell; codes are not RGB or evidence of rendered colors.",
    ),
  palettes: z
    .array(
      z.strictObject({
        subpalette: z.number().int().min(0).max(3),
        cells: z.tuple([
          z.null(),
          z.number().int().min(0).max(11),
          z.number().int().min(0).max(11),
          z.number().int().min(0).max(11),
        ]),
      }),
    )
    .length(4),
  coverage: z.strictObject({
    examined_sprites: z.literal(64),
    unknown_oam_bytes: z.number().int().min(0).max(256),
    partial_oam_bytes: z.number().int().min(0).max(256),
    unresolved_source_blocks: z.number().int().min(0).max(8),
    unknown_pixels: z.number().int().min(0).max(12288),
    partial_pixels: z
      .number()
      .int()
      .min(0)
      .max(12288)
      .describe(
        "Pixels with two or three compatible indices, using partial bit proofs or canonical choices sets.",
      ),
    unknown_palette_codes: z.number().int().min(0).max(12),
    partial_palette_codes: z.number().int().min(0).max(12),
  }),
});
export type NesPpuSprites = z.infer<typeof nesPpuSpritesSchema>;
