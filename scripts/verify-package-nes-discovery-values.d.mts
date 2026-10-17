export function verifyPackageNesDiscoveryValues(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly stable_ram_recursion: true;
  readonly mirrored_current_aliases: true;
  readonly ram_only_predicates: true;
  readonly nonconvex_stores: true;
  readonly independent_equal_values: true;
  readonly relative_and_physical_stack_domains: true;
  readonly independent_io_reads: true;
  readonly matched_call_ram_effects: true;
  readonly unknown_store_invalidation: true;
  readonly joined_initial_and_writer_sources: true;
  readonly value_state_budget: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
