export function mmc5FrozenBackgroundFixture(): Uint8Array;
export function mmc5FrozenBackgroundMaximumInput(
  path: string,
): Record<string, unknown>;
export function verifyMmc5FrozenBackgroundMaximumResult(
  result: unknown,
  bytes: Uint8Array,
): void;
export function verifyPackageNesMmc5FrozenBackground(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly per_cell: true;
  readonly split_geometry: true;
  readonly correlated_pixels: true;
  readonly source_replay: true;
  readonly frozen_state: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
