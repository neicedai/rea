import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { expect } from "vitest";
import { verifyPackageNesVrc3 } from "../../../scripts/verify-package-nes-vrc3.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives Vrc3 source banks, CHR RAM uploads and 8/16-bit IRQ continuation through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc3-");
    const client = await connectTestMcp("vrc3-independent-oracle");
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(await verifyPackageNesVrc3(invoke, root)).toMatchObject({
      ok: true,
      workflows: 24,
      banking: true,
      ram_provenance: true,
      chr_upload: true,
      irq_continuation: true,
      original_unchanged: true,
    });
    const { definition, input: validateInput } = delivery.contract(
      "trace_nes_mapper_events",
    );
    for (const initial of [
      { mapper: 73, irq_latch_nibbles: [1, 2, 3] },
      { mapper: 73, variant: "vrc3" },
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
