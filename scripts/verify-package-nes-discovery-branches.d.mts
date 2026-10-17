export function verifyPackageNesDiscoveryBranches(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly known_flag_pruning: true;
  readonly conditioned_candidates: true;
  readonly join_reanalysis: true;
  readonly stack_call_flags: true;
  readonly banked_branches: true;
  readonly wrapped_targets: true;
  readonly budget_frontiers: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
