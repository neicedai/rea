import assert from "node:assert/strict";
import { expect } from "vitest";
import { z } from "zod";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { nesCodeDiscoveryReportSchema } from "../../../src/domain/nesCodeDiscovery.js";
import { verifyPackageNesDiscoveryDomains } from "../../../scripts/verify-package-nes-discovery-domains.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";

cliTest(
  "preserves exact NES byte domains and independent flag sources through CLI/default SDK",
  async ({ cli }) => {
    const workspace = await createTestTempDirectory("rea-discovery-domains-");
    const client = await connectTestMcp("nes-discovery-domains-oracle");
    const { invoke: deliver, contract } = await createToolDelivery(
      client,
      cli,
      workspace,
    );
    const validateOutput = contract("discover_nes_code").output;
    const record = z.record(z.string(), z.unknown());
    let checkedWire = false;
    const invoke = async (command: string, input: Record<string, unknown>) => {
      expect(command).toBe("discover-nes-code");
      const evidenceValue = await deliver(command, input),
        evidence = parseEvidence(evidenceValue),
        report = nesCodeDiscoveryReportSchema.parse(evidence.normalized_result);
      if (!checkedWire && report.code_discovery.status === "derived") {
        const graph = report.code_discovery;
        const altered = structuredClone(evidenceValue) as Record<
          string,
          unknown
        >;
        const normalized = record.parse(altered.normalized_result);
        const corrupted = record.parse(normalized.code_discovery);
        const domains = z.array(record).parse(corrupted.byte_domains);
        domains[0]!.bitmap_hex = "ff";
        corrupted.byte_domains = domains;
        normalized.code_discovery = corrupted;
        altered.normalized_result = normalized;
        expect(validateOutput(altered)).toBe(false);
        const branch = graph.edges.find((edge) => edge.condition !== null);
        assert.ok(branch);
        const invalid = {
          ...evidence,
          normalized_result: {
            ...report,
            code_discovery: {
              ...graph,
              edges: graph.edges.map((edge) =>
                edge.index === branch.index
                  ? { ...edge, register_domains: null }
                  : edge,
              ),
            },
          },
        };
        expect(validateOutput(invalid)).toBe(false);
        checkedWire = true;
      }
      return evidenceValue;
    };
    expect(
      await verifyPackageNesDiscoveryDomains(invoke, workspace),
    ).toMatchObject({
      ok: true,
      workflows: 12,
      exact_ranges: true,
      wrapped_compare_negative: true,
      result_predicates: true,
      independent_flag_sources: true,
      semantic_copies: true,
      nonconvex_joins: true,
      call_domain_effects: true,
      banked_domain_effects: true,
      budget_frontiers: true,
      correlated_rotations: true,
      original_unchanged: true,
    });
    expect(checkedWire).toBe(true);
  },
  180000,
);
