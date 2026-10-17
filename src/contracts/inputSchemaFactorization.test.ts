import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import { toolContract } from "./toolContracts.js";
import {
  advertisedReferenceExpansionBudget,
  countLocalReferenceExpansions,
} from "./inputSchemaPresentation.js";
import { toolInputSchemaWithMetadata } from "./toolSchemaMetadata.js";

const requests = [
  ["trace_nes_code", { path: "/fixture.nes", initial: { mapper: 32 } }],
  ["explore_nes_code", { path: "/fixture.nes", initial: { mapper: 32 } }],
  ["discover_nes_code", { path: "/fixture.nes", initial: { mapper: 32 } }],
  [
    "trace_nes_mapper_events",
    { path: "/fixture.nes", initial: { mapper: 32 }, events: [] },
  ],
  [
    "trace_nes_mapper_writes",
    { path: "/fixture.nes", initial: { mapper: 32 }, writes: [] },
  ],
] as const;

const cases = (["draft-07", "draft-2020-12"] as const).flatMap((target) =>
  requests.map(([name, input]) => ({ target, name, input })),
);

it.each(cases)(
  "invokes the complete $name input validator within the reference budget ($target)",
  ({ target, name, input }) => {
    const ajv =
      target === "draft-07"
        ? new Ajv({ strict: false, validateFormats: false })
        : new Ajv2020({ strict: false, validateFormats: false });
    const contract = toolContract(name);
    expect(contract.inputSchema.safeParse(input).success, name).toBe(true);
    const schema = toolInputSchemaWithMetadata(contract)[
      "~standard"
    ].jsonSchema.input({ target });
    expect(schema).toHaveProperty(
      target === "draft-07" ? "definitions" : "$defs",
    );
    expect(countLocalReferenceExpansions(schema)).toBeLessThanOrEqual(
      advertisedReferenceExpansionBudget,
    );
    expect(ajv.validateSchema(schema), ajv.errorsText()).toBe(true);
    const validate = ajv.compile(schema);
    for (const value of [
      input,
      { ...input, path: "" },
      { ...input, initial: { ...input.initial, extra: true } },
      { ...input, initial: undefined },
    ])
      expect(validate(value), JSON.stringify(validate.errors)).toBe(
        contract.inputSchema.safeParse(value).success,
      );
  },
  60_000,
);
