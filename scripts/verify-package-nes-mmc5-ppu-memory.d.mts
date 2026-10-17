export function mmc5PpuMemoryFixture(): Uint8Array;
export function verifyPackageNesMmc5PpuMemory(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly shared_exram: true;
  readonly nametable_sources: true;
  readonly cpu_buffer: true;
  readonly source_replay: true;
  readonly graphics_sources: true;
  readonly qualified_background: true;
  readonly exact_snoops: true;
  readonly rollback: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
export function mmc5PpuMemoryMaximumInput(
  path: string,
  facet?: "combined" | "pattern",
): Record<string, unknown>;
export function verifyMmc5PpuMemoryMaximumResult(
  result: unknown,
  bytes: Uint8Array,
  facet?: "combined" | "pattern",
): void;
