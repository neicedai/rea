import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { expect } from "vitest";
import { verifyPackageNesIrem78 } from "../../../scripts/verify-package-nes-irem78.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives Cosmo Carrier/Holy Diver old-bank AND conflicts, source continuation and CIRAM through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-irem78-");
    const client = await connectTestMcp("irem78-independent-oracle");
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(await verifyPackageNesIrem78(invoke, root)).toMatchObject({
      ok: true,
      workflows: 27,
      bus_conflicts: true,
      variant_mirroring: true,
      source_continuation: true,
      selector_uncertainty: true,
      original_unchanged: true,
    });
    const { definition, input: validateInput } = delivery.contract(
      "trace_nes_mapper_events",
    );
    for (const initial of [
      { mapper: 78, latch: 1 },
      { mapper: 78, variant: "unknown", latch: 1 },
      { mapper: 78, variant: "cosmo-carrier", latch: 256 },
      { mapper: 78, variant: "holy-diver", bus_conflicts: "none" },
    ]) {
      const invalid = { path: "/invalid.nes", initial, events: [] };
      expect(validateInput(invalid)).toBe(false);
      expect(
        (await client.callTool({ name: definition.name, arguments: invalid }))
          .isError,
      ).toBe(true);
    }
  },
  180000,
);
