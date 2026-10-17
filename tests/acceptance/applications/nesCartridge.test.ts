import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import type { Client } from "@modelcontextprotocol/client";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nesCartridgeSchema } from "../../../src/domain/nesCartridge.js";
import { nesCartridgeFixture } from "../../../src/native/nes/NesCartridge.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const contract = toolContract("inspect_nes_cartridge");

const inspectBoth = async (
  cli: TestCli,
  client: Client,
  path: string,
  page: number,
) => {
  const result = await cli.run({
    arguments: [
      "inspect-nes-cartridge",
      path,
      "--chr-page",
      String(page),
      "--json",
    ],
  });
  expect(result.exitCode).toBe(0);
  const evidence = contract.outputSchema.parse(result.json);
  const response = await client.callTool({
    name: contract.name,
    arguments: { path, chr_page: page },
  });
  expect(response.isError).not.toBe(true);
  const mcp = contract.outputSchema.parse(response.structuredContent);
  expect(mcp.evidence_id).toBe(evidence.evidence_id);
  expect(mcp.normalized_result).toEqual(evidence.normalized_result);
  const text = response.content.find((item) => item.type === "text");
  if (text?.type !== "text") throw new Error("Missing text Evidence");
  expect(contract.outputSchema.parse(JSON.parse(text.text)).evidence_id).toBe(
    evidence.evidence_id,
  );
  expect(evidence.subject?.digest).toMatchObject({
    sha256: createHash("sha256")
      .update(await readFile(path))
      .digest("hex"),
  });
  return nesCartridgeSchema.parse(evidence.normalized_result);
};

const inspectGraphics = async (cli: TestCli, client: Client, root: string) => {
  const path = join(root, "trainer.nes");
  const bytes = nesCartridgeFixture({ trainer: true });
  await writeFile(path, bytes);
  const first = await inspectBoth(cli, client, path, 0);
  const offset = 16 + 512 + 32768;
  expect(first.header.trainer).toEqual({ offset: 16, size: 512 });
  expect(first.chr).toMatchObject({
    total_pages: 2,
    next_page: 1,
    total_tiles: 512,
    location: { offset, size: 4096 },
    palette: null,
    ppu_mapping: "unknown",
  });
  expect(first.chr.tiles[0]).toEqual({
    index: 0,
    file_offset: offset,
    rows: ["32103210", "10000002", ...Array<string>(6).fill("00000000")],
  });
  expect(first.chr.bytes_hex).toBe(
    bytes.subarray(offset, offset + 4096).toString("hex"),
  );
  const second = await inspectBoth(cli, client, path, 1);
  expect(second.chr.next_page).toBeNull();
  expect(second.chr.tiles[0]).toEqual({
    index: 256,
    file_offset: offset + 4096,
    rows: Array<string>(8).fill("33333333"),
  });
  expect(await readFile(path)).toEqual(bytes);
};

const inspectUnmodeled = async (cli: TestCli, client: Client, root: string) => {
  const path = join(root, "unmodeled-mapper.nes");
  const bytes = nesCartridgeFixture({ mapper: 255 });
  bytes[7] = 0xf8;
  bytes[8] = 15; // NES 2.0 mapper 4095, outside the admitted board models.
  await writeFile(path, bytes);
  const unsupported = await inspectBoth(cli, client, path, 0);
  expect(unsupported.header.mapper).toBe(4095);
  expect(unsupported.prg_layout.status).toBe("unmodeled");
  expect(unsupported.chr.tiles).toHaveLength(256);
  const ramPath = join(root, "chr-ram.nes");
  await writeFile(ramPath, nesCartridgeFixture({ chrRam: true }));
  const ram = await inspectBoth(cli, client, ramPath, 0);
  expect(ram.chr).toMatchObject({
    status: "no-chr-rom",
    total_pages: 0,
    total_tiles: 0,
    next_page: null,
    bytes_hex: "",
    tiles: [],
    ppu_mapping: "unknown",
  });
  const partial = nesCartridgeFixture().subarray(0, 16 + 32768 + 24);
  partial[7] = 8;
  partial[9] = 0xf0;
  partial[5] = 13; // NES 2.0 exponent form: 2^3 * 3 = 24 bytes.
  partial.fill(0xab, partial.length - 8);
  const partialPath = join(root, "partial.nes");
  await writeFile(partialPath, partial);
  const tail = await inspectBoth(cli, client, partialPath, 0);
  expect(tail.header.headerVersion).toBe("nes2");
  expect(tail.chr).toMatchObject({
    total_tiles: 1,
    total_pages: 1,
    incomplete_tile_bytes: 8,
    next_page: null,
  });
  expect(tail.chr.tiles).toHaveLength(1);
  expect(tail.chr.bytes_hex).toBe(partial.subarray(16 + 32768).toString("hex"));
};

cliTest(
  "inspects NES source graphics through compiled CLI and stdio MCP without a disassembler",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-nes-cartridge-acceptance-");
    const client = await connectTestMcp("nes-cartridge-acceptance");
    expect((await client.listTools()).tools).toContainEqual(
      expect.objectContaining({
        name: contract.name,
        annotations: expect.objectContaining({
          readOnlyHint: false,
          openWorldHint: false,
        }),
      }),
    );
    const session = await client.callTool({
      name: "binary_session",
      arguments: {},
    });
    expect(JSON.stringify(session.structuredContent)).toContain(contract.name);
    await inspectGraphics(cli, client, root);
    await inspectUnmodeled(cli, client, root);
    const path = join(root, "trainer.nes");
    for (const [args, options] of [
      [["--chr-page", "2"], { chr_page: 2 }],
      [["--max-file-bytes", "16"], { max_file_bytes: 16 }],
    ] as const) {
      const result = await cli.run({
        arguments: ["inspect-nes-cartridge", path, ...args, "--json"],
      });
      expect(result.exitCode).toBe(1);
      const rejected = await client.callTool({
        name: contract.name,
        arguments: { path, ...options },
      });
      expect(rejected.isError).toBe(true);
      expect(parseMcpToolError(rejected)).toEqual({ error: result.json });
    }
    for (const args of [
      { path, chr_page: -1 },
      { path, chr_page: 0.5 },
      { path: "relative.nes" },
      { path, extra: true },
    ]) {
      expect(
        (await client.callTool({ name: contract.name, arguments: args }))
          .isError,
      ).toBe(true);
    }
    await client.ping();
  },
  60_000,
);
