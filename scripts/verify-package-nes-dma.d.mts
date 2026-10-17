export function verifyPackageNesDma(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  workspace: string,
): Promise<{
  readonly ok: true;
  readonly workflows: number;
  readonly phases: number;
  readonly dma_cycles: number[];
  readonly raw_reads: number;
  readonly puts: number;
  readonly source_replay: true;
  readonly partial_budget: true;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
