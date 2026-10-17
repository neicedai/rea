import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import type { NesPrgView } from "../../../src/domain/nesPrgViews.js";
import { ok } from "../../../src/domain/result.js";
import {
  createCacheProvider,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("NES view selection and session identity", () => {
  it("reuses a reordered state set, but reopens for omission, explicit defaults, and changed states", async () => {
    const directory = await createTestTempDirectory("rea-session-nes-views-");
    const path = join(directory, "fixture.nes");
    const bytes = Buffer.alloc(16 + 0x8000 + 0x2000);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0x10]);
    await writeFile(path, bytes);
    let resolutions = 0;
    const provider = createCacheProvider([]);
    const session = createTestBinarySession(provider, {
      resolveAnalysisProfile: async (target) => {
        resolutions++;
        return ok({
          profile: createAnalysisProfile(
            { id: "fixture", name: "Fixture analysis provider", version: "1" },
            {
              nes_prg_views:
                target.format === "nes"
                  ? (target.nesPrgViews?.map((view) => ({ ...view })) ?? null)
                  : null,
            },
          ),
        });
      },
    });
    const open = async (nesPrgViews?: readonly NesPrgView[]) => {
      const result = await session.open(
        path,
        nesPrgViews === undefined ? {} : { nesPrgViews },
      );
      if (!result.ok) throw result.error;
      return session.analysisProfile()?.digest;
    };
    try {
      const omitted = await open();
      const defaults = [{ mapper: 1, prg_mode: 3, prg_bank: 0 }] as const;
      const explicit = await open(defaults);
      expect(explicit).not.toBe(omitted);
      expect(resolutions).toBe(2);
      const states = [
        ...defaults,
        { mapper: 1, prg_mode: 2, prg_bank: 1 },
      ] as const;
      const combined = await open(states);
      expect(combined).not.toBe(explicit);
      expect(await open([...states].reverse())).toBe(combined);
      expect(resolutions).toBe(3);
      const executed = await session.execute("address_name", {
        address: "0x8000",
      });
      if (!executed.ok) throw executed.error;
      const snapshot = session.exportAnalysisSnapshot();
      if (!snapshot.ok) throw snapshot.error;
      const rejected = await session.open(path, {
        nesPrgViews: defaults,
        snapshot: snapshot.value,
      });
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          _tag: "EvidenceIntegrityError",
          message: expect.stringContaining("profile_mismatch"),
        },
      });
      expect(session.analysisProfile()?.digest).toBe(combined);
      expect(await open()).toBe(omitted);
      expect(session.activeTarget()).not.toHaveProperty("nesPrgViews");
    } finally {
      await session.close();
    }
  });
});
