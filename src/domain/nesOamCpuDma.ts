import { z } from "zod";
import { nesDmaRequestSchema, mergeNesDmaRequests } from "./nesCpuDma.js";
import { ok, err } from "./result.js";
import type { NesPpuState } from "./nesPpuState.js";
import type { NesControllersState } from "./nesControllers.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesApuState } from "./nesApu.js";
import { nesDmcTimingPhase } from "./nesDmcTiming.js";

// One halt, at most one alignment, and 256 get/put pairs.
export const NES_OAM_DMA_CYCLES = 2 + 256 * 2;

export const nesOamCpuDmaLimitations =
  "Optional initial_cpu_dma model oam-cpu-dma schedules qualified OAM transfers before the next CPU read, independently of instruction commitment. Requires initial_cpu_bus, initial_ppu.oam and absent unobserved DMA/DMC reads in selected device profiles. One shared request is reconciled across CPU/OAM/controller/Namco views; 4014 replacement and consecutive RMW writes retain the last page. Explicit current get/put phase is independent of numeric cycle-index parity and is reconciled with CPU-ordered APU timing. An uncontended transfer consumes one halt, an optional alignment, and 256 alternating get/2004-put pairs (513/514 cycles), advancing selected APU/cartridge clocks during stalls. Explicit NTSC initial_apu.dmc.cpu_timing shares halt/dummy/alignment cycles and gives DMC gets priority; OAM puts require a held OAM byte, and an active DMC transfer or a reload first requested by the final OAM put stays in the same held burst until it finishes. Transfer cycles own raw source proofs, 256 writes and ordered event ranges; they do not count as CPU instructions or interrupt polls. Complete transfers commit before a following unsupported instruction; incomplete prefixes, unknown request/page/phase, unobserved DMC and internal-register DMA conflicts without initial_cpu_io remain stopped frontiers. initial_cpu_io adds qualified 2A03 internal status/controller decoding. New PPU clocks, unselected DMC timing, unqualified DMC stop-window races, unselected/PAL internal 4000–401F DMA decode behavior, within-cycle races and physical hardware observations are not inferred.";
export const nesOamCpuDmaStateSchema = z
  .strictObject({
    model: z.literal("oam-cpu-dma"),
    region: z.enum(["ntsc", "pal"]),
    cpu_phase: z.enum(["get", "put"]).nullable().default(null),
    oam_dma_pending: nesDmaRequestSchema.prefault({ status: "unknown" }),
  })
  .describe(nesOamCpuDmaLimitations);
export type NesOamCpuDmaState = z.infer<typeof nesOamCpuDmaStateSchema>;

/** Reconcile one physical request/clock. Unknown device facts can be refined by qualified peers. */
export const admitNesOamCpuDma = (
  initial: NesOamCpuDmaState,
  ppu: NesPpuState | null,
  controllers: NesControllersState | null,
  mapper: NesMapperState,
  apu: NesApuState | null,
) => {
  const failure = (reason: string) =>
    err({ kind: "invalid-oam-cpu-dma" as const, reason });
  if (ppu?.oam == null)
    return failure(
      "Ordered OAM DMA requires initial_ppu.oam model oam-memory.",
    );
  const chip =
    mapper.mapper === 19 && "chip_ram" in mapper ? mapper.chip_ram : null;
  if (
    ppu.dma_reads !== "absent" ||
    (controllers !== null && controllers.dma_reads !== "absent") ||
    (chip !== null && chip.dma_reads !== "absent") ||
    (apu !== null && apu.dmc_reads !== "absent" && apu.dmc?.cpu_timing == null)
  )
    return failure(
      "Ordered OAM DMA requires absent unobserved DMA/DMC reads in every selected device profile.",
    );
  if (
    apu !== null &&
    (apu.frame_clocks !== "cpu-ordered" ||
      apu.frame_sequencer.region !== initial.region)
  )
    return failure(
      "Ordered OAM DMA and a selected APU require matching CPU-ordered region timing.",
    );
  const apuPhase =
    (apu?.frame_clocks === "cpu-ordered"
      ? apu.frame_sequencer.cpu_phase
      : null) ?? nesDmcTimingPhase(apu);
  if (
    apuPhase !== null &&
    initial.cpu_phase !== null &&
    apuPhase !== initial.cpu_phase
  )
    return failure(
      "CPU DMA and APU get/put phases contradict the same CPU clock.",
    );
  const merged = mergeNesDmaRequests([
    initial.oam_dma_pending,
    ppu.oam.dma_pending,
    ...(controllers === null ? [] : [controllers.oam_dma_pending]),
    ...(chip === null
      ? []
      : [
          chip.oam_dma_pending === "none"
            ? { status: "none" as const }
            : { status: "pending" as const, page: chip.oam_dma_pending },
        ]),
  ]);
  if (!merged.ok) return merged;
  return ok({
    ...structuredClone(initial),
    cpu_phase: initial.cpu_phase ?? apuPhase,
    oam_dma_pending: merged.value,
  });
};
