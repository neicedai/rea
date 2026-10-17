import { describe, expect, it } from "vitest";
import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { parseNesHeader, type NesRomMetadata } from "../domain/nes.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import { err, ok } from "../domain/result.js";
import { HopperProvider } from "../hopper/HopperProvider.js";
import { IdaProvider } from "../ida/IdaProvider.js";
import { silentLogger } from "../logger.js";
import type { GhidraInstallationHost } from "./GhidraInstallation.js";
import type { GhidraClientOptions } from "./GhidraClientTypes.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { GhidraSessionError } from "./GhidraSessionError.js";
import { resolveNesMapperLayout } from "../domain/nesMapper.js";
import type { NesPrgView } from "../domain/nesPrgViews.js";

// Adapter admission and commitments only; these doubles do not run Ghidra.
const host: GhidraInstallationHost = {
  platform: "linux",
  architecture: "x64",
  readText: () =>
    "application.version=12.1.4\napplication.java.min=21\napplication.java.max=\n",
  executable: () => true,
  probeJava: () => ({
    version: "21.0.11",
    major: 21,
    home: "/jdk-21",
    bits: 64,
    runtime: "jdk",
    osArch: "amd64",
    osName: "Linux",
  }),
};
const parsed = parseConfig({ GHIDRA_INSTALL_DIR: "/ghidra" });
if (!parsed.ok) throw parsed.error;
const config = parsed.value;
const target = (
  options: {
    trainer?: boolean;
    nes2?: boolean;
    prg32?: boolean;
    chrRam?: boolean;
    mapper?: number;
    prgBanks?: number;
    chrBanks?: number;
  } = {},
  change: Partial<NesRomMetadata> = {},
): Extract<BinaryTarget, { format: "nes" }> => {
  const header = Buffer.alloc(16);
  header.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    options.prgBanks ?? (options.prg32 ? 2 : 1),
    options.chrBanks ?? (options.chrRam ? 0 : 1),
  ]);
  header[6] = (((options.mapper ?? 0) & 15) << 4) | (options.trainer ? 4 : 0);
  header[7] = ((options.mapper ?? 0) & 0xf0) | (options.nes2 ? 8 : 0);
  const parsedHeader = parseNesHeader(
    header,
    16 +
      (options.trainer ? 512 : 0) +
      header.readUInt8(4) * 16384 +
      header.readUInt8(5) * 8192,
  );
  if (!parsedHeader.ok) throw new Error(parsedHeader.error);
  return {
    path: "/fixture.nes",
    sha256: "a".repeat(64),
    kind: "executable",
    format: "nes",
    architecture: "6502",
    availableArchitectures: ["6502"],
    nes: { ...parsedHeader.value, ...change },
  };
};

describe("Ghidra NES admission and import commitment", () => {
  it("binds cartridge facts and original PRG offsets to each CPU mapping", async () => {
    const provider = new GhidraProvider(config, silentLogger, {}, host);
    const nrom128 = target({ trainer: true });
    const nrom256 = target({ nes2: true, prg32: true, chrRam: true });
    const digests = new Set<string>();
    for (const input of [nrom128, nrom256]) {
      expect(provider.inspectTargetSupport(input)).toMatchObject({
        status: "supported",
        diagnostics: { nes_rom: input.nes },
      });
      const resolved = await provider.resolveAnalysisProfile(input);
      if (!resolved.ok) throw resolved.error;
      const profile = resolved.value.profile;
      if (profile === null) throw new Error("Expected a NES profile");
      expect(profile.parameters).toMatchObject({
        target_format: "nes",
        architecture: "6502",
        loader: "BinaryLoader",
        language_id: "6502:LE:16:default",
        compiler_spec_id: "default",
        nes_rom: input.nes,
        nes_support_lane: "nes-contexts-v3",
        address_coordinates: "nes-address-space-and-cpu-byte-address",
        load_image_evidence: "independent-nes-context-source-mappings-v3",
        trainer_mapping: "metadata-only-not-applied",
      });
      const layout = resolveNesMapperLayout(input.nes);
      if (!layout.ok) throw new Error(layout.error);
      expect(profile.parameters.nes_mapper_layout).toEqual(layout.value);
      digests.add(profile.digest);
    }
    expect(digests.size).toBe(2);
  });

  it.each([
    [{ mapper: 6 }, "bank-switching"],
    [{ submapper: 1 }, "submapper"],
    [{ consoleType: 1 }, "console type"],
    [{ prgRom: { offset: 16, size: 65536 } }, "PRG ROM"],
    [{ chrRom: { offset: 16400, size: 16384 } }, "CHR ROM"],
    [{ miscRomCount: 1 }, "miscellaneous"],
    [{ trailingData: { offset: 24592, size: 1 } }, "trailing data"],
  ] satisfies [Partial<NesRomMetadata>, string][])(
    "preserves observed metadata when refusing unsupported layout %j",
    async (change, reason) => {
      const provider = new GhidraProvider(config, silentLogger, {}, host);
      const input = target({}, change);
      expect(provider.inspectTargetSupport(input)).toMatchObject({
        status: "unsupported",
        code: "target_format_unsupported",
        reason: expect.stringContaining(reason),
        diagnostics: { nes_rom: input.nes },
      });
      const profile = await provider.resolveAnalysisProfile(input);
      expect(profile).toMatchObject({
        ok: false,
        error: { _tag: "AnalysisUnsupportedTargetError" },
      });
    },
  );

  it("rejects generic language overrides and Windows P0 imports", async () => {
    const overridden = new GhidraProvider(
      {
        ...config,
        ghidraLanguageOverride: { languageId: "x86:LE:32:default" },
      },
      silentLogger,
      {},
      host,
    );
    expect(await overridden.resolveAnalysisProfile(target())).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining("cannot override") },
    });
    const windows = new GhidraProvider(
      config,
      silentLogger,
      {},
      {
        ...host,
        platform: "win32",
        probeJava: () => ({
          version: "21.0.11",
          major: 21,
          home: "/jdk-21",
          bits: 64,
          runtime: "jdk",
          osArch: "amd64",
          osName: "Windows 11",
        }),
      },
    );
    expect(windows.inspectTargetSupport(target())).toMatchObject({
      status: "unsupported",
      code: "target_format_unsupported",
    });
    expect(await windows.resolveAnalysisProfile(target())).toMatchObject({
      ok: false,
      error: { reason: expect.stringContaining("NES cartridge preparation") },
    });
  });
});

describe("Ghidra bank-view profile commitment", () => {
  it.each([
    [1, 8, 16],
    [2, 8, 0],
    [3, 2, 4],
    [4, 8, 32],
    [7, 8, 0],
    [66, 8, 4],
  ] as const)(
    "commits Mapper %i bank identity and mapper-specific uncertainty",
    async (mapper, prgBanks, chrBanks) => {
      const provider = new GhidraProvider(config, silentLogger, {}, host);
      const input = target({ mapper, prgBanks, chrBanks, trainer: true });
      expect(provider.inspectTargetSupport(input)).toMatchObject({
        status: "supported",
        diagnostics: { nes_rom: input.nes },
      });
      const resolved = await provider.resolveAnalysisProfile(input);
      if (!resolved.ok) throw resolved.error;
      const profile = resolved.value.profile;
      if (profile === null) throw new Error("Expected a NES profile");
      const layout = resolveNesMapperLayout(input.nes);
      if (!layout.ok) throw new Error(layout.error);
      expect(profile.parameters).toMatchObject({
        nes_support_lane: "nes-contexts-v3",
        nes_mapper_layout: layout.value,
      });
      expect(profile.parameters.nes_limitations).toEqual(
        expect.arrayContaining([...layout.value.limitations]),
      );
      const tampered = createAnalysisProfile(profile.provider, {
        ...profile.parameters,
        nes_mapper_layout: { mapper },
      });
      const rejected = provider.createClient(input, tampered);
      try {
        expect(await rejected.execute("health", {})).toMatchObject({
          ok: false,
        });
      } finally {
        await rejected.close();
      }
    },
  );
});

describe("MMC PRG context profile identity", () => {
  it("commits selection origin and raw selectors while treating view order as an independent set", async () => {
    const provider = new GhidraProvider(config, silentLogger, {}, host);
    const input = target({ mapper: 1, prg32: true });
    const first: NesPrgView = { mapper: 1, prg_mode: 3, prg_bank: 0 };
    const alias: NesPrgView = { mapper: 1, prg_mode: 3, prg_bank: 2 };
    const profiles = await Promise.all(
      [
        input,
        { ...input, nesPrgViews: [first] },
        { ...input, nesPrgViews: [alias] },
        { ...input, nesPrgViews: [first, alias] },
        { ...input, nesPrgViews: [alias, first] },
      ].map(async (selected) => {
        const resolved = await provider.resolveAnalysisProfile(selected);
        if (!resolved.ok) throw resolved.error;
        if (resolved.value.profile === null)
          throw new Error("Expected MMC profile");
        return resolved.value.profile;
      }),
    );
    expect(
      new Set(profiles.slice(0, 4).map((profile) => profile.digest)).size,
    ).toBe(4);
    expect(profiles[3]?.digest).toBe(profiles[4]?.digest);
    expect(profiles[0]?.parameters.nes_mapper_layout).toMatchObject({
      contexts: [{ selection: "default-assumption", state: first }],
    });
    expect(profiles[1]?.parameters.nes_mapper_layout).toMatchObject({
      contexts: [{ selection: "caller-selected", state: first }],
    });
    const defaultProfile = profiles[0];
    if (defaultProfile === undefined)
      throw new Error("Expected default profile");
    const client = provider.createClient(
      { ...input, nesPrgViews: [first] },
      defaultProfile,
    );
    try {
      expect(await client.execute("health", {})).toMatchObject({ ok: false });
    } finally {
      await client.close();
    }
  });

  it("rejects state choices that do not belong to the selected cartridge mapper", async () => {
    const provider = new GhidraProvider(config, silentLogger, {}, host);
    const views: NesPrgView[] = [{ mapper: 4, prg_mode: 1, r6: 63, r7: 62 }];
    for (const mapper of [0, 1]) {
      const input = { ...target({ mapper, prg32: true }), nesPrgViews: views };
      expect(provider.inspectTargetSupport(input)).toMatchObject({
        status: "unsupported",
        reason: expect.stringContaining("Mapper"),
      });
      expect(await provider.resolveAnalysisProfile(input)).toMatchObject({
        ok: false,
      });
    }
  });
});

describe("NES provider client restrictions", () => {
  it("requires the fixed handshake and propagates static hardware limitations", async () => {
    const options: GhidraClientOptions[] = [];
    const provider = new GhidraProvider(
      config,
      silentLogger,
      {},
      host,
      (value) => {
        options.push(value);
        return {
          start: async () => err(new GhidraSessionError("start", "Not used")),
          callTool: async () => ok([]),
          close: async () => ok(null),
        };
      },
    );
    const input = target();
    const resolved = await provider.resolveAnalysisProfile(input);
    if (!resolved.ok) throw resolved.error;
    const profile = resolved.value.profile;
    if (profile === null) throw new Error("Expected a NES profile");
    const client = provider.createClient(input, profile);
    try {
      const execution = await client.execute("list_procedures", {});
      if (!execution.ok) throw execution.error;
      expect(options).toEqual([
        expect.objectContaining({
          expectedLanguageId: "6502:LE:16:default",
          expectedCompilerSpecId: "default",
        }),
      ]);
      expect(execution.value.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("unofficial opcode"),
          expect.stringContaining("not emulated"),
        ]),
      );
    } finally {
      await client.close();
    }
    const tampered = createAnalysisProfile(profile.provider, {
      ...profile.parameters,
      language_id: "x86:LE:32:default",
    });
    const rejected = provider.createClient(input, tampered);
    try {
      expect(await rejected.execute("health", {})).toMatchObject({ ok: false });
      expect(options).toHaveLength(1);
    } finally {
      await rejected.close();
    }
  });

  it("refuses NES in Hopper and IDA before creating a provider session", async () => {
    const input = target();
    for (const provider of [
      new HopperProvider(config, silentLogger, {}, "linux"),
      new IdaProvider(config, {}),
    ]) {
      expect(provider.inspectTargetSupport(input)).toMatchObject({
        status: "unsupported",
        code: "target_format_unsupported",
        diagnostics: { nes_rom: input.nes },
      });
      expect(await provider.resolveAnalysisProfile(input)).toMatchObject({
        ok: false,
      });
      const client = provider.createClient(input);
      try {
        expect(await client.execute("health", {})).toMatchObject({ ok: false });
      } finally {
        await client.close();
      }
    }
  });
});
