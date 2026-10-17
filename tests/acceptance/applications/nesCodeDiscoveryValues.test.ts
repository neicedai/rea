import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import assert from "node:assert/strict";
import type { ValidateFunction } from "ajv";
import { expect } from "vitest";
import type { Evidence } from "../../../src/domain/evidence.js";
import { nesCodeDiscoveryReportSchema } from "../../../src/domain/nesCodeDiscovery.js";
import { verifyPackageNesDiscoveryValues } from "../../../scripts/verify-package-nes-discovery-values.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

function rejectMalformedValues(
  evidence: Evidence,
  validate: ValidateFunction<unknown>,
) {
  const report = nesCodeDiscoveryReportSchema.parse(evidence.normalized_result),
    graph = report.code_discovery;
  if (graph.status !== "derived" || graph.value_pages.length === 0)
    return false;
  const branch = graph.edges.find((edge) => edge.condition !== null);
  assert.ok(branch);
  const invalid = (code_discovery: unknown) => ({
    ...evidence,
    normalized_result: { ...report, code_discovery },
  });
  expect(
    validate(
      invalid({
        ...graph,
        value_pages: graph.value_pages.map((page, index) =>
          index === 0
            ? {
                ...page,
                entries: page.entries.map((entry, position) =>
                  position === 0 ? { ...entry, leader: 2052 } : entry,
                ),
              }
            : page,
        ),
      }),
    ),
  ).toBe(false);
  expect(
    validate(
      invalid({
        ...graph,
        edges: graph.edges.map((edge) =>
          edge.index === branch.index
            ? { ...edge, value_snapshot: null }
            : edge,
        ),
      }),
    ),
  ).toBe(false);
  const corrupted = structuredClone(graph);
  corrupted.value_snapshots[0]!.pages[64] = graph.value_pages.length;
  expect(
    nesCodeDiscoveryReportSchema.safeParse({
      ...report,
      code_discovery: corrupted,
    }).success,
  ).toBe(false);
  return true;
}

cliTest(
  "retains current RAM values and independent conditional/write proofs through actual CLI/default SDK",
  async ({ cli }) => {
    const workspace = await createTestTempDirectory("rea-discovery-values-");
    const client = await connectTestMcp("nes-discovery-current-values-oracle");
    const delivery = await createToolDelivery(client, cli, workspace);
    const { contract } = delivery;
    let checkedMalformed = false;

    const invoke = async (command: string, input: Record<string, unknown>) => {
      expect(command).toBe("discover-nes-code");
      const evidence = await delivery.invoke(command, input);
      if (!checkedMalformed)
        checkedMalformed = rejectMalformedValues(
          evidence,
          contract("discover_nes_code").output,
        );
      nesCodeDiscoveryReportSchema.parse(evidence.normalized_result);
      return evidence;
    };
    expect(
      await verifyPackageNesDiscoveryValues(invoke, workspace),
    ).toMatchObject({
      ok: true,
      workflows: 10,
      stable_ram_recursion: true,
      mirrored_current_aliases: true,
      ram_only_predicates: true,
      nonconvex_stores: true,
      independent_equal_values: true,
      relative_and_physical_stack_domains: true,
      independent_io_reads: true,
      matched_call_ram_effects: true,
      unknown_store_invalidation: true,
      joined_initial_and_writer_sources: true,
      value_state_budget: true,
      original_unchanged: true,
    });
    expect(checkedMalformed).toBe(true);
    const validate = contract("discover_nes_code");
    expect(
      validate.input({
        path: "/invalid.nes",
        initial: { mapper: 0 },
        max_value_state_records: 0,
      }),
    ).toBe(false);
  },
  180000,
);
