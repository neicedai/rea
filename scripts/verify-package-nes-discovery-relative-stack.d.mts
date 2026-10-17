export function verifyPackageNesDiscoveryRelativeStack(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly relative_byte_targets: true;
  readonly matched_relative_returns: true;
  readonly partial_stack_bits: true;
  readonly stack_ring_coverage: true;
  readonly alias_frontiers: true;
  readonly physical_regression: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
