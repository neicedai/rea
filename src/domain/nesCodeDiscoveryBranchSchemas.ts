import { z } from "zod";

/** The condition belongs to this edge; its source value remains in its analysis. */
export const nesDiscoveryBranchConditionSchema = z.strictObject({
  flag: z.enum(["c", "z", "n", "v"]),
  value: z.boolean(),
});

export const nesDiscoveryBranchEdgeMetadata = {
  if: {
    properties: { kind: { enum: ["branch-taken", "branch-not-taken"] } },
    required: ["kind"],
  },
  // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema then is data, never a promise hook.
  then: {
    properties: {
      condition: { type: "object" },
      value_snapshot: { type: "integer", minimum: 0 },
      register_domains: { type: "object" },
      flag_predicates: { type: "object" },
    },
  },
  else: {
    properties: {
      condition: { type: "null" },
      value_snapshot: { type: "null" },
      register_domains: { type: "null" },
      flag_predicates: { type: "null" },
    },
  },
};
