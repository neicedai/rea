import type { GhidraLanguageOverride } from "../config/ghidraLanguageOverride.js";
import type { NesRomMetadata } from "../domain/nes.js";
import { resolveNesMapperLayout } from "../domain/nesMapper.js";
import type { NesPrgView } from "../domain/nesPrgViews.js";
import { isAbsolute, join } from "node:path";
import writeFileAtomic from "write-file-atomic";
import {
  GHIDRA_NES_COMPILER_SPEC_ID,
  GHIDRA_NES_LANGUAGE_ID,
} from "./GhidraNesProfile.js";

/** Provider-owned interpretations applied by the headless import boundary. */
export interface GhidraImportOptions {
  readonly psp?: true;
  readonly mipsSoftFloat?: true;
  readonly rawBinary?: {
    readonly languageId: string;
    readonly compilerSpecId: string;
    readonly baseAddr: string;
  };
  readonly platform?: NodeJS.Platform;
  readonly dosMz?: true;
  readonly dosCom?: true;
  /** Admitted cartridge layout from the original iNES/NES 2.0 snapshot. */
  readonly nes?: NesRomMetadata;
  /** Caller-selected complete MMC PRG register states. */
  readonly nesPrgViews?: readonly NesPrgView[];
  /** Explicit import language committed by the analysis profile. */
  readonly languageOverride?: GhidraLanguageOverride;
}

/** Snapshot a bounded-argv layout under the launcher runtime owner's cleanup. */
export const snapshotGhidraNesLayout = async (
  options: GhidraImportOptions,
  runtimeRoot: string,
): Promise<string | undefined> => {
  if (options.nes === undefined) return undefined;
  ghidraImportArguments(options);
  const layout = resolveNesMapperLayout(options.nes, options.nesPrgViews);
  if (!layout.ok) throw new Error(layout.error);
  const path = join(runtimeRoot, "nes-layout.json");
  await writeFileAtomic(path, JSON.stringify(layout.value), {
    encoding: "utf8",
    mode: 0o600,
  });
  return path;
};

/** Source identity and mapper interpretation passed to the NES preparation script. */
export const ghidraNesPreparationArguments = (
  targetPath: string,
  metadata: NesRomMetadata,
  layoutPath: string | undefined,
): readonly string[] => {
  if (layoutPath === undefined || !isAbsolute(layoutPath))
    throw new Error(
      "NES preparation requires an absolute private layout manifest path.",
    );
  return [
    targetPath,
    String(metadata.prgRom.offset),
    String(metadata.prgRom.size),
    Buffer.from(metadata.header).toString("hex"),
    layoutPath,
  ];
};

/** Select one admitted loader/language interpretation without overlapping flags. */
export const ghidraImportArguments = (
  options: GhidraImportOptions,
): readonly string[] => {
  const override = options.languageOverride;
  if (options.nes !== undefined) {
    const layout = resolveNesMapperLayout(options.nes, options.nesPrgViews);
    if (!layout.ok) throw new Error(layout.error);
    if ((options.platform ?? process.platform) === "win32")
      throw new Error(
        "NES import preparation is outside Windows Ghidra P0 authority.",
      );
    if (
      options.psp === true ||
      options.mipsSoftFloat === true ||
      options.rawBinary !== undefined ||
      options.dosMz === true ||
      options.dosCom === true ||
      override !== undefined
    )
      throw new Error(
        "NES import cannot be combined with a DOS import or language override.",
      );
    return [
      "-loader",
      "BinaryLoader",
      "-loader-baseAddr",
      "0x8000",
      // Ghidra BinaryLoader parses both options as hexadecimal (including digits-only values).
      "-loader-fileOffset",
      `0x${options.nes.prgRom.offset.toString(16)}`,
      "-loader-length",
      `0x${Math.min(options.nes.prgRom.size, 0x4000).toString(16)}`,
      "-loader-blockName",
      "NES_PRG_IMPORT",
      "-processor",
      GHIDRA_NES_LANGUAGE_ID,
      "-cspec",
      GHIDRA_NES_COMPILER_SPEC_ID,
    ];
  }
  if (options.nesPrgViews !== undefined)
    throw new Error("NES PRG views require an admitted NES cartridge.");
  const rawBinary = options.rawBinary;
  if (
    options.psp === true &&
    (options.dosMz === true ||
      options.dosCom === true ||
      override !== undefined)
  )
    throw new Error(
      "A PSP ELF import cannot be combined with DOS or a generic Ghidra language override.",
    );
  if (options.psp === true && rawBinary !== undefined)
    throw new Error(
      "A PSP ELF import cannot be combined with a raw-binary import.",
    );
  if (
    options.mipsSoftFloat === true &&
    (options.psp === true ||
      options.dosMz === true ||
      options.dosCom === true ||
      rawBinary !== undefined)
  )
    throw new Error(
      "MIPS soft-float storage applies only to a generic MIPS ELF import.",
    );
  if (
    override !== undefined &&
    (options.dosMz === true || options.dosCom === true)
  )
    throw new Error(
      "A Ghidra language override cannot be combined with a DOS import.",
    );
  if (override !== undefined && rawBinary !== undefined)
    throw new Error(
      "A Ghidra language override cannot be combined with a raw-binary import.",
    );
  if (
    rawBinary !== undefined &&
    (options.dosMz === true || options.dosCom === true)
  )
    throw new Error(
      "A raw-binary import cannot be combined with a DOS import.",
    );
  return options.dosMz === true
    ? [
        "-loader",
        "MzLoader",
        "-processor",
        "x86:LE:16:Real Mode",
        "-cspec",
        "default",
      ]
    : options.dosCom === true
      ? [
          "-loader",
          "BinaryLoader",
          "-loader-baseAddr",
          "1000:0100",
          "-processor",
          "x86:LE:16:Real Mode",
          "-cspec",
          "default",
        ]
      : rawBinary === undefined
        ? options.psp === true
          ? [
              "-loader",
              "PspElfLoader",
              "-processor",
              "Allegrex:LE:32:default",
              "-cspec",
              "default",
            ]
          : override !== undefined
            ? [
                "-processor",
                override.languageId,
                ...(override.compilerSpecId === undefined
                  ? []
                  : ["-cspec", override.compilerSpecId]),
              ]
            : []
        : [
            "-loader",
            "BinaryLoader",
            "-loader-baseAddr",
            rawBinary.baseAddr,
            "-processor",
            rawBinary.languageId,
            "-cspec",
            rawBinary.compilerSpecId,
          ];
};
