import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { expect } from "vitest";
import { verifyPackageNesEarlyMappers } from "../../../scripts/verify-package-nes-early-mappers.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives J87 and Namco76 source banks, partial selectors and fixed CIRAM through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-early-mappers-");
    const client = await connectTestMcp("early-mappers-independent-oracle");
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(await verifyPackageNesEarlyMappers(invoke, root)).toMatchObject({
      ok: true,
      workflows: 24,
      banking: true,
      mappers: [76, 87],
      selector_uncertainty: true,
      no_cartridge_ram: true,
      original_unchanged: true,
    });
    const { definition, input: validateInput } = delivery.contract(
      "trace_nes_mapper_events",
    );
    for (const initial of [
      { mapper: 76, banks: [1, 2, 3] },
      { mapper: 87, prg_bank: 1 },
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
