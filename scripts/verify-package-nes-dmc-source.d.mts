export function verifyPackageNesDmcSource(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly inline_reload: true;
  readonly oam_priority: true;
  readonly contended_sample_provenance: true;
  readonly continuation: true;
  readonly atomic_budget: true;
  readonly explicit_stop: true;
  readonly aborted_and_discarded: true;
  readonly implicit_stop: true;
  readonly duplicate_burst: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
