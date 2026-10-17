import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { expect } from "vitest";
import { verifyPackageNesSunsoft3 } from "../../../scripts/verify-package-nes-sunsoft3.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives Sunsoft3 source banks, live IRQ writes, CIRAM and RAM continuation through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sunsoft3-");
    const client = await connectTestMcp("sunsoft3-independent-oracle");
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(await verifyPackageNesSunsoft3(invoke, root)).toMatchObject({
      ok: true,
      workflows: 21,
      banking: true,
      ram_provenance: true,
      irq_continuation: true,
      original_unchanged: true,
    });
    const { definition, input: validateInput } = delivery.contract(
      "trace_nes_mapper_events",
    );
    for (const initial of [
      { mapper: 67, chr_banks: [1, 2, 3] },
      { mapper: 67, variant: "sunsoft3" },
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
