import { nesPpuFixtureOam, nesPpuFixtureState } from "./nesPpu.fixture.js";
import { expect, it } from "vitest";
import { scheduler } from "node:timers/promises";
import { parseNesHeader } from "./nes.js";
import { nesNamco163StateSchema } from "./nesNamco163.js";

import { initializeNesPpu, readNesPpuCpu } from "./nesPpuRegisters.js";
import {
  nesPpuAdmission,
  readNesPpuPatternMemory,
  readNesPpuNametable,
  writeNesPpuMemory,
  nesPpuNametablePages,
} from "./nesPpuMemory.js";
import { deriveNesPpuPatternTable } from "./nesPpuPatternDerivation.js";
import { nesPpuPatternTableSchema } from "./nesPpuPattern.js";
import { deriveNesPpuSprites } from "./nesPpuSpritesDerivation.js";
import { nesPpuSpritesSchema } from "./nesPpuSprites.js";
import { deriveNesPpuNametable } from "./nesPpuNametableDerivation.js";
import { deriveNesPpuViewport } from "./nesPpuViewportDerivation.js";
import { nesPpuViewportSchema } from "./nesPpuViewport.js";

const fixture = (chrSize = 262144) => {
  const bytes = Buffer.alloc(528 + 32768 + chrSize);
  bytes.set([78, 69, 83, 26, 2, chrSize / 8192, 52, 24]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    header: parsed.value,
    chr: bytes.subarray(parsed.value.chrRom.offset),
  };
};
const mapper = (extra: Record<string, unknown> = {}) =>
  nesNamco163StateSchema.parse({
    mapper: 19,
    variant: "namco163",
    prg_banks: [0, 0, 2],
    chr_banks: [225, 224, 224, 224, 225, 224, 224, 224],
    nametable_banks: [224, 225, 7, 8],
    ...extra,
  });
const ppu = (extra: Record<string, unknown> = {}) =>
  initializeNesPpu(
    nesPpuFixtureState({
      chr_ram_size: null,
      mask: 10,
      next_event_index: 500,
      oam: nesPpuFixtureOam(),
      ...extra,
    }),
  );
const write = (address: number, value: number, index = 0, cpuPort = false) => ({
  address,
  value,
  index,
  cpuPort,
  addressProof: { low: address & 255, high: address >> 8 },
});

it("admits authenticated Namco163 ROM/shared CIRAM and rejects invented storage", () => {
  const { header, chr } = fixture(),
    selected = mapper();
  expect(
    nesPpuAdmission(header, selected, ppu({ nametable: { 1024: 8 } }), chr),
  ).toBeNull();
  expect(
    nesPpuAdmission(header, selected, ppu({ nametable_layout: null }), chr),
  ).toBeNull();
  expect(
    nesPpuAdmission(header, selected, ppu({ chr_ram_size: 8192 }), chr),
  ).toContain("requires no CHR ROM");
  expect(
    nesPpuAdmission(
      header,
      selected,
      ppu({ nametable_layout: "four-screen-4k" }),
      chr,
    ),
  ).toContain("Namco 163");
  expect(
    nesPpuAdmission(
      header,
      selected,
      ppu({ nametable_layout: null, nametable: { 0: 8 } }),
      chr,
    ),
  ).toContain("explicit physical layout");
  expect(nesPpuAdmission(header, selected, ppu(), chr.subarray(1))).toContain(
    "length",
  );
  expect(nesPpuAdmission(fixture(0).header, selected, ppu())).toContain(
    "Namco 163",
  );
});

it("shares pattern/nametable physical cells and writers in both directions", () => {
  const { header, chr } = fixture(),
    selected = mapper(),
    state = ppu({ nametable: { 1029: 17 } });
  expect(
    writeNesPpuMemory(header, selected, state, write(5, 34, 7)),
  ).toMatchObject({
    status: "written",
    destinations: [{ space: "nametable", address: 1029 }],
  });
  const first = readNesPpuNametable(header, selected, state, 0x2405, chr);
  expect(first.value).toBe(34);
  expect(first.sources).toEqual([
    {
      kind: "memory",
      space: "nametable",
      address: 1029,
      value: 34,
      mask: 255,
      origin: { kind: "event-write", index: 7 },
    },
  ]);
  expect(
    writeNesPpuMemory(header, selected, state, write(0x2405, 51, 8)).status,
  ).toBe("written");
  expect(
    readNesPpuPatternMemory(header, selected, state, 5, chr).sources,
  ).toEqual([
    {
      ...first.sources[0],
      value: 51,
      origin: { kind: "event-write", index: 8 },
    },
  ]);
  expect(state.chr_ram).toEqual({});
  selected.prg_banks[1] = 64;
  const before = structuredClone(state);
  expect(
    writeNesPpuMemory(header, selected, state, write(5, 255, 9)),
  ).toMatchObject({ status: "ignored", reason: "chr-rom-readonly" });
  expect(state).toEqual(before);
});

it("keeps lower/upper substitution controls independent from nametable substitution", () => {
  const { header, chr } = fixture(),
    selected = mapper(),
    state = ppu({ nametable: { 1024: 160 } });
  chr[225 * 1024] = 161;
  for (const [control, low, high] of [
    [0, 160, 160],
    [64, 161, 160],
    [128, 160, 161],
    [192, 161, 161],
  ]) {
    selected.prg_banks[1] = control!;
    expect(readNesPpuPatternMemory(header, selected, state, 0, chr).value).toBe(
      low,
    );
    expect(
      readNesPpuPatternMemory(header, selected, state, 4096, chr).value,
    ).toBe(high);
    expect(
      readNesPpuNametable(header, selected, state, 0x2400, chr).value,
    ).toBe(160);
  }
});

it("joins mixed ROM/CIRAM pattern writes conditionally with the old physical origin", () => {
  const { header, chr } = fixture(),
    selected = mapper({
      chr_banks: [{ mask: 127, value: 97 }, 0, 0, 0, 0, 0, 0, 0],
    }),
    state = ppu({ nametable: { 1024: 160 } });
  chr[97 * 1024] = 161;
  const before = readNesPpuPatternMemory(header, selected, state, 0, chr);
  expect(before.value).toEqual({ mask: 254, value: 160 });
  expect(before.sources.map((source) => source.kind).sort()).toEqual([
    "memory",
    "rom",
  ]);
  expect(
    writeNesPpuMemory(header, selected, state, write(0, 162, 7)),
  ).toMatchObject({
    status: "uncertain",
    destinations: [{ space: "nametable", address: 1024 }],
  });
  expect(state.nametable[1024]).toEqual({
    value: { mask: 253, value: 160 },
    origin: { kind: "initial-memory", space: "nametable", address: 1024 },
  });
  expect(
    readNesPpuNametable(header, selected, state, 0x2400, chr).value,
  ).toEqual({ mask: 253, value: 160 });
  expect(
    readNesPpuPatternMemory(header, selected, state, 0, chr).value,
  ).toEqual({ mask: 252, value: 160 });
});

it("recognizes a definite physical write when uncertain logical addresses alias the same CIRAM cell", () => {
  const { header } = fixture(),
    selected = mapper({ nametable_banks: [225, 225, 225, 225] }),
    state = ppu();
  expect(
    writeNesPpuMemory(header, selected, state, {
      address: null,
      addressProof: { low: 0, high: { mask: 95, value: 0 } },
      value: 90,
      index: 4,
    }),
  ).toMatchObject({
    status: "written",
    destinations: [{ space: "nametable", address: 1024 }],
  });
  expect(state.nametable[1024]).toEqual({
    value: 90,
    origin: { kind: "event-write", index: 4 },
  });
});

it("retains captured pattern CIRAM history through later memory and bank changes", () => {
  const { header, chr } = fixture(),
    selected = mapper(),
    state = ppu({
      nametable: { 1024: 17 },
      v: { low: 0, high: 0 },
      read_buffer: { value: 73 },
    });
  expect(
    readNesPpuCpu(header, selected, state, { address: 0x2007, index: 0, chr })!
      .value,
  ).toBe(73);
  expect(state.read_buffer.value).toBe(17);
  expect(state.read_buffer.sources[0]).toMatchObject({
    kind: "memory",
    space: "nametable",
    address: 1024,
    value: 17,
  });
  state.nametable[1024] = 34;
  selected.prg_banks[1] = 64;
  chr[225 * 1024 + 1] = 51;
  expect(nesPpuAdmission(header, selected, state, chr)).toBeNull();
  expect(
    readNesPpuCpu(header, selected, state, { address: 0x2007, index: 1, chr })!
      .value,
  ).toBe(17);
  expect(state.read_buffer).toMatchObject({
    value: 51,
    sources: [
      { kind: "rom", file_offset: header.chrRom.offset + 225 * 1024 + 1 },
    ],
  });
});

it("keeps unavailable CIRAM and missing ROM snapshots explicit alongside compatible sources", async () => {
  const { header, chr } = fixture(),
    selected = mapper({
      chr_banks: [{ mask: 127, value: 97 }, 0, 0, 0, 0, 0, 0, 0],
    }),
    state = ppu({
      nametable_layout: null,
      v: { low: 0, high: 0 },
      read_buffer: { value: 73 },
    });
  chr[97 * 1024] = 160;
  expect(
    readNesPpuPatternMemory(header, selected, state, 0, chr),
  ).toMatchObject({ value: null, reason: "unknown-nametable-wiring" });
  readNesPpuCpu(header, selected, state, { address: 0x2007, index: 0, chr });
  expect(state.read_buffer.sources.map((source) => source.kind).sort()).toEqual(
    ["rom", "unknown"],
  );
  const forged = structuredClone(state);
  forged.read_buffer.value = 160;
  expect(nesPpuAdmission(header, selected, forged, chr)).toContain(
    "do not prove",
  );
  const table = nesPpuPatternTableSchema.parse(
    await deriveNesPpuPatternTable(
      header,
      selected,
      ppu({ nametable: { 1024: 160 } }),
      0,
    ),
  );
  expect(table.source_pages).toContainEqual({ kind: "ciram", address: 1024 });
  expect(table.source_pages).toContainEqual({
    kind: "rom",
    file_offset: header.chrRom.offset + 97 * 1024,
    bytes_hex: null,
  });
  expect(table.tiles[0]!.rows[0]![0]).toBeNull();
});

it("pairs pattern planes within the same CIRAM source and preserves identities across graphics pools", async () => {
  const { header, chr } = fixture(),
    selected = mapper({
      chr_banks: Array(8).fill({ mask: 254, value: 224 }),
      nametable_banks: [224, 224, 224, 224],
    }),
    state = ppu({
      nametable: Object.fromEntries(
        Array.from({ length: 2048 }, (_, address) => [
          address,
          address < 8 || (address >= 1032 && address < 1040) ? 255 : 0,
        ]),
      ),
    });
  const before = structuredClone({ selected, state });
  const table = nesPpuPatternTableSchema.parse(
    await deriveNesPpuPatternTable(header, selected, state, 0, chr),
  );
  expect(table.source_pages).toEqual([
    { kind: "ciram", address: 0 },
    { kind: "ciram", address: 1024 },
  ]);
  expect(table.tiles[0]!.rows[0]![0]).toEqual({ choices: [1, 2] });
  const sprites = nesPpuSpritesSchema.parse(
    await deriveNesPpuSprites(header, selected, state, { chr }),
  );
  expect(sprites.source_pages).toEqual(table.source_pages);
  const viewport = nesPpuViewportSchema.parse(
    await deriveNesPpuViewport(header, selected, state, {
      chr,
      selection: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
    }),
  );
  expect(viewport.chr_source_pages).toEqual(table.source_pages);
  expect(viewport.nametables[0]!.source_pages).toEqual([0]);
  expect({ selected, state }).toEqual(before);
});

it("marks definite and possible debug sources unresolved and invalidates only unverified external writes", async () => {
  const { header, chr } = fixture(),
    selected = mapper(),
    state = ppu({
      nametable: { 0: 17, 1024: 34 },
      palette: { 0: 15 },
      v: { low: 0, high: 0 },
      read_buffer: { value: 73 },
    });
  expect(
    readNesPpuCpu(header, selected, state, { address: 0x2007, index: 0, chr })!
      .value,
  ).toBe(73);
  selected.prg_banks[2] = 63;
  const table = await deriveNesPpuPatternTable(header, selected, state, 0, chr);
  expect(table.source_pages).toEqual([
    { kind: "unknown", reason: "namco163-audio-debug" },
  ]);
  expect(table.coverage.unresolved_source_blocks).toBe(4);
  const sprites = await deriveNesPpuSprites(header, selected, state, { chr });
  expect(sprites.coverage.unresolved_source_blocks).toBe(4);
  const viewport = await deriveNesPpuViewport(header, selected, state, {
    chr,
    selection: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
  });
  expect(viewport.unresolved_chr_blocks).toBe(4);
  expect(
    writeNesPpuMemory(header, selected, state, write(0x3f00, 32, 7, true)),
  ).toMatchObject({ status: "written", invalidated_spaces: [] });
  expect(state.nametable).toEqual({ 0: 17, 1024: 34 });
  selected.prg_banks[2] = { mask: 254, value: 62 };
  expect(
    readNesPpuPatternMemory(header, selected, state, 0, chr)
      .sources.map((source) => source.kind)
      .sort(),
  ).toEqual(["memory", "unknown"]);
  expect(
    writeNesPpuMemory(header, selected, state, write(0x3f00, 99, 8)),
  ).toMatchObject({
    status: "unverified",
    invalidated_spaces: ["nametable"],
    reason: "namco163-audio-debug",
  });
  expect(state.nametable).toEqual({});
  expect(state.palette[0]).toMatchObject({ value: 32 });
  expect(
    readNesPpuCpu(header, selected, state, { address: 0x2007, index: 9, chr })!
      .value,
  ).toBe(34);
  expect(state.read_buffer.value).toBeNull();
});

it("retains maximum sources and supports cancellation after frozen query processing begins", async () => {
  const { header, chr } = fixture(),
    selected = mapper({
      prg_banks: [0, null, { mask: 254, value: 62 }],
      chr_banks: Array(8).fill(null),
      nametable_banks: Array(4).fill(null),
    }),
    state = ppu();
  const table = nesPpuPatternTableSchema.parse(
    await deriveNesPpuPatternTable(header, selected, state, 0, chr),
  );
  expect(table.source_pages).toHaveLength(259);
  expect(table.source_pages.filter((page) => page.kind === "ciram")).toEqual([
    { kind: "ciram", address: 0 },
    { kind: "ciram", address: 1024 },
  ]);
  expect(nesPpuNametablePages(header, selected, state, 0)).toHaveLength(227);
  const before = structuredClone({ selected, state });
  for (const facet of ["nametable", "viewport"] as const) {
    const controller = new AbortController();
    const pending =
      facet === "nametable"
        ? deriveNesPpuNametable(
            header,
            selected,
            state,
            0,
            controller.signal,
            chr,
          )
        : deriveNesPpuViewport(header, selected, state, {
            chr,
            signal: controller.signal,
            selection: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
          });
    const stopped = expect(pending).rejects.toThrow();
    await scheduler.yield();
    controller.abort();
    await stopped;
    expect({ selected, state }).toEqual(before);
  }
});
