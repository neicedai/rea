import {
  connectTestMcp,
  mcpContractsFor,
} from "../../support/cliMcpDelivery.js";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { nesCodeDiscoveryReportSchema } from "../../../src/domain/nesCodeDiscovery.js";
import { verifyNesDiscoveryRetainedDelivery } from "../../../scripts/verify-package-nes-discovery-delivery.mjs";
import {
  THWAITE_SEMANTIC_PROFILE,
  verifyNesThwaiteSemantics,
} from "../../../scripts/verify-nes-thwaite-semantics.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const romArgument = process.env.REA_TEST_NES_THWAITE_ROM;

// The caller supplies an absolute original author ROM path. The golden verifies
// its pinned digest before analysis; this test never downloads or patches bytes.
cliTest.skipIf(!romArgument)(
  "recovers pinned original Thwaite state handlers and resource identities through CLI/default SDK",
  async ({ cli }) => {
    assert.ok(romArgument);
    assert.ok(
      isAbsolute(romArgument),
      "REA_TEST_NES_THWAITE_ROM must be absolute",
    );
    const workspace = await createTestTempDirectory("rea-thwaite-semantics-");
    const client = await connectTestMcp("nes-thwaite-semantic-golden");
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
    let calls = 0;
    const invoke = async (command: string, input: Record<string, unknown>) => {
      expect(command).toBe("discover-nes-code");
      expect(input.path).toBe(romArgument);
      const workflow = [
        { entry: 0xcda5, budget: 4000 },
        { entry: 0xe729, budget: 2 },
        { entry: 0xddeb, budget: 32 },
      ][calls];
      assert.ok(workflow);
      expect(input.roots).toEqual([workflow.entry]);
      expect(input.max_work_items).toBe(workflow.budget);
      const validate = contract("discover_nes_code");
      expect(validate.input(input), JSON.stringify(validate.input.errors)).toBe(
        true,
      );
      const response = await client.callTool({
        name: "discover_nes_code",
        arguments: input,
      });
      const compiled = await cli.run({
        arguments: [command, JSON.stringify(input), "--json"],
      });
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      expect(
        validate.output(compiled.json),
        JSON.stringify(validate.output.errors),
      ).toBe(true);
      const evidence = parseEvidence(compiled.json);
      nesCodeDiscoveryReportSchema.parse(evidence.normalized_result);
      assert.ok(evidence.subject);
      expect(evidence.subject.digest.sha256).toBe(
        THWAITE_SEMANTIC_PROFILE.rom_sha256,
      );
      if (response.isError === true) {
        expect(calls).toBe(0);
        await verifyNesDiscoveryRetainedDelivery({
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
      } else {
        expect(
          validate.output(response.structuredContent),
          JSON.stringify(validate.output.errors),
        ).toBe(true);
        expect(response.structuredContent).toEqual(compiled.json);
      }
      calls++;
      return compiled.json;
    };
    const result = await verifyNesThwaiteSemantics(invoke, romArgument);
    expect(calls).toBe(3);
    expect(result).toMatchObject({
      ok: true,
      workflows: 3,
      selector_domain: 128,
      level_records: 35,
      original_unchanged: true,
      known_branch: {
        entry: 0xe729,
        branch_address: 0xe72a,
        target: 0xe72f,
        condition: { flag: "c", value: false },
        pending_target: 0xe72f,
      },
      ram_reread: {
        entry: 0xddeb,
        branch_address: 0xddef,
        reread_address: 0xddf7,
        ram_address: 0,
        admitted_values: 254,
        independent_write_address: 2,
        initial_unwritten_possible: true,
        fabricated_initial_writers: false,
      },
      profile: {
        rom_sha256: THWAITE_SEMANTIC_PROFILE.rom_sha256,
        source_binary_bit_identical_build: "unknown",
      },
    });
    expect(result.verified_source_handlers).toHaveLength(8);
  },
  180000,
);
