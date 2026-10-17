import { expect, it, vi } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesMmc5StateSchema } from "./nesMmc5.js";
import { nesPpuFixtureState } from "./nesPpu.fixture.js";
import { deriveNesPpuNametable } from "./nesPpuNametableDerivation.js";
import { nesPpuNametableSchema } from "./nesPpuNametable.js";
import { deriveNesPpuViewport } from "./nesPpuViewportDerivation.js";
import { nesPpuViewportSchema } from "./nesPpuViewport.js";
import { deriveNesPpuMmc5Background } from "./nesPpuMmc5BackgroundDerivation.js";
import type { NesPpuMmc5BackgroundProjection } from "./nesPpuMmc5Background.js";

const fixture = () => {
  const bytes = Buffer.alloc(16 + 32768 + 1048576);
  bytes.set([78, 69, 83, 26, 2, 128, 80, 8]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const mapper = nesMmc5StateSchema.parse({
    mapper: 5,
    chr_mode: 3,
    chr_banks: Array(12).fill(0),
    chr_bank_modes: Array(12).fill(3),
    chr_bank_upper: Array(12).fill(0),
    chr_upper: 2,
    ppu_control: 0,
    ppu_mask: 8,
    exram_mode: 1,
    exram_written: true,
    nametable_control: 0,
    split: [0, 17, 7],
    ppu: {
      model: "mmc5-background",
      pin92_high: true,
      split_y: 99,
      split_wiring: "cl",
    },
    exram: { 4: 0x41, 5: 0x82, 36: 0x41, 37: 0x82 },
  });
  const ppu = nesPpuFixtureState({
    chr_ram_size: null,
    nametable_layout: "ciram-2k",
    control: 0,
    mask: 10,
    nametable: { 36: 17, 37: 18, 961: 0 },
    palette: Object.fromEntries(Array.from({ length: 16 }, (_, n) => [n, n])),
    oam: {
      model: "oam-memory",
      retention: "stable",
      dma_pending: { status: "none" },
      cells: Object.fromEntries(
        Array.from({ length: 256 }, (_, n) => [n, n % 4 === 0 ? 255 : 0]),
      ),
    },
  });
  const chr = bytes.subarray(16 + 32768);
  for (let row = 0; row < 8; row++) {
    chr[129 * 4096 + 17 * 16 + row] = 255;
    chr[130 * 4096 + 18 * 16 + row + 8] = 255;
  }
  return { header: parsed.value, mapper, ppu, chr };
};
const stateAt = (
  projection: NesPpuMmc5BackgroundProjection,
  column: number,
  y: number,
) => projection.row_states[projection.rows[y]![column]!]!;
const qualification = { first_screen_column: 0, split_y_at_origin: 235 };

it("keeps adjacent extended cells' bank/palette pairs under one effective-quadrant summary", async () => {
  const { header, mapper, ppu, chr } = fixture();
  const before = structuredClone({ mapper, ppu });
  const page = nesPpuNametableSchema.parse(
    await deriveNesPpuNametable(
      header,
      mapper,
      ppu,
      0,
      undefined,
      chr,
      qualification,
    ),
  );
  if (!("mmc5_background" in page))
    throw new Error("Missing qualified projection");
  const projection = page.mmc5_background;
  expect(page.attributes_model).toBe("effective-quadrant-envelope");
  expect(page.cells[36]!.tile_index).toBe(17);
  expect(page.cells[37]!.tile_index).toBe(18);
  expect(page.attributes[1]!.quadrants[0]!.choices).toEqual([1, 2]);
  expect(stateAt(projection, 4, 8).palette_index_masks).toEqual(
    Array(8).fill(1 << 5),
  );
  expect(stateAt(projection, 5, 8).palette_index_masks).toEqual(
    Array(8).fill(1 << 10),
  );
  const branch = projection.branches[stateAt(projection, 4, 8).branches[0]!]!;
  expect(projection.pattern_sets[branch.pattern_set]).toEqual({
    kind: "4k",
    banks: [129],
  });
  expect(projection.source_pairs[branch.source_pair]!.attribute).toMatchObject({
    address: 36,
    value: 0x41,
    shift: 6,
    origin: { kind: "initial-exram", address: 36 },
  });
  expect({ mapper, ppu }).toEqual(before);
});

it("binds an ExRAM byte used as both tile and extended attribute before decoding pixels", async () => {
  const { header, mapper, ppu, chr } = fixture();
  mapper.nametable_control = 0xaa;
  mapper.exram[37] = { mask: 127, value: 2 };
  for (let row = 0; row < 8; row++) {
    chr[130 * 4096 + 2 * 16 + row] = 255;
    chr[130 * 4096 + 130 * 16 + row] = 255;
    chr[130 * 4096 + 130 * 16 + row + 8] = 255;
  }
  const page = await deriveNesPpuNametable(
    header,
    mapper,
    ppu,
    0,
    undefined,
    chr,
    qualification,
  );
  if (!("mmc5_background" in page))
    throw new Error("Missing qualified projection");
  const state = stateAt(page.mmc5_background, 5, 8);
  expect(state.palette_index_masks).toEqual(
    Array(8).fill((1 << 1) | (1 << 11)),
  );
  expect(
    page.mmc5_background.source_pairs[
      page.mmc5_background.branches[state.branches[0]!]!.source_pair
    ]!.coupling,
  ).toBe("tile-extended-attribute");
});

it("samples qualified viewport geometry from visible coordinates across fine-X and screen-column wrap", async () => {
  const { header, mapper, ppu, chr } = fixture();
  mapper.exram_mode = 0;
  mapper.split[0] = 0xc4;
  mapper.split[2] = 7;
  mapper.exram[29 * 32 + 4] = 21;
  mapper.exram[1017] = 2;
  if (!("ppu" in mapper)) throw new Error("Missing MMC5 model");
  mapper.ppu.split_wiring = "sl";
  ppu.nametable = Object.fromEntries(
    Array.from({ length: 2048 }, (_, n) => [n, 0]),
  );
  ppu.palette = Object.fromEntries(
    Array.from({ length: 16 }, (_, n) => [n, n]),
  );
  chr[7 * 4096 + 21 * 16 + 3] = 255;
  const view = nesPpuViewportSchema.parse(
    await deriveNesPpuViewport(header, mapper, ppu, {
      chr,
      selection: { model: "frozen-viewport", origin_x: 35, origin_y: 1 },
      mmc5Background: { first_screen_column: 3, split_y_at_origin: 235 },
    }),
  );
  if (!("mmc5_background" in view))
    throw new Error("Missing qualified viewport");
  const projection = view.mmc5_background;
  expect(projection.columns).toBe(33);
  expect(projection.first_tile_fine_x).toBe(3);
  expect(stateAt(projection, 0, 0).palette_index_masks[0]).toBe(1);
  expect(stateAt(projection, 1, 0).palette_index_masks[0]).toBe(1 << 9);
  const visible = (x: number) =>
    view.modes[0]!.pixel_states[view.modes[0]!.rows[0]![x]!]!.palette_mask;
  expect(visible(4)).toBe(1);
  expect(visible(5)).toBe(1 << 9);
  expect(visible(253)).toBe(1);
  const physical = view.chr_source_pages
    .filter((page) => page.kind === "rom")
    .map((page) => page.file_offset);
  expect(new Set(physical).size).toBe(physical.length);
  expect(
    projection.chr_pages.every((index) => index < view.chr_source_pages.length),
  ).toBe(true);
});

it("retains exact partial split-counter images and paired rows through239/255 wrap", async () => {
  const { header, mapper, ppu, chr } = fixture();
  mapper.exram_mode = 0;
  mapper.split[0] = 0x9f;
  const projected = await deriveNesPpuMmc5Background({
    header,
    mapper,
    ppu,
    chr,
    qualification: {
      first_screen_column: 0,
      split_y_at_origin: { mask: 254, value: 238 },
    },
    originX: 0,
    originY: 0,
  });
  expect(
    projected.projection.geometry_rows.slice(0, 3).map((row) => row.split_y),
  ).toEqual([
    [238, 239],
    [0, 239],
    [0, 1],
  ]);
  const rows = stateAt(projected.projection, 0, 1).branches.map(
    (index) => projected.projection.branches[index]!.split_coarse_y,
  );
  expect(rows).toEqual([0, 29]);
});

it("keeps all1024 ROM pages and complete240 rows under null-counter qualification without duplicate snapshots", async () => {
  const { header, mapper, ppu, chr } = fixture();
  mapper.exram_mode = 0;
  mapper.chr_banks = Array(12).fill(null);
  mapper.chr_bank_upper = Array(12).fill(null);
  mapper.split[0] = 0;
  ppu.nametable = Object.fromEntries(
    Array.from({ length: 2048 }, (_, n) => [n, 0]),
  );
  const page = nesPpuNametableSchema.parse(
    await deriveNesPpuNametable(header, mapper, ppu, 0, undefined, chr, {
      first_screen_column: 0,
      split_y_at_origin: null,
    }),
  );
  if (!("mmc5_background" in page))
    throw new Error("Missing capacity projection");
  expect(page.chr_source_pages).toHaveLength(1024);
  expect(page.mmc5_background.chr_pages).toEqual(
    Array.from({ length: 1024 }, (_, n) => n),
  );
  expect(page.mmc5_background.rows).toHaveLength(240);
  expect(page.mmc5_background.rows.every((row) => row.length === 32)).toBe(
    true,
  );
  expect(page.mmc5_background.geometry_rows[0]!.split_y).toHaveLength(256);
  expect(page.mmc5_background.geometry_rows[16]!.split_y).toEqual(
    Array.from({ length: 240 }, (_, n) => n),
  );
  expect(
    page.chr_source_pages
      .filter((source) => source.kind === "rom")
      .map((source) => source.file_offset),
  ).toEqual(
    Array.from(
      { length: 1024 },
      (_, bank) => header.chrRom.offset + bank * 1024,
    ),
  );
  expect("chr_source_pages" in page.mmc5_background).toBe(false);
}, 30000);

it("coalesces the complete always-split null-counter facet with every CHR bank and exact shared source references", async () => {
  const { header, mapper, ppu, chr } = fixture();
  mapper.exram_mode = 0;
  mapper.split[0] = 0xc0;
  mapper.split[2] = null;
  mapper.chr_banks = Array(12).fill(null);
  mapper.chr_bank_upper = Array(12).fill(null);
  mapper.exram = Object.fromEntries(
    Array.from({ length: 1024 }, (_, address) => [address, address & 255]),
  );
  if (!("ppu" in mapper)) throw new Error("Missing MMC5 model");
  mapper.ppu.split_wiring = "sl";
  const page = nesPpuNametableSchema.parse(
    await deriveNesPpuNametable(header, mapper, ppu, 0, undefined, chr, {
      first_screen_column: 0,
      split_y_at_origin: null,
    }),
  );
  if (!("mmc5_background" in page))
    throw new Error("Missing always-split facet");
  const projection = page.mmc5_background;
  expect(projection.rows).toHaveLength(240);
  expect(projection.geometry_rows[0]!.split_y).toHaveLength(256);
  expect(projection.geometry_rows[16]!.split_y).toEqual(
    Array.from({ length: 240 }, (_, n) => n),
  );
  expect(page.chr_source_pages).toHaveLength(1024);
  expect(projection.chr_pages).toHaveLength(1024);
  expect(
    new Set(
      page.chr_source_pages
        .filter((source) => source.kind === "rom")
        .map((source) => source.file_offset),
    ).size,
  ).toBe(1024);
  expect(projection.source_pairs).toHaveLength(1024);
  expect(projection.pattern_sets).toEqual([
    { kind: "4k", banks: Array.from({ length: 256 }, (_, bank) => bank) },
  ]);
  expect(
    projection.row_states.every((state) => state.branches.length <= 32),
  ).toBe(true);
  expect(stateAt(projection, 0, 0).branches).toHaveLength(32);
  const fineByGeometry = projection.geometry_rows.map((geometry) =>
    Array.from({ length: 32 }, (_, coarse) =>
      [
        ...new Set(
          geometry.split_y.filter((y) => y >> 3 === coarse).map((y) => y & 7),
        ),
      ].sort((a, b) => a - b),
    ),
  );
  expect(
    projection.row_states.every((state) =>
      state.branches.every((reference) => {
        const branch = projection.branches[reference]!;
        if (
          branch.path !== "split" ||
          branch.source_pair >= projection.source_pairs.length ||
          branch.pattern_set !== 0 ||
          branch.split_coarse_y === null
        )
          return false;
        const expected =
          fineByGeometry[state.geometry]![branch.split_coarse_y]!;
        return (
          branch.pattern_rows.length === expected.length &&
          branch.pattern_rows.every((row, index) => row === expected[index])
        );
      }),
    ),
  ).toBe(true);
  const forged = structuredClone(page);
  forged.mmc5_background.chr_pages[0] = 1024;
  expect(nesPpuNametableSchema.safeParse(forged).success).toBe(false);
}, 30000);

it("cancels between complete projection rows without changing frozen input facts", async () => {
  const { header, mapper, ppu, chr } = fixture();
  const before = structuredClone({ mapper, ppu });
  const controller = new AbortController(),
    reason = new Error("qualified-row-cancellation");
  const original = controller.signal.throwIfAborted.bind(controller.signal);
  let checks = 0;
  const check = vi
    .spyOn(controller.signal, "throwIfAborted")
    .mockImplementation(() => {
      if (++checks === 3) controller.abort(reason);
      original();
    });
  try {
    await expect(
      deriveNesPpuMmc5Background({
        header,
        mapper,
        ppu,
        chr,
        signal: controller.signal,
        qualification,
        originX: 0,
        originY: 0,
      }),
    ).rejects.toBe(reason);
    expect(checks).toBe(3);
    expect({ mapper, ppu }).toEqual(before);
  } finally {
    check.mockRestore();
  }
});
