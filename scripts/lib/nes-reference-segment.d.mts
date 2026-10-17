import type { z } from "zod";
import type {
  NesCodePath,
  traceNesCodeInputSchema,
} from "../../src/domain/nesCodeTrace.js";
import type { NesReferenceRow } from "./nes-reference-profile.mjs";
export interface NesReferenceRamWriter {
  readonly evidence_id: string;
  readonly segment: number;
  readonly instruction_index: number;
  readonly absolute_instruction_index: number;
  readonly write_index: number;
}
export interface NesReferenceRamFact {
  readonly value: number;
  readonly writer: NesReferenceRamWriter;
}
/** Wire schema and pinned artifact qualification are prerequisites owned by the caller. */
export function verifyNesReferenceSegment(input: {
  readonly evidence: unknown;
  readonly rom: Uint8Array;
  readonly rows: readonly NesReferenceRow[];
  readonly startRow: number;
  readonly segmentIndex: number;
  readonly input: z.input<typeof traceNesCodeInputSchema>;
  readonly ram: ReadonlyMap<number, NesReferenceRamFact>;
}): {
  readonly trace: NesCodePath;
  readonly endRow: number;
  readonly ram: Map<number, NesReferenceRamFact>;
  readonly comparedAfterStates: number;
  readonly verifiedDataReads: number;
  readonly unresolvedDataReads: number;
  readonly ramBackedInstructions: number;
};
