import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { expect } from "vitest";
import { verifyPackageNesCpuIo } from "../../../scripts/verify-package-nes-cpu-io.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves 2A03 bus latches and DMA I/O conflicts through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cpu-io-");
    const client = await connectTestMcp("cpu-io-oracle");
    const delivery = await createToolDelivery(client, cli);
    const { invoke } = delivery;
    expect(await verifyPackageNesCpuIo(invoke, root)).toMatchObject({
      ok: true,
      workflows: 19,
    });
    const invalid = {
      path: "/irrelevant.nes",
      initial: { mapper: 0 },
      initial_cpu_io: {
        model: "2a03-io",
        controller_clocking: "contiguous",
        active_controller: 0,
        cpu_latch: 0,
        external_latch: null,
        latch_origins: {
          cpu: [
            { mask: 255, source: { kind: "initial-latch", line: "cpu" } },
            { mask: 1, source: { kind: "initial-latch", line: "cpu" } },
          ],
          external: [],
        },
      },
    };
    expect(delivery.contract("trace_nes_code").input(invalid)).toBe(false);
    expect(
      (await client.callTool({ name: "trace_nes_code", arguments: invalid }))
        .isError,
    ).toBe(true);
  },
  240000,
);
