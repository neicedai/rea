import { createCartridgeFileProbe } from "../../support/filesystem/cartridgeFileProbe.js";
import type { CartridgeFileSystem } from "../../../src/native/cartridgeFile.js";
import { lstat, open, symlink, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { NesCartridgeService } from "../../../src/application/binaryDiagnostics/NesCartridgeService.js";
import { NesMapperTraceService } from "../../../src/application/binaryDiagnostics/NesMapperTraceService.js";
import { nesCodeFixture } from "../../../src/domain/nesCode.fixture.js";
import { mmc5Fixture } from "../../../src/domain/nesMmc5.fixture.js";
import { ok } from "../../../src/domain/result.js";
import { NesCartridgeProvider } from "../../../src/native/nes/NesCartridgeProvider.js";
import { nesCartridgeFixture } from "../../../src/native/nes/NesCartridge.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const fileSystem: CartridgeFileSystem = {
  open,
  lstat: (path) => lstat(path, { bigint: true }),
};

it.each(["prg", "chr"])(
  "captures both ROM sources with the digest and rejects edits after %s capture",
  async (changedRegion) => {
    const root = await createTestTempDirectory("rea-nes-code-snapshot-");
    const path = join(root, "game.nes");
    const fixture = nesCodeFixture(4, [0x60]);
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      chr_page: 0,
      max_file_bytes: fixture.bytes.length,
      includeChr: true,
    };
    const chrOffset = fixture.prgOffset + fixture.prgSize;
    const provider = new NesCartridgeProvider();
    try {
      const snapshot = await provider.captureRom(input);
      if (!snapshot.ok) throw snapshot.error;
      expect(snapshot.value.prgRom).toEqual(
        fixture.bytes.subarray(
          fixture.prgOffset,
          fixture.prgOffset + fixture.prgSize,
        ),
      );
      expect(snapshot.value.cartridge.artifact.sha256).toBe(
        createHash("sha256").update(fixture.bytes).digest("hex"),
      );
      expect(snapshot.value.chrRom).toEqual(fixture.bytes.subarray(chrOffset));
    } finally {
      await provider.close();
    }
    let changed = false;
    const racing = new NesCartridgeProvider(undefined, {
      ...fileSystem,
      open: async (...args) =>
        new Proxy(await open(...args), {
          get(target, key) {
            if (key === "read")
              return async (
                buffer: Buffer,
                offset: number,
                length: number,
                position: number,
              ) => {
                const result = await target.read(
                  buffer,
                  offset,
                  length,
                  position,
                );
                if (
                  !changed &&
                  position ===
                    (changedRegion === "prg" ? fixture.prgOffset : chrOffset) &&
                  buffer.length ===
                    (changedRegion === "prg"
                      ? fixture.prgSize
                      : fixture.bytes.length - chrOffset)
                ) {
                  changed = true;
                  const modified = Buffer.from(fixture.bytes);
                  modified[
                    changedRegion === "prg"
                      ? fixture.programOffset
                      : chrOffset + 8193
                  ] = 0xea;
                  await writeFile(path, modified);
                }
                return result;
              };
            const value: unknown = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
    });
    try {
      expect(await racing.captureRom(input)).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisArtifactChangedError" },
      });
      expect(changed).toBe(true);
    } finally {
      await racing.close();
    }
  },
);

it.each(["missing", "short"])(
  "rejects a %s CHR source from the capture boundary",
  async (failure) => {
    const root = await createTestTempDirectory("rea-nes-chr-snapshot-");
    const path = join(root, "game.nes");
    await writeFile(path, mmc5Fixture().bytes);
    const provider = new NesCartridgeProvider();
    const service = new NesMapperTraceService({
      identity: provider.identity,
      close: () => provider.close(),
      captureRom: async (input, options) => {
        expect(input.includeChr).toBe(true);
        const captured = await provider.captureRom(input, options);
        return captured.ok
          ? ok({
              ...captured.value,
              chrRom:
                failure === "missing"
                  ? null
                  : captured.value.chrRom!.subarray(1),
            })
          : captured;
      },
    });
    try {
      expect(
        await service.traceEvents({ path, initial: { mapper: 5 }, events: [] }),
      ).toMatchObject({ ok: false, error: { _tag: "AnalysisOutputError" } });
      const prgOnly = await provider.captureRom({
        path,
        chr_page: 0,
        max_file_bytes: 1048576,
      });
      if (!prgOnly.ok) throw prgOnly.error;
      expect(prgOnly.value.chrRom).toBeNull();
    } finally {
      await service.close();
    }
  },
);

it("rejects exhausted mapper trace budgets and cancellation before opening source files", async () => {
  const service = new NesMapperTraceService(
    new NesCartridgeProvider(undefined, {
      open: async () => {
        throw new Error("Unexpected source open");
      },
      lstat: async () => {
        throw new Error("Unexpected source lookup");
      },
    }),
  );
  const input = {
    path: "/not-opened.nes",
    initial: { mapper: 4 },
    writes: [
      { address: 0x8000, value: 6 },
      { address: 0x8001, value: 2 },
    ],
    max_steps: 1,
  };
  try {
    expect(await service.trace(input)).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisResourceConstraintError",
        operation: "trace_nes_mapper_writes",
      },
    });
    expect(
      await service.trace(input, { signal: AbortSignal.abort() }),
    ).toMatchObject({
      ok: false,
      error: {
        _tag: "AnalysisCancelledError",
        operation: "trace_nes_mapper_writes",
      },
    });
  } finally {
    await service.close();
  }
});

describe("cartridge filesystem integrity", () => {
  it("rejects non-files, symlinks and malformed headers; honors budget and cancellation", async () => {
    const root = await createTestTempDirectory("rea-nes-cartridge-");
    const path = join(root, "game.nes");
    const alias = join(root, "alias.nes");
    await writeFile(path, nesCartridgeFixture());
    await symlink(path, alias);
    const service = new NesCartridgeService(new NesCartridgeProvider());
    try {
      for (const path of [root, alias, join(root, "missing.nes")]) {
        const result = await service.inspect({ path });
        expect(result).toMatchObject({
          ok: false,
          error: { _tag: "AnalysisInputError" },
        });
      }
      expect(await service.inspect({ path, max_file_bytes: 16 })).toMatchObject(
        { ok: false, error: { _tag: "AnalysisResourceConstraintError" } },
      );
      expect(await service.inspect({ path, chr_page: 2 })).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisInputError",
          issues: [{ path: ["chr_page"], reason: "out_of_range" }],
        },
      });
      expect(
        await service.inspect({ path }, { signal: AbortSignal.abort() }),
      ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
      await writeFile(path, nesCartridgeFixture().subarray(0, 100));
      expect(await service.inspect({ path })).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisInputError" },
      });
    } finally {
      await service.close();
    }
  });

  it.each(["replace", "remove"])(
    "rejects a path that changes after reading: %s",
    async (mode) => {
      const root = await createTestTempDirectory("rea-nes-cartridge-replace-");
      const path = join(root, "game.nes");
      await writeFile(path, nesCartridgeFixture());
      let lookups = 0;
      const provider = new NesCartridgeProvider(undefined, {
        ...fileSystem,
        lstat: async (selected) => {
          if (++lookups === 2) {
            await unlink(selected);
            if (mode === "replace")
              await writeFile(selected, nesCartridgeFixture());
          }
          return fileSystem.lstat(selected);
        },
      });
      const service = new NesCartridgeService(provider);
      try {
        expect(await service.inspect({ path })).toMatchObject({
          ok: false,
          error: { _tag: "AnalysisArtifactChangedError" },
        });
      } finally {
        await service.close();
      }
    },
  );

  it("retains a failed file close and retries the same descriptor at service close", async () => {
    const root = await createTestTempDirectory("rea-nes-cartridge-close-");
    const path = join(root, "game.nes");
    await writeFile(path, nesCartridgeFixture());
    const probe = createCartridgeFileProbe(fileSystem, {
      close: { failures: 3, cause: () => new Error("injected close failure") },
    });
    const provider = new NesCartridgeProvider(undefined, probe.fileSystem);
    const service = new NesCartridgeService(provider);
    try {
      expect(await service.inspect({ path })).toMatchObject({
        ok: false,
        error: { cleanupIncomplete: true, cleanupResources: [path] },
      });
      expect(probe.descriptor?.fd).toBeGreaterThanOrEqual(0);
      expect(await service.inspect({ path })).toMatchObject({
        ok: false,
        error: { cleanupIncomplete: true, cleanupResources: [path] },
      });
      await expect(service.close()).rejects.toMatchObject({
        cleanupIncomplete: true,
        cleanupResources: [path],
      });
    } finally {
      await service.close();
    }
    expect(probe.closeAttempts).toBe(4);
    expect(probe.descriptor?.fd).toBe(-1);

    expect(probe.descriptors).toHaveLength(1);
  });
});

it("preserves malformed cartridge failure when descriptor cleanup also fails", async () => {
  const root = await createTestTempDirectory("rea-nes-malformed-cleanup-");
  const path = join(root, "malformed.nes");
  await writeFile(path, Buffer.alloc(16));
  const probe = createCartridgeFileProbe(fileSystem, {
    close: { failures: 1, cause: () => new Error("malformed close probe") },
  });
  const provider = new NesCartridgeProvider(undefined, probe.fileSystem);
  const service = new NesCartridgeService(provider);
  try {
    const result = await service.inspect({ path });
    if (result.ok)
      throw new Error("Expected malformed acquisition with failed cleanup");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "cleanup_incomplete",
      details: {
        operation: "inspect_nes_cartridge",
        resources: [path],
        diagnostics: {
          primary_error: {
            code: "invalid_request",
            details: {
              operation: "inspect_nes_cartridge",
              issues: [{ path: ["path"], reason: "invalid_format" }],
            },
          },
          cleanup_error: {
            code: "cleanup_incomplete",
            details: { diagnostics: { reason: "malformed close probe" } },
          },
        },
      },
    });
    expect(probe.descriptor?.fd).toBeGreaterThanOrEqual(0);
  } finally {
    await service.close();
  }
  expect(probe.closeAttempts).toBe(2);
  expect(probe.descriptor?.fd).toBe(-1);

  expect(probe.descriptors).toHaveLength(1);
});

it("closes the acquired cartridge descriptor when cancelled during the digest", async () => {
  const root = await createTestTempDirectory("rea-nes-cartridge-cancel-");
  const path = join(root, "game.nes");
  await writeFile(path, nesCartridgeFixture());
  const controller = new AbortController();
  const probe = createCartridgeFileProbe(fileSystem, {
    afterRead: (buffer) => {
      if (buffer.length === 65536) controller.abort();
    },
  });
  const provider = new NesCartridgeProvider(undefined, probe.fileSystem);
  const service = new NesCartridgeService(provider);
  try {
    expect(
      await service.inspect({ path }, { signal: controller.signal }),
    ).toMatchObject({ ok: false, error: { _tag: "AnalysisCancelledError" } });
    expect(probe.descriptor?.fd).toBe(-1);
  } finally {
    await service.close();
  }

  expect(probe.descriptors).toHaveLength(1);
});
