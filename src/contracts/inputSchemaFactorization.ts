import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "./inputSchemaPresentation.js";

type Schema = Record<string, unknown>;
type Parent = Schema | unknown[];
interface Node {
  readonly schema: Schema;
  readonly parent: Parent | undefined;
  readonly key: string;
  readonly cost: number;
}
const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const resourceKeys = new Set([
  "$defs",
  "definitions",
  "$ref",
  "$id",
  "$anchor",
  "$dynamicRef",
  "$dynamicAnchor",
  "$recursiveRef",
  "$recursiveAnchor",
]);

/** Visit only schema positions; examples and literal caller values stay opaque. */
const children = (schema: Schema): [Parent, string, Schema][] => {
  const found: [Parent, string, Schema][] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (schemaMaps.has(key) && isSchema(value)) {
      for (const [name, child] of Object.entries(value))
        if (isSchema(child)) found.push([value, name, child]);
    } else if (schemaArrays.has(key) && Array.isArray(value)) {
      value.forEach((child, index) => {
        if (isSchema(child)) found.push([value, String(index), child]);
      });
    } else if (schemaChildren.has(key)) {
      if (isSchema(value)) found.push([schema, key, value]);
      else if (Array.isArray(value))
        value.forEach((child, index) => {
          if (isSchema(child)) found.push([value, String(index), child]);
        });
    }
  }
  return found;
};

const assign = (parent: Parent, key: string, value: unknown): void => {
  Object.defineProperty(parent, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

const collect = (
  schema: Schema,
  parent?: Parent,
  key = "",
  nodes: Node[] = [],
): number => {
  let cost = 1;
  for (const [container, name, child] of children(schema))
    cost += collect(child, container, name, nodes);
  nodes.push({ schema, parent, key, cost });
  return cost;
};

const clone = (schema: Schema): Schema => {
  const copied = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (schemaMaps.has(key) && isSchema(value))
        return [
          key,
          Object.fromEntries(
            Object.entries(value).map(([name, child]) => [
              name,
              isSchema(child) ? clone(child) : child,
            ]),
          ),
        ];
      if (
        (schemaArrays.has(key) || schemaChildren.has(key)) &&
        Array.isArray(value)
      )
        return [
          key,
          value.map((child) => (isSchema(child) ? clone(child) : child)),
        ];
      if (schemaChildren.has(key) && isSchema(value))
        return [key, clone(value)];
      return [key, value];
    }),
  );
  return copied;
};

// This is a representation trigger, not an input admission limit. A fully
// inlined NES input makes default AJV generate a single function with tens of
// thousands of locals, exceeding V8's stack on invocation. Split large programs
// into balanced, semantically identical schema resources instead.
const inlineValidationNodeTarget = 4096;

/** Bound generated validator stack frames while keeping the client reference budget. */
export const factorInputJsonSchema = (
  schema: Schema,
  referenceBudget: number,
  target: string,
): Schema => {
  const original: Node[] = [];
  const cost = collect(schema, undefined, "", original);
  if (
    cost <= inlineValidationNodeTarget ||
    referenceBudget < 2 ||
    original.some(({ schema: node }) =>
      Object.keys(node).some((key) => resourceKeys.has(key)),
    )
  )
    return schema;
  // Copy schema occurrences individually: shared metadata objects must not
  // turn a single extracted occurrence into several implicit reference uses.
  const root = clone(schema);
  const definitionKey = target === "draft-2020-12" ? "$defs" : "definitions";
  const definitions: Schema = {};
  const bodies = [root];
  for (let part = 0; (part + 1) * 2 <= referenceBudget; part += 1) {
    const groups = bodies
      .map((body) => {
        const nodes: Node[] = [];
        return { nodes, cost: collect(body, undefined, "", nodes) };
      })
      .sort((left, right) => right.cost - left.cost);
    const largest = groups[0];
    if (largest === undefined || largest.cost <= inlineValidationNodeTarget)
      break;
    const candidates = largest.nodes.filter(
      (node) =>
        node.parent !== undefined &&
        node.cost > 1 &&
        !Object.hasOwn(node.schema, "$ref"),
    );
    candidates.sort(
      (left, right) =>
        Math.abs(left.cost - largest.cost / 2) -
        Math.abs(right.cost - largest.cost / 2),
    );
    const selected = candidates[0];
    if (selected?.parent === undefined) break;
    const nested: Node[] = [];
    collect(selected.schema, undefined, "", nested);
    const leaf = nested.find(
      (node) =>
        node.parent !== undefined &&
        node.cost === 1 &&
        !Object.hasOwn(node.schema, "$ref"),
    );
    if (leaf?.parent === undefined) break;
    const name = `rea_input_part_${part}`;
    const leafName = `rea_input_leaf_${part}`;
    definitions[leafName] = leaf.schema;
    // A real child reference keeps standard AJV from expanding the complete
    // extracted body back into its caller's generated function.
    assign(leaf.parent, leaf.key, { $ref: `#/${definitionKey}/${leafName}` });
    definitions[name] = selected.schema;
    assign(selected.parent, selected.key, {
      $ref: `#/${definitionKey}/${name}`,
    });
    bodies.push(selected.schema);
  }
  return bodies.length === 1
    ? schema
    : { ...root, [definitionKey]: definitions };
};
