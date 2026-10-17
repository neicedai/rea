import { nesMapperBoardLimitations } from "./nesMapperBoardLimitations.js";
import { bandaiBoard } from "./nesBandai.js";

import { mmc5Mapping, mmc5StateFromView, mmc5ViewName } from "./nesMmc5.js";
import { fme7Mask } from "./nesFme7.js";
import {
  nesBoardSelection,
  type NesBoardSelection,
} from "./nesBoardSelection.js";
import { isVrc6View } from "./nesVrc6.js";
import { isVrc2Mapper, isVrc2View } from "./nesVrc2.js";
import { nesVrcBoard, type NesVrcWiring } from "./nesVrcBoard.js";
import { vrc4Board, isVrc4View } from "./nesVrc4.js";

import { irem78Board } from "./nesIrem78.js";
import { namco108HasFixedPrg } from "./nesNamco108.js";

import { mmc1HasFixedPrg } from "./nesMmc1.js";
import { nesMapper34Board } from "./nesMapper34.js";
import type { NesRomMetadata } from "./nes.js";
import { nesPrgViewsSchema, type NesPrgView } from "./nesPrgViews.js";
import { err, ok, type Result } from "./result.js";

/** A source-backed CPU window, or one independently named candidate bank. */
export interface NesPrgMapping {
  readonly name: string;
  readonly addressSpace: string;
  readonly start: number;
  readonly size: number;
  readonly fileOffset: number;
  readonly bank: number;
  readonly role: "fixed" | "switchable" | "mirror";
}

/** Static cartridge interpretation; candidate banks are not simultaneous state. */
export interface NesMapperLayout {
  readonly mapper: number;
  readonly board: string;
  readonly bankSize: number;
  readonly prgBanks: number;
  /** CHR source size in 8 KiB header units, not mapper window or selected state count. */
  readonly chrBanks: number;
  readonly mappings: readonly NesPrgMapping[];
  readonly contexts: readonly NesPrgContext[];
  readonly limitations: readonly string[];
}

/** Register choices that make every PRG window within a view mutually consistent. */
export interface NesPrgContext {
  readonly addressSpace: string;
  readonly state: NesPrgView;
  readonly selection: "default-assumption" | "caller-selected";
}

interface BoardLayout {
  readonly board: string;
  readonly bankSize: number;
  readonly minPrgSize: number;
  readonly maxPrgSize: number;
  readonly chrSizes: readonly number[];
  readonly submappers: readonly number[];
  readonly requiresSubmapper?: true;
}

// Conventional board capacities from NESdev's mapper and submapper references.
// MMC1 outer banking uses CHR A16 for conventional 512 KiB boards.
const boardLayout = (
  metadata: NesRomMetadata,
  selection?: NesBoardSelection,
): BoardLayout | null => {
  const wiring = selection?.family === "vrc" ? selection.wiring : undefined;
  switch (metadata.mapper) {
    case 5:
      return {
        board: "MMC5 (PRG/RAM banking)",
        bankSize: 8192,
        minPrgSize: 8192,
        maxPrgSize: 1048576,
        chrSizes: [
          0, 8192, 16384, 32768, 65536, 131072, 262144, 524288, 1048576,
        ],
        submappers: [0],
      };
    case 19:
      return {
        board: "Namco 129/163 (explicit conventional profile)",
        bankSize: 8192,
        minPrgSize: 32768,
        maxPrgSize: 524288,
        chrSizes: [8192, 16384, 32768, 65536, 131072, 262144],
        submappers: [0, 1, 2, 3, 4, 5],
      };
    case 69: {
      const variant =
        selection?.family === "sunsoft" ? selection.variant : "fme7";
      return {
        board: `Sunsoft ${variant.toUpperCase()}`,
        bankSize: 8192,
        minPrgSize: 32768,
        maxPrgSize: (fme7Mask(variant) + 1) * 8192,
        chrSizes: [0, 8192, 16384, 32768, 65536, 131072, 262144],
        submappers: [0],
      };
    }
    case 87:
      return {
        board: "J87",
        bankSize: metadata.prgRom.size,
        minPrgSize: 0x4000,
        maxPrgSize: 0x8000,
        chrSizes: [0x2000, 0x4000, 0x8000],
        submappers: [0],
      };
    case 68:
      return {
        board: "Sunsoft 4 (normal)",
        bankSize: 0x4000,
        minPrgSize: 0x4000,
        maxPrgSize: 0x40000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000],
        submappers: [0],
      };
    case 73:
      return {
        board: "Konami VRC3",
        bankSize: 0x4000,
        minPrgSize: 0x4000,
        maxPrgSize: 0x20000,
        chrSizes: [0],
        submappers: [0],
      };
    case 78:
      return {
        board:
          irem78Board(
            metadata,
            selection?.family === "irem78" ? selection.variant : undefined,
          ) === "cosmo-carrier"
            ? "Irem Cosmo Carrier"
            : "Irem Holy Diver",
        bankSize: 0x4000,
        minPrgSize: 0x4000,
        maxPrgSize: 0x20000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000],
        submappers: [1, 3],
        requiresSubmapper: true,
      };
    case 76:
      return {
        board: "Namco 109 / 3446",
        bankSize: 0x2000,
        minPrgSize: 0x4000,
        maxPrgSize: 0x20000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000],
        submappers: [0],
      };
    case 0:
      return {
        board: "NROM",
        bankSize: metadata.prgRom.size,
        minPrgSize: 0x4000,
        maxPrgSize: 0x8000,
        chrSizes: [0, 0x2000],
        submappers: [0],
      };
    case 1:
      return {
        board: mmc1HasFixedPrg(metadata)
          ? "MMC1 fixed PRG (SEROM/SHROM/SH1ROM)"
          : "MMC1",
        bankSize: mmc1HasFixedPrg(metadata) ? 0x8000 : 0x4000,
        minPrgSize: 0x8000,
        maxPrgSize: mmc1HasFixedPrg(metadata) ? 0x8000 : 0x80000,
        chrSizes: [0, 0x2000, 0x4000, 0x8000, 0x10000, 0x20000],
        submappers: [0, 1, 2, 4, 5],
      };
    case 180:
      return {
        board: "UNROM inverted",
        bankSize: 0x4000,
        minPrgSize: 0x4000,
        maxPrgSize: 0x20000,
        chrSizes: [0],
        submappers: [0],
      };
    case 2:
      return {
        board: "UxROM",
        bankSize: 0x4000,
        minPrgSize: 0x4000,
        maxPrgSize: 0x40000,
        chrSizes: [0],
        submappers: [0, 1, 2],
      };
    case 3:
      return {
        board: "CNROM",
        bankSize: metadata.prgRom.size,
        minPrgSize: 0x4000,
        maxPrgSize: 0x8000,
        chrSizes: [0x2000, 0x4000, 0x8000],
        submappers: [0, 1, 2],
      };
    case 4:
      return {
        board:
          metadata.submapper === 1
            ? "MMC6/HKROM"
            : metadata.submapper === 2
              ? "MMC3 hardwired mirroring"
              : metadata.submapper === 3
                ? "MC-ACC"
                : metadata.submapper === 4
                  ? "NEC MMC3"
                  : "MMC3",
        bankSize: 0x2000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x80000,
        chrSizes: [0, 0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000],
        submappers: [0, 1, 2, 3, 4],
      };
    case 23:
    case 25:
      if (nesVrcBoard(metadata, wiring)?.family !== "vrc2")
        return vrc4Layout(metadata, wiring);
      return {
        board: metadata.mapper === 23 ? "Konami VRC2b" : "Konami VRC2c",
        bankSize: 0x2000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x40000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000],
        submappers: [3],
        requiresSubmapper: true,
      };
    case 21:
      return vrc4Layout(metadata, wiring);
    case 22:
      return {
        board: "Konami VRC2a",
        bankSize: 0x2000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x40000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000],
        submappers: [0],
      };
    case 16:
    case 159: {
      const chip = bandaiBoard(
        metadata,
        selection?.family === "bandai" ? selection.variant : undefined,
      );
      return {
        board:
          metadata.mapper === 159
            ? "Bandai LZ93D50/X24C01"
            : chip === "fcg"
              ? "Bandai FCG-1/2"
              : "Bandai LZ93D50",
        bankSize: 0x4000,
        minPrgSize: 0x4000,
        maxPrgSize: 0x40000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000],
        submappers: metadata.mapper === 16 ? [4, 5] : [0],
        ...(metadata.mapper === 16 ? { requiresSubmapper: true as const } : {}),
      };
    }
    case 24:
    case 26:
      return {
        board: metadata.mapper === 24 ? "Konami VRC6a" : "Konami VRC6b",
        bankSize: 0x2000,
        minPrgSize: 0x4000,
        maxPrgSize: 0x40000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000],
        submappers: [0],
      };
    case 75:
      return {
        board: "Konami VRC1",
        bankSize: 0x2000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x20000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000],
        submappers: [0],
      };
    case 33:
      return {
        board: "Taito TC0190 / TC0350",
        bankSize: 0x2000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x80000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000, 0x80000],
        submappers: [0],
      };
    case 67:
      return {
        board: "Sunsoft 3",
        bankSize: 0x4000,
        minPrgSize: 0x4000,
        maxPrgSize: 0x40000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000],
        submappers: [0],
      };
    case 65:
      return {
        board: "Irem H3001",
        bankSize: 0x2000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x80000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000],
        submappers: [0],
      };
    case 32:
      return {
        board: "Irem G-101",
        bankSize: 0x2000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x40000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000],
        submappers: [0, 1],
      };
    case 206:
      return {
        board: namco108HasFixedPrg(metadata)
          ? "Namco 108 fixed PRG"
          : "Namco 108 / DxROM",
        bankSize: namco108HasFixedPrg(metadata) ? 0x8000 : 0x2000,
        minPrgSize: 0x8000,
        maxPrgSize: namco108HasFixedPrg(metadata) ? 0x8000 : 0x20000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000],
        submappers: [0, 1],
      };
    case 232:
      return {
        board: "Camerica Quattro",
        bankSize: 0x4000,
        minPrgSize: 0x10000,
        maxPrgSize: 0x40000,
        chrSizes: [0],
        submappers: [0, 1],
      };
    case 71:
      return {
        board: "Camerica",
        bankSize: 0x4000,
        minPrgSize: 0x20000,
        maxPrgSize: metadata.submapper === 1 ? 0x20000 : 0x40000,
        chrSizes: [0],
        submappers: [0, 1],
      };
    case 7:
      return {
        board: "AxROM",
        bankSize: 0x8000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x40000,
        chrSizes: [0],
        submappers: [0, 1, 2],
      };
    case 9:
    case 10:
      return {
        board: metadata.mapper === 9 ? "MMC2" : "MMC4",
        bankSize: metadata.mapper === 9 ? 0x2000 : 0x4000,
        minPrgSize: 0x8000,
        maxPrgSize: metadata.mapper === 9 ? 0x20000 : 0x40000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000],
        submappers: [0],
      };
    case 34: {
      const board = nesMapper34Board(metadata);
      return {
        board,
        bankSize: 0x8000,
        minPrgSize: 0x8000,
        maxPrgSize: board === "NINA-001" ? 0x10000 : 0x20000,
        chrSizes:
          board === "NINA-001"
            ? [0x2000, 0x4000, 0x8000, 0x10000]
            : [0, 0x2000],
        submappers: [0, 1, 2],
      };
    }
    case 11:
      return {
        board: "Color Dreams",
        bankSize: 0x8000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x20000,
        chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000],
        submappers: [0],
      };
    case 66:
      return {
        board: "GxROM",
        bankSize: 0x8000,
        minPrgSize: 0x8000,
        maxPrgSize: 0x20000,
        chrSizes: [0x2000, 0x4000, 0x8000],
        submappers: [0],
      };
    default:
      return null;
  }
};

const vrc4Layout = (
  metadata: NesRomMetadata,
  wiring?: NesVrcWiring,
): BoardLayout => ({
  board: vrc4Board(metadata, wiring)?.name ?? "Konami VRC4",
  bankSize: 0x2000,
  minPrgSize: 0x8000,
  maxPrgSize: 0x40000,
  chrSizes: [0x2000, 0x4000, 0x8000, 0x10000, 0x20000, 0x40000, 0x80000],
  submappers: [1, 2],
  requiresSubmapper: true,
});

const prgSizeSupported = (size: number, board: BoardLayout): boolean =>
  Number.isSafeInteger(size) &&
  size >= board.minPrgSize &&
  size <= board.maxPrgSize &&
  Number.isInteger(Math.log2(size));

/** Derive fixed banks or complete selected PRG contexts without inferring runtime state. */
export const resolveNesMapperLayout = (
  metadata: NesRomMetadata,
  views?: readonly NesPrgView[],
  selection?: NesBoardSelection,
): Result<NesMapperLayout, string> => {
  const choices = new Map<string, NesBoardSelection>();
  for (const choice of [selection, ...(views ?? []).map(nesBoardSelection)])
    if (choice !== undefined)
      choices.set(
        choice.family === "vrc"
          ? `vrc:${choice.wiring}`
          : `${choice.family}:${choice.variant}`,
        choice,
      );
  if (choices.size > 1)
    return err(
      "Every NES PRG view must use the same immutable board assumption.",
    );
  const selected = [...choices.values()][0];
  const selectedWiring =
    selected?.family === "vrc" ? selected.wiring : undefined;
  const selectedBandai =
    selected?.family === "bandai" ? selected.variant : undefined;
  if (selected?.family === "sunsoft" && metadata.mapper !== 69)
    return err("Sunsoft variant assumption requires Mapper 69.");
  if (selected?.family === "sunsoft4" && metadata.mapper !== 68)
    return err("Sunsoft 4 normal board assumption requires Mapper 68.");
  if (selected?.family === "irem78" && metadata.mapper !== 78)
    return err("Cosmo Carrier/Holy Diver board assumptions require Mapper 78.");
  if (metadata.mapper === 78) {
    const variant = irem78Board(
      metadata,
      selected?.family === "irem78" ? selected.variant : undefined,
    );
    if (variant === null)
      return err(
        "Mapper 78 requires NES 2.0 submapper 1 (cosmo-carrier) or 3 (holy-diver), or an explicit matching variant for legacy/submapper-0 headers. Deprecated submapper 2 and conflicting board assumptions require separate profiles; historical mirroring flags do not identify a board.",
      );
    if (
      metadata.headerVersion === "nes2" &&
      (metadata.mirroring === "four-screen" ||
        metadata.prgRamSize !== 0 ||
        metadata.prgNvramSize !== 0 ||
        metadata.chrRamSize !== 0 ||
        metadata.chrNvramSize !== 0)
    )
      return err(
        "Mapper 78 profiles require CHR ROM and two-page CIRAM, with no declared RAM/NVRAM or four-screen storage. Other wiring requires a separate profile.",
      );
  }
  if (metadata.mapper === 68) {
    if (metadata.submapper !== null && metadata.submapper !== 0)
      return err(
        "Sunsoft 4 normal wiring requires NES 2.0 submapper 0; Dual Cartridge System external ROM and licensing circuitry require a separate model.",
      );
    if (
      metadata.headerVersion === "ines" &&
      metadata.prgRom.size <= 0x20000 &&
      selected?.family !== "sunsoft4"
    )
      return err(
        "A legacy Mapper 68 image of at most 128 KiB does not distinguish normal Sunsoft 4 from Dual Cartridge System wiring. Supply variant normal in initial state or PRG views as an immutable board assumption; original headers are not rewritten.",
      );
  }
  if (
    selectedWiring !== undefined &&
    nesVrcBoard(metadata, selectedWiring) === null
  )
    return err(
      "VRC wiring assumption conflicts with the cartridge mapper or explicit NES 2.0 submapper.",
    );
  if (
    selectedBandai !== undefined &&
    bandaiBoard(metadata, selectedBandai) === null
  )
    return err(
      "Bandai variant assumption conflicts with the cartridge mapper or explicit NES 2.0 submapper.",
    );
  if (
    metadata.mapper === 16 &&
    (metadata.submapper === null || metadata.submapper === 0) &&
    selectedBandai === undefined
  )
    return err(
      "Bandai Mapper 16 legacy/submapper-0 headers require an explicit fcg/lz93d50 variant assumption in PRG views or initial state; source headers are not rewritten.",
    );
  const board = boardLayout(metadata, selected);
  if (metadata.mapper === 73) {
    if (metadata.mirroring === "four-screen")
      return err(
        "VRC3 uses fixed header H/V CIRAM wiring; four-screen requires a separate profile.",
      );
    if (metadata.headerVersion === "nes2") {
      const prgRam = metadata.prgRamSize ?? 0,
        prgNvram = metadata.prgNvramSize ?? 0,
        chrRam = metadata.chrRamSize ?? 0,
        chrNvram = metadata.chrNvramSize ?? 0;
      if (
        (prgRam > 0 && prgNvram > 0) ||
        ![0, 8192].includes(prgRam + prgNvram) ||
        (chrRam > 0 && chrNvram > 0) ||
        chrRam + chrNvram !== 8192
      )
        return err(
          "VRC3 requires one declared 8 KiB CHR RAM/NVRAM chip and no PRG storage or one fixed 8 KiB PRG RAM/NVRAM chip; other storage needs separate wiring.",
        );
    }
  }
  if (metadata.mapper === 76 || metadata.mapper === 87) {
    const label = metadata.mapper === 76 ? "Namco 109" : "J87";
    if (metadata.mirroring === "four-screen")
      return err(
        `${label} requires fixed horizontal/vertical CIRAM wiring; four-screen needs a separate profile.`,
      );
    if (
      metadata.headerVersion === "nes2" &&
      (metadata.prgRamSize !== 0 ||
        metadata.prgNvramSize !== 0 ||
        metadata.chrRamSize !== 0 ||
        metadata.chrNvramSize !== 0)
    )
      return err(
        `${label} has no modeled RAM/NVRAM; explicit storage declarations require a separate board profile.`,
      );
  }
  if ([65, 67, 68].includes(metadata.mapper)) {
    const storageBoard =
      metadata.mapper === 65
        ? "Irem H3001"
        : metadata.mapper === 67
          ? "Sunsoft 3"
          : "Sunsoft 4";
    if (metadata.mirroring === "four-screen")
      return err(
        `${storageBoard} supports CIRAM mirroring only; four-screen wiring requires a separate profile.`,
      );
    if (metadata.headerVersion === "nes2") {
      const ram = metadata.prgRamSize ?? 0,
        nvram = metadata.prgNvramSize ?? 0;
      if (
        (ram > 0 && nvram > 0) ||
        ![0, 8192].includes(ram + nvram) ||
        metadata.chrRamSize !== 0 ||
        metadata.chrNvramSize !== 0
      )
        return err(
          `${storageBoard} requires CHR ROM and no PRG storage or one explicitly declared 8 KiB RAM/NVRAM chip; other storage needs separate wiring.`,
        );
    }
  }
  if (metadata.mapper === 5 && metadata.mirroring === "four-screen")
    return err(
      "MMC5 does not use header four-screen mirroring; its nametable wiring requires a separate PPU model.",
    );
  if (board === null)
    return err(
      `NES Mapper ${metadata.mapper} requires a separate bank-switching model; supported static layouts are Mapper 0 (NROM), 1 (MMC1), 2 (UxROM), 3 (CNROM), 4 (MMC3), 5 (MMC5 PRG/RAM), 7 (AxROM), 9 (MMC2), 10 (MMC4), 11 (Color Dreams), 16/159 (Bandai FCG), 19 (Namco 163), 69 (Sunsoft FME-7/5A/5B), 21/23/25 (VRC4 submappers 1/2), 24/26 (VRC6), 22 (VRC2a), 23/25 (VRC2b/c submapper 3), 32 (Irem G-101), 33 (Taito TC0190), 34 (BNROM/NINA-001), 65 (Irem H3001), 66 (GxROM), 67 (Sunsoft 3), 68 (Sunsoft 4 normal), 71 (Camerica), 73 (VRC3), 75 (VRC1), 76 (Namco 109), 78 (Cosmo Carrier/Holy Diver), 87 (J87), 180 (UNROM inverted), 232 (Quattro), and 206 (Namco 108).`,
    );
  if (metadata.consoleType !== 0)
    return err(
      "NES static analysis supports NES/Famicom console type 0 only; other console types require separate profiles.",
    );
  if (
    board.requiresSubmapper &&
    (metadata.submapper === null || metadata.submapper === 0) &&
    selected === undefined
  )
    return err(
      `${board.board} requires a matching explicit NES 2.0 submapper or caller-selected wiring assumption; legacy/submapper-0 Mapper ${metadata.mapper} does not establish the chip and register address wiring.`,
    );
  if (
    metadata.submapper !== null &&
    !board.submappers.includes(metadata.submapper) &&
    !(metadata.submapper === 0 && selected !== undefined)
  )
    return err(
      `NES Mapper ${metadata.mapper} submapper ${metadata.submapper} requires a separate layout profile.`,
    );
  if (metadata.mapper === 1 && [1, 2, 4].includes(metadata.submapper ?? 0)) {
    const ramSize = (metadata.prgRamSize ?? 0) + (metadata.prgNvramSize ?? 0);
    const expectedRam =
      metadata.submapper === 1
        ? 8192
        : metadata.submapper === 2
          ? 16384
          : 32768;
    const chrRam8k =
      (metadata.chrRamSize === 8192 && metadata.chrNvramSize === 0) ||
      (metadata.chrRamSize === 0 && metadata.chrNvramSize === 8192);
    if (
      metadata.chrRom.size !== 0 ||
      !chrRam8k ||
      ramSize !== expectedRam ||
      (metadata.submapper === 1 &&
        metadata.prgRamSize !== 8192 &&
        metadata.prgNvramSize !== 8192) ||
      (metadata.submapper === 1 && metadata.prgRom.size !== 0x80000) ||
      (metadata.submapper === 2 && metadata.prgRom.size > 0x40000)
    )
      return err(
        "Deprecated MMC1 SUROM/SOROM/SXROM submapper declarations must match their PRG ROM/RAM and 8 KiB CHR RAM wiring.",
      );
  }
  if (!prgSizeSupported(metadata.prgRom.size, board))
    return err(
      `${board.board} requires power-of-two PRG ROM sizes from ${board.minPrgSize / 1024} through ${board.maxPrgSize / 1024} KiB.`,
    );
  if (metadata.mapper === 19 && metadata.mirroring === "four-screen")
    return err(
      "Namco 163 nametable selection does not establish four-screen board wiring.",
    );
  if (metadata.mapper === 19 && metadata.headerVersion === "nes2") {
    const ram = metadata.prgRamSize ?? 0,
      nvram = metadata.prgNvramSize ?? 0;
    if (
      (ram !== 0 && nvram !== 0) ||
      ![0, 8192].includes(ram + nvram) ||
      (metadata.submapper === 1 && ram + nvram !== 0)
    )
      return err(
        "Namco 163 requires no external RAM or one declared 8 KiB RAM/NVRAM chip; deprecated submapper 1 has no external RAM.",
      );
  }
  if (metadata.mapper === 69) {
    if (metadata.mirroring === "four-screen")
      return err(
        "Sunsoft extra nametable RAM requires a separate board profile.",
      );
    if (metadata.headerVersion === "nes2") {
      const ram = metadata.prgRamSize ?? 0,
        nvram = metadata.prgNvramSize ?? 0,
        size = ram + nvram;
      if (
        (ram > 0 && nvram > 0) ||
        (size !== 0 &&
          (size < 2048 ||
            size > board.maxPrgSize ||
            !Number.isInteger(Math.log2(size))))
      )
        return err(
          "Sunsoft RAM requires zero or one declared power-of-two 2 KiB–chip-capacity RAM/NVRAM region; mixed or oversized storage needs separate wiring.",
        );
    }
  }
  if (!board.chrSizes.includes(metadata.chrRom.size))
    return err(
      `${board.board} supports CHR ROM sizes of ${board.chrSizes.map((size) => size / 1024).join(", ")} KiB only.`,
    );
  if (metadata.miscRomCount !== null && metadata.miscRomCount !== 0)
    return err(
      "NES 2.0 miscellaneous ROM declarations require a separate layout profile.",
    );
  if (metadata.trailingData !== null)
    return err(
      "NES trailing data requires a separate layout profile; static imports cover the declared header, trainer, PRG ROM, and CHR ROM only.",
    );
  if (
    metadata.mapper === 1 &&
    metadata.prgRom.size > 0x40000 &&
    (metadata.chrRom.size > 8192 ||
      (metadata.headerVersion === "nes2" &&
        metadata.chrRom.size === 0 &&
        !(
          (metadata.chrRamSize === 8192 && metadata.chrNvramSize === 0) ||
          (metadata.chrRamSize === 0 && metadata.chrNvramSize === 8192)
        )))
  )
    return err(
      "512 KiB MMC1 PRG ROM requires conventional 8 KiB CHR ROM or RAM wiring.",
    );
  if (
    (metadata.mapper === 24 || metadata.mapper === 26) &&
    metadata.mirroring === "four-screen"
  )
    return err(
      "VRC6 extra nametable RAM/four-screen PCB wiring requires a separate layout profile.",
    );
  if (metadata.mapper === 16 || metadata.mapper === 159) {
    if (metadata.mirroring === "four-screen")
      return err(
        "Bandai extra nametable RAM/four-screen PCB wiring requires a separate layout profile.",
      );
    const chip = bandaiBoard(metadata, selectedBandai);
    if (
      metadata.headerVersion === "nes2" &&
      (metadata.prgRamSize !== 0 ||
        (metadata.mapper === 159
          ? metadata.prgNvramSize !== 128
          : chip === "fcg"
            ? metadata.prgNvramSize !== 0
            : ![0, 256].includes(metadata.prgNvramSize ?? -1)))
    )
      return err(
        "Bandai storage declaration conflicts with FCG-1/2, LZ93D50/24C02 or Mapper 159/X24C01 wiring; EEPROM is not CPU PRG RAM.",
      );
  }
  const prgBanks = metadata.prgRom.size / board.bankSize;
  const contexts = resolveContexts(metadata, views, selected);
  if (!contexts.ok) return contexts;
  return ok({
    mapper: metadata.mapper,
    board: board.board,
    bankSize: board.bankSize,
    prgBanks,
    chrBanks: metadata.chrRom.size / 0x2000,
    mappings:
      contexts.value.length === 0
        ? prgMappings(metadata, board.bankSize, prgBanks)
        : contexts.value.flatMap((context) =>
            contextMappings(metadata, context, prgBanks),
          ),
    contexts: contexts.value,
    limitations: [
      ...mapperLimitations(metadata, contexts.value.length > 0, selectedWiring),
      ...(selectedWiring === undefined
        ? []
        : [
            `Caller-selected ${selectedWiring} wiring is an immutable analysis assumption. Original header bytes, mapper/submapper observations, ROM offsets and digest are preserved; this does not identify a physical board or initialize RAM.`,
          ]),
      ...(selectedBandai === undefined
        ? []
        : [
            `Caller-selected ${selectedBandai} chip interpretation is an immutable analysis assumption; original header observations, source offsets and digest are preserved.`,
          ]),
      ...(selected?.family !== "sunsoft4"
        ? []
        : [
            "Caller-selected normal Sunsoft 4 wiring is an immutable analysis assumption, excluding Dual Cartridge System external ROM and licensing circuitry. Original header bytes, capacities, offsets and digest are preserved.",
          ]),
      ...(selected?.family !== "irem78"
        ? []
        : [
            `Caller-selected ${selected.variant} wiring is an immutable Mapper 78 analysis assumption. Historical legacy mirroring flags, original header bytes, capacities, source offsets and digest are preserved; only two-page CIRAM routing is qualified.`,
          ]),
      ...contextLimitations(metadata, contexts.value),
    ],
  });
};

const resolveContexts = (
  metadata: NesRomMetadata,
  views: readonly NesPrgView[] | undefined,
  selection: NesBoardSelection | undefined,
): Result<readonly NesPrgContext[], string> => {
  const wiring = selection?.family === "vrc" ? selection.wiring : undefined;
  const bandaiVariant =
    selection?.family === "bandai" ? selection.variant : undefined;
  const sunsoftVariant =
    selection?.family === "sunsoft" ? selection.variant : "fme7";
  const mapper = metadata.mapper;
  if (mmc1HasFixedPrg(metadata))
    return views === undefined
      ? ok([])
      : err("MMC1 submapper 5 has fixed PRG ROM; nes_prg_views do not apply.");
  if (namco108HasFixedPrg(metadata))
    return views === undefined
      ? ok([])
      : err(
          "Mapper 206 submapper 1 has fixed PRG ROM; nes_prg_views do not apply.",
        );
  const outer = mapper === 1 && metadata.prgRom.size > 0x40000;
  if (
    (mapper === 232 ||
      mapper === 180 ||
      mapper === 2 ||
      mapper === 71 ||
      mapper === 7 ||
      mapper === 66 ||
      mapper === 11 ||
      mapper === 34) &&
    views === undefined
  )
    return ok([]);
  if (
    !isVrc2Mapper(mapper) &&
    mapper !== 21 &&
    mapper !== 69 &&
    mapper !== 5 &&
    mapper !== 19 &&
    mapper !== 16 &&
    mapper !== 159 &&
    mapper !== 24 &&
    mapper !== 26 &&
    mapper !== 75 &&
    mapper !== 33 &&
    mapper !== 32 &&
    mapper !== 65 &&
    mapper !== 67 &&
    mapper !== 68 &&
    mapper !== 73 &&
    mapper !== 78 &&
    mapper !== 206 &&
    mapper !== 76 &&
    mapper !== 232 &&
    mapper !== 1 &&
    mapper !== 180 &&
    mapper !== 2 &&
    mapper !== 71 &&
    mapper !== 7 &&
    mapper !== 66 &&
    mapper !== 11 &&
    mapper !== 34 &&
    mapper !== 4 &&
    mapper !== 9 &&
    mapper !== 10
  )
    return views === undefined
      ? ok([])
      : err(
          `NES PRG views require Mapper 1, 2, 4, 5, 7, 9, 10, 11, 16, 19, 159, 21, 22, 23, 24, 25, 26, 32, 33, 34, 65, 66, 67, 68, 69, 71, 73, 75, 76, 78, 87, 180, 206 or 232; the target declares Mapper ${mapper}.`,
        );
  const parsed = nesPrgViewsSchema.safeParse(
    views ?? [
      mapper === 5
        ? {
            mapper: 5,
            prg_mode: 3,
            bank_8000: 128,
            bank_a000: 129,
            bank_c000: 130,
            bank_e000: metadata.prgRom.size / 8192 - 1,
          }
        : mapper === 68
          ? { mapper: 68, variant: "normal", prg_bank: 0 }
          : mapper === 78
            ? {
                mapper: 78,
                variant: irem78Board(
                  metadata,
                  selection?.family === "irem78"
                    ? selection.variant
                    : undefined,
                ),
                prg_bank: 0,
              }
            : mapper === 69
              ? {
                  mapper: 69,
                  variant: sunsoftVariant,
                  lower_window: { source: "rom", bank: 0 },
                  prg_bank_0: 0,
                  prg_bank_1: 1,
                  prg_bank_2: 2,
                }
              : mapper === 1
                ? {
                    mapper: 1,
                    prg_mode: 3,
                    prg_bank: 0,
                    ...(outer ? { prg_outer_bank: 0 } : {}),
                  }
                : mapper === 16
                  ? {
                      mapper: 16,
                      variant: bandaiBoard(metadata, bandaiVariant),
                      prg_bank: 0,
                    }
                  : mapper === 159
                    ? { mapper: 159, prg_bank: 0 }
                    : mapper === 24 || mapper === 26
                      ? { mapper, prg_bank_16k: 0, prg_bank_8k: 0 }
                      : vrc4Board(metadata, wiring) !== null
                        ? {
                            mapper,
                            variant: "vrc4",
                            ...(wiring === undefined ? {} : { wiring }),
                            prg_mode: 0,
                            prg_bank_0: 0,
                            prg_bank_1: 1,
                          }
                        : isVrc2Mapper(mapper)
                          ? {
                              mapper,
                              ...(wiring === undefined ? {} : { wiring }),
                              prg_bank_0: 0,
                              prg_bank_1: 1,
                            }
                          : mapper === 75 || mapper === 19
                            ? {
                                mapper,
                                ...(mapper === 19
                                  ? { variant: "namco163" }
                                  : {}),
                                prg_bank_0: 0,
                                prg_bank_1: 1,
                                prg_bank_2: 2,
                              }
                            : mapper === 33
                              ? { mapper: 33, prg_bank_0: 0, prg_bank_1: 1 }
                              : mapper === 32 || mapper === 65
                                ? {
                                    mapper,
                                    prg_mode: 0,
                                    prg_bank_0: 0,
                                    prg_bank_1: 1,
                                  }
                                : mapper === 206 || mapper === 76
                                  ? { mapper, r6: 0, r7: 1 }
                                  : mapper === 4
                                    ? { mapper: 4, prg_mode: 0, r6: 0, r7: 1 }
                                    : { mapper, prg_bank: 0 },
    ],
  );
  if (!parsed.success)
    return err(
      `Invalid NES PRG views: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  if (parsed.data.some((view) => view.mapper !== mapper))
    return err(`Every NES PRG view must match the target's Mapper ${mapper}.`);
  if (
    parsed.data.some(
      (view) => isVrc4View(view) !== (vrc4Board(metadata, wiring) !== null),
    )
  )
    return err(
      "VRC4 PRG views require variant vrc4 and matching header-selected or explicitly assumed VRC4 wiring; VRC2 views must omit variant.",
    );
  if (
    wiring !== undefined &&
    parsed.data.some((view) => !("wiring" in view) || view.wiring !== wiring)
  )
    return err(
      "Every NES PRG view must retain the same explicit VRC wiring assumption.",
    );
  if (
    parsed.data.some(
      (view) =>
        view.mapper === 16 && bandaiBoard(metadata, view.variant) === null,
    )
  )
    return err(
      "Bandai PRG view variant conflicts with the explicit chip declaration.",
    );
  if (
    parsed.data.some(
      (view) =>
        view.mapper === 1 &&
        (outer ? !("prg_outer_bank" in view) : "prg_outer_bank" in view),
    )
  )
    return err(
      "MMC1 prg_outer_bank must be supplied exactly for 512 KiB PRG ROM views.",
    );
  if (
    metadata.mapper === 32 &&
    metadata.submapper === 1 &&
    parsed.data.some((view) => view.mapper === 32 && view.prg_mode !== 0)
  )
    return err("Mapper 32 submapper 1 has hardwired PRG mode 0.");
  return ok(
    parsed.data.map((state) => ({
      state,
      addressSpace:
        (state.mapper === 5
          ? mmc5ViewName(state)
          : state.mapper === 69
            ? `NES_M69_${state.variant.toUpperCase()}_L${state.lower_window.source === "rom" ? `R${hexSelector(state.lower_window.bank)}` : "RAM"}_P${hexSelector(state.prg_bank_0)}_Q${hexSelector(state.prg_bank_1)}_R${hexSelector(state.prg_bank_2)}`
            : state.mapper === 68
              ? `NES_M68_NORMAL_P${hexSelector(state.prg_bank)}`
              : state.mapper === 78
                ? `NES_M78_${state.variant.replaceAll("-", "_").toUpperCase()}_P${hexSelector(state.prg_bank)}`
                : state.mapper === 16
                  ? `NES_M16_${state.variant.toUpperCase()}_P${hexSelector(state.prg_bank)}`
                  : state.mapper === 159
                    ? `NES_M159_P${hexSelector(state.prg_bank)}`
                    : isVrc6View(state)
                      ? `NES_M${state.mapper}_P${hexSelector(state.prg_bank_16k)}_Q${hexSelector(state.prg_bank_8k)}`
                      : isVrc4View(state)
                        ? `NES_M${state.mapper}_V4_M${state.prg_mode}_P${hexSelector(state.prg_bank_0)}_Q${hexSelector(state.prg_bank_1)}`
                        : isVrc2View(state)
                          ? `NES_M${state.mapper}_P${hexSelector(state.prg_bank_0)}_Q${hexSelector(state.prg_bank_1)}`
                          : state.mapper === 75 || state.mapper === 19
                            ? `NES_M${state.mapper}_P${hexSelector(state.prg_bank_0)}_Q${hexSelector(state.prg_bank_1)}_R${hexSelector(state.prg_bank_2)}`
                            : state.mapper === 33
                              ? `NES_M33_P${hexSelector(state.prg_bank_0)}_Q${hexSelector(state.prg_bank_1)}`
                              : state.mapper === 32 || state.mapper === 65
                                ? `NES_M${state.mapper}_M${state.prg_mode}_P${hexSelector(state.prg_bank_0)}_Q${hexSelector(state.prg_bank_1)}`
                                : state.mapper === 206 || state.mapper === 76
                                  ? `NES_M${state.mapper}_R${hexSelector(state.r6)}_S${hexSelector(state.r7)}`
                                  : state.mapper === 232
                                    ? `NES_M232_O${state.prg_outer_bank}_P${hexSelector(state.prg_bank)}`
                                    : state.mapper === 1
                                      ? `NES_M1_M${state.prg_mode}_P${hexSelector(state.prg_bank)}${!("prg_outer_bank" in state) ? "" : `_O${state.prg_outer_bank}`}`
                                      : state.mapper === 4
                                        ? `NES_M4_M${state.prg_mode}_R${hexSelector(state.r6)}_S${hexSelector(state.r7)}`
                                        : `NES_M${state.mapper}_P${hexSelector(state.prg_bank)}`) +
        ("wiring" in state && state.wiring !== undefined
          ? `_${state.wiring.toUpperCase()}`
          : ""),
      selection: views === undefined ? "default-assumption" : "caller-selected",
    })),
  );
};

const hexSelector = (value: number): string =>
  value.toString(16).padStart(2, "0");

const contextMappings = (
  metadata: NesRomMetadata,
  context: NesPrgContext,
  prgBanks: number,
): readonly NesPrgMapping[] => {
  const state = context.state;
  const mask = prgBanks - 1;
  if (state.mapper === 5)
    return mmc5Mapping(metadata, mmc5StateFromView(state))
      .prg_windows.filter(
        (window) => window.file_offset !== null && window.bank !== null,
      )
      .map((window, index) => ({
        name:
          index === 0
            ? context.addressSpace
            : `${context.addressSpace}_A${window.start.toString(16)}`,
        addressSpace: context.addressSpace,
        start: window.start,
        size: window.size,
        fileOffset: window.file_offset!,
        bank: window.bank!,
        role: "switchable" as const,
      }));
  if (state.mapper === 69) {
    const windows = [
      ...(state.lower_window.source === "rom"
        ? [{ start: 0x6000, bank: state.lower_window.bank & mask }]
        : []),
      { start: 0x8000, bank: state.prg_bank_0 & mask },
      { start: 0xa000, bank: state.prg_bank_1 & mask },
      { start: 0xc000, bank: state.prg_bank_2 & mask },
      { start: 0xe000, bank: prgBanks - 1 },
    ];
    return windows.map(({ start, bank }, index) => ({
      name:
        index === 0
          ? context.addressSpace
          : `${context.addressSpace}_A${start.toString(16)}`,
      addressSpace: context.addressSpace,
      start,
      size: 8192,
      fileOffset: metadata.prgRom.offset + bank * 8192,
      bank,
      role: start === 0xe000 ? "fixed" : "switchable",
    }));
  }
  const size =
    state.mapper === 7 ||
    state.mapper === 66 ||
    state.mapper === 11 ||
    state.mapper === 34
      ? 0x8000
      : state.mapper === 232 ||
          state.mapper === 1 ||
          state.mapper === 180 ||
          state.mapper === 2 ||
          state.mapper === 71 ||
          state.mapper === 10 ||
          state.mapper === 16 ||
          state.mapper === 159 ||
          state.mapper === 67 ||
          state.mapper === 68 ||
          state.mapper === 73 ||
          state.mapper === 78
        ? 0x4000
        : 0x2000;
  let banks: readonly number[];
  let fixedWindows: readonly number[];
  if (
    state.mapper === 7 ||
    state.mapper === 66 ||
    state.mapper === 11 ||
    state.mapper === 34
  ) {
    banks = [state.prg_bank & mask];
    fixedWindows = [];
  } else if (state.mapper === 232) {
    banks = [
      (state.prg_outer_bank * 4 + state.prg_bank) & mask,
      (state.prg_outer_bank * 4 + 3) & mask,
    ];
    fixedWindows = [1];
  } else if (
    state.mapper === 16 ||
    state.mapper === 159 ||
    state.mapper === 67 ||
    state.mapper === 68 ||
    state.mapper === 73 ||
    state.mapper === 78
  ) {
    banks = [state.prg_bank & mask, prgBanks - 1];
    fixedWindows = [1];
  } else if (state.mapper === 1) {
    const bank = state.prg_bank & Math.min(mask, 15);
    const outer = ("prg_outer_bank" in state ? state.prg_outer_bank : 0) * 16;
    banks = (
      state.prg_mode < 2
        ? [bank & ~1, (bank & ~1) + 1]
        : state.prg_mode === 2
          ? [0, bank]
          : [bank, Math.min(prgBanks, 16) - 1]
    ).map((value) => value + outer);
    fixedWindows = state.prg_mode < 2 ? [] : [state.prg_mode === 2 ? 0 : 1];
  } else if (isVrc4View(state)) {
    banks =
      state.prg_mode === 0
        ? [
            state.prg_bank_0 & mask,
            state.prg_bank_1 & mask,
            prgBanks - 2,
            prgBanks - 1,
          ]
        : [
            prgBanks - 2,
            state.prg_bank_1 & mask,
            state.prg_bank_0 & mask,
            prgBanks - 1,
          ];
    fixedWindows = state.prg_mode === 0 ? [2, 3] : [0, 3];
  } else if (isVrc2View(state)) {
    banks = [
      state.prg_bank_0 & mask,
      state.prg_bank_1 & mask,
      prgBanks - 2,
      prgBanks - 1,
    ];
    fixedWindows = [2, 3];
  } else if (isVrc6View(state)) {
    const pair = (state.prg_bank_16k * 2) & mask;
    banks = [pair, pair + 1, state.prg_bank_8k & mask, prgBanks - 1];
    fixedWindows = [3];
  } else if (state.mapper === 75 || state.mapper === 19) {
    banks = [
      state.prg_bank_0 & mask,
      state.prg_bank_1 & mask,
      state.prg_bank_2 & mask,
      prgBanks - 1,
    ];
    fixedWindows = [3];
  } else if (state.mapper === 33) {
    banks = [
      state.prg_bank_0 & mask,
      state.prg_bank_1 & mask,
      prgBanks - 2,
      prgBanks - 1,
    ];
    fixedWindows = [2, 3];
  } else if (state.mapper === 32 || state.mapper === 65) {
    banks =
      state.prg_mode === 0
        ? [
            state.prg_bank_0 & mask,
            state.prg_bank_1 & mask,
            prgBanks - 2,
            prgBanks - 1,
          ]
        : [
            prgBanks - 2,
            state.prg_bank_1 & mask,
            state.prg_bank_0 & mask,
            prgBanks - 1,
          ];
    fixedWindows = state.prg_mode === 0 ? [2, 3] : [0, 3];
  } else if (state.mapper === 206 || state.mapper === 76) {
    banks = [state.r6 & mask, state.r7 & mask, prgBanks - 2, prgBanks - 1];
    fixedWindows = [2, 3];
  } else if (state.mapper === 4) {
    const r6 = state.r6 & mask;
    const r7 = state.r7 & mask;
    banks =
      state.prg_mode === 0
        ? [r6, r7, prgBanks - 2, prgBanks - 1]
        : [prgBanks - 2, r7, r6, prgBanks - 1];
    fixedWindows = state.prg_mode === 0 ? [2, 3] : [0, 3];
  } else if (state.mapper === 180) {
    banks = [0, state.prg_bank & mask];
    fixedWindows = [0];
  } else if (state.mapper === 9) {
    banks = [state.prg_bank & mask, prgBanks - 3, prgBanks - 2, prgBanks - 1];
    fixedWindows = [1, 2, 3];
  } else {
    banks = [state.prg_bank & mask, prgBanks - 1];
    fixedWindows = [1];
  }
  return banks.map((bank, index) => {
    const start = 0x8000 + size * index;
    return {
      name:
        index === 0
          ? context.addressSpace
          : `${context.addressSpace}_A${start.toString(16)}`,
      addressSpace: context.addressSpace,
      start,
      size,
      fileOffset: metadata.prgRom.offset + bank * size,
      bank,
      role: fixedWindows.includes(index) ? "fixed" : "switchable",
    };
  });
};

const contextLimitations = (
  metadata: NesRomMetadata,
  contexts: readonly NesPrgContext[],
): readonly string[] => {
  if (contexts.length === 0) return [];
  return [
    "Each selected mapper context is a conditional static PRG view under the recorded register selectors, normally 32 KiB plus a Mapper 69 lower 8 KiB window when ROM is selected; MMC5 RAM windows are omitted from the static ROM image. Different contexts are independent alternatives; these selectors are not observed power-on or execution-time state.",
    ...(contexts.some((context) => context.selection === "default-assumption")
      ? [
          "The PRG view uses a default analysis assumption because no caller-selected register state was supplied. MMC5 assumes mode 3 with ROM banks 0/1/2 and the last bank, leaving lower RAM wiring unknown. Mapper 69 assumes FME-7/lower ROM 0/PRG 0/1/2. MMC1 mode 3/bank 0/lower outer half where applicable, MMC3 mode 0/R6 0/R7 1, VRC6 PRG pair 0/8 KiB bank 0, VRC4 mode 0/PRG 0/1, VRC2 PRG 0/1, Namco 163 PRG 0/1/2 under a conventional 129/163 assumption, VRC1 PRG 0/1/2, Taito TC0190 PRG 0/PRG 1, Irem G-101/H3001 mode 0/PRG 0/PRG 1, Namco 108/109 R6 0/R7 1 and VRC3/qualified Mapper 78 bank 0, Sunsoft 3/Sunsoft 4 normal bank 0 and MMC2/MMC4 bank 0 are convenience choices, not hardware reset guarantees.",
        ]
      : []),
    "Only selected PRG contexts are mapped for analysis. Coverage of source banks and state combinations absent from these contexts is unknown; cross-state calls and mapper-write transitions are not reconstructed.",
    "Raw selectors are retained; effective bank numbers mask unconnected ROM address lines. CHR selectors, PRG RAM enables/banking, MMC1 serial writes, and MMC3 IRQ state are not modeled.",
    ...(metadata.mapper === 1 && metadata.prgRom.size === 0x8000
      ? [
          "A 32 KiB iNES/submapper-0 MMC1 header does not distinguish bankable SIROM from fixed-PRG SEROM/SHROM/SH1ROM boards. This view assumes standard bankable MMC1 wiring; NES 2.0 submapper 5 explicitly selects the supported fixed-PRG wiring.",
        ]
      : []),
  ];
};

const prgMappings = (
  metadata: NesRomMetadata,
  bankSize: number,
  prgBanks: number,
): readonly NesPrgMapping[] => {
  if (
    metadata.mapper === 0 ||
    metadata.mapper === 3 ||
    metadata.mapper === 87 ||
    mmc1HasFixedPrg(metadata) ||
    namco108HasFixedPrg(metadata)
  ) {
    const primary: NesPrgMapping = {
      name: "NES_PRG_ROM",
      addressSpace: "RAM",
      start: 0x8000,
      size: bankSize,
      fileOffset: metadata.prgRom.offset,
      bank: 0,
      role: "fixed",
    };
    return bankSize === 0x4000
      ? [
          primary,
          {
            ...primary,
            name: "NES_PRG_ROM_MIRROR",
            start: 0xc000,
            role: "mirror",
          },
        ]
      : [primary];
  }
  const candidates = Array.from(
    { length: prgBanks },
    (_, bank): NesPrgMapping => {
      const name = `NES_PRG_B${bank.toString(16).padStart(3, "0")}`;
      return {
        name,
        addressSpace: name,
        start: metadata.mapper === 180 ? 0xc000 : 0x8000,
        size: bankSize,
        fileOffset: metadata.prgRom.offset + bank * bankSize,
        bank,
        role: "switchable",
      };
    },
  );
  if (metadata.mapper === 180)
    return [
      {
        name: "NES_PRG_FIXED",
        addressSpace: "RAM",
        start: 0x8000,
        size: bankSize,
        fileOffset: metadata.prgRom.offset,
        bank: 0,
        role: "fixed",
      },
      ...candidates,
    ];
  return metadata.mapper === 2 || metadata.mapper === 71
    ? [
        {
          name: "NES_PRG_FIXED",
          addressSpace: "RAM",
          start: 0xc000,
          size: bankSize,
          fileOffset: metadata.prgRom.offset + (prgBanks - 1) * bankSize,
          bank: prgBanks - 1,
          role: "fixed",
        },
        ...candidates,
      ]
    : candidates;
};

const mapperLimitations = (
  metadata: NesRomMetadata,
  hasContexts: boolean,
  wiring?: NesVrcWiring,
): readonly string[] => {
  const limitations: string[] = [];
  if (
    !hasContexts &&
    (metadata.mapper === 232 ||
      metadata.mapper === 2 ||
      metadata.mapper === 71 ||
      metadata.mapper === 7 ||
      metadata.mapper === 66 ||
      metadata.mapper === 11 ||
      metadata.mapper === 34)
  )
    limitations.push(
      "Switchable PRG banks are independent static address-space views, not simultaneously mapped CPU memory. No selected bank, power-on bank, or execution-time bank transition is inferred; cross-bank references require independent review.",
    );
  if (metadata.mapper !== 0)
    limitations.push(
      "Mapper register writes, bus conflicts, CHR bank selection, and mirroring changes are not emulated. Header mirroring is an observation and does not establish execution-time mapper state.",
    );
  if (metadata.mapper === 9 || metadata.mapper === 10)
    limitations.push(
      "MMC2/MMC4 CHR selection depends on PPU-read-triggered latches as well as bank registers. Static PRG contexts do not establish CHR latch state, selected pattern tables or runtime nametable mirroring; CHR remains source metadata.",
    );
  if ((metadata.mapper === 2 || metadata.mapper === 71) && !hasContexts)
    limitations.push(
      "UxROM fixes the last 16 KiB PRG bank at CPU 0xc000 and exposes every selectable 16 KiB bank independently at 0x8000. Fixed-bank references to the switchable window have no uniquely known destination.",
    );
  limitations.push(...nesMapperBoardLimitations(metadata, wiring));
  if (metadata.mapper === 68) {
    if (metadata.headerVersion === "ines" && metadata.prgRom.size > 0x20000)
      limitations.push(
        "The legacy PRG capacity exceeds the documented Dual Cartridge System internal-ROM maximum, so this analysis uses the normal Sunsoft 4 profile. This is a capacity-based interpretation, not an observation of the physical board.",
      );
  }
  if (metadata.mapper === 232)
    limitations.push(
      "Quattro maps two 16 KiB windows within the selected 64 KiB outer group. The upper window is fixed only within that group; no outer bank or reset vector is assumed. Submapper 1 swaps the two outer register bits. CHR RAM is unobserved.",
    );
  if (metadata.mapper === 180)
    limitations.push(
      "Mapper 180 fixes the first 16 KiB PRG bank at 8000–BFFF and switches C000–FFFF. AND bus conflicts use the ROM byte at the write address; reset/vector bank selection is not assumed. CHR RAM contents remain unknown.",
    );
  if (metadata.mapper === 34)
    limitations.push(
      `Mapper 34 is interpreted as ${nesMapper34Board(metadata)} from ${metadata.submapper === 1 || metadata.submapper === 2 ? "the explicit NES 2.0 submapper" : "the legacy/submapper-0 CHR-size convention (above 8 KiB selects NINA-001)"}. The two boards have distinct write decoders; this is a header-based interpretation, not physical board observation.`,
    );
  if (metadata.mapper === 1 && [1, 2, 4].includes(metadata.submapper ?? 0))
    limitations.push(
      "Deprecated MMC1 SUROM/SOROM/SXROM submapper identity is retained. Capacity declarations were validated before applying the size-derived outer PRG and RAM-bank wiring; new ROM headers should use submapper 0 with accurate sizes.",
    );
  if (mmc1HasFixedPrg(metadata))
    limitations.push(
      "NES 2.0 MMC1 submapper 5 fixes the full 32 KiB PRG ROM at 8000–FFFF. PRG register writes do not affect CPU ROM mapping; CHR banking and mirroring remain MMC1-controlled. No PRG RAM wiring is inferred.",
    );
  if (metadata.mapper === 4 && metadata.submapper === 2)
    limitations.push(
      "MMC3 submapper 2 uses header-selected hardwired nametable mirroring; the MMC3 mirroring register does not control the board output.",
    );
  if (metadata.mapper === 4 && metadata.submapper === 3)
    limitations.push(
      "MC-ACC uses MMC3 PRG/CHR banking. Its falling-edge A12 prescaler and IRQ delivery are not simulated; PRG RAM wiring is unestablished and remains unknown.",
    );
  if (metadata.mapper === 4 && metadata.submapper === 4)
    limitations.push(
      "NEC MMC3 uses MMC3 PRG/CHR banking with old-style IRQ behavior. IRQ register writes are retained, but zero-latch behavior, counter clocks and interrupt delivery are not simulated.",
    );
  if (metadata.mapper === 3)
    limitations.push(
      "CNROM PRG mapping is fixed; the header declares available CHR banks but does not identify the selected 8 KiB PPU bank.",
    );
  if (
    (metadata.mapper === 232 ||
      metadata.mapper === 2 ||
      metadata.mapper === 71 ||
      metadata.mapper === 7) &&
    metadata.chrRamSize !== null &&
    metadata.chrRamSize + (metadata.chrNvramSize ?? 0) !== 0x2000
  )
    limitations.push(
      "The NES 2.0 CHR RAM/NVRAM declaration differs from the conventional 8 KiB board layout; it is preserved as metadata without reconstructing PPU RAM wiring.",
    );
  return limitations;
};
