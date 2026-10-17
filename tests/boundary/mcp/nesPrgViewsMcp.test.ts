import { createApplicationMcpHarness } from "../../fixtures/applicationMcpHarness.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { ok } from "../../../src/domain/result.js";

import { silentLogger } from "../../../src/logger.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("NES view selection over MCP", () => {
  it("advertises and forwards complete states while distinguishing omission", async () => {
    const directory = await createTestTempDirectory("rea-mcp-nes-views-");
    const path = join(directory, "fixture.js");
    const bytes = Buffer.alloc(16 + 0x8000 + 0x2000);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0x40]);
    await writeFile(path, bytes);
    const provider = createCacheProvider([]);
    const session = createTestBinarySession(provider, {
      resolveAnalysisProfile: async (target) =>
        ok({
          profile: createAnalysisProfile(
            { id: "fixture", name: "Fixture analysis provider", version: "1" },
            {
              nes_prg_views:
                target.format === "nes"
                  ? (target.nesPrgViews?.map((view) => ({ ...view })) ?? null)
                  : null,
            },
          ),
        }),
    });
    const { client, close: closeMcp } = await createApplicationMcpHarness({
      session,
      identity: { name: "nes-views-test", version: "1" },
      serverOptions: { logger: silentLogger },
    });

    try {
      const catalog = await client.listTools();
      const open = catalog.tools.find((tool) => tool.name === "open_binary");
      expect(open?.inputSchema.properties).toHaveProperty("nes_prg_views");
      const nes_prg_views = [{ mapper: 4, prg_mode: 1, r6: 2, r7: 3 }];
      const selected = await client.callTool({
        name: "open_binary",
        arguments: { path, nes_prg_views },
      });
      expect(selected.isError).not.toBe(true);
      expect(session.activeTarget()).toMatchObject({
        nesPrgViews: nes_prg_views,
      });
      const selectedDigest = session.analysisProfile()?.digest;
      const omitted = await client.callTool({
        name: "open_binary",
        arguments: { path },
      });
      expect(omitted.isError).not.toBe(true);
      expect(session.activeTarget()).toMatchObject({ format: "nes" });
      expect(session.activeTarget()).not.toHaveProperty("nesPrgViews");
      expect(session.analysisProfile()?.digest).not.toBe(selectedDigest);
      const invalid = await client.callTool({
        name: "open_binary",
        arguments: {
          path,
          nes_prg_views: [{ mapper: 4, prg_mode: 1, r6: 2 }],
        },
      });
      expect(invalid.isError).toBe(true);
      expect(session.activeTarget()).not.toHaveProperty("nesPrgViews");
    } finally {
      await closeMcp();
    }
  });
});
