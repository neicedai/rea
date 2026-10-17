import { z } from "zod";

const index = z.number().int().nonnegative();
const variable = z.number().int().min(0).max(2051);
const witnesses = z.array(index).meta({ uniqueItems: true });

/** CPU registers precede the 2 KiB of canonical, mirrored internal RAM. */
export const nesDiscoveryValueVariableSchema = variable.describe(
  "Current byte variable: A=0, X=1, Y=2, SP=3, or 4 plus a canonical internal RAM address (0..2047). Equal numeric values alone do not establish a copy relationship.",
);
export const nesDiscoveryValuePageSchema = z.strictObject({
  index,
  entries: z
    .array(
      z.strictObject({
        offset: z.number().int().min(0).max(31),
        leader: nesDiscoveryValueVariableSchema,
        domain_index: index,
        condition_witness_indices: witnesses,
      }),
    )
    .min(1)
    .max(32),
});
export const nesDiscoveryValueSnapshotSchema = z.strictObject({
  index,
  pages: z
    .array(index.nullable())
    .length(65)
    .describe(
      "A sparse snapshot of 2052 current byte variables, with 32 variables per page and four in the last page. An omitted entry is an unconstrained singleton. A group uses its least variable as leader; only that leader retains conditional proof references.",
    ),
  ram_pages: z
    .array(index.nullable())
    .length(64)
    .describe(
      "RAM provenance at this same value snapshot. These page references preserve actual writes and the possibility of an initial unwritten byte separately from conditional value proofs.",
    ),
});

const conditionFields = {
  index,
  node_index: index,
  variable: nesDiscoveryValueVariableSchema,
  source_domain_index: index,
  result_domain_index: index,
  analysis_indices: z.array(index).min(1).meta({ uniqueItems: true }),
};
export const nesDiscoveryConditionWitnessSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...conditionFields,
    kind: z.literal("branch"),
    flag: z.enum(["c", "z", "n"]),
    value: z.boolean(),
  }),
  z.strictObject({
    ...conditionFields,
    kind: z.literal("index"),
    variable: z.union([z.literal(1), z.literal(2)]),
    value: z.number().int().min(0).max(255),
  }),
  z.strictObject({
    ...conditionFields,
    kind: z.literal("stack-alias"),
    variable: z.number().int().min(4).max(2051),
    relative_offset: z.number().int().min(0).max(255),
  }),
]);
