import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect } from "vitest";
import {
  exploreNesThroughMcp,
  replayNesThroughMcp,
  traceNesThroughAdapters,
} from "./nesSourceDelivery.js";
import type { TestCli } from "./cli/cliFixture.js";

/** One ROM-backed bank-switch proof shared by board-specific literal programs. */
export async function verifyNesPrgSwitch(
  cli: TestCli,
  client: Client,
  input: Record<string, unknown> & { path: string },
  bytes: Buffer,
  expected: { limitation: string; accumulator: number; targetOffset: number },
) {
  const evidence = await traceNesThroughAdapters(cli, client, input);
  const report = evidence.normalized_result;
  expect(report.artifact.sha256).toBe(
    createHash("sha256").update(bytes).digest("hex"),
  );
  expect(report.limitations.join(" ")).toContain(expected.limitation);
  const trace = report.code_trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_cpu.a).toBe(expected.accumulator);
  expect(trace.instructions.at(-1)?.file_offsets).toEqual([
    expected.targetOffset,
    expected.targetOffset + 1,
  ]);
  for (const instruction of trace.instructions) {
    expect(instruction.file_offsets.every((offset) => offset !== null)).toBe(
      true,
    );
    expect(instruction.bytes_hex).toBe(
      Buffer.from(
        instruction.file_offsets.map((offset) => bytes[offset!]!),
      ).toString("hex"),
    );
  }
  const replay = await replayNesThroughMcp(client, {
    ...input,
    writes: trace.instructions.flatMap((instruction) => instruction.writes),
  });
  expect(replay.normalized_result.trace).toEqual(trace.mapper_trace);
  const explored = await exploreNesThroughMcp(client, input);
  const exploration = explored.normalized_result.code_exploration;
  if (exploration.status !== "derived") throw new Error(exploration.reason);
  expect(exploration.paths[0]?.trace).toEqual(trace);
  expect(await readFile(input.path)).toEqual(bytes);
}
