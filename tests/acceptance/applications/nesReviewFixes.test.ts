import {
  mcpContractsFor,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { nesMapperTraceReportSchema } from "../../../src/domain/nesMapperTrace.js";
import { nesMapperEventsReportSchema } from "../../../src/domain/nesMapperEvents.js";
import { nesCodeExplorationReportSchema } from "../../../src/domain/nesCodeExploration.js";
import { verifyNesDiscoveryRetainedDelivery } from "../../../scripts/verify-package-nes-discovery-delivery.mjs";
import { verifyPackageNesReviewFixes } from "../../../scripts/verify-package-nes-review-fixes.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "retains complete large FME7 traces and MMC3 DMA-budget views through actual CLI/default SDK",
  async ({ cli }) => {
    const workspace = await createTestTempDirectory("rea-nes-review-fixes-");
    const client = await connectTestMcp("nes-review-fix-oracle");

    const contract = await mcpContractsFor(client);
    const lifecycle = async (name: string, input: Record<string, unknown>) => {
      const validate = contract(name);
      expect(validate.input(input), JSON.stringify(validate.input.errors)).toBe(
        true,
      );
      const response = await client.callTool({ name, arguments: input });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      expect(
        validate.output(response.structuredContent),
        JSON.stringify(validate.output.errors),
      ).toBe(true);
      return response.structuredContent;
    };
    let workflows = 0;
    const invoke = async (command: string, input: Record<string, unknown>) => {
      const name = command.replaceAll("-", "_"),
        validate = contract(name),
        inputPath = join(workspace, `review-request-${++workflows}.json`);
      expect(validate.input(input), JSON.stringify(validate.input.errors)).toBe(
        true,
      );
      await writeFile(inputPath, JSON.stringify(input));
      const response = await client.callTool(
        { name, arguments: input },
        { timeout: 180000 },
      );
      const compiled = await cli.run({
        arguments: [command, inputPath, "--json"],
        timeoutMs: 180000,
      });
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      expect(
        validate.output(compiled.json),
        JSON.stringify(validate.output.errors),
      ).toBe(true);
      const evidence = parseEvidence(compiled.json);
      if (name === "trace_nes_mapper_writes")
        nesMapperTraceReportSchema.parse(evidence.normalized_result);
      else if (name === "trace_nes_mapper_events")
        nesMapperEventsReportSchema.parse(evidence.normalized_result);
      else {
        expect(name).toBe("explore_nes_code");
        nesCodeExplorationReportSchema.parse(evidence.normalized_result);
      }
      if (response.isError === true)
        await verifyNesDiscoveryRetainedDelivery({
          operation: name,
          response,
          evidence,
          workspace,
          invoke: lifecycle,
          validateBundle: (bundle) => {
            expect(
              contract("get_evidence_bundle").output({ result: bundle }),
            ).toBe(true);
            parseEvidenceBundle(bundle);
          },
        });
      else {
        expect(
          validate.output(response.structuredContent),
          JSON.stringify(validate.output.errors),
        ).toBe(true);
        expect(compiled.json).toEqual(response.structuredContent);
        expect(response.content).toHaveLength(1);
        const content = response.content[0];
        assert.ok(content?.type === "text");
        const textValue: unknown = JSON.parse(content.text);
        expect(
          validate.output(textValue),
          JSON.stringify(validate.output.errors),
        ).toBe(true);
        expect(parseEvidence(textValue)).toEqual(evidence);
      }
      return compiled.json;
    };
    expect(await verifyPackageNesReviewFixes(invoke, workspace)).toMatchObject({
      ok: true,
      workflows: 4,
      supplied_writes: 16644,
      complete_fme7_views: 8193,
      complete_event_views: true,
      oam_budget_views: true,
      dmc_budget_views: true,
      original_unchanged: true,
    });
    expect(workflows).toBe(4);
  },
  360000,
);
