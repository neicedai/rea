export function verifyPackageNesReviewFixes(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: 4;
  readonly supplied_writes: 16644;
  readonly complete_fme7_views: 8193;
  readonly complete_event_views: true;
  readonly oam_budget_views: true;
  readonly dmc_budget_views: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
