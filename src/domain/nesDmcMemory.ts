import type { NesRomMetadata } from "./nes.js";
import type { NesMapperMapping } from "./nesMapperTrace.js";
import type { NesDmcMappedRead } from "./nesDmc.js";

/** A grant qualifies the reader access; mapping and file bytes own its provenance. */
export const readNesDmcMemory = (
  header: NesRomMetadata,
  mapping: NesMapperMapping,
  prg: Uint8Array | null,
  { address, index }: { address: number | null; index: number },
): NesDmcMappedRead => {
  const window =
    address === null
      ? null
      : (mapping.prg_windows.find(
          (candidate) =>
            address >= candidate.start &&
            address < candidate.start + candidate.size,
        ) ?? null);
  const offset =
    address === null || window?.file_offset == null
      ? null
      : window.file_offset + address - window.start;
  const value =
    offset === null || prg === null
      ? null
      : (prg[offset - header.prgRom.offset] ?? null);
  return {
    address,
    value,
    file_offset: offset,
    source: {
      kind: "dmc-sample",
      index,
      window:
        window === null
          ? null
          : {
              start: window.start,
              size: window.size,
              bank: window.bank,
              file_offset: window.file_offset,
            },
      reason:
        address === null
          ? "unknown-address"
          : offset === null
            ? "unresolved-prg-window"
            : value === null
              ? "prg-bytes-unavailable"
              : null,
    },
  };
};
