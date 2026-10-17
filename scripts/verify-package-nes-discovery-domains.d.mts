export function verifyPackageNesDiscoveryDomains(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly exact_ranges: true;
  readonly wrapped_compare_negative: true;
  readonly result_predicates: true;
  readonly independent_flag_sources: true;
  readonly semantic_copies: true;
  readonly nonconvex_joins: true;
  readonly call_domain_effects: true;
  readonly banked_domain_effects: true;
  readonly budget_frontiers: true;
  readonly correlated_rotations: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
