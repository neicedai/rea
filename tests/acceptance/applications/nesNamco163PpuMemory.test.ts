import {
  createToolDelivery,
  connectTestMcp,
} from "../../support/cliMcpDelivery.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import {
  verifyPackageNesNamco163PpuMemory,
  namco163PpuMemoryMaximumInput,
  verifyNamco163PpuMemoryMaximumResult,
  namco163PpuMemoryFixture,
} from "../../../scripts/verify-package-nes-namco163-ppu-memory.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives Namco163 retained PPU bytes, mixed CIRAM/ROM writes, buffers and graphics through real CLI/MCP schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-namco163-ppu-memory-");
    const client = await connectTestMcp(
      "namco163-ppu-memory-independent-oracle",
    );
    const delivery = await createToolDelivery(client, cli, root);
    const { invoke } = delivery;
    expect(await verifyPackageNesNamco163PpuMemory(invoke, root)).toMatchObject(
      {
        ok: true,
        workflows: 23,
        shared_ciram: true,
        debug_uncertainty: true,
        cpu_buffer: true,
        unknown_backing: true,
        graphics_sources: true,
        original_unchanged: true,
      },
    );
    const { definition, input: validateInput } = delivery.contract(
      "trace_nes_mapper_events",
    );
    for (const initial of [
      { mapper: 19, variant: "namco163", chr_banks: [1, 2] },
      { mapper: 19, variant: "namco163", nametable_banks: [1] },
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
  "retains all Namco163 maximum graphics candidates through default SDK delivery or an explicit recoverable transport constraint",
  async ({ cli }) => {
    const root = await createTestTempDirectory(
      "rea-namco163-maximum-delivery-",
    );
    const path = join(root, "maximum.nes"),
      bytes = namco163PpuMemoryFixture();
    await writeFile(path, bytes);
    const input = namco163PpuMemoryMaximumInput(path);
    const client = await connectTestMcp("namco163-maximum-default-sdk");
    const { invoke } = await createToolDelivery(client, cli, root);
    const evidence = await invoke("trace-nes-mapper-events", input);
    verifyNamco163PpuMemoryMaximumResult(evidence.normalized_result, bytes);
    expect(await readFile(path)).toEqual(Buffer.from(bytes));
  },
  180000,
);
