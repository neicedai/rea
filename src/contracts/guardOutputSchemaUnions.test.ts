import { Ajv } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import { expect, it } from "vitest";
import { z } from "zod";
import { guardOutputSchemaUnions } from "./guardOutputSchemaUnions.js";
import { toolContract } from "./toolContracts.js";
import { toolOutputSchemaWithMetadata } from "./toolSchemaMetadata.js";

it.each(["draft-2020-12", "draft-07"] as const)(
  "preserves nullable facets, strict fields and the last array item under SDK validation in %s",
  (target) => {
    const values = z.array(z.number().int().min(1).max(8));
    const absent = z.strictObject({
      kind: z.literal("facet"),
      state: z.null(),
      values,
    });
    const present = z.strictObject({
      kind: z.literal("facet"),
      state: z.strictObject({ enabled: z.boolean() }),
      values,
    });
    const branch = z.union([absent, present]);
    const canonical = z.strictObject({
      before: branch,
      after: z.union([absent, present]),
    });
    const output = toolOutputSchemaWithMetadata({
      ...toolContract("binary_session"),
      outputSchema: canonical,
    })["~standard"].jsonSchema.output({ target });
    const sdk = new AjvJsonSchemaValidator().getValidator(output);
    const valid = {
      before: { kind: "facet", state: null, values: [1, 8] },
      after: {
        kind: "facet",
        state: { enabled: true },
        values: Array(64).fill(3),
      },
    };
    const variants = [
      valid,
      { ...valid, before: { ...valid.before, state: { enabled: false } } },
      { ...valid, before: { ...valid.before, state: "unknown" } },
      { ...valid, before: { ...valid.before, kind: "other" } },
      { ...valid, before: { kind: "facet", values: [1] } },
      { ...valid, before: { ...valid.before, unexpected: true } },
      {
        ...valid,
        after: { ...valid.after, values: [...Array(63).fill(3), 8.5] },
      },
      {
        ...valid,
        after: { ...valid.after, state: { enabled: true, unexpected: 1 } },
      },
    ];
    for (const value of variants)
      expect(sdk(value).valid).toBe(canonical.safeParse(value).success);
    expect(JSON.stringify(output)).toContain('"then":{"$ref":');
  },
);

it("preserves escaped pointer definitions and leaves inline branches and their descendant targets in place", () => {
  const schema = {
    $defs: {
      "a/b~c": {
        type: "object",
        properties: { value: { type: "integer", maximum: 8 } },
        required: ["value"],
        additionalProperties: false,
      },
      inline: {
        anyOf: [
          {
            type: "object",
            properties: { other: { type: "string", minLength: 3 } },
            required: ["other"],
            additionalProperties: false,
          },
        ],
      },
    },
    type: "object",
    properties: {
      selected: { anyOf: [{ $ref: "#/$defs/a~1b~0c" }] },
      name: { $ref: "#/$defs/inline/anyOf/0/properties/other" },
    },
    required: ["selected", "name"],
    additionalProperties: false,
  };
  const guarded = guardOutputSchemaUnions(schema, "draft-2020-12");
  expect(guarded).toHaveProperty(
    "properties.selected.anyOf.0.then.$ref",
    "#/$defs/a~1b~0c",
  );
  expect(guarded.$defs).toEqual(schema.$defs);
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const original = ajv.compile(schema),
    validate = ajv.compile(guarded);
  for (const value of [
    { selected: { value: 8 }, name: "abc" },
    { selected: { value: 9 }, name: "abc" },
    { selected: { value: 1 }, name: "ab" },
    { selected: { value: 1, unknown: 2 }, name: "abc" },
  ])
    expect(validate(value)).toBe(original(value));
});

it("does not reinterpret literal metadata or constant JSON as schema positions", () => {
  const literal = {
    $id: "caller data",
    anyOf: [{ $ref: "unresolved caller data" }],
  };
  const schema = {
    $defs: {
      empty: { type: "object", properties: {}, additionalProperties: false },
    },
    anyOf: [{ $ref: "#/$defs/empty" }],
    examples: [literal],
    default: literal,
    const: literal,
  };
  const guarded = guardOutputSchemaUnions(schema, "draft-2020-12");
  expect(guarded).toHaveProperty("anyOf.0.then.$ref", "#/$defs/empty");
  expect(guarded.examples).toBe(schema.examples);
  expect(guarded.default).toBe(literal);
  expect(guarded.const).toBe(literal);
  const empty = { ...schema };
  delete (empty as { const?: unknown }).const;
  const validate = new Ajv2020({ strict: false }).compile(
    guardOutputSchemaUnions(empty, "draft-2020-12"),
  );
  expect(validate({})).toBe(true);
  expect(validate({ unknown: 1 })).toBe(false);
});

it("retains sibling restrictions and evaluated-property annotations across a guarded reference", () => {
  const schema = {
    $defs: {
      mode: { enum: ["small", "large"] },
      base: {
        type: "object",
        properties: {
          mode: { $ref: "#/$defs/mode", const: "small" },
          amount: { type: "integer", minimum: 0, maximum: 10 },
        },
        required: ["mode", "amount"],
        additionalProperties: false,
      },
      constrained: {
        $ref: "#/$defs/base",
        properties: { amount: { maximum: 3 } },
      },
    },
    anyOf: [{ $ref: "#/$defs/constrained" }],
    unevaluatedProperties: false,
  };
  const guarded = guardOutputSchemaUnions(schema, "draft-2020-12");
  expect(guarded).toHaveProperty("anyOf.0.then.$ref", "#/$defs/constrained");
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const original = ajv.compile(schema),
    validate = ajv.compile(guarded);
  for (const value of [
    { mode: "small", amount: 3 },
    { mode: "small", amount: 4 },
    { mode: "large", amount: 1 },
    { mode: "small", amount: 1.5 },
    { mode: "small", amount: 2, unexpected: true },
  ])
    expect(validate(value)).toBe(original(value));
  expect(validate({ mode: "small", amount: 3 })).toBe(true);
  expect(validate({ mode: "small", amount: 4 })).toBe(false);
  expect(validate({ mode: "large", amount: 1 })).toBe(false);
});

it("preserves pattern properties, unresolved references and cycles without guessing shape", () => {
  const schema = {
    $defs: {
      patterns: {
        type: "object",
        properties: {},
        patternProperties: { "^known": { type: "integer" } },
        additionalProperties: false,
      },
      cycle: { $ref: "#/$defs/cycle" },
    },
    anyOf: [
      { $ref: "#/$defs/patterns" },
      { $ref: "#/$defs/cycle" },
      { $ref: "#/$defs/missing" },
      { $ref: "#/constructor" },
    ],
  };
  expect(guardOutputSchemaUnions(schema, "draft-2020-12")).toEqual(schema);
  const patterns = { ...schema, anyOf: [schema.anyOf[0]!] };
  const validate = new Ajv2020({ strict: false }).compile(
    guardOutputSchemaUnions(patterns, "draft-2020-12"),
  );
  expect(validate({ known_value: 3 })).toBe(true);
  expect(validate({ unknown: 3 })).toBe(false);
});

it("preserves a contentSchema resource base reached through an outer JSON Pointer", () => {
  const object = (side: string) => ({
    type: "object",
    properties: { side: { const: side } },
    required: ["side"],
    additionalProperties: false,
  });
  const schema = {
    $defs: { target: object("outer") },
    contentSchema: {
      $id: "https://example.test/content",
      $defs: { target: object("inner"), selected: { $ref: "#/$defs/target" } },
    },
    anyOf: [{ $ref: "#/contentSchema/$defs/selected" }],
  };
  const guarded = guardOutputSchemaUnions(schema, "draft-2020-12");
  expect(guarded).toBe(schema);
  const validate = new Ajv2020({ strict: false, allErrors: true }).compile(
    guarded,
  );
  expect(validate({ side: "inner" })).toBe(true);
  expect(validate({ side: "outer" })).toBe(false);
});

it.each([
  { $id: "https://example.test/root" },
  { $anchor: "local" },
  { $dynamicAnchor: "local" },
  { $recursiveAnchor: true },
  { $vocabulary: { "https://example.test/custom-vocabulary": true } },
  { $dynamicRef: "#local" },
  { $recursiveRef: "#" },
  { $ref: "child.json" },
  { $ref: "https://example.test/schema" },
  { $ref: "#/$defs/%ZZ" },
  { $ref: "#/$defs/~2" },
  { $schema: "http://json-schema.org/draft-04/schema#" },
])(
  "preserves schemas with distinct reference or dialect ownership: %j",
  (resource) => {
    const schema = {
      $defs: { resource },
      anyOf: [{ $ref: "#/$defs/resource" }],
    };
    expect(guardOutputSchemaUnions(schema, "draft-2020-12")).toBe(schema);
  },
);

it.each(["draft-04", "openapi-3.0"])(
  "leaves %s projections unchanged",
  (target) => {
    const schema = {
      $defs: {
        value: {
          type: "object",
          properties: { value: { type: "string" } },
          additionalProperties: false,
        },
      },
      anyOf: [{ $ref: "#/$defs/value" }],
    };
    expect(guardOutputSchemaUnions(schema, target)).toBe(schema);
  },
);

it("retains oneOf exclusivity and referenced primitive const/enum facts in draft-07", () => {
  const schema = {
    definitions: {
      kind: { const: "value" },
      mode: { enum: [null, "known"] },
      value: {
        type: "object",
        properties: {
          kind: { $ref: "#/definitions/kind" },
          mode: { $ref: "#/definitions/mode" },
        },
        required: ["kind", "mode"],
        additionalProperties: false,
      },
    },
    oneOf: [{ $ref: "#/definitions/value" }, { $ref: "#/definitions/value" }],
  };
  const guarded = guardOutputSchemaUnions(schema, "draft-07");
  const validate = new Ajv({ strict: false, allErrors: true }).compile(guarded);
  expect(validate({ kind: "value", mode: null })).toBe(false);
  expect(validate({ kind: "other", mode: "known" })).toBe(false);
});
