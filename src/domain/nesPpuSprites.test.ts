import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesPpuFixture, nesPpuFixtureState } from "./nesPpu.fixture.js";
import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsTraceSchema,
} from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { deriveNesPpuSprites } from "./nesPpuSpritesDerivation.js";
import { nesPpuSpritesSchema } from "./nesPpuSprites.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";

const inspect = async (
  extra: Record<string, unknown> = {},
  fixture = nesPpuFixture([], { chrSize: 8192 }),
  raw: Record<string, unknown> = {},
) => {
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/sprites.nes",
    initial: { mapper: 0 },
    ppu_sprites: true,
    initial_ppu: nesPpuFixtureState({
      chr_ram_size: null,
      oam: { model: "oam-memory", retention: "stable" },
      ...extra,
    }),
    events: [],
    ...raw,
  });
  const result = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header.value, input.initial, input.events, {
      initialPpu: input.initial_ppu,
      ppuSprites: input.ppu_sprites,
      chr: fixture.bytes.subarray(fixture.chrOffset),
    }),
  );
  if (
    result.status !== "derived" ||
    !("ppu_trace" in result) ||
    result.ppu_trace.sprites === null
  )
    throw new Error(JSON.stringify(result));
  return { result, sprites: result.ppu_trace.sprites };
};

it("cancels decoding at an asynchronous boundary without mutating supplied state", async () => {
  const fixture = nesPpuFixture([], { chrSize: 8192 }),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const state = nesPpuFixtureState({
      chr_ram_size: null,
      control: null,
      oam: { model: "oam-memory", retention: "stable" },
    }),
    before = structuredClone(state),
    controller = new AbortController(),
    reason = new Error("cancel sprite query");
  const pending = deriveNesPpuSprites(
    header.value,
    nesMapperStateSchema.parse({ mapper: 0 }),
    state,
    {
      chr: fixture.bytes.subarray(fixture.chrOffset),
      signal: controller.signal,
    },
  );
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);
  expect(state).toEqual(before);
});

it("decodes every OAM entry against independent 8x8/8x16 bit-plane and whole-sprite flip oracles", async () => {
  const fixture = nesPpuFixture([], { chrSize: 8192 });
  for (const { height, flips } of [8, 16].flatMap((height) =>
    [0, 64, 128, 192].map((flips) => ({ height, flips })),
  )) {
    const cells = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        [index * 4, index * 4],
        [index * 4 + 1, (index * 7 + 3) & 255],
        [index * 4 + 2, flips | 32 | (index % 4)],
        [index * 4 + 3, 255 - index],
      ]).flat(),
    );
    const { result, sprites } = await inspect(
      {
        control: height === 8 ? 8 : 32,
        mask: 20,
        palette: { 17: 45 },
        oam: { model: "oam-memory", retention: "stable", cells },
      },
      fixture,
    );
    expect(sprites.sprites_enabled).toBe(true);
    expect(sprites.left_column_enabled).toBe(true);
    for (const [index, sprite] of sprites.sprites.entries()) {
      const tile = (index * 7 + 3) & 255,
        table = height === 8 ? 1 : tile & 1,
        base = height === 8 ? tile : tile & 254;
      expect(sprite).toMatchObject({
        index,
        oam_address: index * 4,
        y: index * 4,
        x: 255 - index,
        top_rows: [index * 4 + 1],
        offscreen_y: index * 4 >= 239,
        subpalette: index % 4,
        behind_background: true,
      });
      const mode = sprite.modes[0]!;
      expect(mode.height).toBe(height);
      expect(mode.pattern_tables).toEqual([table]);
      expect(mode.first_tiles).toEqual([base]);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < 8; x++) {
          const sy = flips & 128 ? height - 1 - y : y,
            sx = flips & 64 ? 7 - x : x,
            offset =
              fixture.chrOffset +
              table * 4096 +
              (base + Math.floor(sy / 8)) * 16 +
              (sy % 8);
          expect(mode.rows[y]![x]).toBe(
            ((fixture.bytes[offset]! >> (7 - sx)) & 1) |
              (((fixture.bytes[offset + 8]! >> (7 - sx)) & 1) << 1),
          );
        }
    }
    expect(result.ppu_trace.final.oam!.cells).toEqual(cells);
    expect(result.ppu_trace.operations).toEqual([]);
    expect(result.ppu_trace.final.next_event_index).toBe(0);
    expect(sprites.palette_cells[0]).toEqual({
      address: 17,
      value: 45,
      code: 45,
    });
    expect(sprites.palettes[0]!.cells).toEqual([null, 0, 1, 2]);
  }
});

it("nominates the first eight vertical matches for every Y byte in both heights regardless of mask, X, opacity or priority", async () => {
  const fixture = nesPpuFixture([], { chrSize: 8192 });
  fixture.bytes.fill(0, fixture.chrOffset);
  for (const height of [8, 16])
    for (let group = 0; group < 4; group++) {
      const ys = Array.from({ length: 64 }, (_, index) => group * 64 + index),
        cells = Object.fromEntries(
          ys.flatMap((y, index) => [
            [index * 4, y],
            [index * 4 + 1, 0],
            [index * 4 + 2, 224],
            [index * 4 + 3, 255],
          ]),
        );
      const { sprites } = await inspect(
        {
          control: height === 8 ? 0 : 32,
          mask: 0,
          oam: { model: "oam-memory", retention: "stable", cells },
        },
        fixture,
      );
      expect(sprites.sprites_enabled).toBe(false);
      expect(
        sprites.sprites[0]!.modes[0]!.rows.flat().every((pixel) => pixel === 0),
      ).toBe(true);
      const mode = sprites.scanline_selection.modes[0]!;
      expect(mode.height).toBe(height);
      for (const line of mode.lines) {
        const eligible = ys.flatMap((stored, sprite) => {
          const row = line.y - stored - 1;
          return row >= 0 && row < height ? [{ sprite, row }] : [];
        });
        const { candidate_set, ...geometry } = line;
        expect({
          ...geometry,
          candidates: mode.candidate_sets[candidate_set],
        }).toEqual({
          y: line.y,
          in_range: { minimum: eligible.length, maximum: eligible.length },
          selected: {
            minimum: Math.min(8, eligible.length),
            maximum: Math.min(8, eligible.length),
          },
          excess: {
            minimum: Math.max(0, eligible.length - 8),
            maximum: Math.max(0, eligible.length - 8),
          },
          candidates: eligible.map(({ sprite, row }, slot) => ({
            sprite,
            row_mask: 2 ** row,
            selection: slot < 8 ? "definite" : "excluded",
            slots: slot < 8 ? [slot, slot] : null,
          })),
        });
      }
      expect(mode.coverage.uncertain_selection_scanlines).toBe(0);
    }
});

it("retains exactly the nominations, rows and slots from all compatible partial-Y completions in each global height", async () => {
  const cells = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      index * 4,
      index < 10
        ? index >= 6 && index <= 8
          ? { mask: 252, value: 0 }
          : 0
        : 255,
    ]),
  );
  const { sprites } = await inspect({
    control: null,
    oam: { model: "oam-memory", retention: "stable", cells },
  });
  expect(sprites.scanline_selection.modes.map((mode) => mode.height)).toEqual([
    8, 16,
  ]);
  const invalid = structuredClone(sprites);
  invalid.scanline_selection.modes[0]!.lines[0]!.candidate_set =
    invalid.scanline_selection.modes[0]!.candidate_sets.length;
  expect(nesPpuSpritesSchema.safeParse(invalid).success).toBe(false);
  for (const mode of sprites.scanline_selection.modes)
    for (let y = 0; y < 21; y++) {
      const outcomes = Array.from({ length: 64 }, (_, bits) =>
        Array.from({ length: 10 }, (_, sprite) => {
          const stored =
            sprite >= 6 && sprite <= 8 ? (bits >> ((sprite - 6) * 2)) & 3 : 0;
          return { sprite, row: y - stored - 1 };
        }).filter(({ row }) => row >= 0 && row < mode.height),
      );
      const lengths = outcomes.map((outcome) => outcome.length),
        minimum = Math.min(...lengths),
        maximum = Math.max(...lengths),
        candidates = Array.from({ length: 10 }, (_, sprite) => {
          const eligible = outcomes.flatMap((outcome) =>
              outcome.filter((entry) => entry.sprite === sprite),
            ),
            slots = outcomes
              .map((outcome) =>
                outcome
                  .slice(0, 8)
                  .findIndex((entry) => entry.sprite === sprite),
              )
              .filter((slot) => slot >= 0);
          if (eligible.length === 0) return [];
          return [
            {
              sprite,
              row_mask: eligible.reduce(
                (mask, { row }) => mask | (1 << row),
                0,
              ),
              selection:
                slots.length === 0
                  ? "excluded"
                  : slots.length === 64
                    ? "definite"
                    : "possible",
              slots:
                slots.length === 0
                  ? null
                  : [Math.min(...slots), Math.max(...slots)],
            },
          ];
        }).flat();
      const { candidate_set, ...geometry } = mode.lines[y]!;
      expect({
        ...geometry,
        candidates: mode.candidate_sets[candidate_set],
      }).toEqual({
        y,
        in_range: { minimum, maximum },
        selected: {
          minimum: Math.min(8, minimum),
          maximum: Math.min(8, maximum),
        },
        excess: {
          minimum: Math.max(0, minimum - 8),
          maximum: Math.max(0, maximum - 8),
        },
        candidates,
      });
    }
});

it("preserves partial modes, selectors, flips, coordinates and grayscale without inventing opaque pixel zero", async () => {
  const fixture = nesPpuFixture([], { chrSize: 8192 });
  for (let tile = 0; tile < 512; tile++) {
    fixture.bytes.fill(
      0x81,
      fixture.chrOffset + tile * 16,
      fixture.chrOffset + tile * 16 + 8,
    );
    fixture.bytes.fill(
      0,
      fixture.chrOffset + tile * 16 + 8,
      fixture.chrOffset + tile * 16 + 16,
    );
  }
  const { sprites } = await inspect(
    {
      control: null,
      mask: null,
      palette: { 17: 45 },
      oam: {
        model: "oam-memory",
        retention: "stable",
        cells: {
          0: { mask: 254, value: 238 },
          1: { mask: 254, value: 2 },
          2: { mask: 32, value: 32 },
        },
      },
    },
    fixture,
  );
  const first = sprites.sprites[0]!;
  expect(first.top_rows).toEqual([239, 240]);
  expect(first.offscreen_y).toBeNull();
  expect(first.behind_background).toBe(true);
  expect(first.modes.map((mode) => mode.height)).toEqual([8, 16]);
  expect(first.modes.map((mode) => mode.first_tiles)).toEqual([[2, 3], [2]]);
  for (const mode of first.modes) {
    expect(mode.pattern_tables).toEqual([0, 1]);
    expect(mode.rows).toEqual(
      Array.from({ length: mode.height }, () => [1, 0, 0, 0, 0, 0, 0, 1]),
    );
  }
  expect(sprites.palette_cells[0]!.code).toEqual({ mask: 50, value: 32 });
  expect(sprites.source_pages).toHaveLength(8);
});

it("retains all compatible MMC3 source pages once across both tables and keeps common pixel bits", async () => {
  const fixture = nesPpuFixture([], { mapper: 4, chrSize: 256 * 1024 });
  fixture.bytes.fill(0, fixture.chrOffset);
  for (let offset = 0; offset < 256 * 1024; offset += 16)
    fixture.bytes[fixture.chrOffset + offset] = 0x80;
  const { sprites } = await inspect({ control: null }, fixture, {
    initial: { mapper: 4 },
  });
  expect(sprites.source_pages).toHaveLength(256);
  expect(sprites.blocks).toHaveLength(8);
  expect(sprites.coverage.unresolved_source_blocks).toBe(8);
  for (const source of sprites.source_pages) {
    if (source.kind !== "rom") throw new Error("Missing ROM");
    expect(source.bytes_hex).toBe(
      fixture.bytes
        .subarray(source.file_offset, source.file_offset + 1024)
        .toString("hex"),
    );
  }
  // Unknown horizontal flip permits the lit pixel at either edge, while its high plane stays zero.
  expect(sprites.sprites[0]!.modes[0]!.rows[0]![0]).toEqual({
    mask: 2,
    value: 0,
  });
});

it("keeps opaque non-convex pixels through unknown tile bits and whole-pair flips", async () => {
  const fixture = nesPpuFixture([], { chrSize: 8192 });
  fixture.bytes.fill(0, fixture.chrOffset);
  for (const table of [0, 1]) {
    const base = fixture.chrOffset + table * 4096;
    fixture.bytes.fill(255, base + 32, base + 40);
    fixture.bytes.fill(255, base + 56, base + 64);
  }
  const { sprites } = await inspect(
    {
      control: null,
      oam: {
        model: "oam-memory",
        retention: "stable",
        cells: {
          0: 0,
          1: { mask: 254, value: 2 },
          2: { mask: 32, value: 0 },
          3: 0,
        },
      },
    },
    fixture,
  );
  const first = sprites.sprites[0]!;
  expect(first.horizontal_flip).toBeNull();
  expect(first.vertical_flip).toBeNull();
  for (const mode of first.modes)
    for (const row of mode.rows)
      expect(row).toEqual(
        Array.from({ length: 8 }, () => ({ choices: [1, 2] })),
      );
});

it("requires the OAM profile and discards unqualified retention without changing caller facts", async () => {
  const fixture = nesPpuFixture([], { chrSize: 8192 }),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  for (const initialPpu of [null, nesPpuFixtureState({ chr_ram_size: null })])
    expect(
      await deriveNesMapperEvents(
        header.value,
        traceNesMapperEventsInputSchema.parse({
          path: "/s.nes",
          initial: { mapper: 0 },
          events: [],
        }).initial,
        [],
        { initialPpu, ppuSprites: true },
      ),
    ).toMatchObject({ status: "unsupported" });
  const { sprites, result } = await inspect(
    { oam: { model: "oam-memory", cells: { 0: 255, 1: 3 } } },
    fixture,
  );
  expect(sprites.sprites[0]!.y).toBeNull();
  expect(sprites.sprites[0]!.offscreen_y).toBeNull();
  expect(result.ppu_trace.initial.oam!.cells).toEqual({ 0: 255, 1: 3 });
  expect(result.ppu_trace.final.oam!.cells).toEqual({});
});
