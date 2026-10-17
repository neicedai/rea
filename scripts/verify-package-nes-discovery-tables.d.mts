export function verifyPackageNesDiscoveryTables(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly correlated_tables: true;
  readonly complete_byte_domain: true;
  readonly serial_contexts: true;
  readonly wrapped_pointers: true;
  readonly computed_returns: true;
  readonly partition_budgets: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
