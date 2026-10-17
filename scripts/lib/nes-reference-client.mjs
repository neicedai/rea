import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Ajv2020 } from "ajv/dist/2020.js";
import { exec } from "./verify-package-core.mjs";
import { NesReferenceResponseBudgetError } from "./nes-reference-workflow.mjs";

const createContracts = (definitions) => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const validators = new Map();
  return (name) => {
    const definition = definitions.find((tool) => tool.name === name);
    assert.ok(definition?.outputSchema, `Missing advertised ${name} schema`);
    let validate = validators.get(name);
    if (validate === undefined) {
      const { $schema, ...shape } = definition.outputSchema;
      assert.ok($schema === undefined || typeof $schema === "string");
      validate = {
        input: ajv.compile(definition.inputSchema),
        output: ajv.compile(
          $schema === undefined ? shape : { ...shape, $schema },
        ),
      };
      validators.set(name, validate);
    }
    return { definition, validate };
  };
};

const rejectBudgetResponse = (response, evidence) => {
  const text = response.content.find((item) => item.type === "text");
  assert.ok(text, "Tool failure omitted its diagnostic");
  const { error } = JSON.parse(text.text);
  assert.equal(error.code, "resource_constraint");
  assert.equal(error.details.operation, "trace_nes_code");
  assert.equal(error.details.resource, "transport");
  const limits = error.details.reported_limits;
  assert.ok(
    limits !== null && typeof limits === "object" && !Array.isArray(limits),
    "Response constraint must include its reported limits",
  );
  assert.equal(limits.boundary, "mcp-response");
  assert.equal(limits.evidence_id, evidence.evidence_id);
  assert.deepEqual(limits.evidence_reference, {
    kind: "retained-evidence",
    evidence_id: evidence.evidence_id,
  });
  assert.equal(response.structuredContent, undefined);
  throw new NesReferenceResponseBudgetError({
    evidenceId: evidence.evidence_id,
    details: limits,
  });
};

/** Own one default SDK transport and its named schemas for the complete reference lane. */
export async function createNesReferenceClient({
  cli,
  cwd = process.cwd(),
  environment = { PATH: process.env.PATH ?? "", REA_LOG_LEVEL: "silent" },
}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [cli, "mcp"],
    cwd,
    env: environment,
    stderr: "pipe",
  });
  const client = new Client({
    name: "nes-reference-default-sdk",
    version: "1",
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    try {
      await client.close();
    } finally {
      await transport.close();
    }
    closed = true;
  };
  try {
    await client.connect(transport);
    const definitions = (await client.listTools()).tools;
    const contract = createContracts(definitions);
    const sessionContract = contract("binary_session");
    assert.equal(sessionContract.validate.input({}), true);
    const session = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    assert.notEqual(session.isError, true, "binary_session failed");
    assert.equal(
      sessionContract.validate.output(session.structuredContent),
      true,
      JSON.stringify(sessionContract.validate.output.errors),
    );
    const catalog_identity =
      session.structuredContent.result.server_identity.catalog;
    assert.equal(catalog_identity.counts.mcp_tools, definitions.length);
    for (const digest of Object.values(catalog_identity.digests))
      assert.match(digest, /^[a-f0-9]{64}$/u);
    const { definition, validate } = contract("trace_nes_code");
    const invoke = async (input) => {
      assert.ok(!closed, "NES reference client is closed");
      assert.equal(
        validate.input(input),
        true,
        JSON.stringify(validate.input.errors),
      );
      const response = await client.callTool({
        name: definition.name,
        arguments: input,
      });
      const { stdout } = await exec(
        process.execPath,
        [cli, "trace-nes-code", JSON.stringify(input), "--json"],
        {
          cwd,
          env: environment,
          // The fixed 8,991-row profile uses the reference CLI's original
          // capture ceiling. SDK receive-buffer and MCP budgets stay unchanged.
          maxBuffer: 64 * 1024 * 1024,
          timeout: 120000,
        },
      );
      const evidence = JSON.parse(stdout);
      assert.equal(
        validate.output(evidence),
        true,
        JSON.stringify(validate.output.errors),
      );
      if (response.isError === true) rejectBudgetResponse(response, evidence);
      assert.equal(
        validate.output(response.structuredContent),
        true,
        JSON.stringify(validate.output.errors),
      );
      assert.deepEqual(response.structuredContent, evidence);
      return response.structuredContent;
    };
    return { invoke, close, catalog_identity };
  } catch (cause) {
    try {
      await close();
    } catch (cleanup) {
      const failure = new AggregateError(
        [cause, cleanup],
        "Reference client setup failed",
      );
      failure.cleanup_owner = { close };
      throw failure;
    }
    throw cause;
  }
}
