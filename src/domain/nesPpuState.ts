import { z } from "zod";
import { nesByteValueSchema, nesKnownBitsSchema } from "./nesByteValue.js";
import { nesPpuPatternTableSchema } from "./nesPpuPattern.js";
import { nesPpuNametableSchema } from "./nesPpuNametable.js";
import { nesPpuSpritesSchema } from "./nesPpuSprites.js";
import { nesPpuViewportSchema } from "./nesPpuViewport.js";
import { nesDmaRequestSchema } from "./nesCpuDma.js";
import { nesMmc5ExramOriginSchema } from "./nesMmc5Exram.js";
import { nesMmc5PpuContextSchema } from "./nesMmc5Ppu.js";

export const nesPpuMemoryLimitations =
  "Optional initial_ppu model ppu-memory derives mirrored CPU PPU ports, shared scroll/address toggle, 15-bit address proofs, PPUDATA buffering and physical CHR RAM/CIRAM/palette facts. register_writes_enabled, non-rendering access, palette_read_mode and dma_reads are explicit assumptions; omitted facts stay unknown. Linear 8 KiB CHR RAM and CIRAM/four-screen backing require matching declarations or recorded legacy assumptions. MMC1/MMC3 and other standard CHR muxes preserve every compatible bank source; MMC2/MMC4 read the old source before changing latches. Sunsoft 4 normal nametables preserve CIRAM/CHR-ROM mux alternatives, forced-high ROM bank bit 7 and physical capacity aliases. ROM writes are ignored; uncertain mux writes join possible CIRAM changes with prior cells/origins. Unqualified CIRAM alternatives remain explicit unknown sources through PPUDATA buffering and continuation. Nametable/viewport source pages retain numeric final-memory coordinates or original ROM offsets and nullable authenticated 1 KiB snapshots, pairing tile and attribute facts within each page. VRC6 pattern and nametable reads preserve every compatible ROM/CIRAM source, including partial B003 modes and forced A10 before capacity aliasing. Explicit ciram-2k backing enables CIRAM byte origins; omitted backing preserves an unknown CIRAM alternative alongside captured ROM. CPU 2007 buffers retain captured history across later bank or memory changes; ROM writes are ignored and mixed writes conditionally join CIRAM facts. Namco 163 pattern and nametable muxes retain compatible ROM and shared CIRAM sources; pattern CIRAM pages refer to the same final.nametable cells and origins as nametable pages. E800 lower/upper disable controls are independent, while nametable substitution remains enabled. Null backing retains explicit unknown alternatives. Possible F000=3F audio-debug mode adds an unresolved source; definite debug mode proves no normal graphics source. Unverified debug external writes invalidate retained CIRAM, while CPU palette-only writes remain internal. MMC5 shares CIRAM backing and mapper-owned ExRAM with its qualified PPU mux; generated fill/zero bytes retain tagged register/constant facts. CPU PPUDATA qualifies its non-rendering role, while supplied PPU reads preserve caller fetch/tile qualifications through the existing ordered extended/split interpreter. ExRAM writers use the same absolute PPU event cursor; held captures and buffers preserve historical facts across overwrites and continuation. Ordinary frozen queries separate background/sprite roles and retain up to 1024 ROM pages plus one unresolved override. Optional ppu_mmc5_background supplies separate caller-qualified nametable/viewport screen-column and split-counter origins for per-row frozen extended/split projection. The projection preserves tile/attribute/CHR/palette correlation, including aliased ExRAM cells and CL/SL row wiring; omitted geometry retains unresolved overrides. Historical active-tile geometry never qualifies an entire query. CPU-port operations retain register views, source facts and write deltas; external PPU bus operations omit unchanged CPU registers; only initial/final contain storage images. PPU event steps reference a shared mapper_snapshots table containing complete mapper/mapping/IRQ facts, retaining every event and restoring identical states without duplicate snapshots. Absolute PPU event indices survive continuation; source mapper_event_range indexes relative committed mapper steps. ppu_trace.frontier retains hypothetical accesses of an unapplied source instruction without committing them. CHR ROM comes from the same stable descriptor and full SHA-256 as PRG. Optional ppu_pattern_table 0/1 decodes the final mapped 4 KiB table into 256 tiles with compatible two-bit pixel sets; canonical choices preserve non-bit-constrained alternatives such as opaque 1/2; pooled physical source pages preserve every compatible ROM byte or final CHR RAM or CIRAM cell, retaining explicit unresolved sources without simulating reads or changing latches/IRQs/history. Optional ppu_nametable 0..3 decodes 960 background tile indices, 64 attribute bytes/quadrants, exact compatible subpalette choices and raw/grayscale six-bit palette-code proofs. Physical nametable pages and palette cells refer to final memory origins, preserving mirror correlation and PPUCTRL pattern-table uncertainty. Optional ppu_sprites true with the oam-memory profile decodes all 64 final physical entries, conditional 8x8/8x16 rows, whole-sprite flips and sprite palette codes through shared CHR pages. Unselected sprites is null. OAM/CHR/palette origins remain in final memory; pixel zero is transparent. Frozen OAM scanline nomination examines all 240 visible lines per compatible global height, starting at entry zero; Y+1 geometry admits the first eight vertical matches regardless of X, opacity or priority. Candidate display-row masks, admission and secondary-OAM slot ranges retain partial Y uncertainty. Each height pools identical candidate lists in candidate_sets; all 240 lines retain their candidate_set references and count bounds. Aggregate excess is not the buggy overflow flag. Actual evaluation timing, OAMADDR effects, overflow and sprite-zero hits remain unmodeled. Optional ppu_viewport model frozen-viewport composes every 256x240 logical pixel from an explicit origin in the 512x480 nametable atlas, separately per compatible global sprite height. Pixel-state pools retain palette/code masks and first-opaque/visible OAM contributors under priority and PPUMASK clipping. Tile and attribute alternatives share the same physical nametable page; unknown selectors form conservative covers. Forced blanking uses known/possible v palette addresses and exact grayscale code sets. Mapper/VRAM/OAM remain frozen, including read-triggered latches; no PPU fetches or clocks are executed. The conventional EXT-zero backdrop is assumed before silicon-specific borders, emphasis and RGB output. Current v/t/fine_x and PPUCTRL base bits do not establish the caller-selected viewport origin. Queries do not infer actual scrolling timing, EXT inputs, video conversion, collision status or observed rendering. Pattern indices do not establish observed background/sprite usage or rendered output. RAM and initial registers are caller assumptions, not observed hardware. Optional initial_ppu.oam model oam-memory tracks 256 physical cells, OAMADDR/OAMDATA and queued 4014 DMA. Retention, readability and uncorrupted address writes are explicit qualifications; omissions stay unverified. Raw oam-dma events supply 256 conditional CPU-page values; source tools derive known-page packets with separate oam_dma_reads ROM/RAM origins and a shared max_oam_dma_source_bytes budget. Budget frontiers retain partial proofs without committing a transfer. Unknown source pages and CPU device-page values remain unverified/unknown; no fake ROM offsets are emitted. Attribute bits D2-D4 have scoped constant-zero proofs; DMA origins retain physical destination and every compatible rotation. Source initial_cpu_dma additionally derives qualified OAM halt/alignment/get/put timing with separate source cycles. Time-varying rendering, master-clock alignment, generated NMI edges, actual OAM evaluation timing/decay, unselected DMC timing, RGB/video and audio waveforms are not simulated. Unknown rendering accesses and possible unobserved DMA repeats conservatively invalidate affected facts. ";

const ppuWrite = z.strictObject({
  kind: z.literal("ppu-write"),
  address: z.number().int().min(0).max(16383),
  value: z.number().int().min(0).max(255).nullable(),
});
export const nesPpuBusWriteEventSchema = z
  .union([
    ppuWrite,
    ppuWrite.extend({ value: z.null(), known_bits: nesKnownBitsSchema }),
  ])
  .describe(
    "Actual external PPU bus write, including partial values. Standard CHR RAM/CIRAM requires initial_ppu model ppu-memory; Mapper 5 retains its separate ExRAM model. Addresses 3Fxx use the external nametable underlay, not the internal CPU-port palette overlay.",
  );
const bounded = (maximum: number) =>
  z
    .union([
      z.number().int().min(0).max(maximum),
      nesKnownBitsSchema
        .safeExtend({
          mask: z.number().int().min(1).max(maximum),
          value: z.number().int().min(0).max(maximum),
        })
        .meta(nesKnownBitsSchema.meta() ?? {}),
    ])
    .nullable();
export const nesPpuAddressSchema = z.strictObject({
  low: nesByteValueSchema.default(null),
  high: bounded(127).default(null),
});
export const nesPpuOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("initial-memory"),
    space: z.enum(["chr-ram", "nametable", "palette", "oam"]),
    address: z.number().int().min(0).max(8191),
  }),
  z.strictObject({
    kind: z.literal("initial-register"),
    field: z.enum(["io-latch", "read-buffer", "status"]),
  }),
  z.strictObject({
    kind: z.enum(["event-write", "event-read"]),
    index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z
    .strictObject({
      kind: z.literal("dma-write"),
      index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
      address: z.number().int().min(0).max(255),
      start_address: nesByteValueSchema,
    })
    .describe(
      "OAM DMA write from the referenced event's 256 source values. Every compatible source offset is (address - candidate start_address) & 255; unknown start bits are never replaced by zero.",
    ),
  z.strictObject({
    kind: z.literal("dma-byte"),
    index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    offset: z.number().int().min(0).max(255),
  }),
]);
export type NesPpuOrigin = z.infer<typeof nesPpuOriginSchema>;
export const nesPpuSourceSchema = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("unknown"),
      value: z.null(),
      mask: z.literal(255),
      reason: z.string().min(1),
    })
    .describe(
      "An unresolved complete-byte source alternative. It contributes unknown bits and survives PPUDATA buffering/continuation alongside known physical sources; it is never a fabricated memory or ROM origin.",
    ),
  z.strictObject({
    kind: z.literal("rom"),
    file_offset: z.number().int().nonnegative(),
    value: nesByteValueSchema,
    mask: z.number().int().min(1).max(255),
  }),
  z.strictObject({
    kind: z.literal("memory"),
    space: z.enum(["chr-ram", "nametable", "palette", "oam"]),
    address: z.number().int().min(0).max(8191),
    value: nesByteValueSchema,
    mask: z.number().int().min(1).max(255),
    origin: nesPpuOriginSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("register"),
    field: z.enum(["io-latch", "read-buffer", "status"]),
    value: nesByteValueSchema,
    mask: z.number().int().min(1).max(255),
    origin: nesPpuOriginSchema,
  }),
  z.strictObject({
    kind: z.literal("mmc5-exram"),
    address: z.number().int().min(0).max(1023),
    cell_value: nesByteValueSchema,
    attribute_shift: z
      .union([z.literal(0), z.literal(2), z.literal(4), z.literal(6)])
      .nullable(),
    value: nesByteValueSchema,
    mask: z.number().int().min(1).max(255),
    origin: nesMmc5ExramOriginSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal("mmc5-fill"),
    register: z.union([z.literal(0x5106), z.literal(0x5107)]),
    register_value: nesByteValueSchema,
    value: nesByteValueSchema,
    mask: z.number().int().min(1).max(255),
  }),
  z.strictObject({
    kind: z.literal("mmc5-zero"),
    value: z.literal(0),
    mask: z.number().int().min(1).max(255),
  }),
  z
    .strictObject({
      kind: z.literal("oam-attribute-zeroes"),
      value: z.literal(0),
      mask: z.literal(28),
      addresses: z
        .array(
          z
            .number()
            .int()
            .min(2)
            .max(254)
            .refine((n) => n % 4 === 2)
            .meta({ enum: Array.from({ length: 64 }, (_, n) => n * 4 + 2) }),
        )
        .min(1)
        .max(64),
    })
    .describe(
      "Unimplemented OAM attribute bits D2-D4 are zero at these compatible physical addresses; this is a conditional wiring proof, not a RAM writer or a statement about other OAM addresses.",
    ),
]);
export type NesPpuSource = z.infer<typeof nesPpuSourceSchema>;
const sources = z
  .array(nesPpuSourceSchema)
  .max(2816)
  .describe(
    "Physical byte sources, generated MMC5 fill/zero facts or register facts. MMC5 admits 1024 ordinary CHR offsets and at most 2816 qualified rendering offsets; source masks identify contributing data bits. ExRAM cells refer to the sole mapper.exram owner, with historical captured bytes/origins retained in buffered reads.",
  );
const fact = z.strictObject({
  value: nesByteValueSchema,
  origin: nesPpuOriginSchema,
});
export const nesOamStateSchema = z
  .strictObject({
    model: z.literal("oam-memory"),
    retention: z.enum(["stable", "unobserved"]).default("unobserved"),
    address: nesByteValueSchema.default(null),
    reads: z.enum(["supported", "open-bus"]).nullable().default(null),
    address_writes: z.enum(["uncorrupted", "unobserved"]).default("unobserved"),
    dma_pending: nesDmaRequestSchema.prefault({ status: "unknown" }),
    cells: z
      .record(
        z.string().regex(/^(?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])$/u),
        z.union([nesByteValueSchema, fact]),
      )
      .meta({ maxProperties: 256 })
      .default({}),
  })
  .describe(
    "Optional stable OAM memory interpretation. Retention over covered accesses is a caller assumption; rendering/evaluation/decay are not advanced. OAMDATA readability and uncorrupted OAMADDR writes require explicit qualifications. Missing DMA pending state is unknown, not an assumed empty queue. Cells are physical read-byte facts; known set bits D2-D4 in attribute cells are incompatible with this profile.",
  );
export type NesOamState = z.infer<typeof nesOamStateSchema>;
const oamDmaEvent = z
  .strictObject({
    kind: z.literal("oam-dma"),
    page: nesByteValueSchema,
    values: z.array(nesByteValueSchema).length(256),
  })
  .describe(
    "One explicitly qualified conventional OAM DMA completion at the next CPU read, consuming a pending 4014 request (or qualifying unknown initial request presence). values are successive raw CPU-page byte assumptions, not authenticated CPU reads by themselves. Source-code tracing supplies these values with separate oam_dma_reads provenance. Requires initial_ppu.oam model oam-memory. Non-rendering and no unobserved DMC interference are required to prove storage; no cycles, CPU IRQ polling or sprite rendering are inferred.",
  );
export const nesOamDmaEventSchema = z.union([
  oamDmaEvent,
  oamDmaEvent.extend({
    halted_cpu_address: z
      .number()
      .int()
      .min(0)
      .max(65535)
      .nullable()
      .describe(
        "Qualified CPU address held at the start of this conventional transfer. Controller analysis uses it only to exclude or retain possible internal-device DMA clocks; omission is unknown, never an assumed opcode fetch.",
      ),
  }),
]);
const chrCells = z
  .record(
    z
      .string()
      .regex(/^(?:0|[1-9]\d{0,2}|[1-7]\d{3}|8(?:0\d{2}|1(?:[0-8]\d|9[01])))$/u),
    z.union([nesByteValueSchema, fact]),
  )
  .meta({ maxProperties: 8192 });
const ntCells = z
  .record(
    z.string().regex(/^(?:0|[1-9]\d{0,2}|[1-3]\d{3}|40(?:[0-8]\d|9[0-5]))$/u),
    z.union([nesByteValueSchema, fact]),
  )
  .meta({ maxProperties: 4096 });
const paletteCells = z
  .record(
    z.string().regex(/^(?:[0-9]|1[0-5]|1[789]|2[1235679]|3[01])$/u),
    z.union([bounded(63), fact.extend({ value: bounded(63) })]),
  )
  .meta({ maxProperties: 28 });
export const nesPpuRegistersSchema = z.strictObject({
  control: nesByteValueSchema.default(null),
  mask: nesByteValueSchema.default(null),
  status: nesByteValueSchema.default(null),
  status_origin: nesPpuOriginSchema.default({
    kind: "initial-register",
    field: "status",
  }),
  v: nesPpuAddressSchema.prefault({}),
  t: nesPpuAddressSchema.prefault({}),
  fine_x: bounded(7).default(null),
  write_toggle: z
    .union([z.literal(0), z.literal(1)])
    .nullable()
    .default(null),
  io_latch: z
    .strictObject({
      value: nesByteValueSchema.default(null),
      origin: nesPpuOriginSchema.default({
        kind: "initial-register",
        field: "io-latch",
      }),
    })
    .prefault({}),
  read_buffer: z
    .strictObject({
      value: nesByteValueSchema.default(null),
      sources: sources.default([]),
    })
    .prefault({}),
});
export type NesPpuRegisters = z.infer<typeof nesPpuRegistersSchema>;
export const nesPpuStateSchema = nesPpuRegistersSchema
  .extend({
    model: z.literal("ppu-memory"),
    oam: nesOamStateSchema.nullable().default(null),
    register_writes_enabled: z
      .boolean()
      .nullable()
      .default(null)
      .describe(
        "Explicit PPU warmup/write-inhibit state. Null joins ignored/accepted control, mask, scroll and address writes; no reset or elapsed CPU cycles are inferred.",
      ),
    access_phase: z
      .enum(["non-rendering", "unknown"])
      .default("unknown")
      .describe(
        "Caller qualification for the covered accesses. Otherwise only proven PPUMASK D3/D4 clear establishes non-rendering. Active/unknown rendering writes remain unverified.",
      ),
    palette_read_mode: z
      .enum(["direct", "buffered"])
      .nullable()
      .default(null)
      .describe(
        "Explicit stable direct or early buffered palette-read profile. Null also admits unreliable palette reads, so only common upper-latch/buffer facts survive; no silicon identity or master-clock alignment is inferred.",
      ),
    dma_reads: z
      .enum(["absent", "unobserved"])
      .default("unobserved")
      .describe(
        "Explicit absence of unobserved DMA repeats on CPU PPU-port reads. Without explicit DMC cpu_timing, possible 4015 D4 enable degrades this fact. Selected source DMC timing retains actual repeated CPU-port reads and their effects. OAM-DMA requests involving PPU register pages conservatively invalidate register facts.",
      ),
    chr_ram_size: z
      .literal(8192)
      .nullable()
      .default(null)
      .describe(
        "Explicit linear 8 KiB CHR RAM wiring assumption. Requires no CHR ROM and matching NES2 single RAM/NVRAM declaration, or an explicit legacy assumption. Mixed or larger layouts need another profile.",
      ),
    nametable_layout: z
      .enum(["ciram-2k", "four-screen-4k"])
      .nullable()
      .default(null),
    chr_ram: chrCells.default({}),
    nametable: ntCells.default({}),
    palette: paletteCells.default({}),
    next_event_index: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
  })
  .describe(
    "Optional stable PPU CPU-port and memory interpretation, shared by supplied events and source-code tracing. Register mirrors, 15-bit address facts, buffered reads and physical storage are explicit; omitted values stay unknown. Optional oam-memory qualifies OAM ports and conventional DMA data copies. No PPU cycles, NMI delivery, OAM evaluation/decay, DMA timing, latch decay or rendering pipeline is inferred.",
  );
export type NesPpuState = z.infer<typeof nesPpuStateSchema>;
const alternative = {
  value: nesByteValueSchema,
  sources,
  reason: z.string().min(1).nullable(),
};
export const nesPpuByteOriginSchema = z.strictObject({
  kind: z.literal("ppu-register"),
  cpu_address: z.number().int().min(0x2000).max(0x3fff),
  register_address: z.number().int().min(0x2000).max(0x2007),
  alternatives: z
    .array(
      z.discriminatedUnion("mode", [
        z.strictObject({
          mode: z.enum(["register", "buffered", "unobserved"]),
          ...alternative,
        }),
        z.strictObject({
          mode: z.literal("palette"),
          ...alternative,
          palette_mask: nesByteValueSchema,
        }),
      ]),
    )
    .min(1)
    .max(2),
});
export type NesPpuByteOrigin = z.infer<typeof nesPpuByteOriginSchema>;
const busRead = z.strictObject({
  status: z.literal("ppu-memory"),
  address: z.number().int().min(0).max(16383).nullable(),
  bank: z.number().int().nonnegative().nullable(),
  file_offset: z.number().int().nonnegative().nullable(),
  value: z.number().int().min(0).max(255).nullable(),
  sources,
  reason: z.string().min(1).nullable(),
});
export const nesPpuBusReadSchema = z.union([
  busRead,
  busRead.extend({ value: z.null(), known_bits: nesKnownBitsSchema }),
  busRead.extend({ mmc5: nesMmc5PpuContextSchema }),
  busRead.extend({
    value: z.null(),
    known_bits: nesKnownBitsSchema,
    mmc5: nesMmc5PpuContextSchema,
  }),
]);
export type NesPpuBusRead = z.infer<typeof nesPpuBusReadSchema>;
/** A generated fill/zero fact or one ExRAM cell is resolved without inventing a ROM bank. */
export const nesPpuBusSourceResolved = (read: NesPpuBusRead): boolean =>
  read.sources.length === 1 && read.sources[0]!.kind !== "unknown";
const registerBaseView = nesPpuRegistersSchema
  .omit({ read_buffer: true })
  .extend({
    read_buffer: nesByteValueSchema,
    dma_reads: z.enum(["absent", "unobserved"]),
  });
const registerView = z.union([
  registerBaseView,
  registerBaseView.extend({ oam: nesOamStateSchema.omit({ cells: true }) }),
]);
const operationFields = {
  event_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  bus_reads: z.array(nesPpuBusReadSchema).max(1),
  ppu_address: z.number().int().min(0).max(16383).nullable(),
  write: z
    .strictObject({
      status: z.enum(["written", "uncertain", "ignored", "unverified"]),
      destinations: z
        .array(
          z.strictObject({
            space: z.enum([
              "chr-ram",
              "nametable",
              "palette",
              "oam",
              "mmc5-exram",
            ]),
            address: z.number().int().min(0).max(8191),
          }),
        )
        .max(13340),
      invalidated_spaces: z
        .array(z.enum(["chr-ram", "nametable", "palette", "oam", "mmc5-exram"]))
        .max(5),
      reason: z.string().min(1).nullable(),
    })
    .nullable(),
};
const cpuOperation = z.strictObject({
  kind: z.literal("cpu-port"),
  ...operationFields,
  before: registerView,
  after: registerView,
  read: nesPpuByteOriginSchema.nullable(),
});
const busOperation = z.strictObject({
  kind: z.literal("ppu-bus"),
  ...operationFields,
});
export const nesOamDmaWriteSchema = z
  .strictObject({
    status: z.enum(["written", "unverified"]),
    range: z
      .strictObject({
        space: z.literal("oam"),
        start: z.literal(0),
        size: z.literal(256),
      })
      .nullable(),
    invalidated_spaces: z.array(z.literal("oam")).max(1),
    reason: z.string().min(1).nullable(),
  })
  .describe(
    "A qualified conventional transfer covers the entire physical OAM extent regardless of its starting address. A shared range replaces 256 repeated destination records. Null range means destination coverage was unverified; data retention may remain unverified even when all writes were qualified.",
  );
export type NesOamDmaWrite = z.infer<typeof nesOamDmaWriteSchema>;
export const nesPpuOperationSchema = z.discriminatedUnion("kind", [
  cpuOperation,
  busOperation,
  z.strictObject({
    kind: z.literal("oam-dma-start"),
    event_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    before: registerView,
    after: registerView,
    page: z.number().int().min(0).max(255),
    bus_reads: z.array(z.never()).max(0),
    ppu_address: z.null(),
    write: z.null(),
  }),
  z.strictObject({
    kind: z.literal("oam-dma"),
    ...operationFields,
    write: nesOamDmaWriteSchema,
    before: registerView,
    after: registerView,
    page: nesByteValueSchema,
    start_address: nesByteValueSchema,
  }),
]);
export type NesPpuCpuOperation = z.infer<typeof cpuOperation>;
export type NesPpuBusOperation = z.infer<typeof busOperation>;
export type NesPpuOperation = z.infer<typeof nesPpuOperationSchema>;
export type NesOamDmaOperation = Extract<NesPpuOperation, { kind: "oam-dma" }>;
const cpuRead = z.strictObject({
  address: z.number().int().min(0).max(65535).nullable(),
  value: z.number().int().min(0).max(255).nullable(),
  source: nesPpuByteOriginSchema.nullable(),
});
export const nesPpuCpuReadSchema = z.union([
  cpuRead,
  cpuRead.extend({ value: z.null(), known_bits: nesKnownBitsSchema }),
]);
const ppuTrace = z.strictObject({
  sprites: nesPpuSpritesSchema.nullable().default(null),
  viewport: nesPpuViewportSchema.nullable().default(null),
  initial: nesPpuStateSchema,
  operations: z.array(nesPpuOperationSchema),
  final: nesPpuStateSchema,
  coverage: z.strictObject({
    bus_reads: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Examined external PPU bus reads, including CPU-port refills; excludes hypothetical frontier accesses and unobserved DMA repeats",
      ),
    unknown_bus_sources: z
      .number()
      .int()
      .nonnegative()
      .describe(
        "Examined reads without a unique physical source; common value bits do not identify an uncertain bank",
      ),
    unknown_bus_values: z
      .number()
      .int()
      .nonnegative()
      .describe("Examined reads without any full-byte or partial value proof"),
  }),
  frontier: z
    .array(nesPpuOperationSchema)
    .describe(
      "Source-only hypothetical accesses from an unapplied instruction frontier. They provide provenance for reported partial reads but do not change final state or committed mapper events.",
    ),
});

export const nesPpuTraceSchema = z.union([
  ppuTrace,
  ppuTrace.extend({ pattern_table: nesPpuPatternTableSchema }),
  ppuTrace.extend({ nametable: nesPpuNametableSchema }),
  ppuTrace.extend({
    pattern_table: nesPpuPatternTableSchema,
    nametable: nesPpuNametableSchema,
  }),
]);
