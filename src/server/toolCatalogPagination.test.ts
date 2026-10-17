import type { JSONRPCResultResponse } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { paginateToolsList } from "./toolCatalogPagination.js";

const catalog = (count = 5): JSONRPCResultResponse => ({
  jsonrpc: "2.0",
  id: '目录🐷"\\',
  result: {
    _meta: { provenance: "SDK projection" },
    tools: Array.from({ length: count }, (_, index) => ({
      name: `tool_${index}`,
      description: '地址🐷\\"'.repeat(8),
      inputSchema: { type: "object", properties: {} },
      outputSchema: { type: "object", properties: {} },
      _meta: { source: index },
    })),
  },
});

const page = (
  message: JSONRPCResultResponse,
  cursor?: unknown,
  budget = 800,
) => {
  const result = paginateToolsList(message, cursor, budget);
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
};

describe("tools/list wire pagination", () => {
  it("preserves every converted definition, ordering and metadata across bounded pages", () => {
    const source = catalog();
    const collected: unknown[] = [];
    let cursor: unknown;
    let pages = 0;
    do {
      const result = page(source, cursor);
      expect(
        Buffer.byteLength(JSON.stringify(result), "utf8") + 1,
      ).toBeLessThanOrEqual(800);
      expect(result.id).toBe(source.id);
      expect(result.result["_meta"]).toEqual(source.result["_meta"]);
      expect(result.result["tools"]).toBeInstanceOf(Array);
      const tools = result.result["tools"] as unknown[];
      expect(tools.length).toBeGreaterThan(0);
      collected.push(...tools);
      cursor = result.result["nextCursor"];
      pages += 1;
      expect(pages).toBeLessThanOrEqual(5);
    } while (cursor !== undefined);
    expect(pages).toBeGreaterThan(1);
    expect(collected).toEqual(source.result["tools"]);
    expect(source.result).not.toHaveProperty("nextCursor");
  });

  it("counts Unicode, JSON escaping, the request id and stdio newline at the exact frame boundary", () => {
    const source = catalog(1);
    const exactBytes = Buffer.byteLength(JSON.stringify(source), "utf8") + 1;
    expect(page(source, undefined, exactBytes)).toBe(source);
    expect(paginateToolsList(source, undefined, exactBytes - 1)).toEqual({
      ok: false,
      error: {
        kind: "message_capacity",
        message: expect.any(String),
        maximum_bytes: exactBytes - 1,
        required_bytes: exactBytes,
      },
    });
  });

  it.each([
    null,
    42,
    [],
    "",
    "rea-tools-v1:bad:1",
    `rea-tools-v1:${"0".repeat(64)}:1`,
  ])("rejects malformed or foreign cursor %j", (cursor) => {
    expect(paginateToolsList(catalog(), cursor)).toMatchObject({
      ok: false,
      error: { kind: "invalid_cursor" },
    });
  });

  it("rejects a stale catalog, out-of-range offset and unsafe offset", () => {
    const source = catalog();
    const cursor = page(source).result["nextCursor"];
    expect(typeof cursor).toBe("string");
    for (const invalid of [
      String(cursor).replace(/:[0-9]+$/u, ":5"),
      String(cursor).replace(/:[0-9]+$/u, ":9007199254740992"),
      String(cursor).replace(/:[0-9]+$/u, ":0"),
    ])
      expect(paginateToolsList(source, invalid)).toMatchObject({
        ok: false,
        error: { kind: "invalid_cursor" },
      });
    expect(paginateToolsList(catalog(4), cursor)).toMatchObject({
      ok: false,
      error: { kind: "invalid_cursor" },
    });
  });

  it("keeps a fitting or empty catalog unchanged", () => {
    for (const source of [catalog(), catalog(0)])
      expect(paginateToolsList(source, undefined)).toEqual({
        ok: true,
        value: source,
      });
  });

  it("admits a complete final page even when an unnecessary cursor would exceed its budget", () => {
    const source: JSONRPCResultResponse = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "large", description: "x".repeat(500) },
          { name: "last" },
        ],
      },
    };
    const bytes = Buffer.byteLength(JSON.stringify(source)) + 1;
    expect(page(source, undefined, bytes)).toBe(source);
  });
});
