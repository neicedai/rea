import type { Client } from "@modelcontextprotocol/client";
import { toolContract } from "../../src/contracts/toolContracts.js";
import { createToolDelivery, invokeMcpEvidence } from "./cliMcpDelivery.js";
import type { TestCli } from "./cli/cliFixture.js";

type NesSourceOperation =
  | "trace_nes_code"
  | "explore_nes_code"
  | "trace_nes_mapper_events";

/** Keep source/replay checks on the same named SDK contracts and owned connection. */
export async function createNesSourceCaller(cli: TestCli, client: Client) {
  const delivery = await createToolDelivery(client, cli);
  const call = (
    name: NesSourceOperation,
    input: Record<string, unknown>,
    parity = true,
  ) =>
    parity
      ? delivery.invoke(name, input)
      : invokeMcpEvidence(client, name, input);
  const code = async (input: Record<string, unknown>) => {
    const evidence = toolContract("trace_nes_code").outputSchema.parse(
      await call("trace_nes_code", input),
    );
    const trace = evidence.normalized_result.code_trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    return { trace, evidence };
  };
  return { call, code, contract: delivery.contract };
}

/** Bind repeated source-workflow checks to their exact public result contracts. */
export async function traceNesThroughAdapters(
  cli: TestCli,
  client: Client,
  input: Record<string, unknown>,
) {
  const delivery = await createToolDelivery(client, cli);
  return toolContract("trace_nes_code").outputSchema.parse(
    await delivery.invoke("trace-nes-code", input),
  );
}

export async function traceNesThroughMcp(
  client: Client,
  input: Record<string, unknown>,
) {
  return toolContract("trace_nes_code").outputSchema.parse(
    await invokeMcpEvidence(client, "trace_nes_code", input),
  );
}

export async function replayNesThroughMcp(
  client: Client,
  input: Record<string, unknown>,
) {
  return toolContract("trace_nes_mapper_writes").outputSchema.parse(
    await invokeMcpEvidence(client, "trace_nes_mapper_writes", input),
  );
}

export async function exploreNesThroughMcp(
  client: Client,
  input: Record<string, unknown>,
) {
  return toolContract("explore_nes_code").outputSchema.parse(
    await invokeMcpEvidence(client, "explore_nes_code", input),
  );
}
