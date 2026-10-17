import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { expect } from "vitest";
import { verifyPackageNesSunsoft4 } from "../../../scripts/verify-package-nes-sunsoft4.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives Sunsoft4 source banks, ROM nametables, mixed PPU owners and RAM gates through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sunsoft4-");
    const client = await connectTestMcp("sunsoft4-independent-oracle");
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(await verifyPackageNesSunsoft4(invoke, root)).toMatchObject({
      ok: true,
      workflows: 25,
      banking: true,
      ram_provenance: true,
      rom_nametables: true,
      unknown_mux: true,
      original_unchanged: true,
    });
    const { definition, input: validateInput } = delivery.contract(
      "trace_nes_mapper_events",
    );
    for (const initial of [
      { mapper: 68, variant: "normal", chr_banks: [1, 2, 3] },
      { mapper: 68 },
      { mapper: 68, variant: "dualcart" },
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
