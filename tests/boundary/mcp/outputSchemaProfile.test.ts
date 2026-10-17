import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  isJSONRPCResultResponse,
  STDIO_DEFAULT_MAX_BUFFER_SIZE,
} from "@modelcontextprotocol/server";
import { createHash } from "node:crypto";
import { z } from "zod";
import { expect, it } from "vitest";

import {
  TOOL_CONTRACTS,
  toolContract,
} from "../../../src/contracts/toolContracts.js";
import { EvidenceMcpServer } from "../../../src/server/EvidenceMcpServer.js";
import { toolRegistrationOptions } from "../../../src/server/toolRegistrationOptions.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import type { ToolContract } from "../../../src/contracts/toolContractTypes.js";
import { CATALOG_IDENTITY } from "../../../src/catalogIdentity.js";

const createServer = (omitOutputSchemas: boolean) =>
  new EvidenceMcpServer(
    { name: "output-schema-fixture", version: "1" },
    { capabilities: {} },
    undefined,
    createToolResultDelivery(10 * 1024 * 1024),
    undefined,
    omitOutputSchemas,
  );

it("omits only output schema advertisements and keeps canonical MCP output validation", async () => {
  const server = createServer(true);
  expect(server.catalogIdentity.digests.combined_sha256).not.toBe(
    CATALOG_IDENTITY.digests.combined_sha256,
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "schema-profile-test", version: "1" });
  const contract = {
    ...toolContract("comment"),
    name: "output_schema_fixture",
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({ value: z.string() }),
  } satisfies ToolContract;
  server.registerTool(
    contract.name,
    toolRegistrationOptions(contract),
    async () => ({
      content: [{ type: "text" as const, text: "fixture" }],
      structuredContent: { value: "complete" },
    }),
  );
  const invalidContract = {
    ...contract,
    name: "invalid_output_schema_fixture",
  } satisfies ToolContract;
  server.registerTool(
    invalidContract.name,
    toolRegistrationOptions(invalidContract),
    async () => ({
      content: [{ type: "text" as const, text: "invalid fixture" }],
      structuredContent: { value: 42 },
    }),
  );

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(2);
    expect(tools.every((tool) => tool.outputSchema === undefined)).toBe(true);
    const success = await client.callTool({
      name: contract.name,
      arguments: {},
    });
    expect(success.isError).not.toBe(true);
    expect(success.structuredContent).toEqual({ value: "complete" });
    const invalid = await client.callTool({
      name: invalidContract.name,
      arguments: {},
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toEqual([
      expect.objectContaining({
        type: "text",
        text: expect.stringContaining("Output validation error"),
      }),
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

it("preserves every input contract across output profiles within default SDK catalog frames", async () => {
  const measure = async (omitOutputSchemas: boolean) => {
    const server = createServer(omitOutputSchemas);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "catalog-size-test", version: "1" });
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
    for (const contract of TOOL_CONTRACTS)
      server.registerTool(
        contract.name,
        toolRegistrationOptions(contract),
        async () => ({
          content: [{ type: "text" as const, text: "unused" }],
        }),
      );
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(TOOL_CONTRACTS.length);
      expect(
        listed.tools.every(
          (tool) => (tool.outputSchema === undefined) === omitOutputSchemas,
        ),
      ).toBe(true);
      expect(frames.length).toBeGreaterThan(0);
      expect(
        frames.every((bytes) => bytes <= STDIO_DEFAULT_MAX_BUFFER_SIZE),
      ).toBe(true);
      return {
        bytes: Buffer.byteLength(JSON.stringify(listed), "utf8"),
        inputs: listed.tools.map((tool) => ({
          name: tool.name,
          digest: createHash("sha256")
            .update(JSON.stringify(tool.inputSchema))
            .digest("hex"),
        })),
      };
    } finally {
      await client.close();
      await server.close();
    }
  };

  const full = await measure(false);
  const omitted = await measure(true);
  expect(full.bytes).toBeGreaterThan(STDIO_DEFAULT_MAX_BUFFER_SIZE);
  expect(omitted.inputs).toEqual(full.inputs);
  expect(omitted.bytes).toBeLessThan(full.bytes);
});
