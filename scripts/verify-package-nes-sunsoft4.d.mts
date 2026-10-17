export function verifyPackageNesSunsoft4(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly banking: true;
  readonly ram_provenance: true;
  readonly rom_nametables: true;
  readonly unknown_mux: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
