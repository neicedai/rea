import { z } from "zod";

/** One mapper-controlled 1 KiB nametable window; source uncertainty is explicit. */
export const nesNametableWindowSchema = z.strictObject({
  start: z.number().int().min(0x2000).max(0x2c00).multipleOf(1024),
  size: z.literal(1024),
  source: z.enum(["ciram", "chr-rom", "unknown"]),
  bank: z.number().int().min(0).max(255).nullable(),
  file_offset: z.number().int().nonnegative().nullable(),
});
export type NesNametableWindow = z.infer<typeof nesNametableWindowSchema>;
