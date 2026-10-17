import { nesBandaiStateSchema } from "./nesBandai.js";
import { nesMmc5StateSchema, nesMmc5CpuWindowSchema } from "./nesMmc5.js";
import { nesMmc5NametableWindowSchema } from "./nesMmc5Ppu.js";
import {
  nesNamco163StateSchema,
  nesNamco163PpuWindowSchema,
} from "./nesNamco163.js";
import { nesFme7StateSchema, nesFme7LowerWindowSchema } from "./nesFme7.js";
import { nesH3001StateSchema } from "./nesH3001.js";
import { nesSunsoft3StateSchema } from "./nesSunsoft3.js";
import { nesSunsoft4StateSchema } from "./nesSunsoft4.js";
import { nesVrc3StateSchema } from "./nesVrc3.js";
import { nesIrem78StateSchema } from "./nesIrem78.js";
import { nesJ87StateSchema } from "./nesJ87.js";
import { nesNamco108StateSchema } from "./nesNamco108.js";
import { nesVrc6StateSchema } from "./nesVrc6.js";
import { nesNametableWindowSchema } from "./nesNametableWindow.js";
import { nesVrc2WiringSchema, nesVrc4WiringSchema } from "./nesVrcBoard.js";
import { nesKnownBitsSchema, nesByteValueSchema } from "./nesByteValue.js";
import { z } from "zod";
import {
  nesCartridgeSchema,
  inspectNesCartridgeInputSchema,
} from "./nesCartridge.js";
import { nesPrgViewSchema } from "./nesPrgViews.js";

const byte = z.number().int().min(0).max(255);
const bit = z.union([z.literal(0), z.literal(1)]);
const mode = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]);
const unknownByte = byte.nullable().default(null);

const mmc1BankValue = (maximum: 15 | 31) =>
  z
    .union([
      byte.max(maximum),
      nesKnownBitsSchema
        .safeExtend({
          mask: z.number().int().min(1).max(maximum),
          value: byte.max(maximum),
        })
        .meta(nesKnownBitsSchema.meta() ?? {}),
    ])
    .nullable()
    .default(null);

const latchFields = {
  prg_bank: byte.max(15).nullable().default(null),
  chr_fd_0: byte.max(31).nullable().default(null),
  chr_fe_0: byte.max(31).nullable().default(null),
  chr_fd_1: byte.max(31).nullable().default(null),
  chr_fe_1: byte.max(31).nullable().default(null),
  latch_0: z.enum(["fd", "fe"]).nullable().default(null),
  latch_1: z.enum(["fd", "fe"]).nullable().default(null),
  mirroring: bit.nullable().default(null),
};
export const nesLatchMapperStateSchema = z.discriminatedUnion("mapper", [
  z.strictObject({ mapper: z.literal(9), ...latchFields }),
  z.strictObject({ mapper: z.literal(10), ...latchFields }),
]);
export type NesLatchMapperState = z.infer<typeof nesLatchMapperStateSchema>;

const vrc2Fields = {
  control: nesByteValueSchema
    .default(null)
    .describe("Raw 9000 register; only bit 0 selects mirroring."),
  prg_banks: z.array(nesByteValueSchema).length(2).default([null, null]),
  chr_low: z
    .array(nesByteValueSchema)
    .length(8)
    .default([null, null, null, null, null, null, null, null])
    .describe(
      "Raw low-nibble writes; Mapper 22 ignores D0, other VRC2 boards use it.",
    ),
  chr_high: z
    .array(nesByteValueSchema)
    .length(8)
    .default([null, null, null, null, null, null, null, null])
    .describe(
      "Raw high-nibble writes; only D0-D3 contribute to the combined CHR selector.",
    ),
};

const vrc4Fields = {
  variant: z.literal("vrc4"),
  prg_ram_wiring: z
    .enum(["internal-2k", "external-8k"])
    .nullable()
    .default(null)
    .describe(
      "Caller-selected immutable RAM wiring assumption, requiring a matching single-chip NES 2.0 RAM/NVRAM capacity. internal-2k decodes 6000–6FFF with a 2 KiB mirror; external-8k decodes 6000–7FFF without mirrors. Both obey 9002 D0. Omission leaves wiring unknown; header capacity alone does not establish the decoder.",
    ),
  control: nesByteValueSchema
    .default(null)
    .describe("Raw internal 9000 mirroring register, D1:D0."),
  prg_control: nesByteValueSchema
    .default(null)
    .describe(
      "Raw internal 9002 register: D1 swaps PRG windows, D0 enables WRAM.",
    ),
  prg_banks: vrc2Fields.prg_banks,
  chr_low: vrc2Fields.chr_low.describe("Raw low CHR writes, D3:D0."),
  chr_high: vrc2Fields.chr_high.describe(
    "Raw high CHR writes, D4:D0; the combined selector has nine bits.",
  ),
  irq_latch_low: nesByteValueSchema.default(null),
  irq_latch_high: nesByteValueSchema.default(null),
  irq_control: nesByteValueSchema.default(null),
  irq_enabled: z
    .boolean()
    .nullable()
    .default(null)
    .describe(
      "Proven enable after control/acknowledge; not an IRQ line or counter value.",
    ),
  last_irq_command: z.enum(["control", "acknowledge"]).nullable().default(null),
};
const vrc4StateFields = {
  mapper: z.union([z.literal(21), z.literal(23), z.literal(25)]),
  ...vrc4Fields,
};
const vrc2bFields = {
  mapper: z.literal(23),
  ...vrc2Fields,
  latch_present: z
    .boolean()
    .nullable()
    .default(null)
    .describe(
      "Caller-selected one-bit Microwire loopback wiring at 6000–6FFF; null means unknown. Mapper/submapper alone does not establish this circuit.",
    ),
  latch_value: bit
    .nullable()
    .default(null)
    .describe(
      "Proven D0 of the one-bit latch; omitted/reset value is unknown. Used only with latch_present true and no declared PRG RAM/NVRAM.",
    ),
};
const otherVrc2Fields = {
  mapper: z.union([z.literal(22), z.literal(25)]),
  ...vrc2Fields,
};

/** Logical register fields; omitted values mean unknown, never power-on defaults. */
export const nesMapperStateSchema = z.union([
  nesMmc5StateSchema,
  nesNamco163StateSchema,
  nesFme7StateSchema,
  nesVrc6StateSchema,
  nesBandaiStateSchema,
  z.strictObject({ ...vrc4StateFields }),
  z.strictObject({
    ...vrc4StateFields,
    wiring: nesVrc4WiringSchema.describe(
      "Immutable caller-selected physical board assumption for legacy/submapper-0 headers. Must match the mapper and any explicit NES 2.0 submapper; original header bytes remain unchanged. Omission retains header-only admission.",
    ),
  }),
  z.strictObject({ ...vrc2bFields }),
  z.strictObject({
    ...vrc2bFields,
    wiring: nesVrc2WiringSchema.describe(
      "Immutable caller-selected physical board assumption for legacy/submapper-0 headers. Must match the mapper and any explicit NES 2.0 submapper; original header bytes remain unchanged. Omission retains header-only admission.",
    ),
  }),
  z.strictObject({ ...otherVrc2Fields }),
  z.strictObject({
    ...otherVrc2Fields,
    wiring: nesVrc2WiringSchema.describe(
      "Immutable caller-selected physical board assumption for legacy/submapper-0 headers. Must match the mapper and any explicit NES 2.0 submapper; original header bytes remain unchanged. Omission retains header-only admission.",
    ),
  }),
  z.discriminatedUnion("mapper", [
    nesH3001StateSchema,
    nesSunsoft3StateSchema,
    nesSunsoft4StateSchema,
    nesVrc3StateSchema,
    nesIrem78StateSchema,
    nesJ87StateSchema,
    ...nesNamco108StateSchema.options,
    z.strictObject({
      mapper: z.literal(75),
      control: nesByteValueSchema
        .default(null)
        .describe(
          "Raw 9000 register: D0 mirroring, D1/D2 the high CHR selection bits.",
        ),
      prg_banks: z
        .array(nesByteValueSchema)
        .length(3)
        .default([null, null, null]),
      chr_banks: z
        .array(nesByteValueSchema)
        .length(2)
        .default([null, null])
        .describe(
          "Raw E000/F000 bytes; D0-D3 supply the low CHR selection bits.",
        ),
    }),
    z.strictObject({
      mapper: z.literal(33),
      prg_banks: z
        .array(nesByteValueSchema)
        .length(2)
        .default([null, null])
        .describe(
          "Raw PRG register bytes; register 0 bit 6 also controls mirroring.",
        ),
      chr_banks: z
        .array(nesByteValueSchema)
        .length(6)
        .default([null, null, null, null, null, null])
        .describe(
          "Two 2 KiB selectors followed by four 1 KiB selectors; paired selectors retain bit 0.",
        ),
    }),
    z.strictObject({
      mapper: z.literal(32),
      control: nesByteValueSchema.default(null),
      prg_banks: z.array(nesByteValueSchema).length(2).default([null, null]),
      chr_banks: z
        .array(nesByteValueSchema)
        .length(8)
        .default([null, null, null, null, null, null, null, null]),
    }),
    z.strictObject({
      mapper: z.literal(232),
      prg_outer_bank: z
        .union([
          byte.max(3),
          z.strictObject({ mask: z.literal(1), value: bit }),
          z.strictObject({
            mask: z.literal(2),
            value: z.union([z.literal(0), z.literal(2)]),
          }),
        ])
        .nullable()
        .default(null),
      prg_bank: byte.max(3).nullable().default(null),
    }),
    z.strictObject({
      mapper: z.literal(180),
      prg_bank: byte.max(7).nullable().default(null),
    }),
    z.strictObject({
      mapper: z.literal(0),
      prg_ram_write_enabled: z.boolean().nullable().default(null),
    }),
    z.strictObject({
      mapper: z.literal(71),
      prg_bank: byte.max(15).nullable().default(null),
      mirroring: bit.nullable().default(null),
    }),
    z.strictObject({
      mapper: z.literal(34),
      prg_bank: byte.max(3).nullable().default(null),
      chr_bank_0: byte.max(15).nullable().default(null),
      chr_bank_1: byte.max(15).nullable().default(null),
    }),
    z.strictObject({
      mapper: z.literal(11),
      prg_bank: byte.max(3).nullable().default(null),
      chr_bank: byte.max(15).nullable().default(null),
      bus_conflicts: z.enum(["and", "none", "unknown"]).default("unknown"),
    }),
    z.strictObject({
      mapper: z.literal(66),
      prg_bank: byte.max(3).nullable().default(null),
      chr_bank: byte.max(3).nullable().default(null),
    }),
    z.strictObject({
      mapper: z.literal(7),
      prg_bank: byte.max(7).nullable().default(null),
      mirroring: bit.nullable().default(null),
    }),
    z.strictObject({
      mapper: z.literal(2),
      prg_bank: byte.max(15).nullable().default(null),
    }),
    z.strictObject({
      mapper: z.literal(3),
      chr_bank: byte.max(3).nullable().default(null),
    }),
    z.strictObject({
      mapper: z.literal(1),
      prg_mode: mode.nullable().default(null),
      chr_mode: bit.nullable().default(null),
      mirroring: mode.nullable().default(null),
      prg_bank: mmc1BankValue(15).describe(
        "MMC1 four-bit PRG selector: a number is fully known, null is unknown, or {mask,value} preserves proven serial bits. A window needs only connected ROM address bits; 32 KiB modes ignore bit 0. Partial selectors do not establish a complete static PRG view.",
      ),
      prg_ram_disable_bit: bit.nullable().default(null),
      chr_bank_0: mmc1BankValue(31).describe(
        "MMC1 five-bit CHR selector, retaining proven serial bits as {mask,value}. Only connected CHR address bits are required; conventional outer PRG/RAM banking uses the repurposed high bits independently.",
      ),
      chr_bank_1: mmc1BankValue(31).describe(
        "MMC1 second five-bit CHR selector, with the same partial-bit semantics as chr_bank_0. In 4 KiB mode either output may affect conventional outer PRG/RAM banking; no PPU phase is assumed.",
      ),
      shift_bits: z
        .array(bit.nullable())
        .max(4)
        .nullable()
        .default(null)
        .describe(
          "LSB-first accepted bits (null bits are unknown), or null for unknown serial alignment; [] explicitly selects an empty serial port",
        ),
    }),
    z.strictObject({
      mapper: z.literal(4),
      bank_select: nesByteValueSchema.default(null),
      banks: z
        .array(nesByteValueSchema)
        .length(8)
        .describe(
          "MMC3 R0-R7 raw register bytes: a number is fully known, null is unknown, or {mask,value} retains proven bits. Physical PRG/CHR windows resolve only when their required address bits are known.",
        )
        .default([null, null, null, null, null, null, null, null]),
      mirroring: bit.nullable().default(null),
      ram_protect: nesByteValueSchema.default(null),
      irq_latch: nesByteValueSchema.default(null),
      last_irq_command: z
        .enum(["reload", "disable-acknowledge", "enable"])
        .nullable()
        .default(null),
    }),
    ...nesLatchMapperStateSchema.options,
  ]),
]);
export type NesMapperState = z.infer<typeof nesMapperStateSchema>;

const mapperWrite = z.strictObject({
  address: z.number().int().min(0).max(65535),
  value: byte
    .nullable()
    .describe("CPU bus value; null explicitly denotes an unknown value"),
  preceded_by_cpu_write: z
    .boolean()
    .nullable()
    .default(null)
    .describe(
      "Was the immediately preceding CPU cycle a write (even outside mapper space)? MMC1 uses this to filter serial data writes. Null means timing is unknown; reset writes always apply.",
    ),
});
export const nesMapperWriteSchema = z.union([
  mapperWrite,
  mapperWrite.extend({ value: z.null(), known_bits: nesKnownBitsSchema }),
]);
export type NesMapperWrite = z.infer<typeof nesMapperWriteSchema>;

export const traceNesMapperWritesInputSchema = z.strictObject({
  path: inspectNesCartridgeInputSchema.shape.path,
  max_file_bytes: inspectNesCartridgeInputSchema.shape.max_file_bytes,
  initial: nesMapperStateSchema,
  writes: z
    .array(nesMapperWriteSchema)
    .describe(
      "Ordered caller-supplied CPU writes, not a claim that the ROM executed them; include unknown values explicitly and do not omit intervening mapper writes",
    ),
  max_steps: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(1024)
    .describe(
      "Caller-selected budget for retained per-write register snapshots, default 1024; exceeding it returns an error before constructing the trace",
    ),
});

const windowSchema = z.strictObject({
  start: z.number().int().nonnegative(),
  size: z.number().int().positive(),
  bank: z.number().int().nonnegative().nullable(),
  file_offset: z.number().int().nonnegative().nullable(),
});
const mappingFields = {
  prg_view: nesPrgViewSchema.nullable(),
  prg_windows: z.array(windowSchema).max(4),
  chr_source: z.enum(["rom", "ram-unobserved", "ram-assumed"]),
  chr_windows: z.array(windowSchema).max(8),
  mirroring: z.enum([
    "one-screen-a",
    "one-screen-b",
    "vertical",
    "horizontal",
    "four-screen",
    "unknown",
    "custom",
  ]),
};
export const nesMapperMappingSchema = z.union([
  z.strictObject({
    ...mappingFields,
    cpu_windows: z.array(nesMmc5CpuWindowSchema).length(5),
    chr_windows_a: z.array(windowSchema).length(8),
    chr_windows_b: z.array(windowSchema).length(8),
    nametable_windows: z.array(nesMmc5NametableWindowSchema).length(4),
  }),
  z.strictObject({
    ...mappingFields,
    chr_source: z.literal("rom-ciram"),
    chr_windows: z.array(nesNamco163PpuWindowSchema).length(8),
    nametable_windows: z.array(nesNamco163PpuWindowSchema).length(4),
  }),
  z.strictObject({
    ...mappingFields,
    prg_windows: z.array(windowSchema).length(5),
    lower_window: nesFme7LowerWindowSchema,
  }),
  z.strictObject(mappingFields),
  z.strictObject({
    ...mappingFields,
    nametable_windows: z.array(nesNametableWindowSchema).length(4),
  }),
]);
export type NesMapperMapping = z.infer<typeof nesMapperMappingSchema>;

export const nesMapperWriteEffectSchema = z.enum([
  "outside-mapper",
  "latch-write",
  "uncertain-latch-write",
  "serial-reset",
  "serial-shift",
  "register-commit",
  "ignored-consecutive-write",
  "uncertain-serial-write",
  "bank-select",
  "bank-data",
  "uncertain-register-write",
  "prg-bank",
  "audio-register",
  "oam-dma-request",
  "eeprom-control",
  "prg-chr-bank",
  "chr-bank",
  "nametable",
  "ram-control",
  "exram-write",
  "exram-write-ignored",
  "uncertain-exram-write",
  "irq-latch",
  "irq-control",
  "irq-acknowledge",
  "prg-ram-control",
  "external-select",
  "irq-reload",
  "irq-disable",
  "irq-enable",
]);

export const nesMapperTraceSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("unsupported"),
    reason: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal("derived"),
    initial: nesMapperStateSchema,
    initial_mapping: nesMapperMappingSchema,
    steps: z.array(
      z.strictObject({
        index: z.number().int().nonnegative(),
        write: nesMapperWriteSchema,
        effect: nesMapperWriteEffectSchema,
        state: nesMapperStateSchema,
        prg_view: nesPrgViewSchema.nullable(),
        mapping: nesMapperMappingSchema.describe(
          "PRG/CHR source windows and mirroring immediately after this write; unresolved windows retain null banks and file offsets",
        ),
      }),
    ),
    final: nesMapperStateSchema,
    final_mapping: nesMapperMappingSchema,
    nes_prg_views: z.array(nesPrgViewSchema),
    coverage: z.strictObject({
      supplied_writes: z.number().int().nonnegative(),
      processed_writes: z.number().int().nonnegative(),
      unknown_prg_steps: z.number().int().nonnegative(),
    }),
  }),
]);
export type NesMapperTrace = z.infer<typeof nesMapperTraceSchema>;
export type NesMapperTraceStep = Extract<
  NesMapperTrace,
  { status: "derived" }
>["steps"][number];

export const nesMapperTraceReportSchema = z.strictObject({
  artifact: nesCartridgeSchema.shape.artifact,
  header: nesCartridgeSchema.shape.header,
  trace: nesMapperTraceSchema,
  limitations: z.array(z.string().min(1)),
});
