export function verifyPackageNesDiscoveryReturns(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly matched_returns: true;
  readonly correlated_callers: true;
  readonly stack_qualification: true;
  readonly recursive_fixedpoint: true;
  readonly return_budgets: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
