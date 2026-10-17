import { Ajv2020 } from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import { expect } from "vitest";
import { z } from "zod";

const metaValidator = new Ajv2020({ strict: false, validateFormats: false });
const validatedSchemas = new Set<string>();
const compiledValidators = new Map<string, ValidateFunction<unknown>>();
const schemaRecord = z.record(z.string(), z.unknown());

/** Check the advertised dialect once per exact schema, without registering its IDs. */
export function assertValidAdvertisedSchema(schema: unknown, label: string) {
  const record = schemaRecord.parse(schema);
  const serialized = JSON.stringify(record);
  if (!validatedSchemas.has(serialized)) {
    expect(
      metaValidator.validateSchema(record),
      `${label}: ${metaValidator.errorsText()}`,
    ).toBe(true);
    validatedSchemas.add(serialized);
  }
  return { record, serialized };
}

/** Reuse exact schemas; independent registries preserve distinct reference bases and IDs. */
export function compileAdvertisedSchema(schema: unknown, label: string) {
  const { record, serialized } = assertValidAdvertisedSchema(schema, label);
  const cached = compiledValidators.get(serialized);
  if (cached !== undefined) return cached;
  const validate = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile<unknown>(record);
  compiledValidators.set(serialized, validate);
  return validate;
}
