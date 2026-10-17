export function verifyPackageNesSunsoft3(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly banking: true;
  readonly ram_provenance: true;
  readonly irq_continuation: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
