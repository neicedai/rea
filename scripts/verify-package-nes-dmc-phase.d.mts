export function verifyPackageNesDmcPhase(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly put_reload: true;
  readonly late_discard: true;
  readonly oam_tail: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
