import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { expect } from "vitest";
import { verifyPackageNesDma } from "../../../scripts/verify-package-nes-dma.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "retains ordered OAM DMA source cycles, independent commits and partial frontiers through real CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cpu-dma-");
    const client = await connectTestMcp("cpu-dma-oracle");
    const delivery = await createToolDelivery(client, cli);
    const { invoke } = delivery;
    expect(await verifyPackageNesDma(invoke, root)).toMatchObject({
      ok: true,
      workflows: 11,
    });
    const malformed = {
      path: "/irrelevant.nes",
      initial: { mapper: 0 },
      initial_cpu_dma: {
        model: "oam-cpu-dma",
        region: "ntsc",
        cpu_phase: "odd",
      },
    };
    expect(delivery.contract("trace_nes_code").input(malformed)).toBe(false);
    expect(
      (
        await client.callTool({
          name: "trace_nes_code",
          arguments: malformed,
        })
      ).isError,
    ).toBe(true);
  },
  240000,
);
