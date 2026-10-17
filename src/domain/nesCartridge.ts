import { z } from "zod";
import type { NesRomMetadata } from "./nes.js";
import { decodeNesChrTile } from "./nesChr.js";

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const region = z.strictObject({ offset: integer, size: integer });

/** Parsed header observations, independent of a disassembler's mapper coverage. */
export const nesRomMetadataSchema = z.strictObject({
  headerVersion: z.enum(["ines", "nes2"]),
  header: z.array(z.number().int().min(0).max(255)).length(16),
  mapper: integer.max(4095),
  submapper: integer.max(15).nullable(),
  consoleType: integer.max(3),
  mirroring: z.enum(["horizontal", "vertical", "four-screen"]),
  battery: z.boolean(),
  trainer: region.nullable(),
  prgRom: region,
  chrRom: region,
  trailingData: region.nullable(),
  miscRomCount: integer.max(3).nullable(),
  prgRamSize: integer.nullable(),
  prgNvramSize: integer.nullable(),
  chrRamSize: integer.nullable(),
  chrNvramSize: integer.nullable(),
}) satisfies z.ZodType<NesRomMetadata>;

/** One source page has the 4 KiB extent of a NES pattern table, not a runtime mapping. */
export const NES_CHR_PAGE_BYTES = 4096;

export const inspectNesCartridgeInputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .describe("Absolute path to an iNES or NES 2.0 cartridge"),
  chr_page: integer
    .default(0)
    .describe(
      "Zero-based 4 KiB page in source CHR ROM; not a PPU bank selector. Page 0 also inspects cartridges without CHR ROM.",
    ),
  max_file_bytes: integer
    .min(16)
    .default(67108864)
    .describe(
      "Caller-selected file I/O budget, default 64 MiB; the complete ROM is streamed for SHA-256 without loading it into memory",
    ),
});

/** Every pixel is a derived 2-bit index; colors, palettes and usage remain unknown. */
export const nesCartridgeSchema = z.strictObject({
  artifact: z.strictObject({
    path: z.string().min(1),
    bytes: integer,
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  header: nesRomMetadataSchema,
  prg_layout: z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("modeled"), board: z.string().min(1) }),
    z.strictObject({
      status: z.literal("unmodeled"),
      reason: z.string().min(1),
    }),
  ]),
  chr: z.strictObject({
    status: z.enum(["rom", "no-chr-rom"]),
    page: integer,
    page_bytes: z.literal(NES_CHR_PAGE_BYTES),
    total_pages: integer,
    next_page: integer.nullable(),
    total_tiles: integer,
    location: region,
    bytes_hex: z
      .string()
      .regex(/^(?:[a-f0-9]{2})*$/u)
      .max(NES_CHR_PAGE_BYTES * 2),
    tiles: z
      .array(
        z.strictObject({
          index: integer,
          file_offset: integer,
          rows: z.array(z.string().regex(/^[0-3]{8}$/u)).length(8),
        }),
      )
      .max(NES_CHR_PAGE_BYTES / 16),
    incomplete_tile_bytes: integer.max(15),
    interpretation: z.literal("nes-planar-2bpp-msb-left"),
    palette: z.null(),
    ppu_mapping: z.literal("unknown"),
  }),
  limitations: z.array(z.string().min(1)),
});

export type InspectNesCartridgeInput = z.infer<
  typeof inspectNesCartridgeInputSchema
>;
export type NesCartridge = z.infer<typeof nesCartridgeSchema>;

/** Decode complete tiles only; bytes from an incomplete final tile stay in bytes_hex. */
export const decodeNesChrPage = (
  bytes: Uint8Array,
  firstTile: number,
  fileOffset: number,
): NesCartridge["chr"]["tiles"] => {
  if (bytes.length > NES_CHR_PAGE_BYTES)
    throw new RangeError("NES CHR decoding accepts one 4 KiB source page");
  return Array.from({ length: Math.floor(bytes.length / 16) }, (_, tile) => ({
    index: firstTile + tile,
    file_offset: fileOffset + tile * 16,
    rows: decodeNesChrTile(
      Array.from(bytes.subarray(tile * 16, tile * 16 + 16)),
    ).map((row) => row.join("")),
  }));
};
