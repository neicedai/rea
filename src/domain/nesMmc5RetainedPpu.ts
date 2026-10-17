import type { NesRomMetadata } from "./nes.js";
import type { NesMmc5State } from "./nesMmc5.js";
import {
  readMmc5Ppu,
  mmc5ChrOffsets,
  mmc5NametableChoices,
  type NesMmc5Fetch,
  type NesMmc5PpuRead,
  type NesMmc5PpuContext,
} from "./nesMmc5Ppu.js";
import {
  readMmc5BackgroundPpu,
  replicateMmc5Palette,
} from "./nesMmc5Rendering.js";
import type { NesMmc5TilePosition } from "./nesMmc5RenderingState.js";
import type { NesMmc5ExramCell } from "./nesMmc5Exram.js";
import { joinNesBytes, type NesByteValue } from "./nesByteValue.js";
import { readNesPpuCell, type PpuMemoryRead } from "./nesPpuMemory.js";
import type { NesPpuState } from "./nesPpuState.js";

type Source = PpuMemoryRead["sources"][number];
const unknown = (reason: string): Source => ({
  kind: "unknown",
  value: null,
  mask: 255,
  reason,
});
const join = (sources: Source[]): NesByteValue =>
  sources.length === 0
    ? null
    : sources.map((source) => source.value).reduce(joinNesBytes);
const withValue = (
  read: NesMmc5PpuRead,
  value: NesByteValue,
): NesMmc5PpuRead => {
  const base = {
    status: read.status,
    bank: read.bank,
    file_offset: read.file_offset,
    mmc5: read.mmc5,
  };
  return typeof value === "number"
    ? { ...base, value }
    : value === null
      ? { ...base, value: null }
      : { ...base, value: null, known_bits: value };
};
const context = (read: NesMmc5PpuRead): NesMmc5PpuContext => {
  const {
    fetch,
    chr_sets,
    registers,
    nametable_sources,
    cell_address,
    cell_value,
    limitation,
  } = read.mmc5;
  const base = {
    fetch,
    chr_sets,
    registers,
    nametable_sources,
    cell_address,
    cell_value,
    limitation,
  };
  return structuredClone(
    "rendering" in read.mmc5
      ? { ...base, rendering: read.mmc5.rendering }
      : base,
  );
};
const romSources = (
  header: NesRomMetadata,
  offsets: readonly number[],
  chr?: Uint8Array,
): Source[] =>
  offsets.map((file_offset) => ({
    kind: "rom",
    file_offset,
    mask: 255,
    value:
      chr?.length === header.chrRom.size
        ? (chr[file_offset - header.chrRom.offset] ?? null)
        : null,
  }));
const exramSource = (
  cell: NesMmc5ExramCell,
  value: NesByteValue,
  shift: 0 | 2 | 4 | 6 | null = null,
): Source => ({
  kind: "mmc5-exram",
  address: cell.address,
  cell_value: cell.value,
  value,
  origin: cell.origin,
  attribute_shift: shift,
  mask: 255,
});
const captured = (
  cell: {
    address: number;
    value: NesByteValue;
    origin?: NesMmc5ExramCell["origin"];
  },
  shift: 0 | 2 | 4 | 6 | null,
): Source =>
  exramSource(
    {
      address: cell.address,
      value: cell.value,
      origin:
        cell.origin ??
        (cell.value === null
          ? null
          : { kind: "initial-exram", address: cell.address }),
    },
    shift === null ? cell.value : replicateMmc5Palette(cell.value, shift),
    shift,
  );

/** One ordinary mux read supplies CIRAM facts before the existing ordered interpreter advances. */
const ordinarySources = (
  header: NesRomMetadata,
  mapper: NesMmc5State,
  ppu: NesPpuState,
  address: number,
  fetch: NesMmc5Fetch | undefined,
  chr: Uint8Array | undefined,
): Source[] =>
  address < 8192
    ? header.chrRom.size === 0
      ? [unknown("mmc5-chr-ram-unmodeled")]
      : romSources(header, mmc5ChrOffsets(header, mapper, address, fetch), chr)
    : mmc5NametableChoices(mapper, address).map((choice): Source => {
        if (choice.source === "ciram")
          return ppu.nametable_layout === "ciram-2k" && choice.bank !== null
            ? readNesPpuCell(
                ppu,
                "nametable",
                choice.bank * 1024 + (address & 1023),
              )
            : unknown("unknown-nametable-wiring");
        if (choice.source === "zero")
          return { kind: "mmc5-zero", value: 0, mask: 255 };
        if (choice.source === "fill")
          return {
            kind: "mmc5-fill",
            register: (address & 1023) < 960 ? 0x5106 : 0x5107,
            register_value:
              (address & 1023) < 960 ? mapper.fill_tile : mapper.fill_attribute,
            value: choice.value,
            mask: 255,
          };
        return choice.cell === undefined
          ? unknown("mmc5-nametable-source")
          : exramSource(choice.cell, choice.value);
      });

/** Actual bus qualification is preserved; frozen graphics use separate pure page projections. */
export const readMmc5RetainedPpu = (
  header: NesRomMetadata,
  mapper: NesMmc5State,
  ppu: NesPpuState,
  address: number,
  {
    fetch,
    tile,
    chr,
  }: {
    fetch?: NesMmc5Fetch | undefined;
    tile?: NesMmc5TilePosition | undefined;
    chr?: Uint8Array | undefined;
  } = {},
): PpuMemoryRead & {
  mmc5: NesMmc5PpuContext;
  bank: number | null;
  file_offset: number | null;
} => {
  // Raw external 3Fxx accesses use the nametable underlay. CPU palette reads remain internal.
  const normalized = address >= 0x3000 ? address - 0x1000 : address;
  const effectiveFetch =
    "ppu" in mapper && mapper.ppu.pin92_high !== true ? undefined : fetch;
  const ordinary = readMmc5Ppu(header, mapper, normalized, {
    fetch: effectiveFetch,
    chr,
    ordinary:
      "ppu" in mapper &&
      (fetch !== undefined || mapper.ppu.pin92_high === false),
  });
  const normal = ordinarySources(
    header,
    mapper,
    ppu,
    normalized,
    effectiveFetch,
    chr,
  );
  const prepared =
    ordinary.mmc5.limitation === null
      ? withValue(ordinary, join(normal))
      : ordinary;
  const read =
    "ppu" in mapper
      ? readMmc5BackgroundPpu(header, mapper, normalized, {
          fetch,
          tile,
          chr,
          ordinaryRead: prepared,
        })
      : prepared;
  let sources = normal,
    reason: string | null = null;
  if (read.mmc5.limitation !== null) {
    reason = "mmc5-rendering-context";
    sources = [unknown(reason)];
  } else if (
    "rendering" in read.mmc5 &&
    read.mmc5.rendering.reason !== null &&
    read.mmc5.rendering.reason !== "unqualified-fetch" &&
    read.mmc5.rendering.paths.some((path) => path !== "normal")
  ) {
    reason = `mmc5-${read.mmc5.rendering.reason}`;
    sources = [unknown(reason)];
  } else if (normalized < 8192 && "rom_sources" in read.mmc5) {
    const rom = read.mmc5.rom_sources;
    reason = rom.status === "unresolved" ? rom.reason : null;
    sources = romSources(header, rom.file_offsets, chr);
    if (
      rom.status === "unresolved" &&
      (rom.reason === "rendering-context" || sources.length === 0)
    )
      sources.push(unknown(rom.reason));
  } else if (normalized >= 8192 && "rendering" in read.mmc5) {
    const rendering = read.mmc5.rendering;
    if (rendering.fetch === "tile" || rendering.fetch === "attribute") {
      sources = rendering.paths.some((path) =>
        rendering.fetch === "tile" ? path !== "split" : path === "normal",
      )
        ? [...normal]
        : [];
      if (rendering.fetch === "tile" && rendering.paths.includes("split"))
        sources.push(
          ...rendering.split_tiles.map((cell) => captured(cell, null)),
        );
      if (rendering.fetch === "attribute") {
        if (
          rendering.paths.includes("extended") &&
          rendering.extended_attribute !== null
        )
          sources.push(captured(rendering.extended_attribute, 6));
        if (rendering.paths.includes("split"))
          sources.push(
            ...rendering.split_attributes.map((cell) =>
              captured(cell, cell.shift),
            ),
          );
      }
      if (sources.length === 0) sources = [unknown("mmc5-rendering-context")];
    }
  }
  if (
    normalized < 8192 &&
    chr?.length !== header.chrRom.size &&
    header.chrRom.size !== 0 &&
    reason === null
  )
    reason = "missing-chr-snapshot";
  sources = [
    ...new Map(
      sources.map((source) => [JSON.stringify(source), source]),
    ).values(),
  ];
  const unresolved = sources.find((source) => source.kind === "unknown");
  if (reason === null && unresolved?.kind === "unknown")
    reason = unresolved.reason;
  return {
    value: join(sources),
    sources,
    reason,
    mmc5: context(read),
    bank: read.bank,
    file_offset: read.file_offset,
  };
};
