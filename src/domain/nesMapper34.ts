import type { NesRomMetadata } from "./nes.js";

/** Mapper 34's file-format board interpretation; never combine both decoders. */
export const nesMapper34Board = (
  header: NesRomMetadata,
): "BNROM" | "NINA-001" =>
  header.submapper === 1
    ? "NINA-001"
    : header.submapper === 2
      ? "BNROM"
      : header.chrRom.size > 8192
        ? "NINA-001"
        : "BNROM";
