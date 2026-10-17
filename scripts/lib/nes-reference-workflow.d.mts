import type { z } from "zod";
import type {
  NesCodePath,
  NesCpuState,
  NesCpuBusState,
  traceNesCodeInputSchema,
} from "../../src/domain/nesCodeTrace.js";
import type { NesMapperState } from "../../src/domain/nesMapperTrace.js";
import type { NesReferenceRamWriter } from "./nes-reference-segment.mjs";

export type NesReferenceTraceInput = z.input<typeof traceNesCodeInputSchema>;
export class NesReferenceResponseBudgetError extends Error {
  readonly evidenceId: string;
  readonly details: unknown;
  constructor(options: { evidenceId: string; details: unknown });
}
export interface NesReferenceTraceSegment {
  readonly index: number;
  readonly start_row: number;
  readonly end_row: number;
  readonly evidence_id: string;
  readonly previous_evidence_id: string | null;
  readonly input: NesReferenceTraceInput;
  readonly ram_handoff: readonly {
    readonly initial_ram_index: number;
    readonly address: number;
    readonly value: number;
    readonly writer: NesReferenceRamWriter;
  }[];
  readonly final_cpu: NesCpuState;
  readonly final_mapper: NesMapperState;
  readonly final_cpu_bus: NesCpuBusState;
  readonly stop: NesCodePath["stop"];
}
export interface NesReferenceTraceReport {
  readonly ok: true;
  readonly profile: string;
  readonly rom: {
    readonly path: string;
    readonly requested_path: string;
    readonly sha256: string;
  };
  readonly reference: {
    readonly path: string;
    readonly requested_path: string;
    readonly sha256: string;
    readonly rows: number;
  };
  readonly initial_state_source: string;
  readonly continuation_state_source: string;
  readonly initial_ram_count: number;
  readonly initial_cycle: number;
  readonly final_committed_cycle: number;
  readonly final_cpu: NesCpuState;
  readonly compared_instructions: number;
  readonly compared_after_states: number;
  readonly compared_bus_cycles: number;
  readonly source_verified_bus_reads: number;
  readonly unresolved_bus_reads: number;
  readonly ram_backed_instructions: number;
  readonly reference_rows_not_applied: number;
  readonly reference_coverage: "complete-with-declared-unapplied-frontier";
  readonly full_rom_pass: false;
  readonly stop: NesCodePath["stop"];
  readonly stop_segment: number;
  readonly segments: readonly NesReferenceTraceSegment[];
  readonly budget_attempts: readonly {
    readonly start_row: number;
    readonly max_instructions: number;
    readonly evidence_id: string;
    readonly details: unknown;
  }[];
  readonly scope: string;
}
export function verifyNesReferenceTrace(options: {
  romPath: string;
  logPath: string;
  invoke: (input: NesReferenceTraceInput) => Promise<unknown>;
  segmentInstructions?: number;
}): Promise<NesReferenceTraceReport>;
