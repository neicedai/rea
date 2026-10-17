export function verifyPackageNesIrem78(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly bus_conflicts: true;
  readonly variant_mirroring: true;
  readonly selector_uncertainty: true;
  readonly source_continuation: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
