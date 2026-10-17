import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";

import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, it } from "vitest";

import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { assertValidAdvertisedSchema } from "../../support/advertisedSchemas.js";
import {
  schemaArrays,
  schemaChildren,
  schemaMaps,
} from "../../../src/contracts/inputSchemaPresentation.js";

interface AdvertisedPattern {
  readonly tool: string;
  readonly where: string;
  readonly pattern: string;
}

interface AdvertisedBitmap {
  readonly tool: string;
  readonly where: string;
  readonly width: number;
  readonly pointer: string;
}
const isSchema = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const pointerToken = (key: string): string =>
  key.replaceAll("~", "~0").replaceAll("/", "~1");

const collectPatterns = (
  value: unknown,
  where: string,
  tool: string,
  found: AdvertisedPattern[],
  bitmaps: AdvertisedBitmap[],
  pointer = "",
): void => {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      collectPatterns(
        entry,
        `${where}[${String(index)}]`,
        tool,
        found,
        bitmaps,
        `${pointer}/${String(index)}`,
      ),
    );
    return;
  }
  if (!isSchema(value)) return;
  const patterns = Array.isArray(value.allOf)
    ? value.allOf.filter(isSchema).map((part) => part.pattern)
    : [];
  if (value.type === "string" && patterns.includes("[a-f1-9]")) {
    const fixedWidth = patterns
      .filter((pattern): pattern is string => typeof pattern === "string")
      .map((pattern) => /^\^\[a-f0-9\]\{(16|64)\}\$$/u.exec(pattern))
      .find((match) => match !== null);
    if (fixedWidth !== undefined)
      bitmaps.push({
        tool,
        where,
        width: Number(fixedWidth[1]),
        pointer,
      });
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "pattern" && typeof entry === "string")
      found.push({ tool, where: `${where}/pattern`, pattern: entry });
    if (schemaMaps.has(key) && isSchema(entry)) {
      for (const [name, child] of Object.entries(entry))
        collectPatterns(
          child,
          `${where}/${key}/${name}`,
          tool,
          found,
          bitmaps,
          `${pointer}/${pointerToken(key)}/${pointerToken(name)}`,
        );
    } else if (schemaArrays.has(key) || schemaChildren.has(key)) {
      collectPatterns(
        entry,
        `${where}/${key}`,
        tool,
        found,
        bitmaps,
        `${pointer}/${pointerToken(key)}`,
      );
    }
  }
};

it("advertises portable NUL escapes and patterns that compile in all JS modes", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for a schema projection");
  });
  const { client } = await createApplicationMcpHarness({
    session,
    identity: { name: "advertised-patterns", version: "1" },
  });

  const advertised = (await client.listTools()).tools;
  const patterns: AdvertisedPattern[] = [];
  const bitmaps: AdvertisedBitmap[] = [];
  for (const tool of advertised) {
    collectPatterns(
      tool.inputSchema,
      "inputSchema",
      tool.name,
      patterns,
      bitmaps,
    );
    if (tool.outputSchema !== undefined)
      collectPatterns(
        tool.outputSchema,
        "outputSchema",
        tool.name,
        patterns,
        bitmaps,
      );
  }

  // Annex B and `u` mode accept an unescaped `-`, `/` or `[` inside a character
  // class, so REA's own schema validation cannot observe the defect. `v` mode
  // rejects them, and a client that compiles advertised patterns rejects the
  // complete tools request rather than the affected call.
  const uncompilable = patterns.flatMap((entry) =>
    ["", "u", "v"].flatMap((flags) => {
      try {
        new RegExp(entry.pattern, flags);
        return [];
      } catch (cause: unknown) {
        return [
          `${entry.tool} ${entry.where} /${entry.pattern}/${flags}: ${cause instanceof Error ? cause.message : String(cause)}`,
        ];
      }
    }),
  );
  expect(uncompilable).toEqual([]);

  // RE2 and Rust validators reject look-around and backreferences, and like
  // the NUL escape below, one such pattern refuses the complete tools request.
  expect(
    patterns.filter(({ pattern }) => /\(\?<?[=!]|\\[1-9]|\\k</u.test(pattern)),
  ).toEqual([]);

  // DeepSeek rejects the short NUL escape even though V8 accepts it in all
  // three modes. Keep the shared hex spelling across the advertised catalog;
  // actual provider acceptance is verified separately from JS compilation.
  expect(
    patterns.filter(
      ({ pattern }) => pattern.includes("\\0") || pattern.includes("\\u0000"),
    ),
  ).toEqual([]);
  expect(patterns.some(({ pattern }) => pattern.includes("\\x00"))).toBe(true);

  // SDK conversion must retain both constraints when portable patterns replace
  // look-ahead. These are scalar schemas actually referenced by the wire outputs.
  for (const tool of [
    "trace_nes_mapper_events",
    "trace_nes_code",
    "explore_nes_code",
    "discover_nes_code",
  ])
    expect(
      bitmaps.some((bitmap) => bitmap.tool === tool),
      tool,
    ).toBe(true);
  const roots = new Map<string, { engine: Ajv2020; id: string }>();
  for (const { tool, where, width, pointer } of bitmaps) {
    let root = roots.get(tool);
    if (root === undefined) {
      const definition = advertised.find(
        (candidate) => candidate.name === tool,
      );
      const { record } = assertValidAdvertisedSchema(
        definition?.outputSchema,
        `${tool}.outputSchema`,
      );
      if (typeof record.$id !== "string")
        throw new Error(`Missing ${tool} schema ID`);
      const engine = new Ajv2020({ strict: false, validateFormats: false });
      engine.compile(record);
      root = { engine, id: record.$id };
      roots.set(tool, root);
    }
    // Keep local references bound to their original advertised root and ID.
    const validate = root.engine.getSchema(`${root.id}#${pointer}`);
    if (validate === undefined) throw new Error(`Missing ${tool} ${pointer}`);
    expect(validate("0".repeat(width - 1) + "1"), `${tool} ${where}`).toBe(
      true,
    );
    for (const invalid of [
      "0".repeat(width),
      "1".repeat(width - 1),
      "1".repeat(width + 1),
      "g".repeat(width),
      "A".repeat(width),
    ])
      expect(validate(invalid), `${tool} ${where}: ${invalid}`).toBe(false);
  }
});
