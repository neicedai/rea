import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  verifyPackageNesVrc6PpuMemory,
  vrc6PpuMemoryMaximumInput,
  verifyVrc6PpuMemoryMaximumResult,
  vrc6PpuMemoryFixture,
} from "../../../scripts/verify-package-nes-vrc6-ppu-memory.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives VRC6 retained PPU bytes, mixed CIRAM/ROM writes, buffers and graphics through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc6-ppu-memory-");
    const client = await connectTestMcp("vrc6-ppu-memory-independent-oracle");
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(await verifyPackageNesVrc6PpuMemory(invoke, root)).toMatchObject({
      ok: true,
      workflows: 22,
      captured_memory: true,
      cpu_buffer: true,
      unknown_backing: true,
      graphics_sources: true,
      original_unchanged: true,
    });
    const { definition, input: validateInput } = delivery.contract(
      "trace_nes_mapper_events",
    );
    for (const initial of [
      { mapper: 24, chr_banks: [1, 2] },
      { mapper: 26, control: 256 },
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

cliTest(
  "retains all VRC6 maximum graphics candidates through default SDK delivery or an explicit recoverable transport constraint",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-vrc6-maximum-delivery-");
    const path = join(root, "maximum.nes"),
      bytes = vrc6PpuMemoryFixture(24);
    await writeFile(path, bytes);
    const input = vrc6PpuMemoryMaximumInput(path);
    const client = await connectTestMcp("vrc6-maximum-default-sdk");
    const { invoke } = await createToolDelivery(client, cli, root);
    const evidence = await invoke("trace-nes-mapper-events", input);
    verifyVrc6PpuMemoryMaximumResult(evidence.normalized_result, bytes);
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  },
  180000,
);
