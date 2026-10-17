import assert from "node:assert/strict";
import type { ValidateFunction } from "ajv";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { isNesDiscoveryReturnsRecursiveInput } from "../../../scripts/verify-package-nes-discovery-delivery.mjs";
import { nesCodeDiscoveryReportSchema } from "../../../src/domain/nesCodeDiscovery.js";
import { verifyPackageNesDiscoveryReturns } from "../../../scripts/verify-package-nes-discovery-returns.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";

function rejectMissingReturnWitness(
  evidence: ReturnType<typeof parseEvidence>,
  report: ReturnType<typeof nesCodeDiscoveryReportSchema.parse>,
  validate: ValidateFunction<unknown>,
): boolean {
  const graph = report.code_discovery;
  if (graph.status !== "derived") return false;
  const matched = graph.edges.find(
    (edge) => edge.kind === "return" && edge.resolution === "resolved",
  );
  if (matched === undefined) return false;
  for (const replacement of [
    { ...matched, continuation_index: null, summary_index: null },
    { ...matched, continuation_index: null },
    { ...matched, summary_index: null },
    { ...matched, target_invocation_index: -1 },
  ])
    expect(
      validate({
        ...evidence,
        normalized_result: {
          ...report,
          code_discovery: {
            ...graph,
            edges: graph.edges.map((edge) =>
              edge.index === matched.index ? replacement : edge,
            ),
          },
        },
      }),
    ).toBe(false);
  assert.ok(matched.summary_index !== null);
  const summary = graph.return_summaries[matched.summary_index];
  assert.ok(summary);
  const summaryIndex = summary.index;
  expect(
    validate({
      ...evidence,
      normalized_result: {
        ...report,
        code_discovery: {
          ...graph,
          return_summaries: graph.return_summaries.map((item) =>
            item.index === summaryIndex
              ? { ...item, ram_out: item.ram_out.slice(1) }
              : item,
          ),
        },
      },
    }),
  ).toBe(false);
  return true;
}

function rejectEmptyWriteWitness(
  evidence: ReturnType<typeof parseEvidence>,
  report: ReturnType<typeof nesCodeDiscoveryReportSchema.parse>,
  validate: ValidateFunction<unknown>,
): boolean {
  const graph = report.code_discovery;
  if (graph.status !== "derived" || graph.write_witnesses.length === 0)
    return false;
  const last = graph.write_witnesses.length - 1;
  expect(
    validate({
      ...evidence,
      normalized_result: {
        ...report,
        code_discovery: {
          ...graph,
          write_witnesses: graph.write_witnesses.map((witness, index) =>
            index === last ? { ...witness, analysis_indices: [] } : witness,
          ),
        },
      },
    }),
  ).toBe(false);
  return true;
}

cliTest(
  "preserves matched NES callee return states, writer witnesses and stack qualification through actual CLI/default-SDK schemas",
  async ({ cli }) => {
    const workspace = await createTestTempDirectory("rea-discovery-returns-");
    const client = await connectTestMcp("nes-discovery-returns-oracle");
    const { invoke: deliver, contract } = await createToolDelivery(
      client,
      cli,
      workspace,
    );
    const validateInput = contract("discover_nes_code").input,
      validateOutput = contract("discover_nes_code").output;
    let checkedReturn = false,
      checkedWrite = false,
      checkedRecursiveDelivery = false;
    const invoke = async (command: string, input: Record<string, unknown>) => {
      expect(command).toBe("discover-nes-code");
      const evidenceValue = await deliver(command, input),
        evidence = parseEvidence(evidenceValue),
        report = nesCodeDiscoveryReportSchema.parse(evidence.normalized_result);
      if (!checkedReturn)
        checkedReturn = rejectMissingReturnWitness(
          evidence,
          report,
          validateOutput,
        );
      if (!checkedWrite)
        checkedWrite = rejectEmptyWriteWitness(
          evidence,
          report,
          validateOutput,
        );
      if (isNesDiscoveryReturnsRecursiveInput(input))
        checkedRecursiveDelivery = true;
      return evidenceValue;
    };
    expect(
      await verifyPackageNesDiscoveryReturns(invoke, workspace),
    ).toMatchObject({
      ok: true,
      workflows: 13,
      matched_returns: true,
      correlated_callers: true,
      stack_qualification: true,
      recursive_fixedpoint: true,
      return_budgets: true,
      original_unchanged: true,
    });
    expect(checkedReturn).toBe(true);
    expect(checkedWrite).toBe(true);
    expect(checkedRecursiveDelivery).toBe(true);
    for (const field of ["max_invocations", "max_continuations"]) {
      const input = {
        path: "/invalid.nes",
        initial: { mapper: 4 },
        [field]: 0,
      };
      expect(validateInput(input)).toBe(false);
      expect(
        (
          await client.callTool({
            name: "discover_nes_code",
            arguments: input,
          })
        ).isError,
      ).toBe(true);
    }
  },
  180000,
);
