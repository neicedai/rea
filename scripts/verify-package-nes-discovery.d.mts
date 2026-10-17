export function verifyPackageNesDiscovery(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly rooted_cfg: true;
  readonly raw_context_identity: true;
  readonly mmc1_serial_context: true;
  readonly correlated_dispatch: true;
  readonly physical_coverage: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
