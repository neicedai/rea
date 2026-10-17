import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  verifyPackageNesMmc5PpuMemory,
  mmc5PpuMemoryFixture,
  mmc5PpuMemoryMaximumInput,
  verifyMmc5PpuMemoryMaximumResult,
} from "../../../scripts/verify-package-nes-mmc5-ppu-memory.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "preserves shared MMC5 CIRAM/ExRAM/fill/zero sources and qualified background events through real CLI/default SDK schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc5-ppu-memory-");
    const client = await connectTestMcp("mmc5-ppu-memory-independent-oracle");
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(await verifyPackageNesMmc5PpuMemory(invoke, root)).toMatchObject({
      ok: true,
      workflows: 33,
      shared_exram: true,
      nametable_sources: true,
      cpu_buffer: true,
      source_replay: true,
      graphics_sources: true,
      qualified_background: true,
      exact_snoops: true,
      rollback: true,
      original_unchanged: true,
    });
  },
  180000,
);

cliTest(
  "retains all MMC5 maximum graphics sources through default SDK delivery or a recoverable response-budget constraint",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc5-maximum-delivery-");
    const path = join(root, "maximum.nes"),
      bytes = mmc5PpuMemoryFixture();
    await writeFile(path, bytes);
    const input = mmc5PpuMemoryMaximumInput(path);
    const client = await connectTestMcp("mmc5-maximum-default-sdk");
    const { invoke } = await createToolDelivery(client, cli, root);
    const evidence = await invoke("trace-nes-mapper-events", input);
    verifyMmc5PpuMemoryMaximumResult(evidence.normalized_result, bytes);
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  },
  180000,
);
