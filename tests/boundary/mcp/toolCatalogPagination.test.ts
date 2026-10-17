import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  isJSONRPCResultResponse,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
} from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";

import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";

it("lets the default SDK retrieve an oversized catalog through standard pages and retain tool validation", async () => {
  const server = new EvidenceMcpServer(
    { name: "catalog-pages", version: "1" },
    { capabilities: {} },
    undefined,
    createToolResultDelivery(undefined),
  );
  const description = "🐷".repeat(1024 * 1024);
  const names = ["first", "second", "third"];
  for (const name of names)
    server.registerTool(
      name,
      {
        inputSchema: z.strictObject({
          address: z.string().describe(description),
        }),
      },
      async ({ address }) => ({ content: [{ type: "text", text: address }] }),
    );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const frames: number[] = [];
  const send = serverTransport.send.bind(serverTransport);
  serverTransport.send = async (message, options) => {
    if (
      isJSONRPCResultResponse(message) &&
      Array.isArray(message.result["tools"])
    )
      frames.push(Buffer.byteLength(JSON.stringify(message), "utf8") + 1);
    await send(message, options);
  };
  const client = new Client({ name: "default-sdk", version: "1" });
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    expect(listed.tools.map(({ name }) => name)).toEqual(names);
    expect(listed.nextCursor).toBeUndefined();
    for (const tool of listed.tools)
      expect(tool.inputSchema.properties).toEqual({
        address: { type: "string", description },
      });
    expect(frames.length).toBeGreaterThan(1);
    expect(
      frames.every((bytes) => bytes <= STDIO_DEFAULT_MAX_BUFFER_SIZE),
    ).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(listed), "utf8")).toBeGreaterThan(
      STDIO_DEFAULT_MAX_BUFFER_SIZE,
    );
    const called = await client.callTool({
      name: "third",
      arguments: { address: "0x8000" },
    });
    expect(called.content).toEqual([{ type: "text", text: "0x8000" }]);
    const invalidCursor = client.listTools({ cursor: "invalid" });
    await expect(invalidCursor).rejects.toMatchObject({ code: -32602 });
    const invalidCall = await client.callTool({
      name: "third",
      arguments: { address: 42 },
    });
    expect(invalidCall.isError).toBe(true);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
