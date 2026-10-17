import { nesMapperBoardLimitations } from "../../domain/nesMapperBoardLimitations.js";
import { nesPpuMemoryLimitations } from "../../domain/nesPpuState.js";
import { nesControllerLimitations } from "../../domain/nesControllers.js";
import { nesApuLimitations } from "../../domain/nesApu.js";

import type { ExecutionOptions } from "../AnalysisProvider.js";
import { NES_CARTRIDGE_PROVIDER } from "../InvestigationProviders.js";
import type { NesRomSnapshotPort } from "./NesRomSnapshotPort.js";
import { captureNesRomSnapshot } from "./captureNesRomSnapshot.js";
import {
  AnalysisCancelledError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import { traceNesMapperWritesInputSchema } from "../../domain/nesMapperTrace.js";
import { deriveNesMapperTraceWithCancellation } from "../../domain/nesMapperTraceDerivation.js";

import { traceNesMapperEventsInputSchema } from "../../domain/nesMapperEvents.js";
import { deriveNesMapperEvents } from "../../domain/nesMapperEventsDerivation.js";

/** Join authenticated cartridge facts with explicitly supplied register writes. */
export class NesMapperTraceService {
  constructor(readonly provider: NesRomSnapshotPort) {}
  close(): Promise<void> {
    return this.provider.close();
  }

  trace(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.analyze(rawInput, "trace_nes_mapper_writes", options);
  }
  traceEvents(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    return this.analyze(rawInput, "trace_nes_mapper_events", options);
  }
  private async analyze(
    rawInput: unknown,
    operation: "trace_nes_mapper_writes" | "trace_nes_mapper_events",
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const input = (
      operation === "trace_nes_mapper_events"
        ? traceNesMapperEventsInputSchema
        : traceNesMapperWritesInputSchema
    ).safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(operation, input.error.issues, rawInput),
      );
    const selected = input.data;
    const supplied =
      "events" in selected ? selected.events.length : selected.writes.length;
    if (supplied > selected.max_steps)
      return err(
        new AnalysisResourceConstraintError(
          operation,
          "memory",
          "Supplied operations exceed the caller-selected retained trace budget",
          {
            max_steps: selected.max_steps,
            ...("events" in selected
              ? { supplied_events: supplied }
              : { supplied_writes: supplied }),
          },
        ),
      );
    const captured = await captureNesRomSnapshot(
      this.provider,
      {
        ...selected,
        includeChr:
          "events" in selected &&
          (selected.initial.mapper === 5 || selected.initial_ppu !== null),
      },
      operation,
      options,
    );
    if (!captured.ok) return captured;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const { cartridge, source } = captured.value;
    let trace;
    try {
      trace =
        source.status === "unsupported"
          ? source
          : "events" in selected
            ? await deriveNesMapperEvents(
                cartridge.header,
                selected.initial,
                selected.events,
                {
                  signal: options?.signal,
                  prg: source.prg,
                  chr: source.chr,
                  initialIrq: selected.initial_irq,
                  initialPpu: selected.initial_ppu,
                  initialControllers: selected.initial_controllers,
                  initialApu: selected.initial_apu,
                  ppuPatternTable: selected.ppu_pattern_table,
                  ppuNametable: selected.ppu_nametable,
                  ppuSprites: selected.ppu_sprites,
                  ppuViewport: selected.ppu_viewport,
                  ppuMmc5Background: selected.ppu_mmc5_background,
                },
              )
            : await deriveNesMapperTraceWithCancellation(
                cartridge.header,
                selected.initial,
                selected.writes,
                source.prg,
                { signal: options?.signal },
              );
    } catch (cause) {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(operation, { cause }));
      throw cause;
    }
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(operation));
    const limitations = [
      ...("initial_apu" in selected && selected.initial_apu !== null
        ? [nesApuLimitations]
        : []),
      ...("initial_controllers" in selected &&
      selected.initial_controllers !== null
        ? [nesControllerLimitations]
        : []),
      ...("initial_ppu" in selected && selected.initial_ppu !== null
        ? [nesPpuMemoryLimitations]
        : []),
      ...nesMapperBoardLimitations(
        cartridge.header,
        "wiring" in selected.initial ? selected.initial.wiring : undefined,
      ),
      "Mapper 34 selects NINA-001 from submapper 1 or legacy/submapper-0 CHR ROM above 8 KiB; submapper 2 and other conventional CHR sizes select BNROM. NINA-001 decodes 7FFD/7FFE/7FFF into independent PRG/CHR selectors and has no bus conflicts; BNROM decodes 8000–FFFF with ROM AND conflicts and fixed CHR. This is a header-based board interpretation. This supplied-write mapper report does not reconstruct cartridge RAM contents; source-code tracing separately tracks conventional NINA-001 PRG RAM writes. Lockout circuitry and oversize boards are not modeled.",
      "Mapper 71 uses conflict-free PRG writes at C000–FFFF and fixes the last 16 KiB bank. NES 2.0 submapper 0 retains header mirroring; submapper 1 uses bit 4 of 8000–9FFF writes for single-screen mirroring. Legacy headers leave runtime mirroring unknown. Lockout circuitry is not modeled; Mapper 232 has a separate outer-bank model.",
      "Mapper 11 retains the caller-selected bus_conflicts policy: and, none, or unknown. Unknown joins both board variants; bits 0–1 select PRG and bits 4–7 select CHR. The header alone does not identify conflict-free prototypes. Lockout-control bits are not modeled.",
      "Conventional GxROM (Mapper 66) uses AND bus conflicts: bits 4–5 select PRG and bits 0–1 select CHR. Both selectors use the same pre-write ROM mapping and original CPU byte; unresolved bits stay unknown. Oversized or rewired variants require separate models.",
      "CNROM (Mapper 3), UxROM (Mapper 2) and AxROM (Mapper 7) use submapper 1 for no conflicts and submapper 2 for AND conflicts; unspecified wiring joins both possibilities. Supplied writes and source-code traces use the immutable PRG snapshot captured with the cartridge digest to resolve the ROM bus byte at each write address. Fixed CNROM PRG mappings require no nes_prg_views. Complete UxROM states export nes_prg_views with both switchable and fixed windows in one Ghidra context.",
      "Register states and writes are caller-supplied assumptions. The ROM digest authenticates source bytes, not execution of this sequence. Results are derived conditional interpretations; no CPU or PPU execution was observed.",
      "Coverage includes only supplied operations in their given order. Missing writes, PPU reads, interrupts or inaccurate consecutive-cycle flags can change the result. Unknown values and serial alignment are retained conservatively; alternatives are not exhaustively enumerated. Partial CPU writes may retain known_bits from code tracing, and MMC1 uses proven D7/D0 bits for reset and serial writes while retaining uncertain reset, data and timing alternatives. MMC3 R0-R7 preserve partial bytes as {mask,value} and resolve only proven physical PRG/CHR address bits; an unknown destination joins facts common to the old and written byte. MMC3 bank_select independently resolves target bits, PRG/CHR mode bits and MMC6 master enable; only consistent destinations are joined. Nametable writes use proven D0. RAM permissions use independently proven enable and protection bits; IRQ latch bytes retain partial bits; a proven set bit excludes a zero reload. MMC3 counter values remain complete bytes or unknown; VRC4 event counters also retain proven bits. Partial bits are never substituted as complete bytes.",
      "PRG and CHR maps use the same conventional NROM/CNROM/UxROM/AxROM/GxROM/MMC1/MMC2/MMC3/MMC4 board capacities as static import. MMC1 submapper 5 fixes 32 KiB PRG independently of register writes while retaining CHR/mirroring state; no conditional PRG views apply. 512 KiB MMC1 uses CHR bit 4 for outer ROM banking; unknown output leaves both PRG windows unresolved. MC-ACC (submapper 3) and NEC MMC3 (submapper 4) use MMC3 PRG/CHR maps; their conventional IRQ behavior requires an explicitly selected event model, and MC-ACC RAM wiring remains unknown. MMC6 uses MMC3 PRG/CHR maps but distinct RAM controls; timing/IRQ delivery remains unobserved. Mixed CHR ROM/RAM wiring and special board variants require separate models. CHR RAM contents and wiring remain unobserved.",
      "VRC4 event traces require explicit initial_irq model vrc4 and ordered vrc-cpu-cycle events. The conventional model counts up, reloads on overflow and latches assertion; scanline mode divides cycles by 114/114/113. Control enables reload counter/phase, while acknowledge preserves them. Cycle mode does not establish physical prescaler phase; partial byte proofs and phase sets retain uncertainty. Writes and PPU reads never supply implicit CPU cycles. Writes-only traces record IRQ values and commands only. Event traces with explicit initial_irq and mmc3-irq-clock events additionally derive conventional Sharp/NEC/MC-ACC counter and IRQ line state. Clock events are caller-supplied qualified clocks; alternatively ordered ppu-a12 and cpu-m2-fall signals derive the conventional three-M2-low filter. Missing filter history retains possible phases. Ordinary PPU reads do not imply signal transitions. MC-ACC uses falling A12 edges with an eight-pulse prescaler reset by C001; the first edge after reset clocks the counter. M2 edges do not advance that prescaler. No silicon identity, consecutive-reload hardware glitches or CPU interrupt delivery is inferred. Unprovided PPU A12 edges and wall-clock IRQ assertion timing, PRG RAM access permissions, power-on state, CPU instructions and compressed graphics are not emulated.",
      "nes_prg_views contains unique complete PRG selectors suitable for independent Ghidra contexts, not a runtime execution timeline. Raw write bytes remain in steps and analysis parameters even when selectors ignore some bits.",
    ];
    limitations.push(
      "MMC2/MMC4 CPU writes select PRG/CHR registers and mirroring. A writes-only trace retains supplied initial CHR latch assumptions; it does not establish that no intervening PPU reads occurred. Use trace_nes_mapper_events for interleaved supplied PPU bus reads. The triggering read uses the previous CHR mapping and updates latches for subsequent reads; without initial_ppu, CPU-port buffering remains unknown; rendering and observed gameplay are not inferred.",
    );
    return ok(
      createEvidence(
        {
          path: cartridge.artifact.path,
          format: "nes",
          architecture: "6502",
          sha256: cartridge.artifact.sha256,
        },
        NES_CARTRIDGE_PROVIDER,
        {
          operation: operation,
          parameters: selected,
          result: {
            artifact: cartridge.artifact,
            header: cartridge.header,
            trace,
            limitations,
          },
          confidence: "derived",
          limitations,
          locations: [{ kind: "artifact-path", path: cartridge.artifact.path }],
        },
      ),
    );
  }
}
