export function verifyPackageNesEarlyMappers(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly mappers: readonly [76, 87];
  readonly banking: true;
  readonly selector_uncertainty: true;
  readonly no_cartridge_ram: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
