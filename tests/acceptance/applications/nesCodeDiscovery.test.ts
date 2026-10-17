import type { ValidateFunction } from "ajv";
import { expect } from "vitest";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { nesCodeDiscoveryReportSchema } from "../../../src/domain/nesCodeDiscovery.js";
import { verifyPackageNesDiscovery } from "../../../scripts/verify-package-nes-discovery.mjs";
import { isNesDiscoveryLoopDeliveryInput } from "../../../scripts/verify-package-nes-discovery-delivery.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";

function rejectMalformedOutput(
  evidence: ReturnType<typeof parseEvidence>,
  report: ReturnType<typeof nesCodeDiscoveryReportSchema.parse>,
  validate: ValidateFunction<unknown>,
): boolean {
  const graph = report.code_discovery;
  if (
    graph.status !== "derived" ||
    graph.nodes.length === 0 ||
    graph.edges.length === 0 ||
    graph.data_references.length === 0
  )
    return false;
  const corrupted = [
    {
      ...graph,
      nodes: graph.nodes.map((node, index) =>
        index === graph.nodes.length - 1
          ? { ...node, context_index: -1 }
          : node,
      ),
    },
    {
      ...graph,
      edges: graph.edges.map((edge, index) =>
        index === graph.edges.length - 1 ? { ...edge, from: -1 } : edge,
      ),
    },
    {
      ...graph,
      data_references: graph.data_references.map((reference, index) =>
        index === graph.data_references.length - 1
          ? { ...reference, file_offsets: [-1] }
          : reference,
      ),
    },
  ];
  for (const code_discovery of corrupted)
    expect(
      validate({
        ...evidence,
        normalized_result: { ...report, code_discovery },
      }),
    ).toBe(false);
  return true;
}

cliTest(
  "discovers rooted NES CFGs, correlated bank targets and physical references through actual CLI/default-SDK schemas",
  async ({ cli }) => {
    const workspace = await createTestTempDirectory("rea-nes-discovery-");
    const client = await connectTestMcp("nes-static-discovery-oracle");
    const { invoke: deliver, contract } = await createToolDelivery(
      client,
      cli,
      workspace,
    );
    let checkedMalformedOutput = false,
      checkedLoopDelivery = false;
    const invoke = async (command: string, input: Record<string, unknown>) => {
      const evidenceValue = await deliver(command, input),
        evidence = parseEvidence(evidenceValue),
        report = nesCodeDiscoveryReportSchema.parse(evidence.normalized_result);
      if (!checkedMalformedOutput)
        checkedMalformedOutput = rejectMalformedOutput(
          evidence,
          report,
          contract("discover_nes_code").output,
        );
      // Loop delivery can be inline or recovered at the unchanged default cap.
      if (isNesDiscoveryLoopDeliveryInput(input)) checkedLoopDelivery = true;
      return evidenceValue;
    };
    expect(await verifyPackageNesDiscovery(invoke, workspace)).toMatchObject({
      ok: true,
      workflows: 16,
      rooted_cfg: true,
      raw_context_identity: true,
      mmc1_serial_context: true,
      correlated_dispatch: true,
      physical_coverage: true,
      original_unchanged: true,
    });
    expect(checkedMalformedOutput).toBe(true);
    expect(checkedLoopDelivery).toBe(true);
    const validate = contract("discover_nes_code");
    for (const invalid of [
      { max_nodes: 0 },
      { max_work_items: 0 },
      { max_contexts: 0 },
      { roots: [65536] },
      { roots: ["all"] },
      { initial: { mapper: 4, banks: [0] } },
      { additional_roots: [{ entry: 32768, initial: { mapper: 999 } }] },
      { cpu: { a: 1 } },
    ]) {
      const input = {
        path: "/invalid.nes",
        initial: { mapper: 4 },
        ...invalid,
      };
      expect(validate.input(input), JSON.stringify(input)).toBe(false);
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
