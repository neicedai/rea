import {
  nesPpuStateSchema,
  nesPpuTraceSchema,
  nesPpuCpuReadSchema,
  nesPpuBusReadSchema,
  nesPpuBusWriteEventSchema,
  nesOamDmaEventSchema,
} from "./nesPpuState.js";
import { nesBandaiIrqStateSchema } from "./nesBandaiIrq.js";
import {
  nesNamco163IrqStateSchema,
  nesNamco163IrqReadSchema,
} from "./nesNamco163Irq.js";
import { nesFme7IrqStateSchema } from "./nesFme7Irq.js";
import { nesH3001IrqStateSchema } from "./nesH3001Irq.js";
import { nesSunsoft3IrqStateSchema } from "./nesSunsoft3Irq.js";
import { nesVrc3IrqStateSchema } from "./nesVrc3Irq.js";
import { nesBandaiEepromReadSchema } from "./nesBandaiEepromState.js";
import { nesNamco163RamReadSchema } from "./nesNamco163Ram.js";
import { nesMmc5CpuReadSchema } from "./nesMmc5Cpu.js";
import { nesMmc5IrqStateSchema, nesMmc5IrqReadSchema } from "./nesMmc5Irq.js";
import { nesByteValueSchema } from "./nesByteValue.js";
import { nesMmc5TilePositionSchema } from "./nesMmc5RenderingState.js";
import { nesMmc5FetchSchema, nesMmc5PpuReadSchema } from "./nesMmc5Ppu.js";
import { z } from "zod";
import {
  nesControllerHoldEventSchema,
  nesHeldControllerReadSchema,
} from "./nesCpuIo.js";
import { nesOamDmaStartEventSchema } from "./nesCpuDma.js";
import { nesDmcEventSchema, nesDmcReadSchema } from "./nesDmc.js";
import { nesMmc3SignalEventSchema } from "./nesMmc3A12.js";
import { nesMmc3IrqStateSchema } from "./nesMmc3Irq.js";
import { nesVrcIrqStateSchema } from "./nesVrcIrq.js";
import {
  nesMapperStateSchema,
  nesMapperMappingSchema,
  nesMapperWriteSchema,
  nesMapperWriteEffectSchema,
  traceNesMapperWritesInputSchema,
  nesMapperTraceReportSchema,
} from "./nesMapperTrace.js";
import { nesPrgViewSchema } from "./nesPrgViews.js";
import { nesPpuPatternSelectionSchema } from "./nesPpuPattern.js";
import { nesPpuNametableSelectionSchema } from "./nesPpuNametable.js";
import { nesPpuSpritesSelectionSchema } from "./nesPpuSprites.js";
import { nesPpuViewportSelectionSchema } from "./nesPpuViewport.js";
import { nesPpuMmc5BackgroundSelectionSchema } from "./nesPpuMmc5BackgroundSelection.js";
import {
  nesApuStateSchema,
  nesApuTraceSchema,
  nesApuCpuReadSchema,
  nesApuClockEventSchema,
} from "./nesApu.js";
import {
  nesControllersStateSchema,
  nesControllerTraceSchema,
  nesControllerCpuReadSchema,
  nesControllerButtonsEventSchema,
} from "./nesControllers.js";

const irqStateSchema = z.union([
  nesMmc5IrqStateSchema,
  nesNamco163IrqStateSchema,
  nesFme7IrqStateSchema,
  nesMmc3IrqStateSchema,
  nesVrcIrqStateSchema,
  nesBandaiIrqStateSchema,
  nesH3001IrqStateSchema,
  nesSunsoft3IrqStateSchema,
  nesVrc3IrqStateSchema,
]);
export type NesMapperIrqState = z.infer<typeof irqStateSchema>;
export const nesMapperCpuReadSchema = z.union([
  ...nesHeldControllerReadSchema.options,
  ...nesApuCpuReadSchema.options,
  ...nesControllerCpuReadSchema.options,
  ...nesPpuCpuReadSchema.options,
  ...nesMmc5IrqReadSchema.options,
  ...nesMmc5CpuReadSchema.options,
  ...nesBandaiEepromReadSchema.options,
  ...nesNamco163RamReadSchema.options,
  ...nesNamco163IrqReadSchema.options,
  z.strictObject({
    address: z.number().int().min(0).max(65535).nullable(),
    value: z.null(),
    source: z.null(),
  }),
]);
export type NesMapperCpuRead = z.infer<typeof nesMapperCpuReadSchema>;
const ppuReadEvent = z.strictObject({
  kind: z.literal("ppu-read"),
  address: z.number().int().min(0).max(16383),
});
const cpuReadEvent = z.strictObject({
  kind: z.literal("cpu-read"),
  address: z.number().int().min(0).max(65535).nullable(),
});

export const nesMapperEventSchema = z.union([
  z
    .strictObject({ kind: z.literal("vrc3-cpu-cycle") })
    .describe(
      "One qualified CPU edge for Mapper 73 initial_irq model vrc3. The enabled 8/16-bit counter increments, reloads on overflow and latches IRQ while remaining enabled. Eight-bit overflow reloads only the low byte; control-enable writes reload both bytes. Source bus timing emits a separate subsequent edge, including DMA stalls; supplied writes/reads/PPU events do not imply clocks or physical IRQ timing.",
    ),
  ...nesDmcEventSchema.options,
  nesControllerHoldEventSchema,
  ...nesApuClockEventSchema.options,
  nesControllerButtonsEventSchema,
  nesOamDmaEventSchema,
  nesOamDmaStartEventSchema,
  z
    .strictObject({ kind: z.literal("mmc5-render-frame") })
    .describe(
      "Qualified MMC5 vblank split-scroll load for initial.ppu model mmc5-background. Loads the current 5201 value and invalidates the active tile pipeline; does not clock/reset IRQ or infer a PPU frame.",
    ),
  z
    .strictObject({ kind: z.literal("mmc5-render-line") })
    .describe(
      "One qualified subsequent rendering scanline for initial.ppu model mmc5-background. Advances only held split Y (239/255 wrap to zero), invalidates the tile pipeline, and supplies no IRQ clock. Prefetched tiles can qualify line next without advancing it.",
    ),
  z
    .strictObject({ kind: z.literal("mmc5-cpu-cycle") })
    .describe(
      "One explicit M2 rising edge for initial_irq model mmc5. Three rises without an intervening PPU read clear in-frame/matching history; no CPU access or source instruction supplies this edge automatically.",
    ),
  z
    .strictObject({ kind: z.literal("mmc5-reset") })
    .describe(
      "Caller-qualified MMC5 reset detection. Establishes documented PRG mode, RAM protection, ExRAM mode, CHR-upper and split-control/scroll reset bits. Disables scanline IRQ output without clearing pending, comparator, counter or frame/filter history. Captured CHR latches, bank selectors and storage remain intact. No reset, elapsed M2 gap or power-on image is inferred; audio/MMC5A reset effects remain unmodeled.",
    ),
  z
    .strictObject({ kind: z.literal("namco163-cpu-cycle") })
    .describe(
      "One explicit CPU cycle for initial_irq model namco163: an enabled 15-bit counter increments to 7FFF, asserts on that transition, and saturates. No implicit instruction clocks or CPU interrupt acceptance.",
    ),
  z
    .strictObject({ kind: z.literal("fme7-cpu-cycle") })
    .describe(
      "One explicit CPU cycle for a matching Mapper 69 FME-7/5A/5B IRQ model; count enable and IRQ enable are independent. Source instructions and writes never imply cycles.",
    ),
  z
    .strictObject({ kind: z.literal("h3001-cpu-cycle") })
    .describe(
      "One qualified CPU edge for Mapper 65 initial_irq model h3001. Nonzero 1-to-0 asserts and disables; zero_behavior chooses a conditional zero-start rule or preserves unknown alternatives. Supplied writes/reads/PPU events do not imply this edge. Source bus timing emits a separate subsequent edge, including DMA stalls, without claiming physical IRQ observation.",
    ),
  z
    .strictObject({ kind: z.literal("sunsoft3-cpu-cycle") })
    .describe(
      "One qualified CPU edge for Mapper 67 initial_irq model sunsoft3 with the external IRQ input inactive. Old-zero underflow to FFFF asserts and disables; 1-to-0 does not assert. Supplied writes/reads/PPU events do not imply this edge. Source bus timing emits a separate subsequent edge, including DMA stalls, without claiming physical IRQ observation.",
    ),
  z
    .strictObject({ kind: z.literal("eeprom-write-complete") })
    .describe(
      "Explicit caller assumption that a previously STOP-started EEPROM write cycle completed. No elapsed time, hardware observation or save-file write is inferred.",
    ),
  cpuReadEvent.describe(
    "Supplied CPU read address; null preserves an unknown address and possible device access. Explicit Bandai EEPROM proves D4. Explicit Namco chip_ram returns full/partial byte and advances its pointer, including conservative unobserved-DMA outcomes. With initial_irq model namco163, 5000–5FFF return current counter/enable proofs without acknowledgement. Other unmodeled reads and open-bus bits remain unknown.",
  ),
  cpuReadEvent
    .extend({ address: z.literal(0x2002), ppu_status: nesByteValueSchema })
    .describe(
      "MMC5 initial_irq model only: caller-supplied PPUSTATUS bus byte/proof at exact CPU address 2002. Proven D7 sets reset the frame/scanline state; unknown D7 joins reset/no-reset. Mirrors do not snoop. This is supplied evidence, not a PPU execution result.",
    ),
  z
    .strictObject({ kind: z.literal("bandai-cpu-cycle") })
    .describe(
      "One explicit complete CPU cycle for a matching conventional Bandai IRQ model; writes and PPU reads never imply cycles.",
    ),
  z
    .strictObject({ kind: z.literal("vrc-cpu-cycle") })
    .describe(
      "One explicit complete CPU cycle for the selected conventional VRC4/VRC6 IRQ model. CPU writes and PPU reads do not advance it automatically.",
    ),
  ...nesMmc3SignalEventSchema.options,
  z
    .strictObject({ kind: z.literal("mmc3-irq-clock") })
    .describe(
      "One externally qualified MMC3 counter clock, after A12 filtering; not an unfiltered PPU read or a scanline",
    ),
  z.union(
    nesMapperWriteSchema.options.map((write) =>
      write.extend({ kind: z.literal("cpu-write") }),
    ),
  ),
  ppuReadEvent,
  nesPpuBusWriteEventSchema,
  ppuReadEvent.extend({
    mmc5_fetch: nesMmc5FetchSchema.describe(
      "MMC5-only caller qualification: sprite/background is a rendering fetch recognized by the mapper; ppudata is a non-rendering CPU data-port access; dummy is a qualified non-background throwaway fetch. An address alone establishes none of these. No fetch classification or scanline timing is inferred.",
    ),
  }),
  ppuReadEvent
    .extend({
      address: z
        .number()
        .int()
        .min(0x2000)
        .max(0x3eff)
        .refine((address) => (address & 1023) < 960, {
          message: "MMC5 tile qualification requires a nametable-data address",
        })
        .meta({
          anyOf: Array.from({ length: 8 }, (_, page) => ({
            minimum: 0x2000 + page * 1024,
            maximum: Math.min(0x2000 + page * 1024 + 959, 0x3eff),
          })),
        }),
      mmc5_fetch: z.literal("background"),
      mmc5_tile: nesMmc5TilePositionSchema,
    })
    .describe(
      "MMC5 background nametable-data read with explicit screen-column/current-or-next-line qualification. Requires the selected background rendering model and a nametable data address, not an attribute/pattern/palette address.",
    ),
]);
export const traceNesMapperEventsInputSchema = traceNesMapperWritesInputSchema
  .omit({ writes: true, initial: true })
  .extend({
    initial: nesMapperStateSchema,
    initial_ppu: nesPpuStateSchema.nullable().default(null),
    initial_controllers: nesControllersStateSchema.nullable().default(null),
    initial_apu: nesApuStateSchema.nullable().default(null),
    ppu_pattern_table: nesPpuPatternSelectionSchema,
    ppu_nametable: nesPpuNametableSelectionSchema,
    ppu_sprites: nesPpuSpritesSelectionSchema,
    ppu_viewport: nesPpuViewportSelectionSchema,
    ppu_mmc5_background: nesPpuMmc5BackgroundSelectionSchema,
    initial_irq: irqStateSchema.nullable().default(null),
    max_steps: traceNesMapperWritesInputSchema.shape.max_steps.describe(
      "Caller-selected retained event snapshot budget; excess events are rejected before derivation",
    ),
    events: z
      .array(nesMapperEventSchema)
      .describe(
        "Ordered supplied mapper CPU writes/reads, explicit EEPROM write-completion assumptions, actual PPU bus read addresses, PPU writes under initial_ppu or MMC5 and optional mmc5_fetch qualifications, qualified MMC3 clocks/signals, or explicitly modeled MMC5/VRC/Bandai/FME-7/Namco/H3001/Sunsoft-3 CPU cycles. MMC5 mmc5-reset is externally qualified; ppu_status supplies an exact-2002 bus proof under its IRQ model. MMC5 CPU reads include multiplier/ExRAM and 5204 pre-acknowledgement status under initial_irq model mmc5. Writes and PPU reads do not imply CPU cycles; CPU-port buffering requires explicit initial_ppu and no automatic rendering is inferred",
      ),
  });
export type NesMapperEvent = z.infer<typeof nesMapperEventSchema>;
const mapperEventStep = z.strictObject({
  index: z.number().int().nonnegative(),
  event: nesMapperEventSchema,
  write_effect: nesMapperWriteEffectSchema.nullable(),
  read_source: z
    .union([
      nesPpuBusReadSchema,
      nesMmc5PpuReadSchema,
      z.strictObject({
        status: z.enum([
          "chr-rom",
          "unknown-chr-bank",
          "chr-ram-unobserved",
          "unknown-nametable-bank",
          "ciram-unobserved",
          "outside-pattern-tables",
        ]),
        bank: z.number().int().nonnegative().nullable(),
        file_offset: z.number().int().nonnegative().nullable(),
      }),
    ])
    .nullable(),
  state: nesMapperStateSchema,
  irq: irqStateSchema.nullable(),
  irq_clock: z
    .boolean()
    .nullable()
    .describe(
      "Whether this event clocks the IRQ counter; null means supplied signal or cycle state cannot decide",
    ),
  mapping: nesMapperMappingSchema,
});
const eventStep = z.union([
  mapperEventStep,
  mapperEventStep.extend({ cpu_read: nesMapperCpuReadSchema }),
  mapperEventStep.extend({ dmc_read: nesDmcReadSchema }),
]);
export type NesMapperEventStep = z.infer<typeof eventStep>;
const compactStep = mapperEventStep
  .omit({ state: true, mapping: true, irq: true })
  .extend({
    mapper_snapshot: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .describe(
        "Index in mapper_snapshots identifying mapper/mapping after-state. IRQ after-state is owned either by the referenced snapshot or by this event's irq field, never both.",
      ),
  });
const irqCompactStep = compactStep.extend({ irq: irqStateSchema.nullable() });
const irqEventStep = z.union([
  irqCompactStep,
  irqCompactStep.extend({ cpu_read: nesMapperCpuReadSchema }),
  irqCompactStep.extend({ dmc_read: nesDmcReadSchema }),
]);
export type NesCpuIrqMapperEventStep = z.infer<typeof irqEventStep>;
const ppuEventStep = z.union([
  compactStep,
  compactStep.extend({ cpu_read: nesMapperCpuReadSchema }),
  compactStep.extend({ dmc_read: nesDmcReadSchema }),
  ...irqEventStep.options,
]);
export type NesPpuMapperEventStep = z.infer<typeof ppuEventStep>;
const mapperSnapshot = z.strictObject({
  state: nesMapperStateSchema,
  mapping: nesMapperMappingSchema,
  irq: irqStateSchema.nullable(),
});
export type NesMapperEventSnapshot = z.infer<typeof mapperSnapshot>;
const storedMapperSnapshot = z.union([
  mapperSnapshot,
  mapperSnapshot.omit({ irq: true }),
]);
export type NesStoredMapperEventSnapshot = z.infer<typeof storedMapperSnapshot>;
const coverage = z.strictObject({
  supplied_events: z.number().int().nonnegative(),
  processed_events: z.number().int().nonnegative(),
  unknown_pattern_reads: z.number().int().nonnegative(),
});
const vrc6Coverage = coverage.extend({
  unknown_nametable_reads: z.number().int().nonnegative(),
});
const cpuCoverage = {
  unknown_cpu_reads: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Supplied CPU reads without a full byte or partial proof. Explicit Bandai D4 and Namco chip-RAM proofs count as known coverage; missing data and unknown addresses remain unknown.",
    ),
};
const derivedEventsTrace = z.strictObject({
  status: z.literal("derived"),
  initial: nesMapperStateSchema,
  initial_irq: irqStateSchema.nullable(),
  initial_mapping: nesMapperMappingSchema,
  steps: z.array(eventStep),
  final: nesMapperStateSchema,
  final_irq: irqStateSchema.nullable(),
  final_mapping: nesMapperMappingSchema,
  nes_prg_views: z.array(nesPrgViewSchema),
  coverage: z.union([
    coverage,
    vrc6Coverage,
    coverage.extend(cpuCoverage),
    vrc6Coverage.extend(cpuCoverage),
  ]),
});
const ppuEventsTrace = derivedEventsTrace
  .extend({
    controller_trace: nesControllerTraceSchema.nullable().default(null),
    ppu_trace: nesPpuTraceSchema,
    steps: z.array(ppuEventStep),
    mapper_snapshots: z
      .array(storedMapperSnapshot)
      .min(1)
      .describe(
        "Unique immutable mapper/mapping after-states; index 0 is initialized state. Legacy IRQ state may be stored here; CPU-clocked device traces instead retain irq on each event so counter changes do not duplicate an unchanged mapping.",
      ),
  })
  .superRefine(validateSnapshotReferences);
function validateSnapshotReferences(
  trace: {
    steps: { mapper_snapshot: number; irq?: unknown }[];
    mapper_snapshots: object[];
  },
  ctx: z.RefinementCtx,
) {
  for (const [index, step] of trace.steps.entries()) {
    const snapshot = trace.mapper_snapshots[step.mapper_snapshot];
    if (snapshot === undefined)
      ctx.addIssue({
        code: "custom",
        path: ["steps", index, "mapper_snapshot"],
        message: "Mapper snapshot reference is outside the retained table",
      });
    else if ("irq" in step === "irq" in snapshot)
      ctx.addIssue({
        code: "custom",
        path: ["steps", index, "mapper_snapshot"],
        message:
          "Each event IRQ after-state must have exactly one owner: event or mapper snapshot",
      });
  }
}
const unsupportedEventsTrace = z.strictObject({
  status: z.literal("unsupported"),
  reason: z.string().min(1),
});
const controllerEventsTrace = derivedEventsTrace
  .extend({
    controller_trace: nesControllerTraceSchema,
    steps: z.array(ppuEventStep),
    mapper_snapshots: z.array(storedMapperSnapshot).min(1),
  })
  .superRefine(validateSnapshotReferences);
const apuEventsTrace = derivedEventsTrace
  .extend({
    apu_trace: nesApuTraceSchema,
    steps: z.array(ppuEventStep),
    mapper_snapshots: z.array(storedMapperSnapshot).min(1),
  })
  .superRefine(validateSnapshotReferences);
const pooledEventsTrace = derivedEventsTrace
  .extend({
    steps: z.array(irqEventStep),
    mapper_snapshots: z.array(storedMapperSnapshot).min(1),
  })
  .superRefine(validateSnapshotReferences);
export const nesLegacyMapperEventsTraceSchema = z.union([
  unsupportedEventsTrace,
  derivedEventsTrace,
  pooledEventsTrace,
]);
export type NesLegacyMapperEventsTrace = z.infer<
  typeof nesLegacyMapperEventsTraceSchema
>;
// Facet presence identifies the existing strict variant before walking its
// potentially large step array. Preprocessing preserves the value; the output
// JSON Schema remains the canonical strict variant, including required facets.
const withEventFacets = <Schema extends z.ZodType>(
  schema: Schema,
  facets: { ppu: boolean; controllers?: boolean; apu: boolean },
) =>
  z.preprocess((value, ctx) => {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      "ppu_trace" in value !== facets.ppu ||
      "apu_trace" in value !== facets.apu ||
      (facets.controllers !== undefined &&
        "controller_trace" in value !== facets.controllers)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Mapper event trace facets do not match this strict variant.",
      });
      return z.NEVER;
    }
    return value;
  }, schema);
export const nesMapperEventsTraceSchema = z.union([
  withEventFacets(nesLegacyMapperEventsTraceSchema, {
    ppu: false,
    controllers: false,
    apu: false,
  }),
  withEventFacets(ppuEventsTrace, { ppu: true, apu: false }),
  withEventFacets(controllerEventsTrace, {
    ppu: false,
    controllers: true,
    apu: false,
  }),
  withEventFacets(apuEventsTrace, {
    ppu: false,
    controllers: false,
    apu: true,
  }),
  withEventFacets(ppuEventsTrace.safeExtend({ apu_trace: nesApuTraceSchema }), {
    ppu: true,
    apu: true,
  }),
  withEventFacets(
    controllerEventsTrace.safeExtend({ apu_trace: nesApuTraceSchema }),
    { ppu: false, controllers: true, apu: true },
  ),
]);
export type NesMapperEventsTrace = z.infer<typeof nesMapperEventsTraceSchema>;
/** Resolve both legacy inline snapshots and the explicit PPU snapshot table. */
export const nesMapperEventSnapshot = (
  trace: Extract<NesMapperEventsTrace, { status: "derived" }>,
  step: NesMapperEventStep | NesPpuMapperEventStep,
): NesMapperEventSnapshot | null => {
  if ("mapper_snapshot" in step) {
    if (!("mapper_snapshots" in trace)) return null;
    const snapshot = trace.mapper_snapshots[step.mapper_snapshot];
    if (snapshot === undefined) return null;
    if ("irq" in step)
      return "irq" in snapshot ? null : { ...snapshot, irq: step.irq };
    return "irq" in snapshot ? snapshot : null;
  }
  return { state: step.state, mapping: step.mapping, irq: step.irq };
};
export const nesMapperEventsReportSchema = nesMapperTraceReportSchema
  .omit({ trace: true })
  .extend({ trace: nesMapperEventsTraceSchema });
