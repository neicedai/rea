import { Client } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, expect, it, onTestFinished, vi } from "vitest";
import { createTestMcp, type TestMcp } from "../../support/mcp/mcpFixture.js";
import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import {
  createTestBinarySession,
  createDeferred,
} from "../../fixtures/binarySession.js";
import { err } from "../../../src/domain/result.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";

afterEach(() => vi.restoreAllMocks());

function ownProbe(server: McpServer, registry: TestMcp) {
  onTestFinished(async () => {
    vi.restoreAllMocks();
    await registry.close();
    await server.close();
  });
}

it("retains failed initialization cleanup and retries the same SDK server", async () => {
  const registry = createTestMcp();
  const server = new McpServer({ name: "initialization-owner", version: "1" });
  ownProbe(server, registry);
  const primary = new Error("initialization probe");
  const cleanup = new Error("initialization close probe");
  const connect = server.connect.bind(server);
  vi.spyOn(server, "connect").mockImplementationOnce(async (transport) => {
    await connect(transport);
    throw primary;
  });
  const close = vi.spyOn(server, "close").mockRejectedValueOnce(cleanup);
  const failure = await registry
    .connect(server)
    .catch((cause: unknown) => cause);
  if (!(failure instanceof AggregateError))
    throw new Error("Expected initialization and cleanup failures", {
      cause: failure,
    });
  expect(failure.cause).toBe(primary);
  expect(failure.errors).toEqual([primary, cleanup]);
  expect(close).toHaveBeenCalledTimes(1);
  await registry.close();
  expect(close).toHaveBeenCalledTimes(2);
  expect(close.mock.contexts).toEqual([server, server]);
  await registry.close();
  expect(close).toHaveBeenCalledTimes(2);
});

it("reports both SDK close failures and retires each owner only after success", async () => {
  const registry = createTestMcp();
  const server = new McpServer({ name: "cleanup-owner", version: "1" });
  ownProbe(server, registry);
  const client = await registry.connect(server);
  expect(await client.ping()).toEqual({});
  const clientFailure = new Error("client close probe");
  const serverFailure = new Error("server close probe");
  const clientClose = vi
    .spyOn(client, "close")
    .mockRejectedValueOnce(clientFailure);
  const serverClose = vi
    .spyOn(server, "close")
    .mockRejectedValueOnce(serverFailure);
  const failure = await registry.close().catch((cause: unknown) => cause);
  if (!(failure instanceof AggregateError))
    throw new Error("Expected both close failures", { cause: failure });
  expect(failure.errors).toEqual([clientFailure, serverFailure]);
  await registry.close();
  expect(clientClose.mock.contexts).toEqual([client, client]);
  expect(serverClose.mock.contexts).toEqual([server, server]);
  await registry.close();
  expect(clientClose).toHaveBeenCalledTimes(2);
  expect(serverClose).toHaveBeenCalledTimes(2);
});

it("coalesces concurrent cleanup of the same live SDK connection", async () => {
  const registry = createTestMcp();
  const server = new McpServer({ name: "concurrent-owner", version: "1" });
  ownProbe(server, registry);
  const client = await registry.connect(server);
  expect(await client.ping()).toEqual({});
  const barrier = createDeferred<void>();
  const closeClient = client.close.bind(client);
  const clientClose = vi
    .spyOn(client, "close")
    .mockImplementationOnce(async () => {
      await barrier.promise;
      await closeClient();
    });
  const serverClose = vi.spyOn(server, "close");
  const first = registry.close();
  const second = registry.close();
  try {
    expect(clientClose).toHaveBeenCalledTimes(1);
  } finally {
    barrier.resolve(undefined);
    await Promise.allSettled([first, second]);
  }
  expect(serverClose).toHaveBeenCalledTimes(1);
  await registry.close();
  expect(clientClose).toHaveBeenCalledTimes(1);
  expect(serverClose).toHaveBeenCalledTimes(1);
});

it("closes the caller-selected session when SDK initialization fails", async () => {
  const session = createTestBinarySession(() => {
    throw new Error("No deep provider may start for an initialization probe");
  });
  onTestFinished(async () => {
    const result = await session.close();
    if (!result.ok) throw result.error;
  });
  const close = vi.spyOn(session, "close");
  const primary = new Error("SDK initialization probe");
  vi.spyOn(Client.prototype, "connect").mockRejectedValueOnce(primary);
  await expect(
    createApplicationMcpHarness({
      session,
      identity: { name: "selected-session-owner", version: "1" },
    }),
  ).rejects.toBe(primary);
  expect(close).toHaveBeenCalledTimes(1);
});

it("retries failed harness cleanup without closing its successful session twice", async () => {
  const harness = await createApplicationMcpHarness();

  expect(await harness.client.ping()).toEqual({});
  const sessionClose = vi.spyOn(harness.session, "close");
  const clientClose = vi
    .spyOn(harness.client, "close")
    .mockRejectedValueOnce(new Error("harness client close probe"));
  await expect(harness.close()).rejects.toBeInstanceOf(AggregateError);
  expect(sessionClose).toHaveBeenCalledTimes(1);
  await harness.close();
  expect(sessionClose).toHaveBeenCalledTimes(1);
  expect(clientClose).toHaveBeenCalledTimes(2);
  await harness.close();
  expect(sessionClose).toHaveBeenCalledTimes(1);
  expect(clientClose).toHaveBeenCalledTimes(2);
});

it("retains a failed session after closing RPC and coalesces concurrent harness cleanup", async () => {
  const harness = await createApplicationMcpHarness();
  expect(await harness.client.ping()).toEqual({});
  const clientClose = vi.spyOn(harness.client, "close");
  const barrier = createDeferred<void>();
  const entered = createDeferred<void>();
  const primary = new ProviderCleanupError("fixture", ["session close probe"], {
    reason: "session close probe",
  });
  const sessionClose = vi
    .spyOn(harness.session, "close")
    .mockImplementationOnce(async () => {
      entered.resolve(undefined);
      await barrier.promise;
      return err(primary);
    });
  const first = harness.close();
  const second = harness.close();
  let failures: PromiseSettledResult<void>[] = [];
  try {
    await entered.promise;
    expect(clientClose).toHaveBeenCalledTimes(1);
    expect(sessionClose).toHaveBeenCalledTimes(1);
  } finally {
    barrier.resolve(undefined);
    failures = await Promise.allSettled([first, second]);
  }
  expect(failures).toEqual([
    {
      status: "rejected",
      reason: expect.objectContaining({ errors: [primary] }),
    },
    {
      status: "rejected",
      reason: expect.objectContaining({ errors: [primary] }),
    },
  ]);
  if (failures[0]?.status !== "rejected" || failures[1]?.status !== "rejected")
    throw new Error("Expected shared session cleanup failure");
  expect(failures[0].reason).toBe(failures[1].reason);
  await harness.close();
  expect(sessionClose).toHaveBeenCalledTimes(2);
  expect(clientClose).toHaveBeenCalledTimes(1);
  await harness.close();
  expect(sessionClose).toHaveBeenCalledTimes(2);
  expect(clientClose).toHaveBeenCalledTimes(1);
});
