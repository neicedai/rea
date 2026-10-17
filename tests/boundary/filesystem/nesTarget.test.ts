import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseBinaryTarget } from "../../../src/application/BinaryTargetResolver.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { pe } from "../../../src/domain/binaryTarget.fixture.js";
import type { NesPrgView } from "../../../src/domain/nesPrgViews.js";

const cartridge = (): Buffer => {
  const bytes = Buffer.alloc(16 + 512 + 32_768 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 4], 0);
  bytes.fill(0x33, 16, 528);
  bytes.fill(0xea, 528, 33_296);
  bytes.fill(0x55, 33_296);
  return bytes;
};

describe("NES signature precedence over filename hints", () => {
  it.each(["game.js", "game.asar", "game.hop"])(
    "classifies %s without requiring a PRG selection",
    async (name) => {
      const directory = await createTestTempDirectory("rea-nes-named-");
      const path = join(directory, name);
      const bytes = cartridge();
      await writeFile(path, bytes);
      const result = await parseBinaryTarget(path);
      if (!result.ok) throw result.error;
      expect(result.value).toMatchObject({
        format: "nes",
        kind: "executable",
        architecture: "6502",
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(result.value).not.toHaveProperty("nesPrgViews");
      await writeFile(path, bytes.subarray(0, 4));
      expect(await parseBinaryTarget(path)).toMatchObject({
        ok: false,
        error: { reason: expect.stringContaining("truncated NES header") },
      });
    },
  );

  it("keeps caller-selected database interpretation authoritative", async () => {
    const directory = await createTestTempDirectory("rea-nes-named-db-");
    const path = join(directory, "game.hop");
    await writeFile(path, cartridge());
    const result = await parseBinaryTarget(path, { targetKind: "database" });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      kind: "database",
      format: "analysis-database",
    });
  });
});

describe("NES target admission through the filesystem", () => {
  it("checks the complete ROM beyond the probe and retains original identity and offsets", async () => {
    const directory = await createTestTempDirectory("rea-nes-target-");
    const path = join(directory, "cartridge.rom");
    const bytes = cartridge();
    await writeFile(path, bytes);

    const target = await parseBinaryTarget(path, { hostArchitecture: "arm64" });
    if (!target.ok) throw target.error;
    expect(target.value).toMatchObject({
      path: await realpath(path),
      format: "nes",
      kind: "executable",
      architecture: "6502",
      availableArchitectures: ["6502"],
      sha256: createHash("sha256").update(bytes).digest("hex"),
      nes: {
        header: Array.from(bytes.subarray(0, 16)),
        headerVersion: "ines",
        mapper: 0,
        trainer: { offset: 16, size: 512 },
        prgRom: { offset: 528, size: 32_768 },
        chrRom: { offset: 33_296, size: 8192 },
        trailingData: null,
      },
    });
    expect(await readFile(path)).toEqual(bytes);

    await writeFile(path, bytes.subarray(0, bytes.length - 1));
    const truncated = await parseBinaryTarget(path);
    expect(truncated).toMatchObject({
      ok: false,
      error: {
        _tag: "BinaryTargetError",
        reason:
          "truncated NES CHR-ROM: declared range ends at byte 41488; the file has 41487",
      },
    });
  });

  it("recognizes mapper metadata without claiming deep provider support", async () => {
    const directory = await createTestTempDirectory("rea-nes-mapper-");
    const path = join(directory, "no-extension");
    const bytes = cartridge();
    bytes[6] = 0xc4;
    bytes[7] = 0xb8;
    bytes[8] = 0xda;
    await writeFile(path, bytes);

    const target = await parseBinaryTarget(path, { hostArchitecture: "x64" });
    if (!target.ok) throw target.error;
    expect(target.value).toMatchObject({
      format: "nes",
      architecture: "6502",
      nes: {
        headerVersion: "nes2",
        mapper: 0xabc,
        submapper: 13,
        prgRom: { offset: 528, size: 32_768 },
      },
    });
  });

  it("requires NES magic instead of trusting a .nes extension", async () => {
    const directory = await createTestTempDirectory("rea-nes-signature-");
    const path = join(directory, "fake.nes");
    await writeFile(path, Buffer.alloc(32_768));

    expect(await parseBinaryTarget(path)).toMatchObject({
      ok: false,
      error: {
        _tag: "BinaryTargetError",
        reason: "unsupported binary format",
      },
    });
  });

  it.each(["mapper.hop", "game.js"])(
    "preserves normalized caller states separately from header declarations for %s",
    async (name) => {
      const directory = await createTestTempDirectory("rea-nes-views-");
      const path = join(directory, name);
      const bytes = cartridge();
      bytes[6] = 0x14;
      await writeFile(path, bytes);
      const selected: NesPrgView[] = [
        { mapper: 1, prg_mode: 3, prg_bank: 1 },
        { mapper: 1, prg_mode: 2, prg_bank: 0 },
      ];
      const result = await parseBinaryTarget(path, { nesPrgViews: selected });
      if (!result.ok) throw result.error;
      if (result.value.format !== "nes") throw new Error("Expected NES target");
      expect(result.value).toMatchObject({
        format: "nes",
        sha256: createHash("sha256").update(bytes).digest("hex"),
        nesPrgViews: [selected[1], selected[0]],
        nes: { mapper: 1, header: Array.from(bytes.subarray(0, 16)) },
      });
      expect(Reflect.has(result.value.nes, "nesPrgViews")).toBe(false);
      expect(await readFile(path)).toEqual(bytes);
    },
  );

  it.each([
    ["database.hop", Buffer.from("database")],
    ["bundle.js", Buffer.from("export default 1")],
    ["package.zip", Buffer.from([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0])],
    ["program.exe", pe(0x8664)],
  ])(
    "rejects NES views before non-NES classification of %s",
    async (name, bytes) => {
      const directory = await createTestTempDirectory("rea-non-nes-views-");
      const path = join(directory, name);
      await writeFile(path, bytes);
      expect(
        await parseBinaryTarget(path, {
          nesPrgViews: [{ mapper: 1, prg_mode: 3, prg_bank: 0 }],
        }),
      ).toMatchObject({
        ok: false,
        error: {
          _tag: "BinaryTargetError",
          reason: expect.stringContaining("header-detected NES"),
        },
      });
    },
  );

  it("rejects contradictory DOS/database interpretations even with valid NES magic", async () => {
    const directory = await createTestTempDirectory("rea-nes-interpretation-");
    const path = join(directory, "fixture.nes");
    await writeFile(path, cartridge());
    const nesPrgViews = [{ mapper: 1, prg_mode: 3, prg_bank: 0 }] as const;
    for (const options of [
      { formatHint: "dos-com" as const },
      { targetKind: "database" as const },
    ])
      expect(
        await parseBinaryTarget(path, { ...options, nesPrgViews }),
      ).toMatchObject({
        ok: false,
        error: { reason: expect.stringContaining("header-detected NES") },
      });
    expect(await parseBinaryTarget(path, { nesPrgViews })).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining("mapper does not match") },
    });
  });
});
