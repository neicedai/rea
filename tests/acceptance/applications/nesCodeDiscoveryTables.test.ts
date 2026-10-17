import type { ValidateFunction } from "ajv";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { nesCodeDiscoveryReportSchema } from "../../../src/domain/nesCodeDiscovery.js";
import { verifyPackageNesDiscoveryTables } from "../../../scripts/verify-package-nes-discovery-tables.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";

function rejectInvalidPartitions(
  evidence: ReturnType<typeof parseEvidence>,
  report: ReturnType<typeof nesCodeDiscoveryReportSchema.parse>,
  validate: ValidateFunction<unknown>,
) {
  const graph = report.code_discovery;
  if (graph.status !== "derived") return { refined: false, pending: false };
  const replacements: Record<string, unknown>[] = [];
  const refined = graph.analyses.find(
    (analysis) => analysis.refinement !== null,
  );
  if (refined?.refinement !== undefined && refined.refinement !== null) {
    const refinement = refined.refinement;
    const invalid = {
      ...refined,
      refinement: { ...refinement, value: 256 },
    };
    replacements.push({
      analyses: graph.analyses.map((analysis) =>
        analysis.index === refined.index ? invalid : analysis,
      ),
    });
    replacements.push({
      analyses: graph.analyses.map((analysis) =>
        analysis.index === refined.index
          ? { ...analysis, register_relations_in: 3 }
          : analysis,
      ),
    });
    replacements.push({
      analyses: graph.analyses.map((analysis) =>
        analysis.index === refined.index
          ? {
              ...analysis,
              refinement: {
                ...refinement,
                equal_registers: [refinement.register, refinement.register],
              },
            }
          : analysis,
      ),
    });
    const proof = refinement.source_value;
    if (typeof proof === "object" && proof !== null) {
      const incompatible = proof.value ^ (proof.mask & -proof.mask);
      replacements.push({
        analyses: graph.analyses.map((analysis) =>
          analysis.index === refined.index
            ? {
                ...analysis,
                refinement: { ...refinement, value: incompatible },
              }
            : analysis,
        ),
      });
    }
  }
  const partition = graph.partitions.find((item) => item.selections.length > 0);
  if (partition !== undefined)
    replacements.push({
      partitions: graph.partitions.map((item) =>
        item.index === partition.index
          ? {
              ...item,
              selections: item.selections.map((selection) => ({
                ...selection,
                value: 256,
              })),
            }
          : item,
      ),
    });
  const edge = graph.edges.find((item) => item.target_partition_index !== null);
  if (edge !== undefined)
    replacements.push({
      edges: graph.edges.map((item) =>
        item.index === edge.index
          ? { ...item, target_partition_index: -1 }
          : item,
      ),
    });
  if (graph.pending_refinements.length > 0)
    replacements.push({
      pending_refinements: graph.pending_refinements.map((item) => ({
        ...item,
        next_value: -1,
      })),
    });
  for (const replacement of replacements)
    expect(
      validate({
        ...evidence,
        normalized_result: {
          ...report,
          code_discovery: { ...graph, ...replacement },
        },
      }),
    ).toBe(false);
  return {
    refined: refined !== undefined,
    pending: graph.pending_refinements.length > 0,
  };
}

cliTest(
  "keeps indexed NES table bytes, banks and computed returns paired through actual CLI/default-SDK schemas",
  async ({ cli }) => {
    const workspace = await createTestTempDirectory("rea-discovery-tables-");
    const client = await connectTestMcp("nes-discovery-tables-oracle");
    const { invoke: deliver, contract } = await createToolDelivery(
      client,
      cli,
      workspace,
    );
    const validateInput = contract("discover_nes_code").input,
      validateOutput = contract("discover_nes_code").output;
    let checkedRefinement = false,
      checkedPending = false;
    const invoke = async (command: string, input: Record<string, unknown>) => {
      expect(command).toBe("discover-nes-code");
      const evidenceValue = await deliver(command, input),
        evidence = parseEvidence(evidenceValue),
        report = nesCodeDiscoveryReportSchema.parse(evidence.normalized_result),
        guarded = rejectInvalidPartitions(evidence, report, validateOutput);
      checkedRefinement ||= guarded.refined;
      checkedPending ||= guarded.pending;
      return evidenceValue;
    };
    expect(
      await verifyPackageNesDiscoveryTables(invoke, workspace),
    ).toMatchObject({
      ok: true,
      workflows: 17,
      correlated_tables: true,
      complete_byte_domain: true,
      serial_contexts: true,
      wrapped_pointers: true,
      computed_returns: true,
      partition_budgets: true,
      original_unchanged: true,
    });
    expect(checkedRefinement).toBe(true);
    expect(checkedPending).toBe(true);
    for (const field of ["max_partitions", "max_partition_selections"]) {
      const malformed = {
        path: "/invalid.nes",
        initial: { mapper: 4 },
        [field]: 0,
      };
      expect(validateInput(malformed)).toBe(false);
      expect(
        (
          await client.callTool({
            name: "discover_nes_code",
            arguments: malformed,
          })
        ).isError,
      ).toBe(true);
    }
  },
  180000,
);
