import {
  createStdioToolClient,
  mcpContractsFor,
} from "../../support/cliMcpDelivery.js";
import assert from "node:assert/strict";
import { isAbsolute } from "node:path";

import { expect } from "vitest";

import { parseEvidence } from "../../../src/domain/evidence.js";
import { parseEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import { nesCodeDiscoveryReportSchema } from "../../../src/domain/nesCodeDiscovery.js";
import { nesCodeTraceReportSchema } from "../../../src/domain/nesCodeTrace.js";
import { nesCartridgeSchema } from "../../../src/domain/nesCartridge.js";
import { verifyNesDiscoveryRetainedDelivery } from "../../../scripts/verify-package-nes-discovery-delivery.mjs";
import {
  verifyNesNovaSemantics,
  verifyNesMmc3DemoSemantics,
  type BankedSemanticInvoke,
} from "../../../scripts/verify-nes-banked-semantics.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const novaPath = process.env.REA_TEST_NES_NOVA_ROM;
const mmc3Path = process.env.REA_TEST_NES_MMC3_DEMO_ROM;

function cliArguments(command: string, input: Record<string, unknown>) {
  if (command !== "inspect-nes-cartridge")
    return [command, JSON.stringify(input), "--json"];
  assert.equal(typeof input.chr_page, "number");
  assert.ok(typeof input.path === "string");
  return [command, input.path, "--chr-page", String(input.chr_page), "--json"];
}

async function originalGolden<Result>(
  cli: TestCli,
  path: string,
  verify: (invoke: BankedSemanticInvoke, path: string) => Promise<Result>,
): Promise<Result> {
  assert.ok(
    isAbsolute(path),
    "Original ROM paths must be explicit and absolute",
  );
  const workspace = await createTestTempDirectory("rea-banked-semantics-");
  const connection = createStdioToolClient("nes-author-banked-semantics");
  const { client, transport } = connection;
  try {
    await client.connect(transport);
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
    const invoke: BankedSemanticInvoke = async (command, input) => {
      expect(input.path).toBe(path);
      const name = command.replaceAll("-", "_"),
        validate = contract(name);
      expect(validate.input(input), JSON.stringify(validate.input.errors)).toBe(
        true,
      );
      const response = await client.callTool({ name, arguments: input }),
        compiled = await cli.run({ arguments: cliArguments(command, input) });
      expect(compiled.exitCode, compiled.stderr).toBe(0);
      expect(
        validate.output(compiled.json),
        JSON.stringify(validate.output.errors),
      ).toBe(true);
      const evidence = parseEvidence(compiled.json);
      if (command === "discover-nes-code")
        nesCodeDiscoveryReportSchema.parse(evidence.normalized_result);
      else if (command === "trace-nes-code")
        nesCodeTraceReportSchema.parse(evidence.normalized_result);
      else {
        expect(command).toBe("inspect-nes-cartridge");
        nesCartridgeSchema.parse(evidence.normalized_result);
      }
      if (response.isError === true) {
        expect(command).toBe("discover-nes-code");
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
      return compiled.json;
    };
    return await verify(invoke, path);
  } finally {
    await connection.close();
  }
}

// Each author-original ROM is opt-in independently. No download, build, ROM
// patch, emulator, gameplay run or silently injected RAM image occurs here.
cliTest.skipIf(!novaPath)(
  "derives pinned original Nova MMC1 serial banks and 32KiB NVRAM isolation through CLI/default SDK",
  async ({ cli }) => {
    assert.ok(novaPath);
    const result = await originalGolden(cli, novaPath, verifyNesNovaSemantics);
    expect(result).toMatchObject({
      ok: true,
      workflows: 5,
      requested_path: novaPath,
      bank6_original_fetch: true,
      serial_control: true,
      nvram_capacity: 32768,
      ram_bank_isolation: [0, 3],
      ram_permission_qualification: true,
      original_unchanged: true,
      profile: { source_binary_bit_identical_build: "unknown" },
    });
    expect(result.evidence_ids).toHaveLength(5);
    expect(result.ram_query_assumptions).toEqual(
      [0, 1, 2, 3].map((bank) => ({
        bank,
        address: 0x7fff,
        value: 0xa0 + bank,
      })),
    );
  },
  180000,
);
cliTest.skipIf(!mmc3Path)(
  "derives the author's pinned MMC3 demo windows and complete physical CHR resources through CLI/default SDK",
  async ({ cli }) => {
    assert.ok(mmc3Path);
    const result = await originalGolden(
      cli,
      mmc3Path,
      verifyNesMmc3DemoSemantics,
    );
    expect(result).toMatchObject({
      ok: true,
      workflows: 5,
      requested_path: mmc3Path,
      original_dual_windows: true,
      known_setter_branch: true,
      complete_chr_blocks: ["Alpha.chr", "Gears.chr"],
      examined_chr_tiles: 1024,
      original_unchanged: true,
      profile: {
        kind: "author teaching/demo; not a complete game golden",
        source_binary_bit_identical_build: "unknown",
      },
    });
    expect(result.evidence_ids).toHaveLength(5);
  },
  180000,
);
