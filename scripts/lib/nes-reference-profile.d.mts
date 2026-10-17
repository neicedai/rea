export interface NesReferenceCpu {
  readonly a: number;
  readonly x: number;
  readonly y: number;
  readonly sp: number;
  readonly c: boolean;
  readonly z: boolean;
  readonly i: boolean;
  readonly d: boolean;
  readonly v: boolean;
  readonly n: boolean;
}
export interface NesReferenceRow {
  readonly address: number;
  readonly bytes: string;
  readonly cycle: number;
  readonly cpu: NesReferenceCpu;
}
export interface NesReferenceFrontierCycle {
  readonly index: number;
  readonly role: "opcode" | "dummy" | "stack";
  readonly address: number | null;
  readonly value: number | null;
}
export interface NesReferenceProfile {
  readonly id: "nestest-nintendulator";
  readonly rom_sha256: string;
  readonly log_sha256: string;
  readonly rows: number;
  readonly applied_instructions: number;
  readonly after_states: number;
  readonly committed_cycles: number;
  readonly initial_row: NesReferenceRow;
  readonly final_row: NesReferenceRow;
  readonly frontier: {
    readonly reason: "unknown-control-target";
    readonly address: number;
    readonly bytes_hex: string;
    readonly cycles: readonly NesReferenceFrontierCycle[];
    readonly writes: readonly [];
    readonly mapper_events: readonly [];
    readonly blocked_address: null;
  };
  readonly source_urls: { readonly rom: string; readonly log: string };
  readonly scope: string;
}
export const NESTEST_REFERENCE_PROFILE: NesReferenceProfile;
export function parseNesReferenceLog(
  bytes: Uint8Array,
): readonly NesReferenceRow[];
export function qualifyNesReferenceArtifacts(
  rom: Uint8Array,
  log: Uint8Array,
  profile?: unknown,
): {
  readonly profile: NesReferenceProfile;
  readonly rom_sha256: string;
  readonly reference_sha256: string;
  readonly rows: readonly NesReferenceRow[];
};
export function assertNesReferenceCoverage(
  summary: unknown,
  profile?: unknown,
): void;
