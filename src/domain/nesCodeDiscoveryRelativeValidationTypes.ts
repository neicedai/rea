import type { z } from "zod";
import type { NesByteValue } from "./nesByteValue.js";
import type { NesDiscoveryDomainPool } from "./nesCodeDiscoveryDomainFacts.js";
import type { NesDiscoveryValueFactPools } from "./nesCodeDiscoveryValueFacts.js";
import type {
  nesDiscoveryRelativeWriteWitnessSchema,
  nesDiscoveryRelativePageSchema,
  nesDiscoveryRelativeOriginSchema,
} from "./nesCodeDiscoveryRelativeSchemas.js";
import type { nesDiscoveryReturnSummarySchema } from "./nesCodeDiscoveryCalls.js";

export type Witness = z.infer<typeof nesDiscoveryRelativeWriteWitnessSchema>;
export type Page = z.infer<typeof nesDiscoveryRelativePageSchema>;
export type Origin = z.infer<typeof nesDiscoveryRelativeOriginSchema>;
export type Summary = z.infer<typeof nesDiscoveryReturnSummarySchema>;
export type Reference = {
  node_index: number;
  analysis_index: number;
  kind: string;
  address: number | null;
  value: NesByteValue;
  file_offsets: number[];
  relative_stack_origins: Origin[];
  ram_origins: {
    ram_address: number;
    writer_witness_indices: number[];
    domain_index: number;
  }[];
};
export type Analysis = {
  node_index: number;
  cpu_in: { sp: number | null };
  cpu_out: { sp: number | null };
  value_snapshot_in: number;
  relative_stack_in: (number | null)[];
  relative_stack_out: (number | null)[];
};
export type Graph = NesDiscoveryValueFactPools & {
  nodes: { index: number; mnemonic: string }[];
  analyses: Analysis[];
  invocations: { relative_stack_in: (number | null)[] }[];
  return_summaries: Summary[];
  write_witnesses: { address: number }[];
  relative_stack_write_witnesses: Witness[];
  relative_stack_pages: Page[];
  data_references: Reference[];
  byte_domains: NesDiscoveryDomainPool;
};
