import { z } from "zod";
import { nesDiscoveryRegisterSchema } from "./nesCodeDiscoveryPartitionSchemas.js";
import { nesDiscoveryValueVariableSchema } from "./nesCodeDiscoveryValueSchemas.js";

const index = z.number().int().nonnegative();
const byte = z.number().int().min(0).max(255);
const witnesses = z.array(index).min(1).meta({ uniqueItems: true });
const registers = z
  .array(nesDiscoveryRegisterSchema)
  .max(4)
  .meta({ uniqueItems: true })
  .describe(
    "CPU members of the current value group in canonical A, X, Y, SP order. This projection is empty when only RAM retains the subject value.",
  );

/** A fixed 256-bit set preserves nonconvex byte alternatives without expanding paths. */
export const nesDiscoveryByteDomainSchema = z.strictObject({
  index,
  bitmap_hex: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .regex(/[a-f1-9]/u)
    .describe(
      "A 256-bit unsigned hexadecimal bitmap, padded to 64 digits. Bit v, counted from the least significant bit, admits byte value v. Empty sets are infeasible and are never retained.",
    ),
  count: z.number().int().min(1).max(256),
});
export const nesDiscoveryRegisterDomainsSchema = z.strictObject({
  a: index,
  x: index,
  y: index,
  sp: index,
});
const predicateFields = {
  carrier_variable: nesDiscoveryValueVariableSchema,
  registers,
  source_witness_indices: witnesses,
};
const comparison = z.strictObject({
  ...predicateFields,
  kind: z.literal("compare"),
  operand: byte,
});
const result = z.strictObject({
  ...predicateFields,
  kind: z.literal("result"),
  operand: z.null(),
});
const predicate = z.discriminatedUnion("kind", [comparison, result]);
export const nesDiscoveryFlagPredicatesSchema = z
  .strictObject({
    c: comparison.nullable(),
    z: predicate.nullable(),
    n: predicate.nullable(),
  })
  .describe(
    "Live relations between each status flag and a current CPU/RAM value group. Compare C means v >= operand, Z means v == operand and N is bit 7 of (v - operand) modulo 256. Result Z means v == 0 and N is bit 7 of v. Each slot is independent; a relation survives while any current variable retains its subject value.",
  );
const sourceFields = {
  index,
  node_index: index,
  register: nesDiscoveryRegisterSchema,
  analysis_indices: witnesses,
};
export const nesDiscoveryFlagPredicateSourceSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      ...sourceFields,
      kind: z.literal("result"),
      operand: z.null(),
    }),
    z.strictObject({
      ...sourceFields,
      kind: z.literal("compare"),
      operand: byte,
    }),
  ],
);
