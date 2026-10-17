import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesPpuState } from "./nesPpuState.js";
import type { NesPpuPatternTable } from "./nesPpuPattern.js";
import {
  nesPpuPatternSourceIdentity,
  nesPpuPatternBlockUnresolved,
  type NesPpuPatternLocation,
} from "./nesPpuPattern.js";
import {
  readNesPpuPatternMemory,
  readNesPpuPatternPage,
} from "./nesPpuMemory.js";
import { joinNesBytes, type NesByteValue } from "./nesByteValue.js";
import {
  nesPpuPixelFromMask,
  nesPpuPixelMask,
  type NesPpuPixel,
} from "./nesPpuPixel.js";
import { decodeNesChrPixel } from "./nesChr.js";
import type { NesMmc5Fetch } from "./nesMmc5Ppu.js";

const pixelRows = (
  alternatives: NesByteValue[][],
  offset: number,
): NesPpuPixel[][] =>
  Array.from({ length: 8 }, (_, row) =>
    Array.from({ length: 8 }, (_, x) => {
      let choices = 0;
      for (const bytes of alternatives) {
        choices |= nesPpuPixelMask(
          decodeNesChrPixel(
            bytes[offset + row]!,
            bytes[offset + row + 8]!,
            1 << (7 - x),
          ),
        );
        if (choices === 15) break;
      }
      return nesPpuPixelFromMask(choices || 15);
    }),
  );

/** Inspect the final address mux without simulating reads or changing any device state. */
export const deriveNesPpuPatternTable = async (
  header: NesRomMetadata,
  mapper: NesMapperState,
  ppu: NesPpuState,
  table: 0 | 1,
  chr?: Uint8Array,
  signal?: AbortSignal,
  queryRole?: NesMmc5Fetch,
): Promise<NesPpuPatternTable> => {
  const sourcePages: NesPpuPatternTable["source_pages"] = [],
    pages = new Map<string, number>(),
    blocks: NesPpuPatternTable["blocks"] = [],
    tiles: NesPpuPatternTable["tiles"] = [];
  const coverage: NesPpuPatternTable["coverage"] = {
    examined_tiles: 256,
    unresolved_source_blocks: 0,
    unknown_bytes: 0,
    partial_bytes: 0,
    unknown_pixels: 0,
    partial_pixels: 0,
  };
  for (let block = 0; block < 4; block++) {
    await scheduler.yield();
    signal?.throwIfAborted();
    const address = table * 4096 + block * 1024,
      read = readNesPpuPatternMemory(
        header,
        mapper,
        ppu,
        address,
        chr,
        queryRole,
      );
    const locations = read.sources.map((source): NesPpuPatternLocation =>
      source.kind === "rom"
        ? { kind: "rom", file_offset: source.file_offset }
        : source.kind === "unknown"
          ? { kind: "unknown", reason: source.reason }
          : source.space === "nametable"
            ? { kind: "ciram", address: source.address as 0 | 1024 }
            : { kind: "chr-ram", address: source.address },
    );
    const indices = locations.map((source) => {
      const identity = nesPpuPatternSourceIdentity(source);
      const existing = pages.get(identity);
      if (existing !== undefined) return existing;
      const index = sourcePages.length;
      pages.set(identity, index);
      sourcePages.push(
        source.kind === "rom"
          ? {
              kind: "rom",
              file_offset: source.file_offset,
              bytes_hex:
                chr?.length === header.chrRom.size
                  ? Array.from(
                      chr.subarray(
                        source.file_offset - header.chrRom.offset,
                        source.file_offset - header.chrRom.offset + 1024,
                      ),
                      (byte) => byte.toString(16).padStart(2, "0"),
                    ).join("")
                  : null,
            }
          : source,
      );
      return index;
    });
    blocks.push({
      ppu_address: address,
      sources: indices,
      reason: read.reason,
    });
    if (nesPpuPatternBlockUnresolved({ sources: indices }, sourcePages))
      coverage.unresolved_source_blocks++;
    const alternatives = locations.map((source) =>
      Array.from(
        { length: 1024 },
        (_, offset) =>
          readNesPpuPatternPage(header, ppu, source, offset, chr).value,
      ),
    );
    const values: NesByteValue[] = [];
    for (let offset = 0; offset < 1024; offset++) {
      let value: NesByteValue = null;
      for (const [index, source] of alternatives.entries()) {
        const byte = source[offset]!;
        value = index === 0 ? byte : joinNesBytes(value, byte);
        if (value === null) break;
      }
      values.push(value);
      if (value === null) coverage.unknown_bytes++;
      else if (typeof value === "object") coverage.partial_bytes++;
    }
    for (let tile = 0; tile < 64; tile++) {
      const bytes = values.slice(tile * 16, tile * 16 + 16),
        rows = pixelRows(alternatives, tile * 16);
      for (const row of rows)
        for (const pixel of row)
          if (pixel === null) coverage.unknown_pixels++;
          else if (typeof pixel === "object") coverage.partial_pixels++;
      tiles.push({
        index: block * 64 + tile,
        ppu_address: address + tile * 16,
        block,
        byte_values: bytes,
        rows,
      });
    }
  }
  signal?.throwIfAborted();
  return {
    table,
    interpretation: "nes-planar-2bpp-msb-left",
    source_page_bytes: 1024,
    source_pages: sourcePages,
    blocks,
    tiles,
    coverage,
  };
};
