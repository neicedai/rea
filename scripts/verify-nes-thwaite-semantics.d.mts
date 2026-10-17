export const THWAITE_SEMANTIC_PROFILE: Readonly<{
  version: string;
  source_commit: string;
  source_url: string;
  source_binary_bit_identical_build: "unknown";
  rom_sha256: string;
  rom_size: number;
  dispatch_address: number;
  dispatch_offset: number;
  dispatch_hex: string;
  table_address: number;
  table_offset: number;
  table_hex: string;
  levels_address: number;
  levels_offset: number;
  levels_size: number;
  levels_sha256: string;
  known_branch_entry: number;
  known_branch_offset: number;
  known_branch_hex: string;
  ram_reread_entry: number;
  ram_reread_offset: number;
  ram_reread_hex: string;
}>;
export function verifyNesThwaiteSemantics(
  invoke: (command: string, input: Record<string, unknown>) => Promise<unknown>,
  romPath: string,
): Promise<{
  readonly ok: true;
  readonly workflows: 3;
  readonly profile: typeof THWAITE_SEMANTIC_PROFILE;
  readonly evidence_id: string;
  readonly selector_domain: 128;
  readonly verified_source_handlers: readonly {
    state: number;
    selector: number;
    source_label: string;
    target: number;
    file_offset: number;
  }[];
  readonly level_records: 35;
  readonly known_branch: {
    readonly evidence_id: string;
    readonly entry: number;
    readonly branch_address: number;
    readonly target: number;
    readonly condition: { readonly flag: "c"; readonly value: false };
    readonly source: string;
    readonly termination: string;
    readonly pending_target: number;
  };
  readonly ram_reread: {
    readonly evidence_id: string;
    readonly entry: number;
    readonly branch_address: number;
    readonly reread_address: number;
    readonly ram_address: number;
    readonly admitted_values: number;
    readonly independent_write_address: number;
    readonly initial_unwritten_possible: true;
    readonly fabricated_initial_writers: false;
    readonly source: string;
    readonly termination: string;
    readonly work_items_processed: number;
  };
  readonly termination: string;
  readonly work_items_processed: number;
  readonly pending_items: number;
  readonly original_unchanged: true;
  readonly scope: string;
}>;
