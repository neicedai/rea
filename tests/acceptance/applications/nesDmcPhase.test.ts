import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { expect } from "vitest";
import { verifyPackageNesDmcPhase } from "../../../scripts/verify-package-nes-dmc-phase.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives put-boundary reloads, late implicit discards and OAM tails through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-dmc-phase-");
    const client = await connectTestMcp("dmc-phase-oracle");
    const delivery = await createToolDelivery(client, cli);
    const { invoke } = delivery;
    expect(await verifyPackageNesDmcPhase(invoke, root)).toMatchObject({
      ok: true,
      workflows: 19,
      put_reload: true,
      late_discard: true,
      oam_tail: true,
      original_unchanged: true,
    });
  },
  180000,
);
