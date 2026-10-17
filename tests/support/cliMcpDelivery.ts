import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type { ValidateFunction } from "ajv";
import { expect, onTestFinished } from "vitest";
import { parseEvidence } from "../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../src/domain/evidenceBundle.js";
import { verifyNesDiscoveryRetainedDelivery } from "../../scripts/verify-package-nes-discovery-delivery.mjs";
import type { TestCli } from "./cli/cliFixture.js";
import { compileAdvertisedSchema } from "./advertisedSchemas.js";

/** One explicitly owned stdio connection; callers select test- or file-scoped lifetime. */
export function createStdioToolClient(
  name: string,
  environment: Record<string, string> = {},
) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      fileURLToPath(new URL("../../scripts/rea.mjs", import.meta.url)),
      "mcp",
    ],
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? "",
      REA_LOG_LEVEL: "silent",
      ...environment,
    },
    stderr: "pipe",
  });
  const client = new Client({ name, version: "1" });
  return {
    client,
    transport,
    async close() {
      const failures: unknown[] = [];
      try {
        await client.close();
      } catch (cause) {
        failures.push(cause);
      }
      try {
        await transport.close();
      } catch (cause) {
        failures.push(cause);
      }
      if (failures.length)
        throw new AggregateError(
          failures,
          "MCP test connection cleanup failed",
        );
    },
  };
}

/** Connect a test-owned session, retaining teardown even when initialization fails. */
export async function connectTestMcp(
  name: string,
  environment: Record<string, string> = {},
): Promise<Client> {
  const connection = createStdioToolClient(name, environment);
  onTestFinished(() => connection.close());
  await connection.client.connect(connection.transport);
  return connection.client;
}

async function createContracts(client: Client) {
  const definitions = (await client.listTools()).tools;
  const validators = new Map<
    string,
    {
      definition: (typeof definitions)[number];
      input: ValidateFunction<unknown>;
      output: ValidateFunction<unknown>;
    }
  >();
  const contract = (name: string) => {
    const prior = validators.get(name);
    if (prior !== undefined) return prior;
    const definition = definitions.find((tool) => tool.name === name);
    assert.ok(
      definition?.outputSchema,
      `Missing advertised schema for ${name}`,
    );
    const validated = {
      definition,
      input: compileAdvertisedSchema(definition.inputSchema, `${name}.input`),
      output: compileAdvertisedSchema(
        definition.outputSchema,
        `${name}.output`,
      ),
    };
    validators.set(name, validated);
    return validated;
  };
  return contract;
}

const catalogs = new WeakMap<Client, ReturnType<typeof createContracts>>();

/** Named SDK contracts are immutable for one source-workflow connection. */
export function mcpContractsFor(client: Client) {
  const existing = catalogs.get(client);
  if (existing !== undefined) return existing;
  const created = createContracts(client);
  catalogs.set(client, created);
  void created.catch(() => {
    if (catalogs.get(client) === created) catalogs.delete(client);
  });
  return created;
}

async function request(
  client: Client,
  name: string,
  input: Record<string, unknown>,
) {
  const contract = await mcpContractsFor(client);
  const validate = contract(name);
  expect(validate.input(input), JSON.stringify(validate.input.errors)).toBe(
    true,
  );
  const result = await client.callTool({ name, arguments: input });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(
    validate.output(result.structuredContent),
    JSON.stringify(validate.output.errors),
  ).toBe(true);
  return result;
}

function expectText(
  reply: Awaited<ReturnType<Client["callTool"]>>,
  expected: unknown,
) {
  const text = reply.content.find((item) => item.type === "text");
  assert.ok(text?.type === "text");
  assert.deepEqual(JSON.parse(text.text), expected);
}

/** MCP-only source workflows still validate their named schema, Evidence and text delivery. */
export async function invokeMcpEvidence(
  client: Client,
  name: string,
  input: Record<string, unknown>,
) {
  const reply = await request(client, name, input);
  const evidence = parseEvidence(reply.structuredContent);
  expectText(reply, reply.structuredContent);
  return evidence;
}

/** Named SDK contracts and every-field CLI/MCP parity, including default-cap Evidence recovery. */
export async function createToolDelivery(
  client: Client,
  cli: TestCli,
  workspace?: string,
) {
  const contract = await mcpContractsFor(client);
  type RetainedDelivery = Awaited<
    ReturnType<typeof verifyNesDiscoveryRetainedDelivery>
  >;
  const retainedDeliveries: RetainedDelivery[] = [];
  const lifecycle = async (name: string, input: Record<string, unknown>) =>
    (await request(client, name, input)).structuredContent;
  const invoke = async (
    command: string,
    input: Record<string, unknown>,
    options: { timeoutMs?: number } = {},
  ) => {
    const name = command.replaceAll("-", "_"),
      validate = contract(name);
    expect(validate.input(input), JSON.stringify(validate.input.errors)).toBe(
      true,
    );
    const compiled = await cli.run({
      arguments: [name.replaceAll("_", "-"), JSON.stringify(input), "--json"],
      ...(options.timeoutMs === undefined
        ? {}
        : { timeoutMs: options.timeoutMs }),
    });
    expect(compiled.exitCode, compiled.stderr).toBe(0);
    expect(
      validate.output(compiled.json),
      JSON.stringify(validate.output.errors),
    ).toBe(true);
    const evidence = parseEvidence(compiled.json);
    const response = await client.callTool(
      { name, arguments: input },
      options.timeoutMs === undefined
        ? undefined
        : { timeout: options.timeoutMs },
    );
    if (response.isError === true && workspace !== undefined) {
      const retained = await verifyNesDiscoveryRetainedDelivery({
        operation: name,
        response,
        evidence,
        workspace,
        invoke: lifecycle,
        validateBundle: (bundle) => {
          expect(
            contract("get_evidence_bundle").output({ result: bundle }),
          ).toBe(true);
          parseEvidenceBundle(bundle);
        },
      });
      retainedDeliveries.push(retained);
    } else {
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(
        validate.output(response.structuredContent),
        JSON.stringify(validate.output.errors),
      ).toBe(true);
      assert.deepEqual(response.structuredContent, compiled.json);
      expectText(response, compiled.json);
    }
    return evidence;
  };
  return {
    invoke,
    contract,
    get retainedDeliveries(): readonly RetainedDelivery[] {
      return retainedDeliveries;
    },
  };
}
