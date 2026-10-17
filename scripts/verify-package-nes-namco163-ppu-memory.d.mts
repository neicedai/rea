export function verifyPackageNesNamco163PpuMemory(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly shared_ciram: true;
  readonly cpu_buffer: true;
  readonly unknown_backing: true;
  readonly graphics_sources: true;
  readonly debug_uncertainty: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
export function namco163PpuMemoryMaximumInput(
  path: string,
  facet?: "nametable" | "pattern" | "sprites" | "viewport" | "combined",
): Record<string, unknown>;
export function verifyNamco163PpuMemoryMaximumResult(
  result: unknown,
  bytes: Uint8Array,
  facet?: "nametable" | "pattern" | "sprites" | "viewport" | "combined",
): void;
export function namco163PpuMemoryFixture(): Uint8Array;
