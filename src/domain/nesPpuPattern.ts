import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";
import { nesPpuPixelSchema } from "./nesPpuPixel.js";

/** MMC5 admits 1 MiB CHR plus one explicitly unresolved rendering alternative. */
export const NES_PPU_PATTERN_SOURCE_PAGES = 1025;

export const nesPpuPatternSelectionSchema = z
  .union([z.literal(0), z.literal(1)])
  .nullable()
  .default(null)
  .describe(
    "Optional final mapped 4 KiB pattern table (0 at 0000, 1 at 1000). Requires initial_ppu model ppu-memory. Decodes all 256 tiles with compatible pixel sets and pooled physical sources without performing PPU reads or changing latches, buffers, IRQs or event indices. MMC5 leaves the query fetch role unspecified, joining ordinary roles and explicit unknown extended/split alternatives; a historical active tile never qualifies a complete table. This static interpretation does not establish rendered pixels, palette colors or observed usage.",
  );
export const nesPpuPatternSourcePageSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("rom"),
    file_offset: z.number().int().nonnegative(),
    bytes_hex: z
      .string()
      .regex(/^[a-f0-9]{2048}$/u)
      .nullable(),
  }),
  z.strictObject({
    kind: z.literal("chr-ram"),
    address: z.number().int().min(0).max(7168).multipleOf(1024),
  }),
  z.strictObject({
    kind: z.literal("ciram"),
    address: z.union([z.literal(0), z.literal(1024)]),
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    reason: z.string().min(1),
  }),
]);
export type NesPpuPatternSourcePage = z.infer<
  typeof nesPpuPatternSourcePageSchema
>;
export type NesPpuPatternLocation =
  | Omit<Extract<NesPpuPatternSourcePage, { kind: "rom" }>, "bytes_hex">
  | Exclude<NesPpuPatternSourcePage, { kind: "rom" }>;

/** Physical storage identity survives pooling across pattern, sprite and viewport facets. */
export const nesPpuPatternSourceIdentity = (
  page: NesPpuPatternLocation,
): string =>
  page.kind === "rom"
    ? `rom:${page.file_offset}`
    : page.kind === "unknown"
      ? `unknown:${page.reason}`
      : `${page.kind}:${page.address}`;
export const nesPpuPatternBlockSchema = z.strictObject({
  ppu_address: z.number().int().min(0).max(7168).multipleOf(1024),
  sources: z
    .array(
      z
        .number()
        .int()
        .min(0)
        .max(NES_PPU_PATTERN_SOURCE_PAGES - 1),
    )
    .max(NES_PPU_PATTERN_SOURCE_PAGES)
    .describe(
      "Indices into the owning physical source-page pool for every compatible source of this logical 1 KiB block. Empty means unavailable wiring/snapshot; common pixels do not identify an uncertain source.",
    ),
  reason: z.string().min(1).nullable(),
});
/** A lone unresolved branch is not a proven physical page. */
export const nesPpuPatternBlockUnresolved = (
  block: Pick<z.infer<typeof nesPpuPatternBlockSchema>, "sources">,
  pages: readonly NesPpuPatternSourcePage[],
): boolean =>
  block.sources.length !== 1 ||
  block.sources.some((index) => pages[index]?.kind === "unknown");
export const nesPpuPatternTableSchema = z
  .strictObject({
    table: z.union([z.literal(0), z.literal(1)]),
    interpretation: z.literal("nes-planar-2bpp-msb-left"),
    source_page_bytes: z.literal(1024),
    source_pages: z
      .array(nesPpuPatternSourcePageSchema)
      .max(NES_PPU_PATTERN_SOURCE_PAGES)
      .describe(
        "Unique physical 1 KiB source pages, bounded by MMC5's admitted 1 MiB CHR ROM plus one unresolved rendering alternative. Other boards retain their own capacity qualifications; Namco 163 may include both CIRAM pages and an unresolved debug/backing branch. ROM pages retain original offsets and authenticated bytes, or null when unavailable. CHR RAM pages refer to final.chr_ram; CIRAM pages refer to the same final.nametable cells used by nametable mappings. Unknown pages retain their reason and contribute unknown bytes. Coordinates are independent of mapper bank units. An unqualified MMC5 pattern query joins ordinary fetch roles and retains possible extended/split overrides as unknown; it never uses a historical active tile as a table-wide interpretation.",
      ),
    blocks: z.array(nesPpuPatternBlockSchema).length(4),
    tiles: z
      .array(
        z.strictObject({
          index: z.number().int().min(0).max(255),
          ppu_address: z.number().int().min(0).max(8176).multipleOf(16),
          block: z.number().int().min(0).max(3),
          byte_values: z.array(nesByteValueSchema).length(16),
          rows: z.array(z.array(nesPpuPixelSchema).length(8)).length(8),
        }),
      )
      .length(256),
    coverage: z.strictObject({
      examined_tiles: z.literal(256),
      unresolved_source_blocks: z.number().int().min(0).max(4),
      unknown_bytes: z.number().int().min(0).max(4096),
      partial_bytes: z.number().int().min(0).max(4096),
      unknown_pixels: z.number().int().min(0).max(16384),
      partial_pixels: z
        .number()
        .int()
        .min(0)
        .max(16384)
        .describe(
          "Pixels with two or three compatible indices, using partial bit proofs or canonical choices sets; null admits all four and is counted as unknown.",
        ),
    }),
  })
  .superRefine((table, ctx) => {
    for (const [blockIndex, block] of table.blocks.entries())
      for (const [index, source] of block.sources.entries())
        if (source >= table.source_pages.length)
          ctx.addIssue({
            code: "custom",
            path: ["blocks", blockIndex, "sources", index],
            message: "Pattern source reference is outside source_pages",
          });
  });
export type NesPpuPatternTable = z.infer<typeof nesPpuPatternTableSchema>;
