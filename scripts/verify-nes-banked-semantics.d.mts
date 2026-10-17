export interface BankedSemanticProfile {
  readonly name: string;
  readonly kind: string;
  readonly version: string;
  readonly source_url: string;
  readonly source_commit: string;
  readonly source_binary_bit_identical_build: "unknown";
  readonly rom_sha256: string;
  readonly rom_size: number;
  readonly header_hex: string;
  readonly [key: string]: unknown;
}
export type BankedSemanticInvoke = (
  command: string,
  input: Record<string, unknown>,
) => Promise<unknown>;
export interface BankedSemanticResult {
  readonly ok: true;
  readonly workflows: number;
  readonly requested_path: string;
  readonly profile: BankedSemanticProfile;
  readonly evidence_ids: readonly string[];
  readonly original_unchanged: true;
  readonly scope: string;
}
export function verifyNesNovaSemantics(
  invoke: BankedSemanticInvoke,
  path: string,
): Promise<
  BankedSemanticResult & {
    readonly bank6_original_fetch: true;
    readonly serial_control: true;
    readonly nvram_capacity: 32768;
    readonly ram_bank_isolation: readonly [0, 3];
    readonly ram_permission_qualification: true;
    readonly ram_query_assumptions: readonly {
      bank: number;
      address: number;
      value: number;
    }[];
  }
>;
export function verifyNesMmc3DemoSemantics(
  invoke: BankedSemanticInvoke,
  path: string,
): Promise<
  BankedSemanticResult & {
    readonly original_dual_windows: true;
    readonly known_setter_branch: true;
    readonly complete_chr_blocks: readonly ["Alpha.chr", "Gears.chr"];
    readonly examined_chr_tiles: 1024;
  }
>;
