import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";
import {
  isNesRegisterRelations,
  nesRegisterRelationMasks,
} from "./nesCodeDiscoveryRegisterRelations.js";

const index = z.number().int().nonnegative();
const byte = z.number().int().min(0).max(255);
const compatibleSelectionMetadata = Array.from({ length: 8 }, (_, bit) => {
  const set = Array.from({ length: 256 }, (_, value) => value).filter(
    (value) => (value & (1 << bit)) !== 0,
  );
  const unset = Array.from({ length: 256 }, (_, value) => value).filter(
    (value) => (value & (1 << bit)) === 0,
  );
  return [set, unset].map((values) => ({
    if: {
      properties: {
        source_value: {
          type: "object",
          properties: { mask: { enum: set }, value: { enum: values } },
          required: ["mask", "value"],
        },
      },
      required: ["source_value"],
    },
    // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema then is data, never a promise hook.
    then: { properties: { value: { enum: values } } },
  }));
}).flat();
export const nesDiscoveryRegisterSchema = z.enum(["a", "x", "y", "sp"]);
export const nesDiscoveryIndexRegisterSchema = z.enum(["x", "y"]);
export const nesDiscoveryRegisterRelationsSchema = z
  .number()
  .int()
  .min(0)
  .max(63)
  .refine(isNesRegisterRelations)
  .meta({ enum: [...nesRegisterRelationMasks] })
  .describe(
    "Derived must-equal CPU byte relations. Bits encode A-X, A-Y, A-SP, X-Y, X-SP and Y-SP; zero makes no equality claim. This is a canonical equivalence relation, not equality inferred from matching unknown bit envelopes.",
  );
export const nesDiscoveryPartitionSchema = z.strictObject({
  index,
  selections: z.array(
    z.strictObject({
      node_index: index,
      register: nesDiscoveryIndexRegisterSchema,
      value: byte,
    }),
  ),
});
export const nesDiscoveryRefinementSchema = z
  .strictObject({
    register: nesDiscoveryIndexRegisterSchema,
    source_value: nesByteValueSchema,
    source_domain_index: index,
    value: byte,
    equal_registers: z
      .array(nesDiscoveryRegisterSchema)
      .min(1)
      .max(4)
      .refine((values) => new Set(values).size === values.length)
      .meta({ uniqueItems: true }),
  })
  .meta({ allOf: compatibleSelectionMetadata });
export const nesDiscoveryPendingRefinementSchema = z.strictObject({
  invocation_index: index,
  context_index: index,
  address: z.number().int().min(0).max(65535),
  node_index: index,
  partition_index: index,
  register: nesDiscoveryIndexRegisterSchema,
  source_value: nesByteValueSchema,
  source_domain_index: index,
  next_value: byte,
});
