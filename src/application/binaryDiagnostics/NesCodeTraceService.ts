import { nesMapperBoardLimitations } from "../../domain/nesMapperBoardLimitations.js";
import { nesPpuMemoryLimitations } from "../../domain/nesPpuState.js";
import { nesControllerLimitations } from "../../domain/nesControllers.js";
import { nesApuLimitations } from "../../domain/nesApu.js";
import { nesCpuInterruptLimitations } from "../../domain/nesCpuInterrupts.js";
import { nesOamCpuDmaLimitations } from "../../domain/nesOamCpuDma.js";
import { nesCpuIoLimitations } from "../../domain/nesCpuIo.js";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { NesRomSnapshotPort } from "./NesRomSnapshotPort.js";
import { captureNesRomSnapshot } from "./captureNesRomSnapshot.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  traceNesCodeInputSchema,
  nesCpuBusLimitations,
  nesSourceIrqLimitations,
} from "../../domain/nesCodeTrace.js";
import { deriveNesCode } from "../../domain/nesCodeDerivation.js";

import { exploreNesCodeInputSchema } from "../../domain/nesCodeExploration.js";
import { exploreNesCode } from "../../domain/nesCodeExplorationDerivation.js";
/** Analyze immutable source bytes with explicit CPU/mapper assumptions, never run the game. */
export class NesCodeTraceService {
  constructor(readonly provider: NesRomSnapshotPort) {}
  close(): Promise<void> {
    return this.provider.close();
  }
  trace(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.analyze(rawInput, "trace_nes_code", options);
  }
  explore(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.analyze(rawInput, "explore_nes_code", options);
  }
  private async analyze(
    rawInput: unknown,
    operation: "trace_nes_code" | "explore_nes_code",
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const parsed = (
      operation === "explore_nes_code"
        ? exploreNesCodeInputSchema.transform((input) => ({
            mode: "explore" as const,
            input,
          }))
        : traceNesCodeInputSchema.transform((input) => ({
            mode: "trace" as const,
            input,
          }))
    ).safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(operation, parsed.error.issues, rawInput),
      );
    const request = parsed.data;
    const input = request.input;
    const captured = await captureNesRomSnapshot(
      this.provider,
      { ...input, includeChr: input.initial_ppu !== null },
      operation,
      options,
    );
    if (!captured.ok) return captured;
    const { cartridge, source } = captured.value;
    try {
      options?.signal?.throwIfAborted();
      const derived =
        request.mode === "explore"
          ? {
              code_exploration:
                source.status === "unsupported"
                  ? source
                  : await exploreNesCode(
                      cartridge.header,
                      source.prg,
                      request.input,
                      { signal: options?.signal, chr: source.chr },
                    ),
            }
          : {
              code_trace:
                source.status === "unsupported"
                  ? source
                  : await deriveNesCode(
                      cartridge.header,
                      source.prg,
                      request.input,
                      { signal: options?.signal, chr: source.chr },
                    ),
            };
      const limitations = [
        nesCpuBusLimitations,
        ...(input.initial_cpu_io === null ? [] : [nesCpuIoLimitations]),
        ...(input.initial_cpu_dma === null ? [] : [nesOamCpuDmaLimitations]),
        ...(input.initial_interrupts === null
          ? []
          : [nesCpuInterruptLimitations]),
        ...(input.initial_irq === null ? [] : [nesSourceIrqLimitations]),
        ...(input.initial_apu === null ? [] : [nesApuLimitations]),
        ...(input.initial_controllers === null
          ? []
          : [nesControllerLimitations]),
        ...(input.initial_ppu === null ? [] : [nesPpuMemoryLimitations]),
        ...nesMapperBoardLimitations(
          cartridge.header,
          "wiring" in request.input.initial
            ? request.input.initial.wiring
            : undefined,
        ),
        "This is a conditional source-code derivation, not observed gameplay or CPU execution. Entry, CPU registers and mapper state are caller-selected assumptions. reset/nmi/irq select source-resolved vector entries without delivering a reset/interrupt, pushing a stack frame or changing supplied CPU flags; omitted values remain unknown. An entry object with accepted_interrupt and return_address explicitly assumes an already-accepted IRQ/NMI and derives its frame before following its vector. Automatic acceptance and I-flag polling require initial_interrupts; signal races, DMA timing, PPU rendering and audio playback are not inferred. MMC2/MMC4 CHR latches follow modeled CPU-port reads under initial_ppu; otherwise latch fields remain conditional initial assumptions. Use trace_nes_mapper_events for explicitly supplied PPU bus reads.",
        "Each trace follows one conditional instruction path. Explicit branch_choices restrict unknown conditional branches to caller-selected outcomes, are recorded on applied instructions and are not observations; branch_choices_used reports the consumed prefix. A mismatched choice address stops before applying the branch. Without a choice, unknown branch/control targets, unknown write addresses or stack state, unsupported opcodes, unresolved interrupt vectors, top-level RTS with an unresolved return address and the caller instruction budget stop the path explicitly. This does not establish whole-ROM, whole-function or all-branch coverage.",
        "Official NMOS 6502 encodings, 27 stable unofficial NOP encodings, the immediate $EB SBC alias, and stable memory-addressed LAX/SAX/LAS encodings and immediate ANC/ALR/AXS/ARR, and memory DCP/ISC/SLO/RLA/SRE/RRA are decoded with Ricoh binary ADC/SBC (D does not enable BCD), zero-page/index wrapping and the indirect JMP page-wrap behavior. BRK pushes PC+2 and the status copy to the known stack, sets I and follows the current IRQ/BRK ROM vector; RTI restores a known return address and individually proven status flags. Partially known pushed status bytes retain known_bits (mask/value) on writes and data_reads; PLP/RTI restore only proven bits; BIT derives N/V/Z from proven operand bits and the known accumulator. Generic unknown stores erase those bit facts. Supported arithmetic retains partial byte proofs; instruction decoding requires complete source bytes. interrupt_vector preserves vector bytes and source offsets on applied BRK instructions or unresolved-vector frontiers. Automatic boundary IRQ/NMI entry and line polling require initial_interrupts; NMI edges/hijacking require separate PPU timing and remain unmodeled. Unsupported unofficial opcodes are boundaries. Nominal bus cycles require initial_cpu_bus; only explicitly selected device models derive read side effects.",
        "Internal RAM facts start from explicit initial_ram byte assumptions; omitted bytes are unknown. CPU mirrors share physical bytes. Subsequent writes replace those assumptions with derived writer provenance, including stack operations. Conventional NINA-001 unbanked 8 KiB PRG RAM is tracked, including writes overlapping 7FFD–7FFF registers: readback retains the entire CPU byte, independently of masked bank selectors. Legacy NINA board interpretation implies this wiring; NES 2.0 requires exactly one 8 KiB RAM/NVRAM declaration. Conventional MMC4/FxROM likewise tracks an unbanked 8 KiB region under a recorded legacy board interpretation or one matching NES 2.0 RAM/NVRAM declaration; MMC2/PxROM does not inherit that RAM wiring. MMC6 (Mapper 4/submapper 1) tracks internal 1 KiB RAM at 7000–7FFF, mirrored to canonical 7000–73FF; bank-select bit 5 gates RAM and clears protection when disabled. Each 512-byte half has separate read/write enables; a disabled half reads zero when the other half is readable. Such instruction bytes use mapper_origins with the controlling register values, never fabricated RAM writers. Zero or one explicit 1 KiB RAM/NVRAM declaration is admitted; other sizes remain unknown. MMC3 also tracks one explicitly declared NES 2.0 8 KiB PRG RAM/NVRAM region under A001 enable/write-protect control. Disabled or protected writes preserve storage; an uncertain write preserves only the bits shared by the stored and retained values, keeping the earlier source as the surviving bit proof without claiming a definite last writer. Disabled or unknown read enable yields unknown data and instruction fetches. MMC1 RAM uses standard Mapper 1/MMC1B wiring with one explicitly declared NES 2.0 8 KiB RAM/NVRAM region: the PRG disable bit controls access, and conventional SNROM also uses CHR bit 4. Different possible SNROM CHR outputs under unobserved PPU A12 yield unknown permission. Explicit NES 2.0 SOROM/SXROM/SZROM capacities also model two/four/two physical RAM banks selected by CHR outputs. Unobserved PPU A12 joins candidate banks; reads require agreement and uncertain stores retain only common facts. MMC1 submapper 5 fixes PRG mapping independently of unknown or changed PRG selectors; it does not infer cartridge RAM wiring. 512 KiB MMC1 derives the outer ROM half from CHR bit 4, without treating it as SNROM RAM disable; disagreeing possible CHR outputs leave both ROM windows unknown. Mixed CHR ROM/RAM wiring remains unmodeled. MMC1A/Mapper 155, legacy MMC1/MMC3 RAM capacities, RAM layouts outside the explicitly modeled board profiles and MMIO reads outside selected device models remain unknown. Instruction fetches use mapped PRG ROM, explicit RAM assumptions or known path-local RAM writes. RAM instruction bytes have null file offsets and ram_origins with an explicit internal-ram/prg-ram region, canonical CPU address and earlier writer identity; PRG RAM origins also identify the physical bank. Multiple origins for one byte prove its complete value or common known_bits across every possible bank; a missing bank removes the proof. Caller-provided internal RAM instruction bytes instead identify initial_ram_index in ram_origins, without a fabricated writer. Accepted entry frame bytes identify entry_interrupt_write_index in entry_interrupt.writes; they are never attributed to a code instruction. initial_prg_ram supplies physical cartridge RAM assumptions only for established board layouts, independently of current bank selection; it does not bypass read/write permissions. Their instruction origins use initial_prg_ram_index and physical bank. Noncanonical mirror addresses, nonexistent banks and unknown layouts are unsupported. Save-file formats and trainer contents are not inferred.",
        "CNROM uses fixed PRG mapping; UxROM switches the lower 16 KiB window while retaining the final bank above it. Submapper 1 has no conflicts; submapper 2 ANDs the CPU write with its immutable ROM bus byte; unspecified wiring joins both possibilities. The original CPU write is retained, while derived selectors can remain unknown. Complete UxROM states export Ghidra nes_prg_views containing both CPU windows.",
        "VRC2b one-bit loopback requires explicit latch_present true with no declared PRG RAM/NVRAM. Reads prove only D0, retaining null complete bytes and a mapper origin tied to an initial-state assumption or earlier CPU write. Upper open-bus bits stay unknown; unknown stores invalidate the prior proof. 7000–7FFF does not affect the latch. No reset or Microwire EEPROM protocol is inferred.",
        "Each instruction records its original bytes and per-byte source offsets, including window boundaries. data_reads records semantic operand, pointer and stack lookups with addresses, values and source provenance; stop.data_reads retains attempted lookups without applying a stopped instruction. Null addresses and values preserve unresolved dependencies. These are semantic reads, not CPU cycles. Selected Namco chip RAM and PPU models separately retain device-affecting NMOS dummy/NOP reads in mapper events. Immediate bytes and BRK/vector reads retain their separate instruction/vector evidence. Mapper writes immediately change subsequent ROM reads and instruction fetches. Read-modify-write operands are latched before both bus writes; the second write is marked consecutive for MMC1 filtering.",
        "NROM with an explicit NES 2.0 single 2/4/8 KiB RAM or NVRAM chip uses mirrored cartridge RAM; initial.prg_ram_write_enabled is a caller assumption about external write protection, and omission leaves write success unknown. Existing save contents are not inferred. The nested mapper_trace normally contains derived writes and complete conditional PRG views usable with Ghidra. Explicit Namco chip_ram or initial_ppu uses ordered mapper-event replay, preserving read-induced pointer changes and device-affecting NMOS dummy/NOP reads; mapper_event_range attributes events to each applied instruction. Unapplied frontiers retain attempted semantic reads but commit no events. Replay the event shape through trace_nes_mapper_events. PRG/CHR layout, unknown-state and IRQ limitations of trace_nes_mapper_writes still apply. A stop frontier is not an applied instruction.",
      ];
      if (request.mode === "explore")
        limitations.push(
          "Exploration expands unknown conditional branches breadth-first into separately replayed paths. Added branch_choices are exploration assumptions, not observed outcomes or a proof of feasibility. Initial caller choices constrain the explored subtree. CPU, RAM and mapper state are never merged between paths.",
          "max_paths bounds all retained attempts, including branching prefixes; max_total_instructions counts repeated prefixes as well as new instructions. Each path also obeys max_instructions. pending_paths are not executed. queue-exhausted means only that no queued alternatives remain, not that stopped paths, unknown targets, loops or the entire ROM are covered. Inspect every path's stop reason.",
          "The union nes_prg_views contains complete contexts derived on individual conditional paths, not simultaneous runtime mappings. Preserve the corresponding path assumptions when opening these views in Ghidra.",
        );
      return ok(
        createEvidence(
          {
            path: cartridge.artifact.path,
            format: "nes",
            architecture: "6502",
            sha256: cartridge.artifact.sha256,
          },
          this.provider.identity,
          {
            operation: operation,
            parameters: input,
            result: {
              artifact: cartridge.artifact,
              header: cartridge.header,
              ...derived,
              limitations,
            },
            confidence: "derived",
            limitations,
            locations: [
              { kind: "artifact-path", path: cartridge.artifact.path },
            ],
          },
        ),
      );
    } catch (cause) {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(operation, { cause }));
      throw cause;
    }
  }
}
