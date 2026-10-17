import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";

const index = z.number().int().nonnegative();
const offset = z.number().int().min(0).max(255);

/** Logical offsets are relative to the current SP; they are not RAM addresses. */
export const nesDiscoveryRelativeSnapshotSchema = z
  .array(index.nullable())
  .length(8);
export const nesDiscoveryRelativeOriginSchema = z.strictObject({
  offset,
  writer_nodes: z.array(index),
  writer_witness_indices: z.array(index).min(1),
});
export const nesDiscoveryRelativeWriteWitnessSchema = z.strictObject({
  index,
  node_index: index,
  offset,
  value: nesByteValueSchema,
  domain_index: index,
  analysis_indices: z.array(index).min(1),
});
export const nesDiscoveryRelativePageSchema = z.strictObject({
  index,
  cells: z
    .array(
      z.strictObject({
        offset: z.number().int().min(0).max(31),
        value: nesByteValueSchema,
        domain_index: index,
        writer_witness_indices: z.array(index).min(1),
      }),
    )
    .max(32),
});
