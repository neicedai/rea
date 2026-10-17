import type { NesRomMetadata } from "./nes.js";
import { bandaiLimitations } from "./nesBandai.js";
import { fme7Limitations } from "./nesFme7.js";
import { g101Limitations } from "./nesG101.js";
import { h3001Limitations } from "./nesH3001.js";
import { irem78Limitations } from "./nesIrem78.js";
import { j87Limitations } from "./nesJ87.js";
import { mmc5Limitations } from "./nesMmc5.js";
import { namco108Limitations, namco109Limitations } from "./nesNamco108.js";
import { namco163Limitations } from "./nesNamco163.js";
import { sunsoft3Limitations } from "./nesSunsoft3.js";
import { sunsoft4Limitations } from "./nesSunsoft4.js";
import { vrc1Limitations } from "./nesVrc1.js";
import { isVrc2Mapper, vrc2Limitations } from "./nesVrc2.js";
import { vrc3Limitations } from "./nesVrc3.js";
import { vrc4Board, vrc4Limitations } from "./nesVrc4.js";
import { vrc6Limitations } from "./nesVrc6.js";
import type { NesVrcWiring } from "./nesVrcBoard.js";
import { taito33Limitations } from "./nesTaito33.js";

/** One board qualification shared by static mapping and conditional source/event reports. */
export function nesMapperBoardLimitations(
  header: Pick<NesRomMetadata, "mapper" | "submapper">,
  wiring?: NesVrcWiring,
): readonly string[] {
  if (vrc4Board(header, wiring) !== null) return [vrc4Limitations];
  if (isVrc2Mapper(header.mapper)) return [vrc2Limitations(header.mapper)];
  switch (header.mapper) {
    case 5:
      return [mmc5Limitations];
    case 16:
    case 159:
      return [bandaiLimitations];
    case 19:
      return [namco163Limitations];
    case 24:
    case 26:
      return [vrc6Limitations];
    case 32:
      return [g101Limitations];
    case 33:
      return [taito33Limitations];
    case 65:
      return [h3001Limitations];
    case 67:
      return [sunsoft3Limitations];
    case 68:
      return [sunsoft4Limitations];
    case 69:
      return [fme7Limitations];
    case 73:
      return [vrc3Limitations];
    case 75:
      return [vrc1Limitations];
    case 76:
      return [namco109Limitations];
    case 78:
      return [irem78Limitations];
    case 87:
      return [j87Limitations];
    case 206:
      return [namco108Limitations];
    default:
      return [];
  }
}
