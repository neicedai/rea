export function verifyPackageNesVrc6PpuMemory(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly captured_memory: true;
  readonly cpu_buffer: true;
  readonly unknown_backing: true;
  readonly graphics_sources: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
export function vrc6PpuMemoryMaximumInput(
  path: string,
  facet?: "pattern" | "sprites" | "viewport" | "combined",
): Record<string, unknown>;
export function verifyVrc6PpuMemoryMaximumResult(
  result: unknown,
  bytes: Uint8Array,
  facet?: "pattern" | "sprites" | "viewport" | "combined",
): void;
export function vrc6PpuMemoryFixture(mapper: 24 | 26): Uint8Array;
