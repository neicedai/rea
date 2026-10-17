import { nesPpuFixtureOam, nesPpuFixtureState } from "./nesPpu.fixture.js";
import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesSunsoft4StateSchema } from "./nesSunsoft4.js";
import { sunsoft4NametableCandidates } from "./nesSunsoft4Nametable.js";
import { nesPpuStateSchema } from "./nesPpuState.js";
import { initializeNesPpu, readNesPpuCpu } from "./nesPpuRegisters.js";
import {
  nesPpuAdmission,
  readNesPpuNametable,
  writeNesPpuMemory,
} from "./nesPpuMemory.js";
import { deriveNesPpuNametable } from "./nesPpuNametableDerivation.js";
import { nesPpuNametableSchema } from "./nesPpuNametable.js";
import { deriveNesPpuViewport } from "./nesPpuViewportDerivation.js";
import { nesPpuViewportSchema } from "./nesPpuViewport.js";

const fixture = () => {
  const bytes = Buffer.alloc(528 + 32768 + 262144);
  bytes.set([78, 69, 83, 26, 2, 32, 68, 72]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    header: parsed.value,
    chr: bytes.subarray(parsed.value.chrRom.offset),
  };
};
const mapper = (extra: Record<string, unknown> = {}) =>
  nesSunsoft4StateSchema.parse({
    mapper: 68,
    variant: "normal",
    prg_bank: 0,
    chr_banks: [0, 1, 2, 3],
    nametable_banks: [5, 6],
    control: 16,
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

it("projects all concrete Sunsoft4 route bits and forces NT bit7 before capacity aliasing", () => {
  const routes = [
    [0, 1, 0, 1],
    [0, 0, 1, 1],
    [0, 0, 0, 0],
    [1, 1, 1, 1],
  ];
  for (const capacity of [8192, 16384, 131072, 262144])
    for (let control = 0; control < 256; control++)
      for (let page = 0; page < 4; page++) {
        const slot = routes[control & 3]![page]!;
        expect(
          sunsoft4NametableCandidates(
            mapper({ control, nametable_banks: [5, 134] }),
            page,
            capacity,
          ),
        ).toEqual([
          control & 16
            ? {
                source: "chr-rom",
                bank: [133, 134][slot]! & (capacity / 1024 - 1),
              }
            : { source: "ciram", bank: slot },
        ]);
      }
});

it("joins mixed CIRAM/ROM reads and conditional writes without replacing the previous writer", () => {
  const { header, chr } = fixture(),
    mixed = mapper({ control: { mask: 3, value: 0 } }),
    state = ppu({ nametable: { 0: 160 } });
  chr[133 * 1024] = 161;
  expect(readNesPpuNametable(header, mixed, state, 8192, chr)).toEqual({
    value: { mask: 254, value: 160 },
    sources: [
      {
        kind: "memory",
        space: "nametable",
        address: 0,
        value: 160,
        mask: 255,
        origin: { kind: "initial-memory", space: "nametable", address: 0 },
      },
      {
        kind: "rom",
        file_offset: header.chrRom.offset + 133 * 1024,
        value: 161,
        mask: 255,
      },
    ],
    reason: null,
  });
  const write = writeNesPpuMemory(header, mixed, state, {
    address: 8192,
    addressProof: { low: 0, high: 32 },
    value: 162,
    index: 7,
  });
  expect(write.status).toBe("uncertain");
  expect(state.nametable[0]).toEqual({
    value: { mask: 253, value: 160 },
    origin: { kind: "initial-memory", space: "nametable", address: 0 },
  });
  expect(
    writeNesPpuMemory(header, mapper(), state, {
      address: 8192,
      addressProof: { low: 0, high: 32 },
      value: 255,
      index: 8,
    }),
  ).toMatchObject({
    status: "ignored",
    destinations: [],
    reason: "chr-rom-readonly",
  });
  expect(chr[133 * 1024]).toBe(161);
});

it("retains missing CIRAM alternatives through PPUDATA and validates continuation proof strength", () => {
  const { header, chr } = fixture(),
    mixed = mapper({ control: { mask: 3, value: 0 } }),
    state = ppu({ nametable_layout: null, v: { low: 0, high: 32 } });
  chr[133 * 1024] = 83;
  const read = readNesPpuCpu(header, mixed, state, {
    address: 8199,
    index: 0,
    chr,
  });
  expect(read).not.toBeNull();
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
        file_offset: header.chrRom.offset + 133 * 1024,
        value: 83,
        mask: 255,
      },
    ],
  });
  state.next_event_index = 1;
  expect(nesPpuAdmission(header, mixed, state, chr)).toBeNull();
  const continuation = nesPpuStateSchema.parse(state);
  expect(nesPpuAdmission(header, mixed, continuation, chr)).toBeNull();
  continuation.read_buffer.value = 83;
  expect(nesPpuAdmission(header, mixed, continuation, chr)).toContain(
    "do not prove",
  );
});

it("retains known ROM offsets when CHR bytes are absent and refills the palette-read underlay", async () => {
  const { header, chr } = fixture(),
    state = ppu({ v: { low: 0, high: 63 }, palette: { 0: 9 } });
  chr[134 * 1024 + 768] = 77;
  const read = readNesPpuCpu(header, mapper(), state, {
    address: 8199,
    index: 0,
    chr,
  });
  expect(read?.value).toEqual({ mask: 63, value: 9 });
  expect(state.read_buffer).toEqual({
    value: 77,
    sources: [
      {
        kind: "rom",
        file_offset: header.chrRom.offset + 134 * 1024 + 768,
        value: 77,
        mask: 255,
      },
    ],
  });
  const view = nesPpuNametableSchema.parse(
    await deriveNesPpuNametable(header, mapper(), state, 0),
  );
  expect(view.source_pages).toEqual([
    {
      kind: "rom",
      file_offset: header.chrRom.offset + 133 * 1024,
      bytes_hex: null,
    },
  ]);
  expect(view.reason).toBe("missing-chr-snapshot");
  expect(view.cells.every((cell) => cell.tile_index === null)).toBe(true);
});

it("pairs tile and attribute choices within each ROM page in the frozen viewport", async () => {
  const { header, chr } = fixture(),
    state = ppu(),
    selected = mapper({ control: { mask: 16, value: 16 } });
  chr.fill(255, 0, 8);
  chr.fill(255, 24, 32);
  chr.fill(0, 133 * 1024, 134 * 1024);
  chr.fill(1, 134 * 1024, 134 * 1024 + 960);
  chr.fill(85, 134 * 1024 + 960, 135 * 1024);
  const map = await deriveNesPpuNametable(
    header,
    selected,
    state,
    0,
    undefined,
    chr,
  );
  expect(map.cells[0]!.tile_index).toEqual({ mask: 254, value: 0 });
  expect(map.attributes[0]!.quadrants[0]!.choices).toEqual([0, 1]);
  const view = nesPpuViewportSchema.parse(
    await deriveNesPpuViewport(header, selected, state, {
      selection: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
      chr,
    }),
  );
  expect(view.nametables[0]!.source_pages).toEqual(map.source_pages);
  const mode = view.modes[0]!;
  const pixel = mode.pixel_states[mode.rows[0]![0]!]!;
  expect(pixel.palette_mask).toBe(66);
});

it("keeps all 130 mixed source pages under pressure and observes nametable/viewport cancellation", async () => {
  const { header, chr } = fixture(),
    selected = mapper({ control: null, nametable_banks: [null, null] }),
    state = ppu({ nametable: { 0: 0, 1024: 0 } });
  const map = nesPpuNametableSchema.parse(
    await deriveNesPpuNametable(header, selected, state, 0, undefined, chr),
  );
  expect(map.source_pages).toHaveLength(130);
  expect(map.source_pages.slice(0, 2)).toEqual([0, 1024]);
  expect(map.source_pages[2]).toMatchObject({
    kind: "rom",
    file_offset: header.chrRom.offset + 128 * 1024,
  });
  expect(map.source_pages[129]).toMatchObject({
    kind: "rom",
    file_offset: header.chrRom.offset + 255 * 1024,
  });
  expect(map.coverage).toMatchObject({
    examined_cells: 960,
    examined_attributes: 64,
    unresolved_source: true,
  });
  const view = nesPpuViewportSchema.parse(
    await deriveNesPpuViewport(header, selected, state, {
      selection: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
      chr,
    }),
  );
  expect(
    view.nametables.every((page) => page.source_pages.length === 130),
  ).toBe(true);
  const controller = new AbortController();
  controller.abort(new Error("Sunsoft4 cancelled"));
  await expect(
    deriveNesPpuNametable(header, selected, state, 0, controller.signal, chr),
  ).rejects.toThrow("Sunsoft4 cancelled");
  await expect(
    deriveNesPpuViewport(header, selected, state, {
      selection: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
      chr,
      signal: controller.signal,
    }),
  ).rejects.toThrow("Sunsoft4 cancelled");
});
