import { ok as resultOk } from "../../src/domain/result.js";
import type { Client } from "@modelcontextprotocol/client";
import { onTestFinished } from "vitest";

import { createTestBinarySession } from "./binarySession.js";
import type { BinarySession } from "../../src/application/binary/BinarySession.js";
import { observed } from "./analysisExecution.js";
import {
  createServer,
  type CreateServerOptions,
} from "../../src/server/createServer.js";
import {
  createTestMcp,
  type McpClientIdentity,
} from "../support/mcp/mcpFixture.js";

/** Owned MCP SDK session shared by application workflow scenarios. */
export interface ApplicationMcpHarness {
  readonly client: Client;
  readonly session: BinarySession;
  readonly close: () => Promise<void>;
}

/** Connect application workflows through the production MCP registration. */
export async function createApplicationMcpHarness(
  options: {
    readonly session?: BinarySession;
    readonly serverOptions?: CreateServerOptions;
    readonly identity?: McpClientIdentity;
  } = {},
): Promise<ApplicationMcpHarness> {
  const session =
    options.session ??
    createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
  const registry = createTestMcp();
  let sessionClosed = false;
  let closing: Promise<void> | undefined;
  const closeSession = async () => {
    if (sessionClosed) return;
    const result = await session.close();
    if (!result.ok) throw result.error;
    sessionClosed = true;
  };
  const close = async () => {
    if (closing !== undefined) return closing;
    const pending = (async () => {
      const failures: unknown[] = [];
      try {
        await registry.close();
      } catch (cause) {
        failures.push(cause);
      }
      try {
        await closeSession();
      } catch (cause) {
        failures.push(cause);
      }
      if (failures.length)
        throw new AggregateError(failures, "Application MCP cleanup failed");
    })();
    closing = pending;
    try {
      await pending;
    } finally {
      closing = undefined;
    }
  };
  onTestFinished(close);
  try {
    const server = createServer(
      { kind: "session", session },
      options.serverOptions,
    );
    const client = await registry.connect(
      server,
      options.identity ?? { name: "application-workflow-test", version: "1" },
    );
    return { client, session, close };
  } catch (cause) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        "Application MCP initialization and cleanup failed",
        { cause },
      );
    }
    throw cause;
  }
}
