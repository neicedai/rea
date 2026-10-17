import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";

/** VRC6 can expose all 256 ROM pages together with both CIRAM pages. */
export const NES_PPU_NAMETABLE_SOURCE_PAGES = 258;
export const nesPpuNametableSourcePageSchema = z
  .union([
    z.number().int().min(0).max(3072).multipleOf(1024),
    z.strictObject({
      kind: z.literal("rom"),
      file_offset: z.number().int().nonnegative(),
      bytes_hex: z
        .string()
        .regex(/^[a-f0-9]{2048}$/u)
        .nullable(),
    }),
    z.strictObject({ kind: z.literal("unknown"), reason: z.string().min(1) }),
    z.strictObject({ kind: z.literal("mmc5-exram") }),
    z.strictObject({
      kind: z.literal("mmc5-fill"),
      tile: nesByteValueSchema,
      attribute: nesByteValueSchema,
    }),
    z.strictObject({ kind: z.literal("mmc5-zero") }),
  ])
  .describe(
    "One compatible 1 KiB nametable source. A number retains final.nametable coordinates and origins. MMC5 ExRAM references the unique final mapper.exram store; fill captures raw tile/attribute register facts and zero identifies a generated constant source. Neither is fabricated RAM. ROM pages retain original CHR offsets and bytes; null bytes mean unavailable snapshots. Explicit unknown alternatives preserve unavailable backing or unqualified MMC5 extended/split overrides. Tile and attribute bytes use the same candidate page.",
  );
export type NesPpuNametableSourcePage = z.infer<
  typeof nesPpuNametableSourcePageSchema
>;
export type NesPpuNametableLocation =
  | number
  | Omit<Extract<NesPpuNametableSourcePage, { kind: "rom" }>, "bytes_hex">
  | Exclude<NesPpuNametableSourcePage, number | { kind: "rom" }>;
