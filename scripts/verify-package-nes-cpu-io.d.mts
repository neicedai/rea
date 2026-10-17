export function verifyPackageNesCpuIo(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly composite_reads: number;
  readonly io_profiles: number;
  readonly byte_sources: true;
  readonly atomic_budget: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
