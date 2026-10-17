import { z } from "zod";
import {
  nesByteValueSchema,
  nesByteBits,
  nesByteCandidates,
  joinNesBytes,
} from "./nesByteValue.js";
import type { NesByteValue } from "./nesByteValue.js";
import { nesMmc5ExramCapturedCellSchema } from "./nesMmc5Exram.js";

const cell = nesMmc5ExramCapturedCellSchema;
const shift = z.union([z.literal(0), z.literal(2), z.literal(4), z.literal(6)]);
const attributeCell = z.union([
  cell.options[0].extend({ shift }),
  cell.options[1].extend({ shift }),
]);
const paths = z
  .array(z.enum(["normal", "extended", "split"]))
  .min(1)
  .max(3);
export const nesMmc5TilePositionSchema = z
  .strictObject({
    column: z.number().int().min(0).max(31),
    line: z.enum(["current", "next"]),
  })
  .describe(
    "Caller-qualified screen tile position for a background nametable-data fetch, including prefetches for the next line. The PPU bus address does not establish the screen column. It does not advance the split scanline counter.",
  );
export type NesMmc5TilePosition = z.infer<typeof nesMmc5TilePositionSchema>;

export const nesMmc5RenderingStateSchema = z
  .strictObject({
    model: z.literal("mmc5-background"),
    pin92_high: z.boolean().nullable().default(null),
    split_wiring: z.enum(["cl", "sl"]).nullable().default(null),
    split_y: nesByteValueSchema.default(null),
    phase: z
      .enum(["unknown", "attribute", "pattern-low", "pattern-high", "idle"])
      .default("unknown"),
    paths: paths.default(["normal", "extended", "split"]),
    nametable_address: z
      .number()
      .int()
      .min(0x2000)
      .max(0x2fff)
      .nullable()
      .default(null),
    tile_column: z
      .number()
      .int()
      .min(0)
      .max(31)
      .nullable()
      .default(null)
      .describe(
        "Captured screen column of the last qualified tile. Inactive pipeline geometry remains historical evidence and cannot constrain a subsequent missing tile context.",
      ),
    tile_y: nesByteValueSchema.default(null),
    tile_value: nesByteValueSchema.default(null),
    extended_attribute: cell.nullable().default(null),
    split_tiles: z.array(cell).max(1024).default([]),
    split_attributes: z.array(attributeCell).max(256).default([]),
    pattern_address: z.number().int().min(0).max(8191).nullable().default(null),
  })
  .describe(
    "Explicit ordered background-fetch interpretation. No PPU cycles, screen position, frame or IRQ clocks are inferred. pin92_high qualifies substitutions; split_wiring joins CL/SL when unknown. Split Y loads 5201 only on a qualified render-frame event and advances only on render-line events; tile positions qualify current/next-line prefetches. Captured ExRAM attribute bytes survive later storage writes; live 5130/5202 affect subsequent pattern bytes.",
  );
export type NesMmc5RenderingState = z.infer<typeof nesMmc5RenderingStateSchema>;

export const nesMmc5RenderingReadSchema = z.strictObject({
  paths,
  fetch: z.enum(["tile", "attribute", "pattern-low", "pattern-high", "other"]),
  nametable_address: z.number().int().min(0x2000).max(0x2fff).nullable(),
  tile_column: z.number().int().min(0).max(31).nullable(),
  tile_y: nesByteValueSchema,
  extended_attribute: cell.nullable(),
  split_tiles: z.array(cell).max(1024),
  split_attributes: z.array(attributeCell).max(256),
  pattern_rows: z.array(z.number().int().min(0).max(7)).max(8),
  reason: z
    .enum([
      "missing-tile",
      "unexpected-address",
      "incompatible-tile",
      "unqualified-fetch",
    ])
    .nullable(),
});

/** Normal vertical wrap skips attribute rows; a caller-supplied 240..255 origin retains them until 255 wraps. */
export const nextMmc5SplitY = (value: NesByteValue): NesByteValue =>
  nesByteCandidates(value)
    .map<NesByteValue>((y) => (y === 239 || y === 255 ? 0 : y + 1))
    .reduce(joinNesBytes);

export const mmc5Substitutions = (mask: NesByteValue): boolean | null =>
  nesByteBits(mask, 8) === 8 || nesByteBits(mask, 16) === 16
    ? true
    : nesByteBits(mask, 24) === 0
      ? false
      : null;

/** Relevant control changes invalidate only active interpretation, preserving captured source facts. */
export const invalidateMmc5RenderingWrite = (
  ppu: NesMmc5RenderingState,
  address: number,
  before: NesByteValue,
  after: NesByteValue,
): void => {
  const mask = address === 0x5104 ? 3 : address === 0x5200 ? 223 : 0;
  if (address === 0x2001) {
    const first = mmc5Substitutions(before),
      second = mmc5Substitutions(after);
    if (first === null || first !== second) ppu.phase = "unknown";
  } else if (mask !== 0) {
    const first = nesByteBits(before, mask),
      second = nesByteBits(after, mask);
    if (first === null || first !== second) ppu.phase = "unknown";
  }
};
