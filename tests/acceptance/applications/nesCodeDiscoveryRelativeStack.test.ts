import assert from "node:assert/strict";
import type { ValidateFunction } from "ajv";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { nesCodeDiscoveryReportSchema } from "../../../src/domain/nesCodeDiscovery.js";
import { verifyPackageNesDiscoveryRelativeStack } from "../../../scripts/verify-package-nes-discovery-relative-stack.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";

function checkWireProofs(
  evidence: ReturnType<typeof parseEvidence>,
  report: ReturnType<typeof nesCodeDiscoveryReportSchema.parse>,
  validate: ValidateFunction<unknown>,
) {
  const graph = report.code_discovery;
  if (graph.status !== "derived" || graph.return_summaries.length === 0)
    return false;
  const summary = graph.return_summaries.find(
    (item) => item.stack_target !== null,
  );
  assert.ok(summary);
  const project = (replacement: Record<string, unknown>) => ({
    ...evidence,
    normalized_result: {
      ...report,
      code_discovery: { ...graph, ...replacement },
    },
  });
  const summaryGraph = (replacement: Record<string, unknown>) =>
    project({
      return_summaries: graph.return_summaries.map((item) =>
        item.index === summary.index ? { ...item, ...replacement } : item,
      ),
    });
  // These are schema alternatives, not claims that a forged Evidence ID authenticates.
  for (const proof of ["physical-bytes", "relative-bytes", "opaque-token"])
    expect(
      validate(
        summaryGraph({
          return_proof: proof,
          stack_target: proof === "opaque-token" ? null : summary.stack_target,
        }),
      ),
      JSON.stringify(validate.errors),
    ).toBe(true);
  for (const proof of ["physical-bytes", "relative-bytes"])
    expect(
      validate(summaryGraph({ return_proof: proof, stack_target: null })),
    ).toBe(false);
  expect(
    validate(
      summaryGraph({
        return_proof: "opaque-token",
        stack_target: summary.stack_target,
      }),
    ),
  ).toBe(false);
  expect(
    validate(
      summaryGraph({ relative_stack_out: summary.relative_stack_out.slice(1) }),
    ),
  ).toBe(false);
  const witness = graph.relative_stack_write_witnesses[0];
  assert.ok(witness);
  for (const replacement of [
    { ...witness, offset: 256 },
    { ...witness, analysis_indices: [] },
  ])
    expect(
      validate(
        project({
          relative_stack_write_witnesses:
            graph.relative_stack_write_witnesses.map((item) =>
              item.index === witness.index ? replacement : item,
            ),
        }),
      ),
    ).toBe(false);
  const originReference = graph.data_references.find(
    (item) => item.relative_stack_origins.length > 0,
  );
  assert.ok(originReference);
  expect(
    validate(
      project({
        data_references: graph.data_references.map((item) =>
          item.index === originReference.index
            ? {
                ...item,
                relative_stack_origins: item.relative_stack_origins.map(
                  (origin) => ({ ...origin, offset: 256 }),
                ),
              }
            : item,
        ),
      }),
    ),
  ).toBe(false);
  return true;
}

cliTest(
  "proves unknown-SP NES byte targets and matched returns without inventing physical stack RAM through CLI/default SDK",
  async ({ cli }) => {
    const workspace = await createTestTempDirectory("rea-relative-stack-");
    const client = await connectTestMcp("nes-relative-stack-oracle");
    const { invoke: deliver, contract } = await createToolDelivery(
      client,
      cli,
      workspace,
    );
    const validateOutput = contract("discover_nes_code").output;
    let guarded = false;
    const invoke = async (command: string, input: Record<string, unknown>) => {
      expect(command).toBe("discover-nes-code");
      const evidenceValue = await deliver(command, input),
        evidence = parseEvidence(evidenceValue),
        report = nesCodeDiscoveryReportSchema.parse(evidence.normalized_result);
      if (!guarded) guarded = checkWireProofs(evidence, report, validateOutput);
      return evidenceValue;
    };
    expect(
      await verifyPackageNesDiscoveryRelativeStack(invoke, workspace),
    ).toMatchObject({
      ok: true,
      workflows: 16,
      relative_byte_targets: true,
      matched_relative_returns: true,
      partial_stack_bits: true,
      stack_ring_coverage: true,
      alias_frontiers: true,
      physical_regression: true,
      original_unchanged: true,
    });
    expect(guarded).toBe(true);
  },
  180000,
);
