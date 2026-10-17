import type { ValidateFunction } from "ajv";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { nesCodeDiscoveryReportSchema } from "../../../src/domain/nesCodeDiscovery.js";
import { verifyPackageNesDiscoveryBranches } from "../../../scripts/verify-package-nes-discovery-branches.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";

function checkWireConditions(
  evidence: ReturnType<typeof parseEvidence>,
  report: ReturnType<typeof nesCodeDiscoveryReportSchema.parse>,
  validate: ValidateFunction<unknown>,
) {
  const graph = report.code_discovery;
  if (graph.status !== "derived") return false;
  const branch = graph.edges.find((edge) => edge.kind === "branch-taken"),
    ordinary = graph.edges.find((edge) => edge.kind === "fallthrough");
  if (branch === undefined || ordinary === undefined) return false;
  const project = (index: number, replacement: Record<string, unknown>) => ({
    ...evidence,
    normalized_result: {
      ...report,
      code_discovery: {
        ...graph,
        edges: graph.edges.map((edge) =>
          edge.index === index ? replacement : edge,
        ),
      },
    },
  });
  // Converted JSON Schema checks local shape and keyword qualifications. Actual
  // byte/analysis feasibility is checked by the report parser and literal oracle.
  for (const condition of [
    null,
    { flag: "d", value: true },
    { flag: "c", value: 1 },
  ])
    expect(validate(project(branch.index, { ...branch, condition }))).toBe(
      false,
    );
  const missing = Object.fromEntries(
    Object.entries(branch).filter(([key]) => key !== "condition"),
  );
  expect(validate(project(branch.index, missing))).toBe(false);
  expect(
    validate(
      project(ordinary.index, {
        ...ordinary,
        condition: { flag: "c", value: false },
      }),
    ),
  ).toBe(false);
  return true;
}

cliTest(
  "prunes impossible NES flag branches and preserves conditioned bank-aware successors through CLI/default SDK",
  async ({ cli }) => {
    const workspace = await createTestTempDirectory("rea-discovery-branches-");
    const client = await connectTestMcp("nes-discovery-branches-oracle");
    const { invoke: deliver, contract } = await createToolDelivery(
      client,
      cli,
      workspace,
    );
    const validateOutput = contract("discover_nes_code").output;
    let checkedWire = false;
    const invoke = async (command: string, input: Record<string, unknown>) => {
      expect(command).toBe("discover-nes-code");
      const evidenceValue = await deliver(command, input),
        evidence = parseEvidence(evidenceValue),
        report = nesCodeDiscoveryReportSchema.parse(evidence.normalized_result);
      if (!checkedWire)
        checkedWire = checkWireConditions(evidence, report, validateOutput);
      return evidenceValue;
    };
    expect(
      await verifyPackageNesDiscoveryBranches(invoke, workspace),
    ).toMatchObject({
      ok: true,
      workflows: 10,
      known_flag_pruning: true,
      conditioned_candidates: true,
      join_reanalysis: true,
      stack_call_flags: true,
      banked_branches: true,
      wrapped_targets: true,
      budget_frontiers: true,
      original_unchanged: true,
    });
    expect(checkedWire).toBe(true);
  },
  180000,
);
