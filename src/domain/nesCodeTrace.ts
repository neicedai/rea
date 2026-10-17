import {
  NES_DMC_INLINE_TRANSFERS,
  NES_DMC_OAM_TRANSFERS,
  NES_DMC_STALL_CYCLES,
} from "./nesDmcTiming.js";
import { nesDmcCpuDmaTraceSchema } from "./nesDmcCpuDma.js";
import { nesPpuStateSchema, nesPpuByteOriginSchema } from "./nesPpuState.js";
import { nesPpuPatternSelectionSchema } from "./nesPpuPattern.js";
import { nesPpuNametableSelectionSchema } from "./nesPpuNametable.js";
import { nesPpuSpritesSelectionSchema } from "./nesPpuSprites.js";
import { nesPpuViewportSelectionSchema } from "./nesPpuViewport.js";
import { nesPpuMmc5BackgroundSelectionSchema } from "./nesPpuMmc5BackgroundSelection.js";
import { nesApuStateSchema, nesApuReadSourceSchema } from "./nesApu.js";
import {
  nesControllersStateSchema,
  nesControllerReadSourceSchema,
} from "./nesControllers.js";
import { NES_CPU_DMA_SOURCE_BYTES } from "./nesCpuDmaBudget.js";
import {
  nesKnownBitsSchema,
  nesKnownByteValueSchema,
  nesByteValueSchema,
} from "./nesByteValue.js";
import { nesBandaiEepromReadSourceSchema } from "./nesBandaiEepromState.js";
import { nesFme7VariantSchema } from "./nesFme7.js";
import { nesMmc5RamWiringSchema } from "./nesMmc5.js";
import {
  nesMmc5MultiplySourceSchema,
  nesMmc5ExramSourceSchema,
} from "./nesMmc5Cpu.js";
import { z } from "zod";
import { NES_OAM_DMA_CYCLES, nesOamCpuDmaStateSchema } from "./nesOamCpuDma.js";
import {
  nesCpuIoStateSchema,
  nesCpuIoReadSourceSchema,
  nesHeldControllerSourceSchema,
  nesCpuIoLatchViewSchema,
} from "./nesCpuIo.js";
import {
  nesCpuInterruptStateSchema,
  nesCpuInterruptPollSchema,
} from "./nesCpuInterrupts.js";
import { nesCpuRegisterBitsSchema } from "./nesCpuRegister.js";
import {
  nesMapperEventsTraceSchema,
  traceNesMapperEventsInputSchema,
} from "./nesMapperEvents.js";
import { nesNamco163IrqReadSourceSchema } from "./nesNamco163Irq.js";
import { nesNamco163RamReadSourceSchema } from "./nesNamco163Ram.js";
import {
  inspectNesCartridgeInputSchema,
  nesCartridgeSchema,
} from "./nesCartridge.js";
import {
  nesMapperStateSchema,
  nesMapperTraceSchema,
  nesMapperWriteSchema,
} from "./nesMapperTrace.js";
import { nesPrgViewSchema } from "./nesPrgViews.js";

const byte = z.number().int().min(0).max(255).nullable().default(null);
const flag = z.boolean().nullable().default(null);
const cpuState = z.strictObject({
  a: byte,
  x: byte,
  y: byte,
  sp: byte,
  c: flag,
  z: flag,
  i: flag,
  d: flag,
  v: flag,
  n: flag,
});
export const nesCpuStateSchema = z.union([
  cpuState,
  cpuState
    .extend({ register_bits: nesCpuRegisterBitsSchema })
    .superRefine((cpu, ctx) => {
      for (const register of ["a", "x", "y", "sp"] as const)
        if (cpu.register_bits[register] !== undefined && cpu[register] !== null)
          ctx.addIssue({
            code: "custom",
            path: ["register_bits", register],
            message: "A partial register proof requires a null complete byte",
          });
    })
    .meta({
      allOf: ["a", "x", "y", "sp"].map((register) => ({
        if: { properties: { register_bits: { required: [register] } } },
        then: { properties: { [register]: { type: "null" } } },
      })),
    }),
]);
export type NesCpuState = z.infer<typeof nesCpuStateSchema>;
const cpuBusState = z
  .strictObject({
    model: z.literal("nmos-6502-bus"),
    dma_reads: z.enum(["absent", "unobserved"]),
    next_cycle_index: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .default(0),
  })
  .describe(
    "Caller-selected ordered NMOS 6502 CPU bus, with no unobserved RDY/DMA pause while dma_reads is absent. Without initial_cpu_dma, pending OAM requests and 4014 writes invalidate that qualification. Without initial_apu.dmc.cpu_timing, possible 4015 DMC enable writes invalidate it and stop before the next read. Explicit NTSC 2a03-dmc-dma timing schedules load/reload stalls, qualifies independent stop history, retries ordinary halted writes and shares OAM setup cycles; cpu_bus.dmc distinguishes delivered samples, aborted halts and real discarded gets with stop provenance. Cycles are derived, not captured hardware. Optional CPU-ordered APU framing consumes one subsequent edge after each bus action. Selected CPU-clocked cartridge IRQ models emit separate subsequent edges; other device clocks are not inferred. Interrupt polling additionally requires initial_interrupts.",
  );
export type NesCpuBusState = z.infer<typeof cpuBusState>;
export const nesCpuBusLimitations =
  "Optional initial_cpu_bus model nmos-6502-bus derives ordered nominal NMOS bus actions, with opcode/operand/pointer/data/dummy/stack/vector read sources and write indices. dma_reads absent is a caller qualification excluding unobserved RDY/DMA pauses; pending OAM requests and 4014 writes demote it to unobserved unless initial_cpu_dma owns their timing; possible 4015 D4 enable writes always demote it, stopping before the next read. Unresolved optional page-crossing cycles stop with cpu-timing-unresolved. cpu_bus retains initial/initialized/committed-final cycle indices. cpu_bus_frontier retains the unapplied prefix and its hypothetical writes; it never advances final_cpu or committed bus/device state. JSR reads its high operand after stack writes, so that byte can identify a preceding write in the same instruction. With initial_apu.frame_clocks cpu-ordered, each bus action emits one subsequent apu-cpu-cycle edge in mapper_event_range; replay those ordered events. CPU-clocked cartridge IRQ edges additionally require initial_irq; other device clocks and physical execution are not inferred. Ordered OAM DMA timing additionally requires initial_cpu_dma. Interrupt polling requires initial_interrupts. Without this profile, source tracing supplies no cycle clocks.";
export const nesSourceIrqLimitations =
  "Optional source initial_irq selects a VRC3/VRC4/VRC6, Bandai FCG/LZ93D50, FME-7, Namco 163, H3001 or Sunsoft 3 counter model with qualified initial_cpu_bus. Every qualified nominal or DMA bus action emits a separate subsequent cartridge CPU-cycle event before an optional APU edge; register writes take effect first. mapper_event_range retains both clock families without conflating them. Namco 5000–57FF reads the live low counter; 5800–5FFF combines current high count bits with the live enable bit. Reads never acknowledge. Counter proofs use namco163-irq-counter mapper_origins with mapper_event_index relative to the nested mapper trace; stopped reads refer to cpu_bus_frontier.mapper_events after that committed prefix. Frontier events and writes are hypothetical and do not change committed final_irq/CPU/device state. Continue with mapper_trace.final and final_irq plus selected device/bus final states. Partial counters and enables preserve uncertainty. MMC3/MMC5 source IRQ timing is unsupported without qualified PPU signals; use the supplied-event tool. IRQ acceptance/polling additionally requires initial_interrupts. OAM stalls additionally require initial_cpu_dma; source DMC stalls require initial_apu.dmc.cpu_timing. Qualified initial one-byte loads model implicit stop/abort or late discarded gets and same-burst duplication under explicit silicon selection. Ordinary buffer-empty reloads become eligible immediately; caller reload latency does not establish get/put phase. Unknown windows retain a frontier. Caller-seeded timing, other within-cycle races and physical silicon timing are not observations.";
export const traceNesCodeInputSchema = z.strictObject({
  path: inspectNesCartridgeInputSchema.shape.path,
  max_file_bytes: inspectNesCartridgeInputSchema.shape.max_file_bytes,
  initial: nesMapperStateSchema,
  initial_ppu: nesPpuStateSchema.nullable().default(null),
  initial_controllers: nesControllersStateSchema.nullable().default(null),
  initial_apu: nesApuStateSchema.nullable().default(null),
  initial_cpu_bus: cpuBusState.nullable().default(null),
  initial_interrupts: nesCpuInterruptStateSchema.nullable().default(null),
  initial_cpu_dma: nesOamCpuDmaStateSchema.nullable().default(null),
  initial_cpu_io: nesCpuIoStateSchema.nullable().default(null),
  initial_irq: traceNesMapperEventsInputSchema.shape.initial_irq.describe(
    "Explicit cartridge IRQ state. Source clocks require initial_cpu_bus and a CPU-clocked VRC4/VRC6/Bandai/FME-7/Namco/H3001/Sunsoft3 model; MMC3/MMC5 require PPU signals unavailable from the CPU-only source path. No CPU interrupt acceptance is inferred.",
  ),
  ppu_pattern_table: nesPpuPatternSelectionSchema,
  ppu_nametable: nesPpuNametableSelectionSchema,
  ppu_sprites: nesPpuSpritesSelectionSchema,
  ppu_viewport: nesPpuViewportSelectionSchema,
  ppu_mmc5_background: nesPpuMmc5BackgroundSelectionSchema,
  max_dmc_dma_source_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(NES_CPU_DMA_SOURCE_BYTES)
    .describe(
      "Shared retained DMC DMA read-proof byte budget, including halted/dummy/alignment and OAM-shared source reads. Incomplete transfers retain only a budgeted unapplied prefix.",
    ),
  max_oam_dma_source_bytes: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .default(NES_CPU_DMA_SOURCE_BYTES)
    .describe(
      "Caller budget for retained OAM DMA read-proof JSON elements and separators in UTF-8, default 2 MiB; excludes structural metadata and other Evidence. Shared across all explored attempts, including repeated prefixes and hypothetical frontier reads. A transfer that cannot fit stops its instruction before committing a packet, retaining a partial oam_dma_frontier with the pending request intact. Does not raise the client's total response limit.",
    ),
  cpu: nesCpuStateSchema
    .prefault({})
    .describe(
      "Caller-selected initial register and flag values; omitted values are unknown, never reset defaults",
    ),
  initial_ram: z
    .array(
      z.strictObject({
        address: z.number().int().min(0).max(2047),
        value: z.number().int().min(0).max(255),
      }),
    )
    .max(2048)
    .superRefine((items, ctx) => {
      const addresses = new Set<number>();
      for (const [index, item] of items.entries()) {
        if (addresses.has(item.address))
          ctx.addIssue({
            code: "custom",
            path: [index, "address"],
            message: "Initial RAM addresses must be unique",
          });
        addresses.add(item.address);
      }
    })
    .default([])
    .describe(
      "Caller-selected byte assumptions for physical 2 KiB internal RAM, including stack. Addresses 0..2047 must be unique; CPU mirrors share the same bytes. Omitted bytes are unknown. Not a hardware observation or cartridge RAM image.",
    ),
  initial_prg_ram: z
    .array(
      z.strictObject({
        bank: z.number().int().min(0).max(63),
        address: z.number().int().min(0x6000).max(0x7fff),
        value: z.number().int().min(0).max(255),
      }),
    )
    .max(524288)
    .superRefine((items, ctx) => {
      const locations = new Set<string>();
      for (const [index, item] of items.entries()) {
        const key = `${item.bank}:${item.address}`;
        if (locations.has(key))
          ctx.addIssue({
            code: "custom",
            path: [index, "address"],
            message: "Initial PRG RAM bank/address pairs must be unique",
          });
        locations.add(key);
      }
    })
    .default([])
    .describe(
      "Caller-selected physical cartridge RAM byte assumptions. Bank/address pairs must be unique and fit the modeled board; use canonical addresses, not mirrors. Up to 64 physical 8 KiB banks on FME-7; other boards retain their own capacity checks. Does not enable RAM or bypass read/write protection; omitted bytes stay unknown. Unknown board wiring is unsupported.",
    ),
  entry: z
    .union([
      z.enum(["reset", "nmi", "irq"]),
      z.number().int().min(0).max(65535),
      z.strictObject({
        accepted_interrupt: z.enum(["nmi", "irq"]),
        return_address: z.number().int().min(0).max(65535),
      }),
    ])
    .default("reset")
    .describe(
      "CPU entry address or reset/NMI/IRQ vector selector (no frame or flag changes). An object with accepted_interrupt and return_address explicitly assumes an already-accepted interrupt: resolves its vector, pushes the return PC and status with B=0, then sets I. Requires known SP and vector; does not infer acceptance, line timing or I-flag polling.",
    ),
  branch_choices: z
    .array(
      z.strictObject({
        address: z.number().int().min(0).max(65535),
        taken: z.boolean(),
      }),
    )
    .default([])
    .describe(
      "Ordered caller assumptions consumed only at unknown conditional branches; addresses must match the encountered frontier. Known branches never consume a choice.",
    ),
  max_instructions: z
    .number()
    .int()
    .positive()
    .max(Number.MAX_SAFE_INTEGER)
    .default(1024)
    .describe(
      "Caller-selected retained instruction budget; exhaustion returns an explicitly stopped prefix, not complete program coverage",
    ),
});
export type TraceNesCodeInput = z.infer<typeof traceNesCodeInputSchema>;

const reasons = z.enum([
  "return",
  "instruction-budget",
  "oam-dma-source-budget",
  "unresolved-vector",
  "unmapped-instruction",
  "cpu-timing-dma",
  "cpu-timing-unresolved",
  "interrupt-uncertain",
  "cpu-dma-request",
  "cpu-dma-phase",
  "cpu-dma-io-conflict",
  "cpu-io-controller-uncertain",
  "dmc-dma-request",
  "dmc-dma-phase",
  "dmc-dma-address",
  "dmc-dma-stop-timing",
  "dmc-dma-stop-window",
  "dmc-dma-source-budget",
  "unsupported-opcode",
  "unknown-branch",
  "branch-choice-mismatch",
  "unknown-control-target",
  "unknown-write-address",
  "unknown-stack",
]);
export type NesCodeStopReason = z.infer<typeof reasons>;
const offsets = z.array(z.number().int().nonnegative().nullable()).max(3);
const ramWriter = {
  byte_index: z.number().int().min(0).max(2),
  instruction_index: z.number().int().nonnegative(),
  write_index: z.number().int().min(0).max(2),
};
const writtenRamOrigin = z.discriminatedUnion("region", [
  z.strictObject({
    ...ramWriter,
    region: z.literal("internal-ram"),
    ram_address: z.number().int().min(0).max(2047),
  }),
  z.strictObject({
    ...ramWriter,
    region: z.literal("prg-ram"),
    bank: z.number().int().min(0).max(63),
    ram_address: z.number().int().min(0x6000).max(0x7fff),
  }),
]);
const ramOrigin = z.union([
  writtenRamOrigin,
  z.strictObject({
    byte_index: z.number().int().min(0).max(2),
    region: z.literal("internal-ram"),
    ram_address: z.number().int().min(0x100).max(0x1ff),
    interrupt_index: z.number().int().nonnegative(),
    interrupt_write_index: z.number().int().min(0).max(2),
  }),
  z.strictObject({
    byte_index: z.number().int().min(0).max(2),
    region: z.literal("internal-ram"),
    ram_address: z.number().int().min(0x100).max(0x1ff),
    entry_interrupt_write_index: z.number().int().min(0).max(2),
  }),
  z.strictObject({
    byte_index: z.number().int().min(0).max(2),
    region: z.literal("prg-ram"),
    ram_address: z.number().int().min(0x6000).max(0x7fff),
    bank: z.number().int().min(0).max(63),
    initial_prg_ram_index: z.number().int().min(0).max(524287),
  }),
  z.strictObject({
    byte_index: z.number().int().min(0).max(2),
    region: z.literal("internal-ram"),
    ram_address: z.number().int().min(0).max(2047),
    initial_ram_index: z.number().int().min(0).max(2047),
  }),
]);
export type NesRamLocation =
  | { region: "internal-ram"; ram_address: number }
  | { region: "prg-ram"; ram_address: number; bank: number };
// Up to three instruction bytes, each proven across all 64 possible FME-7 RAM banks.
const ramOrigins = z
  .array(ramOrigin)
  .max(192)
  .describe(
    "Sources proving the complete byte or its known_bits. Multiple physical bank origins prove common bits across every candidate. An uncertain store retains the earlier source only for bits shared by the stored and retained values; this does not identify a definite last writer.",
  );
const mapperWriteSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("initial-state") }),
  z
    .strictObject({
      kind: z.literal("event-write"),
      index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .describe(
      "Absolute PPU event index retained by the selected ppu-memory profile; preceding writer evidence may belong to an earlier continuation segment.",
    ),
  z.strictObject({
    kind: z.literal("cpu-write"),
    instruction_index: z.number().int().nonnegative(),
    write_index: z.number().int().min(0).max(2),
  }),
]);
export type NesMapperWriteSource = z.infer<typeof mapperWriteSourceSchema>;
const mapperOrigins = z
  .array(
    z.discriminatedUnion("kind", [
      nesCpuIoReadSourceSchema.extend({
        byte_index: z.number().int().min(0).max(2),
      }),
      nesHeldControllerSourceSchema.extend({
        byte_index: z.number().int().min(0).max(2),
      }),
      nesNamco163IrqReadSourceSchema.extend({
        byte_index: z.number().int().min(0).max(2),
        mapper_event_index: z
          .number()
          .int()
          .nonnegative()
          .max(Number.MAX_SAFE_INTEGER)
          .describe(
            "Read event's zero-based index in this code path's nested mapper trace. Unapplied reads belong to the frontier after that committed prefix.",
          ),
      }),
      nesApuReadSourceSchema.extend({
        byte_index: z.number().int().min(0).max(2),
      }),
      nesControllerReadSourceSchema.extend({
        byte_index: z.number().int().min(0).max(2),
      }),
      nesPpuByteOriginSchema.extend({
        byte_index: z.number().int().min(0).max(2),
      }),
      nesMmc5MultiplySourceSchema.extend({
        byte_index: z.number().int().min(0).max(2),
        factor_sources: z.array(mapperWriteSourceSchema).length(2),
      }),
      nesMmc5ExramSourceSchema.extend({
        access: z.literal("readable"),
        cell_value: nesKnownByteValueSchema,
        byte_index: z.number().int().min(0).max(2),
        mode_source: mapperWriteSourceSchema,
        byte_source: mapperWriteSourceSchema,
      }),
      nesNamco163RamReadSourceSchema.extend({
        byte_index: z.number().int().min(0).max(2),
        address_source: mapperWriteSourceSchema,
        cells: z
          .array(
            z.strictObject({
              address: z.number().int().min(0).max(127),
              value: nesKnownByteValueSchema,
              source: z.union([
                z.strictObject({
                  kind: z.literal("initial-chip-ram"),
                  index: z.number().int().min(0).max(127),
                }),
                z.strictObject({
                  kind: z.literal("cpu-write"),
                  instruction_index: z.number().int().nonnegative(),
                  write_index: z.number().int().min(0).max(2),
                }),
              ]),
            }),
          )
          .min(1)
          .max(128),
      }),
      z.strictObject({
        byte_index: z.number().int().min(0).max(2),
        kind: z.literal("fme7-window"),
        variant: nesFme7VariantSchema,
        bank_control: nesByteValueSchema,
        source_candidates: z
          .array(
            z.union([
              z.strictObject({
                kind: z.literal("rom"),
                file_offset: z.number().int().nonnegative(),
                value: nesKnownByteValueSchema,
              }),
              z.strictObject({
                kind: z.literal("ram"),
                bank: z.number().int().min(0).max(63),
                ram_address: z.number().int().min(0x6000).max(0x7fff),
                value: nesKnownByteValueSchema,
                source: z.union([
                  z.strictObject({
                    kind: z.literal("initial-prg-ram"),
                    index: z.number().int().min(0).max(524287),
                  }),
                  z.strictObject({
                    kind: z.literal("cpu-write"),
                    instruction_index: z.number().int().nonnegative(),
                    write_index: z.number().int().min(0).max(2),
                  }),
                ]),
              }),
            ]),
          )
          .min(2)
          .max(128),
      }),
      z.strictObject({
        byte_index: z.number().int().min(0).max(2),
        kind: z.literal("bandai-eeprom"),
        line_source: nesBandaiEepromReadSourceSchema,
        control_source: mapperWriteSourceSchema,
        initial_eeprom_byte_indices: z
          .array(z.number().int().min(0).max(255))
          .max(256),
      }),
      z.strictObject({
        byte_index: z.number().int().min(0).max(2),
        kind: z.literal("mmc5-window"),
        prg_mode: nesByteValueSchema,
        prg_banks: z.array(nesByteValueSchema).length(5),
        ram_wiring: nesMmc5RamWiringSchema.nullable(),
        source_candidates: z
          .array(
            z.union([
              z.strictObject({
                kind: z.literal("rom"),
                file_offset: z.number().int().nonnegative(),
                value: nesKnownByteValueSchema,
              }),
              z.strictObject({
                kind: z.literal("ram"),
                bank: z.number().int().min(0).max(15),
                ram_address: z.number().int().min(0x6000).max(0x7fff),
                value: nesKnownByteValueSchema,
                source: z.union([
                  z.strictObject({
                    kind: z.literal("initial-prg-ram"),
                    index: z.number().int().min(0).max(524287),
                  }),
                  z.strictObject({
                    kind: z.literal("cpu-write"),
                    instruction_index: z.number().int().nonnegative(),
                    write_index: z.number().int().min(0).max(2),
                  }),
                ]),
              }),
            ]),
          )
          .min(2)
          .max(144)
          .describe(
            "Every possible physical source: at most 128 ROM and 16 external RAM banks; no guessed open-bus byte.",
          ),
      }),
      z.strictObject({
        byte_index: z.number().int().min(0).max(2),
        kind: z.literal("mmc6-disabled-half"),
        ram_address: z.number().int().min(0x7000).max(0x73ff),
        bank_select: nesKnownByteValueSchema,
        ram_protect: nesKnownByteValueSchema,
      }),
      z.strictObject({
        byte_index: z.number().int().min(0).max(2),
        kind: z.literal("vrc2-microwire-latch"),
        latch_value: z.union([z.literal(0), z.literal(1)]),
        source: mapperWriteSourceSchema,
      }),
    ]),
  )
  .max(3);
// Omit must distribute over the variants to retain each device's evidence fields.
type MapperOriginWithoutIndex<T> = T extends unknown
  ? Omit<T, "byte_index">
  : never;
export type NesMapperByteOrigin = MapperOriginWithoutIndex<
  z.infer<typeof mapperOrigins>[number]
>;
const dataRead = z.strictObject({
  address: z.number().int().min(0).max(65535).nullable(),
  value: byte,
  file_offset: z.number().int().nonnegative().nullable(),
  ram_origins: ramOrigins.max(64),
  mapper_origins: mapperOrigins.max(1),
});
const dataReadSchema = z.union([
  dataRead,
  dataRead.extend({ value: z.null(), known_bits: nesKnownBitsSchema }),
]);
const dataReads = z
  .array(dataReadSchema)
  .max(3)
  .describe(
    "Semantic memory reads used by this instruction, including pointer and stack bytes; not a cycle/bus log. A single-byte read uses byte_index 0 in origins. Null addresses/values preserve unresolved dependencies. Partial status or mapper-device reads may include known_bits; immediate operands and vector reads have separate instruction/vector evidence.",
  );
export type NesDataRead = z.infer<typeof dataReads>[number];
const dmaIoRead = z.strictObject({
  decoded_address: z.union([
    z.literal(0x4015),
    z.literal(0x4016),
    z.literal(0x4017),
  ]),
  internal_read: dataReadSchema,
  cpu_value: nesByteValueSchema,
  external_value: nesByteValueSchema,
  before: nesCpuIoLatchViewSchema,
});
export type NesDmaIoRead = z.infer<typeof dmaIoRead>;
const nominalReadRoles = [
  "opcode",
  "operand",
  "pointer",
  "data",
  "dummy",
  "stack",
  "vector",
] as const;
const dmcReadRoles = [
  "dmc-halt",
  "dmc-dummy",
  "dmc-alignment",
  "dmc-get",
] as const;
const busReadCycle = z.strictObject({
  index: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  kind: z.literal("read"),
  role: z.enum([...nominalReadRoles, ...dmcReadRoles]),
  read: dataReadSchema,
});
const busWriteCycle = z.strictObject({
  index: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  kind: z.literal("write"),
  role: z.enum(["data", "dummy", "stack"]),
  write_index: z.number().int().min(0).max(2),
});
const busCycle = z.union([
  busReadCycle,
  busReadCycle.extend({ dma_io: dmaIoRead }),
  busWriteCycle,
]);
export type NesCpuBusCycle = z.infer<typeof busCycle>;
const boundedCpuCycles = (
  maximum: number,
  minimumNominal: number,
  maximumNominal: number,
) =>
  z
    .array(busCycle)
    .max(maximum)
    .superRefine((cycles, ctx) => {
      const nominal = cycles.filter(
        (cycle) => cycle.kind === "write" || !cycle.role.startsWith("dmc-"),
      ).length;
      if (
        nominal < minimumNominal ||
        nominal > maximumNominal ||
        cycles.length - nominal >
          NES_DMC_INLINE_TRANSFERS * NES_DMC_STALL_CYCLES
      )
        ctx.addIssue({
          code: "custom",
          message:
            "CPU cycles must retain their nominal instruction/entry bound and at most two four-cycle DMC transfers.",
        });
    })
    .meta({
      allOf: [
        {
          contains: {
            anyOf: [
              { properties: { kind: { const: "write" } }, required: ["kind"] },
              {
                properties: {
                  kind: { const: "read" },
                  role: { enum: nominalReadRoles },
                },
                required: ["kind", "role"],
              },
            ],
          },
          minContains: minimumNominal,
          maxContains: maximumNominal,
        },
        {
          contains: {
            properties: {
              kind: { const: "read" },
              role: { enum: dmcReadRoles },
            },
            required: ["kind", "role"],
          },
          minContains: 0,
          maxContains: NES_DMC_INLINE_TRANSFERS * NES_DMC_STALL_CYCLES,
        },
      ],
    });
const instructionBus = boundedCpuCycles(
  8 + NES_DMC_INLINE_TRANSFERS * NES_DMC_STALL_CYCLES,
  2,
  8,
)
  .min(2)
  .describe(
    "Ordered nominal CPU actions plus source DMC stalls. At most eight nominal cycles and two four-cycle DMC transfers fit before the next output-byte boundary. Raw read/device proofs remain inline; DMA clocks do not constitute another instruction poll.",
  );
const interruptBus = boundedCpuCycles(
  7 + NES_DMC_INLINE_TRANSFERS * NES_DMC_STALL_CYCLES,
  7,
  7,
).min(7);
const busFrontier = z.strictObject({
  cycles: boundedCpuCycles(
    8 + NES_DMC_INLINE_TRANSFERS * NES_DMC_STALL_CYCLES,
    0,
    8,
  ),
  writes: z.array(nesMapperWriteSchema).max(3),
  mapper_events: z
    .array(traceNesMapperEventsInputSchema.shape.events.element)
    .max(
      (8 + NES_DMC_INLINE_TRANSFERS * NES_DMC_STALL_CYCLES) * 3 +
        NES_DMC_INLINE_TRANSFERS * 2 +
        1,
    ),
  blocked_address: z.number().int().min(0).max(65535).nullable(),
});
export const nesCodeVectorSchema = z
  .array(
    z.strictObject({
      address: z.number().int().min(0).max(65535),
      value: byte,
      file_offset: z.number().int().nonnegative().nullable(),
    }),
  )
  .length(2)
  .nullable();
export type NesCodeVector = z.infer<typeof nesCodeVectorSchema>;
const codeInstructionFields = {
  index: z.number().int().nonnegative(),
  address: z.number().int().min(0).max(65535),
  bytes_hex: z.string().regex(/^(?:[0-9a-f]{2}){1,3}$/u),
  file_offsets: offsets,
  ram_origins: ramOrigins,
  mapper_origins: mapperOrigins,
  interrupt_vector: nesCodeVectorSchema,
  data_reads: dataReads,
  mnemonic: z.string().min(1),
  encoding: z.enum(["official", "unofficial"]),
  addressing_mode: z.string().min(1),
  prg_view: nesPrgViewSchema.nullable(),
  branch_assumption: z
    .strictObject({
      choice_index: z.number().int().nonnegative(),
      taken: z.boolean(),
    })
    .nullable(),
  cpu_after: nesCpuStateSchema,
  next_address: z.number().int().min(0).max(65535),
  writes: z.array(nesMapperWriteSchema).max(3),
};
const codeInstruction = z.strictObject(codeInstructionFields);
const mapperEventRange = z
  .strictObject({
    start: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .describe(
    "Range in the nested mapper event trace for a committed instruction or accepted interrupt entry, including device-affecting bus writes/reads. Unapplied frontiers own no committed events.",
  );
const eventInstruction = codeInstruction.extend({
  mapper_event_range: mapperEventRange,
});
const oamDmaReads = z
  .array(dataReadSchema)
  .length(256)
  .describe(
    "The 256 raw CPU-page byte reads of a source-derived OAM DMA packet, in packet offset order. These are separate from semantic instruction operands and supply no clocks. Original ROM offsets and RAM writer/input origins remain explicit. A frontier's reads are hypothetical and commit no packet or OAM state.",
  );
const oamDmaFrontier = z
  .strictObject({
    page: z.number().int().min(0).max(255),
    reads: z.array(dataReadSchema).max(255),
    available_source_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    retained_source_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
  })
  .describe(
    "Budget-limited hypothetical DMA source prefix. No transfer or current instruction was committed. reads start at page*256; their count identifies the next unretained byte. available_source_bytes is this attempt's remaining allocation, not a replacement of the caller's shared exploration budget.",
  );
export type NesOamDmaFrontier = z.infer<typeof oamDmaFrontier>;
const instructionWithDma = eventInstruction.extend({
  oam_dma_reads: oamDmaReads,
});
const appliedInstruction = z.union([
  codeInstruction,
  eventInstruction,
  instructionWithDma,
  codeInstruction.extend({ cpu_bus_cycles: instructionBus }),
  eventInstruction.extend({ cpu_bus_cycles: instructionBus }),
]);
const stopFields = {
  reason: reasons,
  address: z.number().int().min(0).max(65535).nullable(),
  bytes_hex: z.string().regex(/^(?:[0-9a-f]{2}){0,3}$/u),
  file_offsets: offsets,
  ram_origins: ramOrigins,
  mapper_origins: mapperOrigins,
  interrupt_vector: nesCodeVectorSchema,
  data_reads: dataReads,
  successors: z.array(z.number().int().min(0).max(65535)).max(2),
};
const entryInterrupt = z.strictObject({
  kind: z.enum(["nmi", "irq"]),
  return_address: z.number().int().min(0).max(65535),
  writes: z.array(nesMapperWriteSchema).length(3),
  cpu_after: nesCpuStateSchema,
});
const rangedEntry = entryInterrupt.extend({
  mapper_event_range: mapperEventRange,
});
const cpuBusReport = z.strictObject({
  initial: cpuBusState,
  initialized: cpuBusState,
  final: cpuBusState,
});
const cpuIoReport = z.strictObject({
  initial: nesCpuIoStateSchema,
  initialized: nesCpuIoStateSchema,
  final: nesCpuIoStateSchema,
  frontier: nesCpuIoStateSchema.nullable(),
});
const cpuBusReports = [
  cpuBusReport,
  cpuBusReport.extend({ io: cpuIoReport }),
] as const;
const codePathSchema = z.strictObject({
  status: z.literal("derived"),
  resolved_entry: z.number().int().min(0).max(65535).nullable(),
  cpu_bus: z
    .union([
      ...cpuBusReports,
      ...cpuBusReports.map((schema) =>
        schema.extend({
          dmc: nesDmcCpuDmaTraceSchema.extend({
            boundary_cycles: z.array(busCycle),
          }),
        }),
      ),
    ])
    .nullable()
    .default(null),
  entry_vector: nesCodeVectorSchema,
  entry_interrupt: z
    .union([
      entryInterrupt,
      rangedEntry,
      entryInterrupt.extend({ cpu_bus_cycles: interruptBus }),
      rangedEntry.extend({ cpu_bus_cycles: interruptBus }),
    ])
    .nullable(),
  branch_choices_used: z.number().int().nonnegative(),
  instructions: z.array(appliedInstruction),
  stop: z.union([
    z.strictObject(stopFields),
    z.strictObject({ ...stopFields, oam_dma_reads: oamDmaReads }),
    z.strictObject({ ...stopFields, oam_dma_frontier: oamDmaFrontier }),
    z.strictObject({ ...stopFields, cpu_bus_frontier: busFrontier }),
  ]),
  final_cpu: nesCpuStateSchema,
  mapper_trace: z
    .union([nesMapperTraceSchema, nesMapperEventsTraceSchema])
    .describe(
      "Write-only traces retain the write replay shape. An explicit Namco chip-RAM model uses the event replay shape, including ordered CPU reads and writes; replay with trace_nes_mapper_events so read-induced pointer changes are preserved.",
    ),
});
const automaticInterrupt = rangedEntry.extend({
  index: z.number().int().nonnegative(),
  before_instruction_index: z.number().int().nonnegative(),
  target_address: z.number().int().min(0).max(65535),
  interrupt_vector: nesCodeVectorSchema,
  cpu_bus_cycles: interruptBus,
});
const interruptFields = {
  interrupts: z.strictObject({
    initial: nesCpuInterruptStateSchema,
    final: nesCpuInterruptStateSchema,
    polls: z.array(nesCpuInterruptPollSchema),
    entries: z.array(automaticInterrupt),
    frontier: z
      .strictObject({
        kind: z.enum(["nmi", "irq"]),
        return_address: z.number().int().min(0).max(65535),
        before_instruction_index: z.number().int().nonnegative(),
      })
      .nullable(),
  }),
};
const dmaCycles = z
  .array(
    z.union([
      busReadCycle,
      busReadCycle.extend({ dma_io: dmaIoRead }),
      busWriteCycle.extend({
        write_index: z.number().int().min(0).max(255),
      }),
    ]),
  )
  .max(NES_OAM_DMA_CYCLES + NES_DMC_OAM_TRANSFERS * NES_DMC_STALL_CYCLES);
export type NesDmaCpuBusCycle = z.infer<typeof dmaCycles>[number];
const dmaTransfer = z.strictObject({
  index: z.number().int().nonnegative(),
  before_instruction_index: z.number().int().nonnegative(),
  halted_address: z.number().int().min(0).max(65535),
  page: z.number().int().min(0).max(255),
  start_phase: z.enum(["get", "put"]),
  cpu_bus_cycles: dmaCycles.min(NES_OAM_DMA_CYCLES - 1),
  writes: z.array(nesMapperWriteSchema).length(256),
  mapper_event_range: mapperEventRange,
});
const dmaFields = {
  cpu_dma: z.strictObject({
    initial: nesOamCpuDmaStateSchema,
    initialized: nesOamCpuDmaStateSchema,
    final: nesOamCpuDmaStateSchema,
    transfers: z.array(dmaTransfer),
    retained_source_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    frontier: z
      .strictObject({
        before_instruction_index: z.number().int().nonnegative(),
        halted_address: z.number().int().min(0).max(65535),
        page: nesByteValueSchema,
        start_phase: z.enum(["get", "put"]).nullable(),
        cpu_bus_cycles: dmaCycles,
        writes: z.array(nesMapperWriteSchema).max(256),
        mapper_events: z
          .array(traceNesMapperEventsInputSchema.shape.events.element)
          .max(
            (NES_OAM_DMA_CYCLES +
              NES_DMC_OAM_TRANSFERS * NES_DMC_STALL_CYCLES) *
              3 +
              24 +
              NES_DMC_OAM_TRANSFERS * 2 +
              2,
          ),
        blocked_address: z.number().int().min(0).max(65535).nullable(),
      })
      .nullable(),
  }),
};
export const nesCodeTraceSchema = z.union([
  z.strictObject({
    status: z.literal("unsupported"),
    reason: z.string().min(1),
  }),
  codePathSchema,
  codePathSchema.extend(interruptFields),
  codePathSchema.extend(dmaFields),
  codePathSchema.extend({ ...interruptFields, ...dmaFields }),
]);
export type NesCodeTrace = z.infer<typeof nesCodeTraceSchema>;
export type NesCodePath = Extract<NesCodeTrace, { status: "derived" }>;

export const nesCodeTraceReportSchema = z.strictObject({
  artifact: nesCartridgeSchema.shape.artifact,
  header: nesCartridgeSchema.shape.header,
  code_trace: nesCodeTraceSchema,
  limitations: z.array(z.string().min(1)),
});
