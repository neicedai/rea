import { z } from "zod";
import { nativeMetadataRecoverySummarySchema } from "./nativeMetadataRecovery.js";
import { jsonValueSchema } from "../jsonValue.js";
import { binaryArchitectureSchema } from "../rawBinary.js";
import { nesPrgViewSchema } from "../nesPrgViews.js";

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const hexBytes = z.string().regex(/^(?:[a-f0-9]{2})*$/u);
const address = z.string().min(1);

/** Measured provider image, without exporting the complete executable bytes. */
export const nativeLoadImageObservationSchema = z.strictObject({
  metadata_recovery: z.array(nativeMetadataRecoverySummarySchema).optional(),
  executable_format: z.string().min(1),
  language_id: z.string().min(1),
  compiler_spec_id: z.string().min(1),
  image_base: address,
  default_address_space: z.string().min(1),
  source_files: z.array(
    z.strictObject({
      name: z.string(),
      size: integer,
      original_sha256: digest,
      modified_sha256: digest,
    }),
  ),
  mappings: z.array(
    z.strictObject({
      block: z.string(),
      start: address,
      end: address,
      address_space: z.string().min(1),
      initialized: z.boolean(),
      loaded: z.boolean(),
      overlay: z.boolean(),
      length: integer.min(1),
      source_file_index: integer.nullable(),
      file_offset: integer.nullable(),
      sha256: digest.nullable(),
    }),
  ),
  relocations: z.array(
    z.strictObject({
      address,
      segment: integer.max(0xffff).nullable(),
      offset: integer.max(0xffff).nullable(),
      status: z.string().min(1),
      type: z.number().int(),
      values: z.array(
        z
          .number()
          .int()
          .min(Number.MIN_SAFE_INTEGER)
          .max(Number.MAX_SAFE_INTEGER),
      ),
      original_bytes_hex: hexBytes.nullable(),
      memory_bytes_hex: hexBytes.nullable(),
    }),
  ),
  entry_points: z.array(address),
  entry_context: z.array(
    z.strictObject({
      address,
      registers: z.array(
        z.strictObject({
          name: z.string().min(1),
          value_hex: z
            .string()
            .regex(/^0x[a-f0-9]+$/u)
            .nullable(),
        }),
      ),
    }),
  ),
});

/** Independent comparison, preserving both expectations and measured values. */
export const nativeLoadImageCheckSchema = z.strictObject({
  name: z.string().min(1),
  matched: z.boolean(),
  expected: jsonValueSchema,
  observed: jsonValueSchema,
  file_offset: integer.nullable(),
  address: address.nullable(),
});

/** Read-only native image verification; verified applies only to declared coverage. */
export const nativeLoadImageSchema = z.union([
  z.strictObject({
    status: z.literal("unsupported"),
    reason: z.string().min(1),
    observations: nativeLoadImageObservationSchema,
    limitations: z.array(z.string().min(1)),
  }),
  z.strictObject({
    status: z.enum(["verified", "mismatch"]),
    format: z.enum(["dos-mz", "dos-com"]),
    target_sha256: digest,
    load_segment: integer.max(0xffff),
    header_bytes: integer,
    module_bytes: integer,
    overlay_bytes: integer,
    entry: z.strictObject({
      relative_segment: integer.max(0xffff),
      offset: integer.max(0xffff),
      linear_address: address,
    }),
    observations: nativeLoadImageObservationSchema,
    checks: z.array(nativeLoadImageCheckSchema),
    limitations: z.array(z.string().min(1)),
  }),
  z.strictObject({
    status: z.enum(["verified", "mismatch"]),
    format: z.literal("raw-binary"),
    target_sha256: digest,
    architecture: binaryArchitectureSchema,
    language_id: z.string().min(1),
    compiler_spec_id: z.string().min(1),
    base_address: address,
    file_bytes: integer.min(1),
    entry: z.strictObject({
      address: address,
      file_offset: z.literal(0),
    }),
    observations: nativeLoadImageObservationSchema,
    checks: z.array(nativeLoadImageCheckSchema),
    limitations: z.array(z.string().min(1)),
  }),
  z.strictObject({
    status: z.enum(["verified", "mismatch"]),
    format: z.literal("nes"),
    target_sha256: digest,
    mapper: z.union([
      z.literal(0),
      z.literal(1),
      z.literal(2),
      z.literal(3),
      z.literal(4),
      z.literal(7),
      z.literal(9),
      z.literal(10),
      z.literal(11),
      z.literal(34),
      z.literal(65),
      z.literal(67),
      z.literal(68),
      z.literal(73),
      z.literal(78),
      z.literal(76),
      z.literal(87),
      z.literal(66),
      z.literal(69),
      z.literal(19),
      z.literal(5),
      z.literal(71),
      z.literal(180),
      z.literal(232),
      z.literal(206),
      z.literal(32),
      z.literal(33),
      z.literal(75),
      z.literal(22),
      z.literal(21),
      z.literal(24),
      z.literal(16),
      z.literal(159),
      z.literal(26),
      z.literal(23),
      z.literal(25),
    ]),
    board: z.string().min(1),
    mapping_model: z.enum([
      "independent-static-bank-views",
      "complete-selected-prg-contexts",
    ]),
    prg_views: z.array(
      z.strictObject({
        address_space: z.string().min(1),
        state: nesPrgViewSchema,
        selection: z.enum(["default-assumption", "caller-selected"]),
      }),
    ),
    bank_size: integer.min(1),
    prg_banks: integer.min(1),
    chr_banks: integer.describe(
      "CHR ROM source size in 8 KiB header units; not the hardware CHR bank count or a selected CHR state.",
    ),
    prg_mappings: z.array(
      z.strictObject({
        name: z.string().min(1),
        address_space: z.string().min(1),
        start: address,
        bytes: integer.min(1),
        file_offset: integer,
        bank: integer,
        role: z.enum(["fixed", "switchable", "mirror"]),
      }),
    ),
    header_bytes: z.literal(16),
    prg_rom: z.strictObject({ file_offset: integer, bytes: integer }),
    chr_rom: z.strictObject({ file_offset: integer, bytes: integer }),
    vectors: z.array(
      z.strictObject({
        name: z.enum(["NMI", "RESET", "IRQ"]),
        file_offset: integer,
        address,
        address_space: z.string().min(1),
        bank: integer,
        target: address,
        resolved_target: address.nullable(),
        resolution: z.enum([
          "mapped-in-view",
          "bank-state-required",
          "outside-prg-rom",
        ]),
        in_prg_rom: z.boolean(),
      }),
    ),
    observations: nativeLoadImageObservationSchema,
    checks: z.array(nativeLoadImageCheckSchema),
    limitations: z.array(z.string().min(1)),
  }),
]);

/** Provider-neutral native load-image result. */
export type NativeLoadImage = z.infer<typeof nativeLoadImageSchema>;
/** Measured source mappings, bytes, relocations and entries. */
export type NativeLoadImageObservation = z.infer<
  typeof nativeLoadImageObservationSchema
>;
/** One independently compared native import fact. */
export type NativeLoadImageCheck = z.infer<typeof nativeLoadImageCheckSchema>;
