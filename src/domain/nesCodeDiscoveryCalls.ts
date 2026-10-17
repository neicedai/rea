import { z } from "zod";
import { nesCpuStateSchema } from "./nesCodeTrace.js";
import { nesByteValueSchema } from "./nesByteValue.js";
import { nesDiscoveryRelativeSnapshotSchema } from "./nesCodeDiscoveryRelativeSchemas.js";
import { nesDiscoveryRegisterRelationsSchema } from "./nesCodeDiscoveryPartitionSchemas.js";
import {
  nesDiscoveryRegisterDomainsSchema,
  nesDiscoveryFlagPredicatesSchema,
} from "./nesCodeDiscoveryDomainSchemas.js";

const index = z.number().int().nonnegative();
const address = z.number().int().min(0).max(65535);
const byte = z.number().int().min(0).max(255);

/** Relative offsets qualify an opaque frame without inventing physical RAM bytes. */
export const nesDiscoveryFrameSchema = z.strictObject({
  kind: z.enum(["root", "physical", "opaque"]),
  entry_sp: byte.nullable(),
  relative_sp: byte.nullable(),
  footprint_hex: z.string().regex(/^[a-f0-9]{64}$/u),
  intact: z.boolean(),
});
export const nesDiscoveryRamSnapshotSchema = z
  .array(index.nullable())
  .length(64);
export const nesDiscoveryInvocationSchema = z.strictObject({
  index,
  entry_address: address,
  entry_context_index: index,
  cpu_in: nesCpuStateSchema,
  value_snapshot: index,
  register_relations: nesDiscoveryRegisterRelationsSchema,
  register_domains: nesDiscoveryRegisterDomainsSchema,
  flag_predicates: nesDiscoveryFlagPredicatesSchema,
  ram_in: nesDiscoveryRamSnapshotSchema,
  relative_stack_in: nesDiscoveryRelativeSnapshotSchema,
  frame: nesDiscoveryFrameSchema,
});
export const nesDiscoveryContinuationSchema = z.strictObject({
  index,
  caller_invocation_index: index,
  caller_partition_index: index,
  callee_invocation_index: index,
  call_node_index: index,
  call_analysis_indices: z.array(index).min(1),
  return_address: address,
});
const returnSummaryFields = {
  index,
  invocation_index: index,
  partition_index: index,
  return_node_index: index,
  return_analysis_index: index,
  context_index: index,
  cpu_out: nesCpuStateSchema,
  value_snapshot: index,
  register_relations: nesDiscoveryRegisterRelationsSchema,
  register_domains: nesDiscoveryRegisterDomainsSchema,
  flag_predicates: nesDiscoveryFlagPredicatesSchema,
  ram_out: nesDiscoveryRamSnapshotSchema,
  relative_stack_out: nesDiscoveryRelativeSnapshotSchema,
  frame: nesDiscoveryFrameSchema,
};
export const nesDiscoveryReturnSummarySchema = z.discriminatedUnion(
  "return_proof",
  [
    z.strictObject({
      ...returnSummaryFields,
      return_proof: z.literal("physical-bytes"),
      stack_target: address,
    }),
    z.strictObject({
      ...returnSummaryFields,
      return_proof: z.literal("relative-bytes"),
      stack_target: address,
    }),
    z.strictObject({
      ...returnSummaryFields,
      return_proof: z.literal("opaque-token"),
      stack_target: z.null(),
    }),
  ],
);
export const nesDiscoveryWriteWitnessSchema = z.strictObject({
  index,
  node_index: index,
  address: z.number().int().min(0).max(2047),
  value: nesByteValueSchema,
  domain_index: index,
  analysis_indices: z.array(index).min(1),
});
export const nesDiscoveryRamPageSchema = z.strictObject({
  index,
  cells: z
    .array(
      z.strictObject({
        offset: z.number().int().min(0).max(31),
        value: nesByteValueSchema,
        writer_witness_indices: z.array(index),
        initial_unwritten_possible: z.boolean(),
        unknown_write_possible: z.boolean(),
      }),
    )
    .max(32),
});
