import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./inputSchemaPresentation.js";

type Schema = Record<string, unknown>;
const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const types = new Set([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const resourceKeys = new Set([
  "$id",
  "$anchor",
  "$dynamicAnchor",
  "$dynamicRef",
  "$recursiveAnchor",
  "$recursiveRef",
  "$vocabulary",
]);

/** Visit schema positions only; annotations and literal JSON remain opaque. */
const mapSchemas = (
  value: unknown,
  replace: (schema: Schema) => Schema,
): unknown => {
  if (!isSchema(value)) return value;
  const output: Schema = {};
  for (const [key, child] of Object.entries(value)) {
    if (schemaMaps.has(key) && isSchema(child))
      output[key] = Object.fromEntries(
        Object.entries(child).map(([name, schema]) => [
          name,
          mapSchemas(schema, replace),
        ]),
      );
    else if (schemaArrays.has(key) && Array.isArray(child))
      output[key] = child.map((schema) => mapSchemas(schema, replace));
    else if (schemaChildren.has(key))
      output[key] = Array.isArray(child)
        ? child.map((schema) => mapSchemas(schema, replace))
        : mapSchemas(child, replace);
    else
      Object.defineProperty(output, key, {
        value: child,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  }
  return replace(output);
};

const pointer = (reference: string): readonly string[] | null => {
  if (reference === "#") return [];
  if (!reference.startsWith("#/")) return null;
  let fragment: string;
  try {
    fragment = decodeURIComponent(reference.slice(2));
  } catch {
    return null;
  }
  const tokens = fragment.split("/");
  if (tokens.some((token) => /~(?:[^01]|$)/u.test(token))) return null;
  return tokens.map((token) =>
    token.replaceAll("~1", "/").replaceAll("~0", "~"),
  );
};

const resolve = (root: Schema, value: unknown): Schema | null => {
  const visited = new Set<object>();
  while (isSchema(value) && typeof value.$ref === "string") {
    if (visited.has(value)) return null;
    visited.add(value);
    const tokens = pointer(value.$ref);
    if (tokens === null) return null;
    let selected: unknown = root;
    for (const token of tokens) {
      if (
        (!isSchema(selected) && !Array.isArray(selected)) ||
        !Object.hasOwn(selected, token)
      )
        return null;
      selected = Reflect.get(selected, token);
    }
    value = selected;
  }
  return isSchema(value) ? value : null;
};

const primitive = (value: unknown): boolean =>
  value === null || ["string", "boolean", "number"].includes(typeof value);

const propertyShape = (root: Schema, property: unknown): Schema | null => {
  const declaration = resolve(root, property);
  if (declaration === null) return null;
  if (Object.hasOwn(declaration, "const") && primitive(declaration.const))
    return { const: declaration.const };
  if (Array.isArray(declaration.enum) && declaration.enum.every(primitive))
    return { enum: declaration.enum };
  return typeof declaration.type === "string" && types.has(declaration.type)
    ? { type: declaration.type }
    : null;
};

const shape = (root: Schema, member: unknown): Schema | null => {
  // A pure reference arm can move under then without moving its definition or
  // any nested schema addressed by an existing JSON Pointer. Inline arms stay.
  if (
    !isSchema(member) ||
    Object.keys(member).length !== 1 ||
    typeof member.$ref !== "string"
  )
    return null;
  const schema = resolve(root, member);
  if (
    schema === null ||
    schema.type !== "object" ||
    schema.additionalProperties !== false ||
    !isSchema(schema.properties) ||
    Object.hasOwn(schema, "patternProperties")
  )
    return null;
  if (
    schema.required !== undefined &&
    (!Array.isArray(schema.required) ||
      !schema.required.every((key) => typeof key === "string"))
  )
    return null;
  const properties: Schema = {};
  for (const [name, property] of Object.entries(schema.properties)) {
    const needed = propertyShape(root, property);
    if (needed !== null)
      Object.defineProperty(properties, name, {
        value: needed,
        enumerable: true,
      });
  }
  return {
    type: "object",
    required: schema.required ?? [],
    propertyNames:
      Object.keys(schema.properties).length === 0
        ? false
        : { enum: Object.keys(schema.properties) },
    ...(Object.keys(properties).length === 0 ? {} : { properties }),
  };
};

/** Preserve complete union validation while cheaply excluding impossible shapes. */
export const guardOutputSchemaUnions = (
  schema: Schema,
  target: string,
): Schema => {
  if (!["draft-2020-12", "draft-07"].includes(target)) return schema;
  const dialect =
    target === "draft-2020-12"
      ? "https://json-schema.org/draft/2020-12/schema"
      : "http://json-schema.org/draft-07/schema#";
  let scoped = false;
  mapSchemas(schema, (node) => {
    if (
      Object.keys(node).some((key) => resourceKeys.has(key)) ||
      (node.$schema !== undefined && node.$schema !== dialect) ||
      (typeof node.$ref === "string" && pointer(node.$ref) === null)
    )
      scoped = true;
    return node;
  });
  // Resource bases, dynamic anchors, nonlocal references and custom vocabularies
  // require their own resolver. Preserve their ownership without guessing.
  if (scoped) return schema;
  return mapSchemas(schema, (node) => {
    for (const key of ["anyOf", "oneOf"])
      if (Array.isArray(node[key]))
        node[key] = node[key].map((member: unknown) => {
          const necessary = shape(schema, member);
          if (necessary === null) return member;
          // oxlint-disable-next-line unicorn/no-thenable -- JSON Schema then is a schema, never a callable promise hook.
          return { if: necessary, then: member, else: false };
        });
    return node;
  }) as Schema;
};
