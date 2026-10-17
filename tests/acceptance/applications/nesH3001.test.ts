import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { expect } from "vitest";
import { verifyPackageNesH3001 } from "../../../scripts/verify-package-nes-h3001.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives H3001 swapped source banks, CIRAM, RAM and qualified IRQ continuation through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-h3001-");
    const client = await connectTestMcp("h3001-independent-oracle");
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(await verifyPackageNesH3001(invoke, root)).toMatchObject({
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
      { mapper: 65, prg_banks: [1, 2, 3] },
      { mapper: 65, variant: "h3001" },
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
