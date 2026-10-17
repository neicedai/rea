export function verifyPackageNesDmc(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly regions: number;
  readonly mapper_sources: true;
  readonly continuation: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
