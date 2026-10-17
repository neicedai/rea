import type { NesRomMetadata } from "./nes.js";
import type { NesMmc5State } from "./nesMmc5.js";
import type { NesPpuPatternLocation } from "./nesPpuPattern.js";
import type { NesPpuNametableLocation } from "./nesPpuNametableSource.js";
import {
  mmc5ChrOffsets,
  mmc5NametableChoices,
  type NesMmc5Fetch,
} from "./nesMmc5Ppu.js";
import {
  mmc5BackgroundPaths,
  replicateMmc5Palette,
} from "./nesMmc5Rendering.js";
import { readMmc5ExramCell } from "./nesMmc5Exram.js";
import type { NesByteValue } from "./nesByteValue.js";

const queryPaths = (state: NesMmc5State, fetch?: NesMmc5Fetch) => {
  if (fetch === "sprite" || fetch === "ppudata" || fetch === "dummy")
    return { ordinary: true, override: false };
  const { paths } = mmc5BackgroundPaths(state, null);
  return {
    ordinary: fetch !== "background" || paths.includes("normal"),
    override: paths.some((path) => path !== "normal"),
  };
};
const renderingUnknown = () => ({
  kind: "unknown" as const,
  reason: "mmc5-rendering-context",
});

/** A static query role is a qualification, never evidence that a fetch occurred. */
export const mmc5FrozenPatternPages = (
  header: NesRomMetadata,
  mapper: NesMmc5State,
  slot: number,
  fetch?: NesMmc5Fetch,
): NesPpuPatternLocation[] => {
  const { ordinary, override } = queryPaths(mapper, fetch);
  const pages: NesPpuPatternLocation[] = ordinary
    ? mmc5ChrOffsets(header, mapper, slot * 1024, fetch).map((file_offset) => ({
        kind: "rom",
        file_offset,
      }))
    : [];
  if (header.chrRom.size === 0)
    pages.push({ kind: "unknown", reason: "mmc5-chr-ram-unmodeled" });
  if (override) pages.push(renderingUnknown());
  return pages;
};

/** Frozen pages keep storage identity separate from ordinary rendering qualification. */
export const mmc5FrozenNametablePages = (
  mapper: NesMmc5State,
  page: number,
  ciramQualified: boolean,
  fetch?: NesMmc5Fetch,
): NesPpuNametableLocation[] => {
  const { ordinary, override } = queryPaths(mapper, fetch);
  if (!ordinary) return [renderingUnknown()];
  const pages = mmc5NametableChoices(mapper, 0x2000 + page * 1024).map(
    (choice): NesPpuNametableLocation => {
      switch (choice.source) {
        case "ciram":
          return ciramQualified && choice.bank !== null
            ? choice.bank * 1024
            : { kind: "unknown", reason: "unknown-nametable-wiring" };
        case "exram":
          return { kind: "mmc5-exram" };
        case "fill":
          return {
            kind: "mmc5-fill",
            tile: structuredClone(mapper.fill_tile),
            attribute: structuredClone(mapper.fill_attribute),
          };
        case "zero":
          return { kind: "mmc5-zero" };
        default:
          return { kind: "unknown", reason: "mmc5-nametable-source" };
      }
    },
  );
  if (override) pages.push(renderingUnknown());
  return [
    ...new Map(
      pages.map((source) => [JSON.stringify(source), source]),
    ).values(),
  ];
};

/** ExRAM remains mapper-owned; generated fill/zero pages have no physical writer. */
export const readMmc5FrozenNametablePage = (
  mapper: NesMmc5State,
  page: Extract<
    NesPpuNametableLocation,
    { kind: "mmc5-exram" | "mmc5-fill" | "mmc5-zero" }
  >,
  offset: number,
): NesByteValue => {
  if (page.kind === "mmc5-zero") return 0;
  if (page.kind === "mmc5-exram")
    return mapper.exram_written === false
      ? null
      : readMmc5ExramCell(mapper, offset).value;
  if (offset < 960) return page.tile;
  return replicateMmc5Palette(page.attribute, 0);
};
