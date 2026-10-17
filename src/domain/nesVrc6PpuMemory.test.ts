import { nesPpuFixtureOam, nesPpuFixtureState } from "./nesPpu.fixture.js";
import { expect, it } from "vitest";
import { scheduler } from "node:timers/promises";
import { parseNesHeader } from "./nes.js";
import { nesVrc6StateSchema } from "./nesVrc6.js";

import { initializeNesPpu, readNesPpuCpu } from "./nesPpuRegisters.js";
import {
  nesPpuAdmission,
  readNesPpuPatternMemory,
  readNesPpuNametable,
  writeNesPpuMemory,
} from "./nesPpuMemory.js";
import { deriveNesPpuPatternTable } from "./nesPpuPatternDerivation.js";
import { nesPpuPatternTableSchema } from "./nesPpuPattern.js";
import { deriveNesPpuNametable } from "./nesPpuNametableDerivation.js";
import { nesPpuNametableSchema } from "./nesPpuNametable.js";
import { deriveNesPpuViewport } from "./nesPpuViewportDerivation.js";
import { nesPpuViewportSchema } from "./nesPpuViewport.js";
import { standardNesChrCandidates } from "./nesMapperTraceMapping.js";

const fixture = (mapper = 24, chrSize = 262144) => {
  const bytes = Buffer.alloc(528 + 32768 + chrSize);
  bytes.set([
    78,
    69,
    83,
    26,
    2,
    chrSize / 8192,
    (mapper & 15) * 16 + 4,
    (mapper & 240) + 8,
  ]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    header: parsed.value,
    chr: bytes.subarray(parsed.value.chrRom.offset),
  };
};
const mapper = (extra: Record<string, unknown> = {}) =>
  nesVrc6StateSchema.parse({
    mapper: 24,
    prg_bank_16k: 0,
    prg_bank_8k: 0,
    control: 32,
    chr_banks: [0, 1, 2, 3, 4, 5, 46, 10],
    ...extra,
  });
const ppu = (extra: Record<string, unknown> = {}) =>
  initializeNesPpu(
    nesPpuFixtureState({
      chr_ram_size: null,
      mask: 10,
      oam: nesPpuFixtureOam(),
      ...extra,
    }),
  );
const write = (address: number, value: number, index = 0) => ({
  address,
  value,
  index,
  addressProof: { low: address & 255, high: address >> 8 },
});

it.each([24, 26])(
  "admits qualified VRC6 %i ROM/CIRAM backing and rejects invented storage",
  (id) => {
    const { header, chr } = fixture(id),
      selected = mapper({ mapper: id });
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
    ).toContain("VRC6");
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
  },
);

it("reads repeated and forced-A10 pattern halves from authenticated physical pages", () => {
  const { header, chr } = fixture();
  chr[4 * 1024] = 64;
  chr[5 * 1024] = 80;
  const state = ppu(),
    duplicate = mapper({ control: 1, chr_banks: [5, 0, 0, 0, 0, 0, 0, 0] });
  expect(readNesPpuPatternMemory(header, duplicate, state, 0, chr).value).toBe(
    80,
  );
  expect(
    readNesPpuPatternMemory(header, duplicate, state, 1024, chr).sources,
  ).toEqual([
    {
      kind: "rom",
      file_offset: header.chrRom.offset + 5 * 1024,
      value: 80,
      mask: 255,
    },
  ]);
  duplicate.control = 33;
  expect(readNesPpuPatternMemory(header, duplicate, state, 0, chr).value).toBe(
    64,
  );
  expect(
    readNesPpuPatternMemory(header, duplicate, state, 1024, chr).value,
  ).toBe(80);
});

it("retains only compatible partial pattern sources and joins correlated plane pixels", async () => {
  const { header, chr } = fixture(),
    selected = mapper({
      control: 0,
      chr_banks: [{ mask: 254, value: 2 }, 0, 0, 0, 0, 0, 0, 0],
    }),
    state = ppu();
  chr.fill(255, 2 * 1024, 2 * 1024 + 8);
  chr.fill(255, 3 * 1024 + 8, 3 * 1024 + 16);
  expect(standardNesChrCandidates(selected, 0, 256)).toEqual([2, 3]);
  expect(readNesPpuPatternMemory(header, selected, state, 0, chr)).toEqual({
    value: null,
    reason: null,
    sources: [
      {
        kind: "rom",
        file_offset: header.chrRom.offset + 2048,
        value: 255,
        mask: 255,
      },
      {
        kind: "rom",
        file_offset: header.chrRom.offset + 3072,
        value: 0,
        mask: 255,
      },
    ],
  });
  const original = structuredClone(selected);
  const table = nesPpuPatternTableSchema.parse(
    await deriveNesPpuPatternTable(header, selected, state, 0, chr),
  );
  expect(
    table.blocks[0]!.sources.map((index) => table.source_pages[index]),
  ).toEqual(
    [2048, 3072].map((offset) => ({
      kind: "rom",
      file_offset: header.chrRom.offset + offset,
      bytes_hex: chr.subarray(offset, offset + 1024).toString("hex"),
    })),
  );
  expect(table.tiles[0]!.rows[0]![0]).toEqual({ choices: [1, 2] });
  expect(selected).toEqual(original);
});

it("keeps ROM/CIRAM read alternatives and conditional writes tied to the old memory origin", () => {
  const { header, chr } = fixture(),
    selected = mapper({ control: { mask: 47, value: 32 } }),
    state = ppu({ nametable: { 1024: 160 } });
  chr[47 * 1024] = 161;
  expect(readNesPpuNametable(header, selected, state, 0x2400, chr)).toEqual({
    value: { mask: 254, value: 160 },
    reason: null,
    sources: [
      {
        kind: "memory",
        space: "nametable",
        address: 1024,
        value: 160,
        mask: 255,
        origin: { kind: "initial-memory", space: "nametable", address: 1024 },
      },
      {
        kind: "rom",
        file_offset: header.chrRom.offset + 47 * 1024,
        value: 161,
        mask: 255,
      },
    ],
  });
  expect(
    writeNesPpuMemory(header, selected, state, write(0x2400, 162, 7)),
  ).toMatchObject({
    status: "uncertain",
    destinations: [{ space: "nametable", address: 1024 }],
  });
  expect(state.nametable[1024]).toEqual({
    value: { mask: 253, value: 160 },
    origin: { kind: "initial-memory", space: "nametable", address: 1024 },
  });
  selected.control = 48;
  expect(
    writeNesPpuMemory(header, selected, state, write(0x2400, 255, 8)),
  ).toMatchObject({
    status: "ignored",
    destinations: [],
    reason: "chr-rom-readonly",
  });
  expect(
    writeNesPpuMemory(header, selected, state, write(0, 255, 9)),
  ).toMatchObject({
    status: "ignored",
    destinations: [],
    reason: "chr-rom-readonly",
  });
  expect(chr[47 * 1024]).toBe(161);
});

it("preserves missing CIRAM backing alongside known ROM without inventing a buffered byte", () => {
  const { header, chr } = fixture(),
    selected = mapper({ control: { mask: 47, value: 32 } }),
    state = ppu({ nametable_layout: null, v: { low: 0, high: 36 } });
  chr[47 * 1024] = 83;
  readNesPpuCpu(header, selected, state, { address: 0x2007, index: 0, chr });
  expect(state.read_buffer).toEqual({
    value: null,
    sources: [
      {
        kind: "unknown",
        reason: "unknown-nametable-wiring",
        value: null,
        mask: 255,
      },
      {
        kind: "rom",
        file_offset: header.chrRom.offset + 47 * 1024,
        value: 83,
        mask: 255,
      },
    ],
  });
  state.next_event_index = 1;
  expect(nesPpuAdmission(header, selected, state, chr)).toBeNull();
  state.read_buffer.value = 83;
  expect(nesPpuAdmission(header, selected, state, chr)).toContain(
    "do not prove",
  );
});

it("retains captured PPUDATA history after CIRAM writes and mapper bank changes", () => {
  const { header, chr } = fixture(),
    selected = mapper({ control: { mask: 47, value: 32 } }),
    state = ppu({ nametable: { 1024: 160 }, v: { low: 0, high: 36 } });
  chr[47 * 1024] = 161;
  readNesPpuCpu(header, selected, state, { address: 0x2007, index: 0, chr });
  const captured = structuredClone(state.read_buffer);
  selected.control = 32;
  writeNesPpuMemory(header, selected, state, write(0x2400, 91, 1));
  selected.control = 48;
  selected.chr_banks[6] = 60;
  chr[61 * 1024 + 1] = 77;
  state.next_event_index = 2;
  expect(nesPpuAdmission(header, selected, state, chr)).toBeNull();
  const result = readNesPpuCpu(header, selected, state, {
    address: 0x2007,
    index: 2,
    chr,
  });
  expect(result?.value).toEqual({ mask: 254, value: 160 });
  expect(captured.sources[0]).toMatchObject({
    value: 160,
    origin: { kind: "initial-memory" },
  });
  expect(state.read_buffer).toMatchObject({
    value: 77,
    sources: [
      { kind: "rom", file_offset: header.chrRom.offset + 61 * 1024 + 1 },
    ],
  });
  expect(state.nametable[1024]).toEqual({
    value: 91,
    origin: { kind: "event-write", index: 1 },
  });
});

it("retains absent ROM snapshots and refills the palette-read nametable underlay", async () => {
  const { header, chr } = fixture(),
    selected = mapper({ control: 48 }),
    state = ppu({ v: { low: 0, high: 63 }, palette: { 0: 9 } });
  chr[11 * 1024 + 768] = 77;
  expect(
    readNesPpuCpu(header, selected, state, { address: 0x2007, index: 0, chr })
      ?.value,
  ).toEqual({ mask: 63, value: 9 });
  expect(state.read_buffer).toMatchObject({
    value: 77,
    sources: [
      { kind: "rom", file_offset: header.chrRom.offset + 11 * 1024 + 768 },
    ],
  });
  const view = nesPpuNametableSchema.parse(
    await deriveNesPpuNametable(header, selected, state, 1),
  );
  expect(view.reason).toBe("missing-chr-snapshot");
  expect(view.source_pages).toEqual([
    {
      kind: "rom",
      file_offset: header.chrRom.offset + 47 * 1024,
      bytes_hex: null,
    },
  ]);
  expect(view.cells.every((cell) => cell.tile_index === null)).toBe(true);
});

it("pairs tile and attribute bytes within each VRC6 source page in the frozen viewport", async () => {
  const { header, chr } = fixture(),
    selected = mapper({ control: { mask: 47, value: 32 } }),
    state = ppu({
      nametable: Object.fromEntries(
        Array.from({ length: 1024 }, (_, offset) => [1024 + offset, 0]),
      ),
    });
  chr.fill(255, 0, 8);
  chr.fill(255, 24, 32);
  chr.fill(1, 47 * 1024, 47 * 1024 + 960);
  chr.fill(85, 47 * 1024 + 960, 48 * 1024);
  const map = await deriveNesPpuNametable(
    header,
    selected,
    state,
    1,
    undefined,
    chr,
  );
  expect(map.cells[0]!.tile_index).toEqual({ mask: 254, value: 0 });
  expect(map.attributes[0]!.quadrants[0]!.choices).toEqual([0, 1]);
  const original = structuredClone({ selected, state });
  const view = nesPpuViewportSchema.parse(
    await deriveNesPpuViewport(header, selected, state, {
      selection: { model: "frozen-viewport", origin_x: 256, origin_y: 0 },
      chr,
    }),
  );
  expect(view.nametables[1]!.source_pages).toEqual(map.source_pages);
  const mode = view.modes[0]!;
  expect(mode.pixel_states[mode.rows[0]![0]!]!.palette_mask).toBe(66);
  expect({ selected, state }).toEqual(original);
});

it("retains all 258 physical candidates under pressure and cancels complete frozen queries", async () => {
  const { header, chr } = fixture(),
    selected = mapper({ control: null, chr_banks: Array(8).fill(null) }),
    state = ppu({ nametable: { 0: 0, 1024: 0 } });
  const map = nesPpuNametableSchema.parse(
    await deriveNesPpuNametable(header, selected, state, 0, undefined, chr),
  );
  expect(map.source_pages).toHaveLength(258);
  expect(map.source_pages.slice(0, 2)).toEqual([0, 1024]);
  expect(map.source_pages[2]).toMatchObject({
    kind: "rom",
    file_offset: header.chrRom.offset,
  });
  expect(map.source_pages[257]).toMatchObject({
    kind: "rom",
    file_offset: header.chrRom.offset + 255 * 1024,
  });
  const view = nesPpuViewportSchema.parse(
    await deriveNesPpuViewport(header, selected, state, {
      selection: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
      chr,
    }),
  );
  expect(
    view.nametables.every((page) => page.source_pages.length === 258),
  ).toBe(true);
  const controller = new AbortController();
  const operation = deriveNesPpuNametable(
    header,
    selected,
    state,
    0,
    controller.signal,
    chr,
  );
  await scheduler.yield();
  controller.abort(new Error("VRC6 cancelled"));
  await expect(operation).rejects.toThrow("VRC6 cancelled");
  const viewportController = new AbortController();
  const viewport = deriveNesPpuViewport(header, selected, state, {
    selection: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
    chr,
    signal: viewportController.signal,
  });
  await scheduler.yield();
  viewportController.abort(new Error("VRC6 viewport cancelled"));
  await expect(viewport).rejects.toThrow("VRC6 viewport cancelled");
});
