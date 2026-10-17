import { j87Limitations } from "../../domain/nesJ87.js";
import { namco109Limitations } from "../../domain/nesNamco108.js";
import { sunsoft3Limitations } from "../../domain/nesSunsoft3.js";
import { sunsoft4Limitations } from "../../domain/nesSunsoft4.js";
import { irem78Limitations } from "../../domain/nesIrem78.js";
import { vrc3Limitations } from "../../domain/nesVrc3.js";
import { h3001Limitations } from "../../domain/nesH3001.js";
import { nesPpuMemoryLimitations } from "../../domain/nesPpuState.js";
import { nesControllerLimitations } from "../../domain/nesControllers.js";
import { nesApuLimitations } from "../../domain/nesApu.js";
import { nesCpuInterruptLimitations } from "../../domain/nesCpuInterrupts.js";
import { nesOamCpuDmaLimitations } from "../../domain/nesOamCpuDma.js";
import { nesCpuIoLimitations } from "../../domain/nesCpuIo.js";
import {
  inspectRecordedCrashInputSchema,
  recordedCrashSchema,
} from "../../domain/native/recordedCrash.js";
import {
  inspectNesCartridgeInputSchema,
  nesCartridgeSchema,
} from "../../domain/nesCartridge.js";

import {
  inspectBinaryLayoutInputSchema,
  binaryLayoutSchema,
} from "../../domain/native/binaryLayout.js";
import { binaryLayoutSummaryViewResultSchema } from "../../domain/analysisView/analysisView.js";
import {
  analysisDetailOutputSchemaOf,
  analysisDetailSchema,
} from "../analysisDetail.js";
import type { ToolContract } from "../toolContractTypes.js";
import { toolContractMetadata } from "../toolEffects.js";
import { evidenceResultOf } from "../toolOutputSchemaPrimitives.js";
import {
  inspectPeResourcesInputSchema,
  peResourcesSchema,
} from "../../domain/native/peResources.js";
import {
  traceNesMapperWritesInputSchema,
  nesMapperTraceReportSchema,
} from "../../domain/nesMapperTrace.js";
import {
  traceNesCodeInputSchema,
  nesCodeTraceReportSchema,
  nesCpuBusLimitations,
  nesSourceIrqLimitations,
} from "../../domain/nesCodeTrace.js";

import {
  exploreNesCodeInputSchema,
  nesCodeExplorationReportSchema,
} from "../../domain/nesCodeExploration.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoveryReportSchema,
  nesCodeDiscoveryLimitations,
} from "../../domain/nesCodeDiscovery.js";

import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsReportSchema,
} from "../../domain/nesMapperEvents.js";

/** Caller-selected delivery of completed binary layout Evidence. */
export const inspectBinaryLayoutRequestSchema =
  inspectBinaryLayoutInputSchema.extend({ detail: analysisDetailSchema });

const mmc5AnalysisDescription =
  "MMC5/Mapper 5 derives four PRG modes and ROM/RAM window switching with explicit RAM wiring/protection. Sparse Ghidra views import ROM only; mixed source proofs retain every candidate. MMC5 multiplier reads preserve partial operand proofs; sparse ExRAM CPU modes 2/3 retain byte and writer sources. Modes 0/1 keep open bus and rendering-dependent writes unknown. Source-code tools also retain partial CPU A/X/Y/SP proofs as register_bits across operations and snapshots; event/write tools retain mapper state without executing instructions. MMC5 CHR A/B windows retain write-time mode and upper-bit snapshots instead of rescaling old bytes. Exact 2000/2001 snooping distinguishes sprite-size and substitution-enable assumptions; event mmc5_fetch qualifies rendering sprite/background or non-rendering PPUDATA reads. PPU nametable reads identify CIRAM, ExRAM, fill and constant-zero sources with common byte proofs. With initial_ppu model ppu-memory, explicit ciram-2k backing retains CIRAM bytes and writer origins; null backing stays unknown. CPU 2007 buffering, external PPU reads/writes and source replay share this store and mapper-owned ExRAM. ExRAM facts retain physical cell origins, fill sources capture raw tile/attribute register proofs, and generated zero is not fabricated RAM. Conditional writes join earlier bits and preserve their source; ROM writes are ignored. Ordinary MMC5 pattern events examine authenticated CHR ROM bytes, return common value/known_bits and retain every compatible offset in mmc5.rom_sources; a common byte never identifies an uncertain bank. Missing fetch context joins bank sets. Frozen pattern selection leaves the query role unspecified; sprite facets qualify a static sprite role, while nametable/viewport facets qualify background. These query roles establish no observed fetch recognition. Viewport background and sprite source blocks/caches remain distinct. Up to 1024 CHR ROM pages and one unresolved rendering alternative survive pooled source indices. Optional ppu_mmc5_background independently qualifies the first screen column and split Y for selected nametable/viewport facets. Per-row projection retains correlated tile, attribute, CHR and palette sources, including ExRAM aliases and CL/SL fine-Y wiring, through shared pools. Omitted qualifications keep possible extended/split overrides unresolved; definite overrides exclude ordinary background sources. A historical active tile never supplies frozen query geometry. Event initial_irq model mmc5 interprets delayed fourth-read scanline clocks, explicit mmc5-cpu-cycle idle detection, pending/enabled assertion, pre-acknowledgement 5204 status bits, exact vector/PPUSTATUS resets and caller-qualified mmc5-reset. No CPU accesses imply clocks. Known event-model in-frame state qualifies mode 0/1 ExRAM writes; ordinary source traces still leave those writes unknown. Only trace_nes_mapper_events advances optional initial.ppu model mmc5-background over qualified tile/attribute/low/high fetch sequences. With initial_ppu, these ordered extended/split reads use retained CIRAM/ExRAM sources through the existing pipeline. The separately qualified frozen projection does not advance that pipeline or consume captured tile geometry. pin92_high and PPUMASK qualify substitutions; mmc5_tile supplies screen column and current/next-line prefetch context. mmc5-render-frame loads held split Y from 5201; mmc5-render-line advances it without IRQ clocks. Extended attributes latch ExRAM bytes while 5130 stays live. Split takes priority, uses live 5202, and joins CL/SL fine-Y wiring when omitted. Missing context stays unresolved; partial controls join paths and retain all physical origins. Automatic fetch/scanline classification, CHR RAM, PCM/audio/timer IRQs and sound execution remain unknown. Qualified reset establishes documented register bits and leaves ExRAM access unverified until 5104 is written; initial reset-mode reads need exram_written true.";

/** Offline binary diagnostics are independent of macOS process/UI providers. */
export const BINARY_DIAGNOSTICS_TOOL_CONTRACTS = [
  {
    name: "trace_nes_mapper_events",
    ...toolContractMetadata("trace_nes_mapper_events"),
    kind: "native-provider",
    description:
      nesApuLimitations +
      nesControllerLimitations +
      nesPpuMemoryLimitations +
      mmc5AnalysisDescription +
      " " +
      h3001Limitations +
      " " +
      sunsoft3Limitations +
      " " +
      sunsoft4Limitations +
      " " +
      irem78Limitations +
      vrc3Limitations +
      " " +
      j87Limitations +
      " " +
      namco109Limitations +
      " Namco 163/Mapper 19 requires explicit initial.variant namco163 and preserves it in complete PRG views. Three selected 8 KiB PRG banks and a fixed final bank share exact source offsets. Tagged 1 KiB pattern/nametable windows distinguish CHR-ROM, CIRAM and unknown sources; F000=3F debug-mode possibilities remain unknown. Declared single-chip 8 KiB external RAM has four independently protected 2 KiB regions; F800 high nibble must be 4 for writes. Without initial.chip_ram, chip ports retain raw writes only. Optional chip_ram supplies 128 byte facts, address_port, explicit increment_model saturate/wrap (omission joins both), and dma_reads absent/unobserved. Active audio phase bytes are conservatively unknown. Namco source traces with this model return ordered mapper event traces plus per-instruction mapper_event_range; replay CPU reads and writes with trace_nes_mapper_events. Visible 4014 writes queue OAM DMA until the next supplied CPU read; replacement requests supersede earlier pages, and pages 48–4F advance the chip pointer through 256 reads. No sprite pixels or implicit IRQ clocks are inferred. Indexed/RMW/NOP device reads preserve pointer effects; unapplied frontiers commit no events. No waveform execution or save-file writes are inferred. Explicit initial_irq model namco163 plus namco163-cpu-cycle events calculates a 15-bit saturating up-counter; reaching 7FFF asserts, writes to either counter port acknowledge, reads never acknowledge, and no CPU delivery is inferred. Derive CPU-register transitions and interleaved PPU read sources for supported NES mapper boards from an explicitly ordered supplied event sequence. Optional initial_ppu.oam model oam-memory accepts qualified oam-dma packets with exactly 256 raw CPU byte facts and retains physical OAM destinations and rotation origins; packet bytes are caller assumptions. Source tools separately authenticate oam_dma_reads and share max_oam_dma_source_bytes across exploration attempts. This dataflow model does not imply DMA timing or sprite rendering. Mapper 69 requires explicit initial.variant fme7/5a/5b, retained in complete PRG views. Its five source windows include 6000–7FFF ROM/RAM selection, three independent PRG banks and a fixed last bank. lower_window distinguishes rom, ram-unobserved and unknown sources/permissions. Optional initial_irq model fme7 with fme7-cpu-cycle events calculates a 16-bit decrementing counter with separate count/IRQ enable and control acknowledgement. Raw 5B audio registers do not establish sound or elapsed time. Bandai Mapper 16 requires initial.variant fcg/lz93d50, matching explicit NES 2.0 submapper 4/5 or retaining an immutable legacy/submapper-0 assumption. Mapper 159 identifies LZ93D50/X24C01. FCG writes only 6000–7FFF; LZ93D50 writes only 8000–FFFF. Matching initial_irq model bandai-fcg/bandai-lz93d50 and bandai-cpu-cycle events derive a 16-bit decrementing counter, old-zero underflow and latched assertion. FCG writes counter bytes directly; LZ reloads latch bytes on any control write. Counter state uses counter_low/counter_high byte proofs. With explicit initial.eeprom model x24c01/x24c02, control writes derive MSB-first serial commands, ACKs, sequential reads and page buffers; X24C02 requires page_size 4 or 16. cpu-read events return cpu_read with only proven D4 at 6000–7FFF. STOP starts busy state; eeprom-write-complete is an explicit caller completion assumption that commits staged bytes. Missing bytes, readiness or serial history remain unknown. No elapsed write time is inferred from instructions, writes or IRQ cycles; EEPROM NVRAM is not CPU PRG RAM. VRC2/VRC4 initial.wiring selects an immutable physical-board assumption for legacy/submapper-0 headers without rewriting the ROM; explicit mapper/submapper conflicts remain unsupported. Exported PRG views retain the assumption for Ghidra. VRC4 states require variant vrc4 and retain swap mode, nine-bit CHR selectors and register address wiring; VRC2 submapper 3 retains its separate state shape. VRC6/Mapper 24/26 retains 16/8 KiB PRG selectors, all B003 PPU modes, explicit nametable_windows with CIRAM/CHR-ROM/unknown sources, and raw audio registers. PPU nametable reads at 2000–3EFF (including 3000 mirrors) report ROM offsets or unobserved CIRAM; palette reads remain outside this model. VRC6 coverage includes unknown_nametable_reads. IRQ register facts alone do not establish clocks or delivery. MMC1 serial commits and MMC3 CHR inversion use the same register semantics as trace_nes_mapper_writes; discrete mapper bus conflicts use the captured pre-write PRG byte. MMC2/Mapper 9 and MMC4/Mapper 10 additionally update PPU-read-triggered CHR latches. Returns each original event, register after-state and PRG/CHR mapping; PPU read_source identifies the bank and ROM offset used BEFORE any latch update. Models MMC2's exact lower-table trigger addresses and MMC4's eight-address ranges; upper-table triggers use eight-address ranges on both. Missing state stays unknown. Supply actual 14-bit PPU bus addresses, not CPU $2007 addresses or guessed rendering reads. Optional initial_irq explicitly selects a conventional Sharp/NEC or MC-ACC model with partial counter and line state. mmc3-irq-clock supplies one externally qualified counter clock; CPU writes update reload/enable/acknowledge and each event returns irq state. Ordered ppu-a12 level events and cpu-m2-fall edges derive standard three-M2-low A12 filtering; initial_irq.a12_filter retains possible phases and each step reports irq_clock as true, false or unknown. The mc-acc model instead counts falling A12 edges through an eight-pulse prescaler, clocks on pulses 1/9/17 after C001, and retains mcacc_prescaler level/phase possibilities. It requires legacy Mapper 4 or NES 2.0 submapper 3. A qualified clock establishes high A12 for Sharp/NEC, or low A12 and pulse phase 1 for MC-ACC; do not also supply the raw edge for that same clock. VRC4/VRC6 use explicit initial_irq model vrc4/vrc6 respectively with vrc-cpu-cycle events. VRC4 reloads from split nibbles; VRC6 uses its full-byte latch. Enabled scanline mode subtracts three from a 341-step countdown (114/114/113-cycle intervals); cycle mode clocks every enabled CPU cycle. Overflow reloads the split latch and latches asserted IRQ until acknowledge/control. Enabling through control reloads counter and phase 341; disabled control writes retain counter/phase in this conventional model. Acknowledge clears assertion and copies A to enable without reloading. Cycle-mode physical prescaler phase remains unknown. Partial counter/latch proofs and possible prescaler phases survive continuation. No cycles are inferred from writes or PPU reads. IRQ events without an explicit compatible model, MMC3 models outside Mapper 4, VRC models without matching board state, mixed clock families and incompatible filter declarations are unsupported. No silicon identity, consecutive-reload glitches or CPU IRQ delivery is inferred. PPU read addresses alone do not establish A12 edge timing or IRQ counter clocks. Without initial_ppu, CPU-port buffering remains unknown. No automatic PPU rendering, hardware execution or gameplay observation is implied. Full ROM digest authenticates source bytes only. max_steps bounds retained snapshots before derivation; unsupported boards retain source facts. No active target or disassembler required.",
    inputSchema: traceNesMapperEventsInputSchema,
    outputSchema: evidenceResultOf(nesMapperEventsReportSchema),
    examples: [
      {
        title: "Project an MMC5 background page with explicit frozen geometry",
        input: {
          path: "/artifacts/mmc5.nes",
          initial: {
            mapper: 5,
            exram_mode: 1,
            exram_written: true,
            nametable_control: 0,
            ppu_mask: 8,
            chr_upper: 0,
            split: [0, 0, 0],
            ppu: { model: "mmc5-background", pin92_high: true },
          },
          initial_ppu: {
            model: "ppu-memory",
            nametable_layout: "ciram-2k",
            nametable: { "0": 1 },
          },
          ppu_nametable: 0,
          ppu_mmc5_background: {
            nametable: { first_screen_column: 0, split_y_at_origin: 0 },
          },
          events: [],
        },
      },
      {
        title: "Read and acknowledge an assumed MMC5 scanline IRQ",
        input: {
          path: "/artifacts/mmc5.nes",
          initial: { mapper: 5 },
          initial_irq: {
            model: "mmc5",
            counter: 12,
            in_frame: true,
            pending: true,
            enabled: true,
            asserted: true,
          },
          events: [{ kind: "cpu-read", address: 20996 }],
        },
      },
      {
        title: "Write and read MMC5 ExRAM through PPU nametable mirrors",
        input: {
          path: "/artifacts/mmc5.nes",
          initial: { mapper: 5, exram_mode: 0, nametable_control: 170 },
          events: [
            { kind: "ppu-write", address: 8192, value: 106 },
            { kind: "ppu-read", address: 12288, mmc5_fetch: "ppudata" },
          ],
        },
      },
      {
        title: "Read an MMC5 product and ExRAM cell",
        input: {
          path: "/artifacts/mmc5.nes",
          initial: {
            mapper: 5,
            multiplier: [7, 9],
            exram_mode: 2,
            exram: { "0": 42 },
          },
          events: [
            { kind: "cpu-read", address: 20997 },
            { kind: "cpu-read", address: 23552 },
          ],
        },
      },
      {
        title: "Locate VRC6 ROM nametable reads and their mirrors",
        input: {
          path: "/artifacts/vrc6.nes",
          initial: {
            mapper: 26,
            control: 49,
            chr_banks: [0, 2, 4, 6, 8, 10, 12, 14],
          },
          events: [
            { kind: "ppu-read", address: 8192 },
            { kind: "ppu-read", address: 12288 },
          ],
        },
      },
      {
        title: "Compute a VRC4 cycle-mode IRQ overflow",
        input: {
          path: "/artifacts/vrc4.nes",
          initial: {
            mapper: 21,
            variant: "vrc4",
            irq_latch_low: 15,
            irq_latch_high: 15,
          },
          initial_irq: { model: "vrc4" },
          events: [
            { kind: "cpu-write", address: 61444, value: 7 },
            { kind: "vrc-cpu-cycle" },
          ],
        },
      },
      {
        title: "Inspect an MMC2 latch transition",
        input: {
          path: "/artifacts/game.nes",
          initial: { mapper: 9, chr_fd_0: 1, chr_fe_0: 2, latch_0: "fd" },
          events: [
            { kind: "ppu-read", address: 4072 },
            { kind: "ppu-read", address: 0 },
          ],
        },
      },
    ],
  },
  {
    name: "discover_nes_code",
    ...toolContractMetadata("discover_nes_code"),
    kind: "native-provider",
    description:
      "Discover NES 6502 code, calls, data references and unanalyzed PRG regions directly from reset/NMI/IRQ vectors or explicit roots, without running a game or opening a disassembler. Uses a bank-aware abstract worklist to converge loops, propagate known mapper writes and preserve raw register/serial context identity. Returns an inline instruction graph, original byte locations, RAM writer references, unresolved and budget frontiers, physical coverage intervals and complete conditional nes_prg_views for Ghidra. " +
      nesCodeDiscoveryLimitations +
      " No active target required.",
    inputSchema: discoverNesCodeInputSchema,
    outputSchema: evidenceResultOf(nesCodeDiscoveryReportSchema),
    examples: [
      {
        title: "Discover MMC3 reset, interrupt handlers and referenced data",
        input: {
          path: "/artifacts/game.nes",
          initial: {
            mapper: 4,
            bank_select: 6,
            banks: [0, 2, 4, 5, 6, 7, 0, 1],
          },
          roots: ["reset", "nmi", "irq"],
          max_nodes: 4096,
        },
      },
    ],
  },
  {
    name: "explore_nes_code",
    ...toolContractMetadata("explore_nes_code"),
    kind: "native-provider",
    description:
      nesCpuBusLimitations +
      nesSourceIrqLimitations +
      nesCpuInterruptLimitations +
      nesOamCpuDmaLimitations +
      nesCpuIoLimitations +
      nesApuLimitations +
      nesControllerLimitations +
      nesPpuMemoryLimitations +
      mmc5AnalysisDescription +
      " " +
      h3001Limitations +
      " " +
      sunsoft3Limitations +
      " " +
      sunsoft4Limitations +
      " " +
      irem78Limitations +
      vrc3Limitations +
      " " +
      j87Limitations +
      " " +
      namco109Limitations +
      " Namco 163/Mapper 19 requires explicit initial.variant namco163 and preserves it in complete PRG views. Three selected 8 KiB PRG banks and a fixed final bank share exact source offsets. Tagged 1 KiB pattern/nametable windows distinguish CHR-ROM, CIRAM and unknown sources; F000=3F debug-mode possibilities remain unknown. Declared single-chip 8 KiB external RAM has four independently protected 2 KiB regions; F800 high nibble must be 4 for writes. Without initial.chip_ram, chip ports retain raw writes only. Optional chip_ram supplies 128 byte facts, address_port, explicit increment_model saturate/wrap (omission joins both), and dma_reads absent/unobserved. Active audio phase bytes are conservatively unknown. Namco source traces with this model return ordered mapper event traces plus per-instruction mapper_event_range; replay CPU reads and writes with trace_nes_mapper_events. Visible 4014 writes queue OAM DMA until the next supplied CPU read; replacement requests supersede earlier pages, and pages 48–4F advance the chip pointer through 256 reads. No sprite pixels or implicit IRQ clocks are inferred. Indexed/RMW/NOP device reads preserve pointer effects; unapplied frontiers commit no events. No waveform execution or save-file writes are inferred. Explore conditional NES 6502 paths through fixed NROM/CNROM PRG mapping or UxROM/AxROM/Color Dreams/BNROM/NINA-001/GxROM/Camerica/Bandai/FME-7/VRC2/VRC4/VRC6/MMC1/MMC2/MMC3/MMC4 bank switches from one immutable ROM snapshot, without running a game or opening a disassembler. Expands unknown conditional branches breadth-first into both assumed outcomes; supplied branch_choices constrain the initial subtree. Each path retains its own replayed CPU/RAM/mapper state, choices, instruction bytes/source offsets and explicit stop frontier. max_paths counts all retained attempts including branching prefixes; max_total_instructions counts all applied instructions including replayed prefixes, and max_instructions limits each path. Reports pending alternatives and a union of complete conditional nes_prg_views for Ghidra. queue-exhausted is not a whole-ROM completeness claim: unknown targets, instruction budgets, stack uncertainty, unsupported unofficial opcodes and unresolved interrupt vectors can leave individual paths stopped. Automatic interrupt polling requires initial_interrupts. No symbolic feasibility proof, PPU rendering or observed gameplay claim. Qualified DMA timing requires initial_cpu_dma or initial_apu.dmc.cpu_timing. VRC2/VRC4 initial.wiring admits matching legacy/submapper-0 boards while retaining original header/digest facts and the assumption on exported views. No active target required.",
    inputSchema: exploreNesCodeInputSchema,
    outputSchema: evidenceResultOf(nesCodeExplorationReportSchema),
    examples: [
      {
        title: "Explore MMC3 reset-path alternatives",
        input: {
          path: "/artifacts/game.nes",
          initial: { mapper: 4 },
          max_paths: 16,
          max_total_instructions: 4096,
        },
      },
    ],
  },
  {
    name: "trace_nes_code",
    ...toolContractMetadata("trace_nes_code"),
    kind: "native-provider",
    description:
      nesCpuBusLimitations +
      nesSourceIrqLimitations +
      nesCpuInterruptLimitations +
      nesOamCpuDmaLimitations +
      nesCpuIoLimitations +
      nesApuLimitations +
      nesControllerLimitations +
      nesPpuMemoryLimitations +
      mmc5AnalysisDescription +
      " " +
      h3001Limitations +
      " " +
      sunsoft3Limitations +
      " " +
      sunsoft4Limitations +
      " " +
      irem78Limitations +
      vrc3Limitations +
      " " +
      j87Limitations +
      " " +
      namco109Limitations +
      " Namco 163/Mapper 19 requires explicit initial.variant namco163 and preserves it in complete PRG views. Three selected 8 KiB PRG banks and a fixed final bank share exact source offsets. Tagged 1 KiB pattern/nametable windows distinguish CHR-ROM, CIRAM and unknown sources; F000=3F debug-mode possibilities remain unknown. Declared single-chip 8 KiB external RAM has four independently protected 2 KiB regions; F800 high nibble must be 4 for writes. Without initial.chip_ram, chip ports retain raw writes only. Optional chip_ram supplies 128 byte facts, address_port, explicit increment_model saturate/wrap (omission joins both), and dma_reads absent/unobserved. Active audio phase bytes are conservatively unknown. Namco source traces with this model return ordered mapper event traces plus per-instruction mapper_event_range; replay CPU reads and writes with trace_nes_mapper_events. Visible 4014 writes queue OAM DMA until the next supplied CPU read; replacement requests supersede earlier pages, and pages 48–4F advance the chip pointer through 256 reads. No sprite pixels or implicit IRQ clocks are inferred. Indexed/RMW/NOP device reads preserve pointer effects; unapplied frontiers commit no events. No waveform execution or save-file writes are inferred. Derive a conditional 6502 instruction path and Mapper 0/1/2/3/4/7/9/10/11/16/19/21/22/23/24/25/26/32/33/34/65/66/67/68/69/71/73/75/76/78/87/159/180/206/232 bus writes directly from original NES PRG bytes, without executing the game or opening a disassembler. Starts at an explicit CPU address or a reset, nmi or irq vector resolved under caller-selected initial mapper/CPU state; omitted register values are unknown. String vector entry selection does not push a frame or change flags. An entry object {accepted_interrupt: nmi|irq, return_address} assumes an already-accepted interrupt and records a separate entry_interrupt frame with B=0 before setting I; unknown SP/vector stops without applying entry. Frame byte origins use entry_interrupt_write_index. Partially known saved status bytes retain known_bits mask/value proofs through PHP/PLP, BRK/RTI and accepted interrupt entry without guessing unknown flags; BIT uses these proven bits to derive N/V/Z where possible. No interrupt-line or I-flag polling is inferred. Optional initial_ram provides unique physical internal RAM byte assumptions, shared by CPU mirrors; fetched bytes identify the input index instead of a fabricated writer. Optional initial_prg_ram supplies physical cartridge RAM bank/address byte assumptions for modeled layouts without bypassing permissions, with initial_prg_ram_index provenance. Optional ordered branch_choices select outcomes only for unknown conditional branches, with per-instruction assumption provenance and a consumed count; mismatched addresses stop without applying the choice. With Mapper 23/submapper 3 and explicit latch_present true, reads at 6000–6FFF prove only D0 with initial-state or CPU-write mapper_origins; upper open-bus bits remain unknown. FME-7/Mapper 69 uses explicit fme7/5a/5b chip assumptions, three 8 KiB PRG selectors plus a fixed last bank and a separate 6000–7FFF ROM/RAM window. Declared physical RAM and caller-selected register-bit7/ungated permissions retain bank and mirror identity. Partial ROM/RAM mux reads can prove common bytes while fme7-window origins retain every ROM offset and RAM writer/input; disagreement remains unknown. Up to 64 physical RAM banks retain all necessary origins. Audio/IRQ register facts do not imply waveform, clocks or delivery. Bandai Mapper 16/159 uses a switchable 16 KiB lower window and fixed last upper bank, eight independent 1 KiB CHR ROM selectors and two mirroring bits. Mapper 16 initial.variant fcg/lz93d50 retains chip choice across trace continuation and exported views; conflicting explicit submappers remain unsupported. Optional initial.eeprom selects a conditional Xicor serial model, sparse byte assumptions and initial phase/readiness/control pins. Reads prove only D4; mapper_origins retain the exact control writer and initial EEPROM byte indices. Proven bits can resolve branches and subsequent bank choices. Source instructions never establish write completion; EEPROM remains separate from CPU RAM. VRC6/Mapper 24/26 uses a 16 KiB PRG pair, an independent 8 KiB bank and a fixed final bank. B003 D7 gates one explicitly declared NES 2.0 8 KiB RAM/NVRAM chip independently of PPU modes; raw audio writes retain register facts without waveform simulation. Tracks internal RAM, conventional NINA-001/MMC4 PRG RAM and explicitly declared MMC1B/SNROM/MMC3/G-101/VRC2c PRG RAM plus explicitly selected VRC4 internal-2k/external-8k RAM under board-specific enable/write-protection controls, including writes and code fetches with per-byte writer provenance, stack calls including source-resolved BRK/RTI, known branches, binary Ricoh arithmetic, direct/indexed/indirect data addressing and live PRG bank changes during source fetches. Returns per-instruction original bytes/file offsets, CPU after-state, semantic data_reads with source provenance, bus writes, explicit stop frontier and nested mapper_trace with Ghidra-compatible nes_prg_views. Unknown control flow or store addresses, unknown stack, unsupported unofficial opcodes, unresolved interrupt vectors, top-level RTS with an unresolved return address and max_instructions stop the prefix; automatic interrupt polling requires initial_interrupts. No exhaustive control-flow claim, PPU rendering, power-on guesses or uninitialized RAM-code execution. Qualified DMA timing requires initial_cpu_dma or initial_apu.dmc.cpu_timing. Captures at most the conventional board's 512 KiB PRG from the same stable descriptor as the full ROM digest. VRC2/VRC4 initial.wiring optionally selects a matching immutable board assumption for legacy/submapper-0 headers. Header/digest facts are unchanged; explicit submapper conflicts remain unsupported, and exported PRG views retain wiring. No active target required.",
    inputSchema: traceNesCodeInputSchema,
    outputSchema: evidenceResultOf(nesCodeTraceReportSchema),
    examples: [
      {
        title: "Derive MMC3 reset-path writes from ROM",
        input: { path: "/artifacts/game.nes", initial: { mapper: 4 } },
      },
      {
        title:
          "Analyze an unchanged legacy VRC4 cartridge with explicit wiring",
        input: {
          path: "/artifacts/legacy.nes",
          initial: { mapper: 21, variant: "vrc4", wiring: "vrc4c" },
        },
      },
      {
        title:
          "Analyze an MMC1 routine with explicit bank and accumulator assumptions",
        input: {
          path: "/artifacts/game.nes",
          initial: { mapper: 1, prg_mode: 3, prg_bank: 0 },
          entry: 49152,
          cpu: { a: 2 },
        },
      },
    ],
  },
  {
    name: "trace_nes_mapper_writes",
    ...toolContractMetadata("trace_nes_mapper_writes"),
    kind: "native-provider",
    description:
      mmc5AnalysisDescription +
      " " +
      h3001Limitations +
      " " +
      sunsoft3Limitations +
      " " +
      sunsoft4Limitations +
      " " +
      irem78Limitations +
      vrc3Limitations +
      " " +
      j87Limitations +
      " " +
      namco109Limitations +
      " Namco 163/Mapper 19 requires explicit initial.variant namco163 and preserves it in complete PRG views. Three selected 8 KiB PRG banks and a fixed final bank share exact source offsets. Tagged 1 KiB pattern/nametable windows distinguish CHR-ROM, CIRAM and unknown sources; F000=3F debug-mode possibilities remain unknown. Declared single-chip 8 KiB external RAM has four independently protected 2 KiB regions; F800 high nibble must be 4 for writes. Without initial.chip_ram, chip ports retain raw writes only. Optional chip_ram supplies 128 byte facts, address_port, explicit increment_model saturate/wrap (omission joins both), and dma_reads absent/unobserved. Active audio phase bytes are conservatively unknown. Namco source traces with this model return ordered mapper event traces plus per-instruction mapper_event_range; replay CPU reads and writes with trace_nes_mapper_events. Visible 4014 writes queue OAM DMA until the next supplied CPU read; replacement requests supersede earlier pages, and pages 48–4F advance the chip pointer through 256 reads. No sprite pixels or implicit IRQ clocks are inferred. Indexed/RMW/NOP device reads preserve pointer effects; unapplied frontiers commit no events. No waveform execution or save-file writes are inferred. Derive fixed NROM/Mapper 0 mappings, CNROM/Mapper 3 CHR selectors, UxROM/Mapper 2, inverted UNROM/Mapper 180 and AxROM/Mapper 7 PRG selectors, GxROM/Mapper 66 joint PRG/CHR selectors, Irem G-101/Mapper 32 PRG mode and independent CHR windows, Taito/Mapper 33 PRG banks and mixed 2/1 KiB CHR windows, VRC1/Mapper 75 three-bank PRG and split-register CHR selectors, VRC2a/Mapper 22 swapped-address split-nibble CHR selectors and explicit NES 2.0 submapper 3 VRC2b/c on Mapper 23/25, explicit submapper 1/2 VRC4 on Mapper 21/23/25 with variant vrc4, swapped PRG windows and nine-bit CHR selectors, or MMC1/Mapper 1, MMC3/Mapper 4, MMC2/Mapper 9 or MMC4/Mapper 10 register transitions from caller-supplied ordered CPU writes and an explicitly partial initial state, tied to an original cartridge digest. Returns every write, register after-state and post-write mapping with PRG/CHR source windows, banks, original file offsets and mirroring, plus partial initial/final mappings, coverage and complete nes_prg_views usable with open_binary. Intermediate window mappings remain available when a complete PRG selector is unknown. MMC1 serial commits, resets, fifth-write address selection and consecutive-cycle filtering are modeled; unknown timing/values remain conservative. MMC3 register aliases, bank modes, CHR inversion and IRQ register commands are decoded, without executing CPU/PPU or inferring IRQ timing. MMC2/MMC4 decode PRG/CHR selectors and mirroring; CHR latches remain conditional on supplied initial values unless PPU events are provided through trace_nes_mapper_events. CNROM/UxROM/AxROM use the currently mapped immutable PRG byte at each write address for declared AND conflicts; unspecified wiring joins conflict and no-conflict outcomes. No power-on defaults, automatic code-path extraction or proof that supplied writes executed. GxROM models conventional AND-conflict PRG/CHR selection. Mapper 206 uses the Namco 108 bank-select/data port at 8000–9FFF with fixed PRG/CHR modes, no IRQ or PRG RAM, and fixed 32 KiB PRG on submapper 1. Raw partial bank bytes are retained; chip-specific electrical timing hazards are not simulated. Mapper 232 selects a 64 KiB outer group for both PRG windows and an inner 16 KiB bank for the lower window; submapper 1 swaps outer register bits. Unknown outer selection leaves both windows unresolved unless ROM capacity makes the selection irrelevant. Mapper 180 fixes the first 16 KiB PRG bank low and selects the upper window with three bits and AND bus conflicts. Unsupported layouts retain cartridge facts with a reason. max_steps bounds retained snapshots before derivation. VRC2b one-bit loopback at 6000–6FFF requires explicit latch_present true with no declared PRG RAM; unknown wiring remains unknown. VRC4 prg_ram_wiring is an immutable caller assumption: internal-2k requires one declared 2 KiB chip at 6000–6FFF with a mirror, external-8k one 8 KiB chip at 6000–7FFF; both use 9002 D0. Mapper 69 records command/parameter writes, partial destinations, lower ROM/RAM selection, three PRG selectors, eight 1 KiB CHR selectors and mirroring. fme7/5a/5b is an immutable chip assumption retained in PRG views; 5A/5B admit five bank bits, FME-7 six. lower_window states source, physical bank and permissions separately from ROM windows. 5B audio registers are raw facts only. Mapper 69 IRQ calculations require separate explicit cycle events. Bandai Mapper 16/159 retains a lower 16 KiB selector, fixed final upper bank and eight independent 1 KiB CHR ROM selectors. Mapper 16 requires variant fcg/lz93d50 matching NES 2.0 submapper 4/5 or an immutable legacy assumption. FCG-1/2 decodes 6000–7FFF writes; LZ93D50 decodes 8000–FFFF writes. Raw IRQ and EEPROM bytes alone do not establish elapsed clocks or contents. Optional initial.eeprom follows Xicor serial edges and stages page writes; only an explicit completion event commits storage. VRC6/Mapper 24/26 records raw PRG/CHR/B003, audio and IRQ registers, 16/8 KiB PRG windows and every PPU banking mode, including explicit CIRAM/ROM nametable windows. Source tracing separately tracks canonical RAM bytes and writer/input provenance. Omitted wiring or incompatible declarations never establish RAM contents. VRC2/VRC4 initial.wiring admits matching legacy/submapper-0 boards as an immutable assumption retained in PRG views; explicit header conflicts are unsupported and original ROM bytes/digest remain unchanged. No disassembler or active target required.",
    inputSchema: traceNesMapperWritesInputSchema,
    outputSchema: evidenceResultOf(nesMapperTraceReportSchema),
    examples: [
      {
        title: "Derive MMC3 PRG windows after setting R6 and R7",
        input: {
          path: "/artifacts/game.nes",
          initial: { mapper: 4 },
          writes: [
            { address: 32768, value: 6 },
            { address: 32769, value: 2 },
            { address: 32768, value: 7 },
            { address: 32769, value: 3 },
          ],
        },
      },
    ],
  },
  {
    name: "inspect_nes_cartridge",
    ...toolContractMetadata("inspect_nes_cartridge"),
    kind: "native-provider",
    description:
      "Inspect an explicit local iNES/NES 2.0 cartridge without opening a disassembler or executing it. Returns original header declarations, trainer/PRG/CHR/trailing ranges, complete SHA-256 and one caller-selected 4 KiB source CHR page decoded into 8x8 two-bit tile rows, with original bytes and per-tile file offsets. Works even when its mapper has no CPU analysis model. Source pages are not runtime PPU banks; palettes, nametables, sprites and graphics usage remain unknown. No CHR ROM reports unavailable source pixels, not empty runtime graphics. Incomplete final tile bytes remain raw. Streams the complete regular file under max_file_bytes and rejects changed identity; CHR output is bounded by one pattern-table-sized page. No active binary, engine, process launch or host setup required.",
    inputSchema: inspectNesCartridgeInputSchema,
    outputSchema: evidenceResultOf(nesCartridgeSchema),
    examples: [
      {
        title: "Inspect cartridge metadata and the first source CHR page",
        input: { path: "/artifacts/game.nes" },
      },
      {
        title: "Decode another source CHR page",
        input: { path: "/artifacts/game.nes", chr_page: 1 },
      },
    ],
  },

  {
    name: "inspect_pe_resources",
    ...toolContractMetadata("inspect_pe_resources"),
    kind: "native-provider",
    description:
      "Inspect one explicit local PE32/PE32+ image's complete bounded type/name/language resource tree without executing it or opening a disassembler. Returns numeric IDs versus original UTF-16 names, directory/data-entry file locations, payload RVA/file ranges, complete SHA-256 hashes and static RT_GROUP_ICON image-resource candidates. Language fallback, image decoding and actual shell/window loading remain unobserved. Reads a stable regular file; malformed or ambiguous mappings, non-identical overlapping ranges and exhausted budgets return no partial success. Portable on supported Node hosts; no Windows SDK or engine installation required.",
    inputSchema: inspectPeResourcesInputSchema,
    outputSchema: evidenceResultOf(peResourcesSchema),
    examples: [
      {
        title: "Inspect PE resource identities and icon relationships",
        input: { path: "/artifacts/application.exe" },
      },
    ],
  },
  {
    name: "inspect_binary_layout",
    ...toolContractMetadata("inspect_binary_layout"),
    kind: "native-provider",
    description:
      "Inspect an explicit local binary without launching it as a host process. Returns file-backed section/segment ranges, linked addresses, original symbol/REL/RELA table identities, complete encoded RELR tables and upstream-derived offsets with unknown per-word locations/addends, raw name bytes, dependency/interpreter names and static mitigation inferences inline with artifact SHA-256 Evidence. Initial profile: ELF64 x86-64 little-endian EXEC/DYN/REL on Linux x64 via caller-supplied Python with unchanged pwntools 4.15.0, pyelftools 0.33 and Unicorn 2.1.2. Runtime addresses/library paths, overall relocation inventory completeness and complete derived GOT/PLT coverage remain unknown. Zero executable entry values mean absence; relocatable entries are not applicable. Upstream can emulate PLT instructions with Unicorn for derived static maps. Uses bounded complete output and owned temporary files/processes; malformed, unsupported or oversized objects return no partial success. Select detail summary to retain the complete layout Evidence in this session and receive only its summary view, then inspect sections, symbols, mitigations or linkage with inspect_analysis_view.",
    inputSchema: inspectBinaryLayoutRequestSchema,
    outputSchema: analysisDetailOutputSchemaOf(
      binaryLayoutSchema,
      binaryLayoutSummaryViewResultSchema,
    ),
    examples: [
      {
        title: "Inspect ELF linked and file layout",
        input: { path: "/artifacts/application.elf" },
      },
      {
        title: "Retain the complete layout and return its summary view",
        input: { path: "/artifacts/application.elf", detail: "summary" },
      },
    ],
  },
  {
    name: "inspect_recorded_crash",
    ...toolContractMetadata("inspect_recorded_crash"),
    kind: "native-provider",
    description:
      "Inspect a supplied Linux ELF64 amd64 or AArch64 little-endian core without launching its target or attaching to any live PID. Returns all recorded segments, raw note owners/descriptors and source ranges, every Linux CORE PRSTATUS thread/register and SIGINFO fields inline with SHA-256 Evidence. Historical PID is recorded metadata; current process/file identity, note coverage and signal-thread associations stay unknown. Optionally add derived core-only GDB/pwndbg mapping candidates through explicit BYO configuration; zero map flags mean unknown permissions. Uses the same stable snapshot for both stages, bounded complete output and owned cleanup. Linux x64 host profile: unchanged pwntools 4.15.0/pyelftools 0.33/Unicorn 2.1.2; optional unchanged pwndbg 2026.09.15. No implicit executable/library pairing, GDB command language, host configuration changes or dependency installation.",
    inputSchema: inspectRecordedCrashInputSchema,
    outputSchema: evidenceResultOf(recordedCrashSchema),
    examples: [
      {
        title: "Inspect recorded registers and signal evidence",
        input: { path: "/artifacts/crash.core" },
      },
      {
        title: "Add core-only debugger mapping candidates",
        input: {
          path: "/artifacts/crash.core",
          include_debugger_context: true,
        },
      },
    ],
  },
] as const satisfies readonly ToolContract[];
