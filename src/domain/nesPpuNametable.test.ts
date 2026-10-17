import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import {
  nesPpuFixture,
  nesPpuFixtureState,
  nesPpuNametableUploadFixture,
} from "./nesPpu.fixture.js";
import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsTraceSchema,
} from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { deriveNesPpuNametable } from "./nesPpuNametableDerivation.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { exploreNesCodeInputSchema } from "./nesCodeExploration.js";
import { exploreNesCode } from "./nesCodeExplorationDerivation.js";

const inspect = async (
  extra: Record<string, unknown> = {},
  raw: Record<string, unknown> = {},
  fixture = nesPpuFixture(),
) => {
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/map.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState(extra),
    ppu_nametable: 0,
    events: [],
    ...raw,
  });
  const result = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header.value, input.initial, input.events, {
      initialPpu: input.initial_ppu,
      ppuNametable: input.ppu_nametable,
    }),
  );
  if (
    result.status !== "derived" ||
    !("ppu_trace" in result) ||
    !("nametable" in result.ppu_trace)
  )
    throw new Error(JSON.stringify(result));
  return {
    ...result,
    ppu_trace: { ...result.ppu_trace, nametable: result.ppu_trace.nametable },
  };
};

it("retains non-convex attribute choices and correlated physical pages under unknown MMC3 mirroring", async () => {
  const result = await inspect(
    {
      nametable: { 0: 17, 1024: 33, 960: 0, 1984: 3 },
      control: { mask: 15, value: 0 },
    },
    { initial: { mapper: 4 }, ppu_nametable: 1 },
    nesPpuFixture([], { mapper: 4 }),
  );
  const map = result.ppu_trace.nametable;
  expect(map.source_pages).toEqual([0, 1024]);
  expect(map.cells[0]!.tile_index).toEqual({ mask: 207, value: 1 });
  expect(map.attributes[0]).toMatchObject({
    value: { mask: 252, value: 0 },
    quadrants: [
      { value: null, choices: [0, 3] },
      { value: 0, choices: [0] },
      { value: 0, choices: [0] },
      { value: 0, choices: [0] },
    ],
  });
  expect(map.pattern_tables).toEqual([0, 1]);
  expect(map.coverage.unresolved_source).toBe(true);
  expect(result.ppu_trace.final.nametable[0]).toBe(17);
  expect(result.ppu_trace.final.nametable[1024]).toBe(33);
  expect(result.ppu_trace.operations).toEqual([]);
  expect(result.ppu_trace.coverage.bus_reads).toBe(0);
});

it("preserves partial palette selectors and grayscale code proofs without opaque background zero", async () => {
  for (const mask of [0, 1, null]) {
    const result = await inspect({
      mask,
      nametable: { 960: { mask: 1, value: 1 } },
      palette: { 0: 15, 1: 45, 4: 63, 8: 62, 12: 61 },
    });
    const map = result.ppu_trace.nametable;
    expect(map.attributes[0]!.quadrants[0]).toEqual({
      value: { mask: 1, value: 1 },
      choices: [1, 3],
    });
    expect(map.palette_cells[1]).toEqual({
      address: 1,
      value: 45,
      code: mask === 0 ? 45 : mask === 1 ? 32 : { mask: 50, value: 32 },
    });
    expect(
      map.palette_cells.every((cell) => ![4, 8, 12].includes(cell.address)),
    ).toBe(true);
    expect(map.palettes.every((palette) => palette.cells[0] === 0)).toBe(true);
    expect(map.palette_cells[0]!.address).toBe(0);
    expect(map.palette_cells[2]!.code).toEqual(
      mask === 1 ? { mask: 15, value: 0 } : null,
    );
  }
});

it("keeps declared four-screen pages separate including the final attribute byte and bottom tile row", async () => {
  const fixture = nesPpuFixture();
  fixture.bytes[6]! |= 8;
  for (const page of [0, 1, 2, 3]) {
    const result = await inspect(
      {
        nametable_layout: "four-screen-4k",
        nametable: {
          [page * 1024 + 959]: page + 10,
          [page * 1024 + 1023]: 0xe4,
        },
      },
      { ppu_nametable: page },
      fixture,
    );
    const map = result.ppu_trace.nametable;
    expect(map.source_pages).toEqual([page * 1024]);
    expect(map.cells[959]).toEqual({
      x: 31,
      y: 29,
      tile_index: page + 10,
      attribute: 63,
      quadrant: 1,
    });
    expect(
      map.attributes[63]!.quadrants.map((quadrant) => quadrant.value),
    ).toEqual([0, 1, 2, 3]);
  }
});

it("retains missing storage as unknown while resolving a proven PPUCTRL pattern bit", async () => {
  const result = await inspect({
    nametable_layout: null,
    control: { mask: 16, value: 16 },
    next_event_index: 99,
  });
  const map = result.ppu_trace.nametable;
  expect(map.source_pages).toEqual([]);
  expect(map.reason).toBe("unknown-nametable-wiring");
  expect(map.pattern_tables).toEqual([1]);
  expect(map.coverage).toEqual({
    examined_cells: 960,
    examined_attributes: 64,
    unresolved_source: true,
    unknown_tile_indices: 960,
    partial_tile_indices: 0,
    unknown_subpalettes: 960,
    partial_subpalettes: 0,
    ambiguous_subpalettes: 960,
    unknown_palette_codes: 13,
    partial_palette_codes: 0,
  });
  expect(result.ppu_trace.final.next_event_index).toBe(99);
  expect(result.steps).toEqual([]);
});

it("joins source-uploaded tile, attribute, palette and pattern facts through final committed state", async () => {
  const fixture = nesPpuNametableUploadFixture(),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/upload-map.nes",
    initial: { mapper: 0 },
    initial_ppu: fixture.initial_ppu,
    ppu_nametable: 1,
    ppu_pattern_table: 1,
  });
  const code = await deriveNesCode(
    header.value,
    fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
    input,
  );
  if (code.status !== "derived") throw new Error(code.reason);
  const trace = nesMapperEventsTraceSchema.parse(code.mapper_trace);
  if (
    trace.status !== "derived" ||
    !("ppu_trace" in trace) ||
    !("nametable" in trace.ppu_trace) ||
    !("pattern_table" in trace.ppu_trace)
  )
    throw new Error("Missing graphics");
  expect(trace.ppu_trace.final.nametable[0]).toEqual({
    value: 18,
    origin: { kind: "event-write", index: 502 },
  });
  expect(trace.ppu_trace.final.nametable[960]).toEqual({
    value: 228,
    origin: { kind: "event-write", index: 506 },
  });
  expect(trace.ppu_trace.final.palette[1]).toEqual({
    value: 41,
    origin: { kind: "event-write", index: 509 },
  });
  expect(trace.ppu_trace.nametable.cells[0]!.tile_index).toBe(18);
  expect(trace.ppu_trace.nametable.palette_cells[1]!.code).toBe(41);
  expect(trace.ppu_trace.pattern_table.tiles[18]!.rows[0]).toEqual([
    1, 2, 0, 0, 0, 0, 0, 0,
  ]);
  expect(trace.ppu_trace.final.next_event_index).toBe(510);
  expect(fixture.initial_ppu.nametable).toEqual({});
});

it("requires the selected PPU model and honors cancellation before a completed map", async () => {
  const fixture = nesPpuFixture(),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  expect(
    await deriveNesMapperEvents(
      header.value,
      nesMapperStateSchema.parse({ mapper: 0 }),
      [],
      { ppuNametable: 0 },
    ),
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("initial_ppu"),
  });
  const controller = new AbortController();
  controller.abort(new Error("cancel-map"));
  await expect(
    deriveNesPpuNametable(
      header.value,
      nesMapperStateSchema.parse({ mapper: 0 }),
      nesPpuFixtureState(),
      0,
      controller.signal,
    ),
  ).rejects.toThrow("cancel-map");
});

it("keeps branch and unapplied-prefix maps isolated while replaying each committed memory state", async () => {
  const fixture = nesPpuFixture([
      0xad, 0x16, 0x40, 0xf0, 8, 0xa9, 0xaa, 0x8d, 7, 0x20, 0x4c, 0x12, 0xc1,
      0xa9, 0xbb, 0x8d, 7, 0x20, 0x60,
    ]),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = exploreNesCodeInputSchema.parse({
    path: "/map-branches.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState({ v: { low: 0, high: 32 } }),
    ppu_nametable: 0,
  });
  const result = await exploreNesCode(
    header.value,
    fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
    input,
  );
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.paths).toHaveLength(3);
  for (const path of result.paths) {
    if (path.trace.status !== "derived") throw new Error(path.trace.reason);
    const mapped = nesMapperEventsTraceSchema.parse(path.trace.mapper_trace);
    if (
      mapped.status !== "derived" ||
      !("ppu_trace" in mapped) ||
      !("nametable" in mapped.ppu_trace)
    )
      throw new Error("Missing branch map");
    const value =
      path.branch_choices.length === 0
        ? null
        : path.branch_choices[0]!.taken
          ? 0xbb
          : 0xaa;
    expect(mapped.ppu_trace.nametable.cells[0]!.tile_index).toBe(value);
    expect(mapped.ppu_trace.nametable.coverage.unknown_tile_indices).toBe(
      value === null ? 960 : 959,
    );
    expect(mapped.ppu_trace.final.next_event_index).toBe(
      value === null ? 0 : 1,
    );
  }
  expect(input.initial_ppu!.nametable).toEqual({});
});
