import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";
import { test as base } from "vitest";

/** Client identity used during an in-memory MCP negotiation. */
export interface McpClientIdentity {
  readonly name: string;
  readonly version: string;
}

/** Registry for production MCP servers and SDK clients owned by one test. */
export interface TestMcp {
  connect(server: McpServer, identity?: McpClientIdentity): Promise<Client>;
  close(): Promise<void>;
}

const DEFAULT_CLIENT_IDENTITY: McpClientIdentity = {
  name: "rea-vitest",
  version: "1.0.0",
};

/** Create an MCP connection registry for a fixture composition root. */
export const createTestMcp = (): TestMcp => {
  interface OwnedConnection {
    readonly pending: Set<Client | McpServer>;
    closing: Promise<readonly unknown[]> | undefined;
  }
  const connections = new Set<OwnedConnection>();
  const release = async (
    connection: OwnedConnection,
  ): Promise<readonly unknown[]> => {
    if (connection.closing !== undefined) return connection.closing;
    const pending = (async () => {
      const failures: unknown[] = [];
      for (const resource of connection.pending) {
        try {
          await resource.close();
          connection.pending.delete(resource);
        } catch (cause) {
          failures.push(cause);
        }
      }
      if (connection.pending.size === 0) connections.delete(connection);
      return failures;
    })();
    connection.closing = pending;
    try {
      return await pending;
    } finally {
      connection.closing = undefined;
    }
  };

  return {
    connect: async (server, identity = DEFAULT_CLIENT_IDENTITY) => {
      const client = new Client(identity);
      const [clientTransport, serverTransport] =
        InMemoryTransport.createLinkedPair();
      const connection: OwnedConnection = {
        pending: new Set([client, server]),
        closing: undefined,
      };
      connections.add(connection);
      try {
        await server.connect(serverTransport);
        await client.connect(clientTransport);
      } catch (cause) {
        const failures = await release(connection);
        if (failures.length)
          throw new AggregateError(
            [cause, ...failures],
            "MCP test initialization and cleanup failed",
            { cause },
          );
        throw cause;
      }
      return client;
    },
    close: async () => {
      const failures = (
        await Promise.all([...connections].reverse().map(release))
      ).flat();
      if (failures.length)
        throw new AggregateError(
          failures,
          "MCP test connection cleanup failed",
        );
    },
  };
};

/** Vitest API extended with production-server/in-memory-client MCP wiring. */
export const mcpTest = base.extend<{ mcp: TestMcp }>({
  // oxlint-disable-next-line no-empty-pattern -- Vitest parses fixture dependencies from object destructuring.
  mcp: async ({}, use) => {
    const mcp = createTestMcp();
    try {
      await use(mcp);
    } finally {
      await mcp.close();
    }
  },
});
