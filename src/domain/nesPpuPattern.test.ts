import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesPpuFixture, nesPpuFixtureState } from "./nesPpu.fixture.js";
import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsTraceSchema,
} from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { deriveNesPpuPatternTable } from "./nesPpuPatternDerivation.js";
import { nesPpuPatternTableSchema } from "./nesPpuPattern.js";
import { decodeNesChrTile } from "./nesChr.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { deriveNesCode } from "./nesCodeDerivation.js";

const inspect = async (
  fixture: ReturnType<typeof nesPpuFixture>,
  raw: Record<string, unknown>,
  capture = true,
) => {
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/pattern.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState(),
    events: [],
    ppu_pattern_table: 0,
    ...raw,
  });
  const result = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header.value, input.initial, input.events, {
      initialPpu: input.initial_ppu,
      ppuPatternTable: input.ppu_pattern_table,
      chr: capture ? fixture.bytes.subarray(fixture.chrOffset) : undefined,
    }),
  );
  if (
    result.status !== "derived" ||
    !("ppu_trace" in result) ||
    !("pattern_table" in result.ppu_trace)
  )
    throw new Error(JSON.stringify(result));
  return {
    ...result,
    ppu_trace: {
      ...result.ppu_trace,
      pattern_table: result.ppu_trace.pattern_table,
    },
  };
};

it("retains partial plane bits without inventing pixels or dropping physical RAM writer proofs", async () => {
  const ppu = nesPpuFixtureState({
    next_event_index: 8,
    chr_ram: {
      0: {
        value: { mask: 192, value: 128 },
        origin: { kind: "event-write", index: 7 },
      },
      8: 64,
    },
  });
  const before = structuredClone(ppu),
    result = await inspect(nesPpuFixture(), { initial_ppu: ppu });
  const table = result.ppu_trace.pattern_table!;
  expect(table.tiles[0]!.rows[0]).toEqual([
    1,
    2,
    ...Array.from({ length: 6 }, () => ({ mask: 2, value: 0 })),
  ]);
  expect(table.tiles[0]!.rows[1]).toEqual(Array(8).fill(null));
  expect(table.coverage).toEqual({
    examined_tiles: 256,
    unresolved_source_blocks: 0,
    unknown_bytes: 4094,
    partial_bytes: 1,
    unknown_pixels: 16376,
    partial_pixels: 6,
  });
  expect(table.source_pages).toEqual(
    [0, 1024, 2048, 3072].map((address) => ({ kind: "chr-ram", address })),
  );
  expect(result.ppu_trace.final.chr_ram[0]).toEqual(ppu.chr_ram[0]);
  expect(result.ppu_trace.final.next_event_index).toBe(8);
  expect(result.ppu_trace.coverage.bus_reads).toBe(0);
  expect(ppu).toEqual(before);
  const invalid = structuredClone(table);
  invalid.blocks[0]!.sources = [511];
  expect(nesPpuPatternTableSchema.safeParse(invalid).success).toBe(false);
});

it("joins uncertain MMC3 sources in bounded physical pages and decodes their common pixel bits", async () => {
  const fixture = nesPpuFixture([], { mapper: 4, chrSize: 262144 });
  for (let bank = 0; bank < 256; bank++) {
    fixture.bytes.fill(
      0,
      fixture.chrOffset + bank * 1024,
      fixture.chrOffset + bank * 1024 + 16,
    );
    fixture.bytes[fixture.chrOffset + bank * 1024] = bank & 1 ? 0x81 : 0xc1;
    fixture.bytes[fixture.chrOffset + bank * 1024 + 8] = 0x60;
  }
  const result = await inspect(fixture, {
    initial: { mapper: 4, bank_select: 128 },
    initial_ppu: nesPpuFixtureState({ chr_ram_size: null }),
    events: [
      { kind: "cpu-write", address: 0x8000, value: 0x82 },
      { kind: "cpu-write", address: 0x8001, value: 5 },
    ],
  });
  const table = result.ppu_trace.pattern_table!;
  expect(table.source_pages).toHaveLength(256);
  expect(table.blocks.map((block) => block.sources.length)).toEqual([
    1, 256, 256, 256,
  ]);
  expect(table.tiles[0]!.rows[0]).toEqual([1, 2, 2, 0, 0, 0, 0, 1]);
  expect(table.tiles[64]!.byte_values[0]).toEqual({ mask: 191, value: 129 });
  expect(table.tiles[64]!.rows[0]).toEqual([
    1,
    { mask: 2, value: 2 },
    2,
    0,
    0,
    0,
    0,
    1,
  ]);
  expect(table.coverage.unresolved_source_blocks).toBe(3);
  for (const page of table.source_pages) {
    if (page.kind !== "rom") throw new Error("Expected ROM page");
    expect(page.bytes_hex).toBe(
      fixture.bytes
        .subarray(page.file_offset, page.file_offset + 1024)
        .toString("hex"),
    );
  }
});

it("performs a static MMC2 inspection without changing CHR latches, IRQs or event history", async () => {
  const fixture = nesPpuFixture([], { mapper: 9, chrSize: 32768 }),
    initial = {
      mapper: 9,
      chr_fd_0: 1,
      chr_fe_0: 2,
      latch_0: "fe",
      chr_fd_1: 3,
      chr_fe_1: 4,
      latch_1: "fd",
    };
  const result = await inspect(fixture, {
    initial,
    initial_ppu: nesPpuFixtureState({
      chr_ram_size: null,
      next_event_index: 12,
    }),
  });
  expect(result.final).toEqual(result.initial);
  expect(result.steps).toEqual([]);
  expect(result.ppu_trace.operations).toEqual([]);
  expect(result.ppu_trace.final.next_event_index).toBe(12);
  expect(result.ppu_trace.pattern_table!.source_pages[0]).toMatchObject({
    kind: "rom",
    file_offset: fixture.chrOffset + 8192,
  });
  expect(result.final_irq).toBeNull();
});

it("pools the complete 512 KiB VRC4 candidate space once across all logical blocks", async () => {
  const fixture = nesPpuFixture([], { mapper: 4, chrSize: 524288 });
  fixture.bytes[6] = 0x54;
  fixture.bytes[7] = 0x18;
  fixture.bytes[8] = 0x10;
  const result = await inspect(fixture, {
    initial: { mapper: 21, variant: "vrc4" },
    initial_ppu: nesPpuFixtureState({ chr_ram_size: null }),
  });
  const table = result.ppu_trace.pattern_table;
  expect(table.source_pages).toHaveLength(512);
  expect(table.blocks.map((block) => block.sources.length)).toEqual([
    512, 512, 512, 512,
  ]);
  expect(
    table.blocks.every(
      (block) =>
        JSON.stringify(block.sources) ===
        JSON.stringify(table.blocks[0]!.sources),
    ),
  ).toBe(true);
  expect(table.coverage).toEqual({
    examined_tiles: 256,
    unresolved_source_blocks: 4,
    unknown_bytes: 4096,
    partial_bytes: 0,
    unknown_pixels: 0,
    partial_pixels: 16384,
  });
});

it("retains all fifteen nonempty pixel sets while keeping each physical source's low/high planes together", async () => {
  for (let bits = 1; bits <= 15; bits++) {
    const allowed = [0, 1, 2, 3].filter((pixel) => bits & (1 << pixel)),
      fixture = nesPpuFixture([], { mapper: 4, chrSize: 8192 });
    fixture.bytes.fill(0, fixture.chrOffset);
    for (let bank = 0; bank < 8; bank++) {
      const pixel = allowed[(bank >> 1) % allowed.length]!,
        offset = fixture.chrOffset + bank * 1024;
      fixture.bytes.fill(pixel & 1 ? 255 : 0, offset, offset + 8);
      fixture.bytes.fill(pixel & 2 ? 255 : 0, offset + 8, offset + 16);
    }
    const result = await inspect(fixture, {
        initial: { mapper: 4 },
        initial_ppu: nesPpuFixtureState({ chr_ram_size: null }),
      }),
      tile = result.ppu_trace.pattern_table!.tiles[0]!;
    for (const pixel of tile.rows.flat()) {
      const actual =
        typeof pixel === "number"
          ? [pixel]
          : pixel === null
            ? [0, 1, 2, 3]
            : "choices" in pixel
              ? pixel.choices
              : [0, 1, 2, 3].filter(
                  (value) => (value & pixel.mask) === pixel.value,
                );
      expect(actual).toEqual(allowed);
    }
    if (bits === 6) {
      expect(tile.byte_values[0]).toBeNull();
      expect(tile.byte_values[8]).toBeNull();
      expect(tile.rows[0]![0]).toEqual({ choices: [1, 2] });
    }
  }
});

it("keeps unavailable wiring/snapshot pixels unknown and requires the selected PPU model", async () => {
  const missing = await inspect(nesPpuFixture(), {
    initial_ppu: nesPpuFixtureState({ chr_ram_size: null }),
  });
  expect(missing.ppu_trace.pattern_table!.coverage).toEqual({
    examined_tiles: 256,
    unresolved_source_blocks: 4,
    unknown_bytes: 4096,
    partial_bytes: 0,
    unknown_pixels: 16384,
    partial_pixels: 0,
  });
  expect(
    missing.ppu_trace.pattern_table!.blocks.every(
      (block) => block.reason === "unknown-chr-wiring",
    ),
  ).toBe(true);
  const rom = await inspect(
    nesPpuFixture([], { chrSize: 8192 }),
    { initial_ppu: nesPpuFixtureState({ chr_ram_size: null }) },
    false,
  );
  expect(
    rom.ppu_trace.pattern_table!.blocks.every(
      (block) => block.reason === "missing-chr-snapshot",
    ),
  ).toBe(true);
  const fixture = nesPpuFixture(),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/missing.nes",
    initial: { mapper: 0 },
    ppu_pattern_table: 0,
  });
  expect(
    await deriveNesCode(
      header.value,
      fixture.bytes.subarray(fixture.prgOffset),
      input,
    ),
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("initial_ppu"),
  });
  expect(
    await deriveNesMapperEvents(header.value, input.initial, [], {
      ppuPatternTable: 0,
    }),
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("initial_ppu"),
  });
});

it("cancels inspection before retaining a completed table", async () => {
  const fixture = nesPpuFixture(),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const controller = new AbortController();
  controller.abort(new Error("cancel-pattern"));
  await expect(
    deriveNesPpuPatternTable(
      header.value,
      nesMapperStateSchema.parse({ mapper: 0 }),
      nesPpuFixtureState(),
      0,
      undefined,
      controller.signal,
    ),
  ).rejects.toThrow("cancel-pattern");
});

it("decodes every complete plane pair and every distinct partial pixel proof", () => {
  for (let low = 0; low < 256; low++)
    for (let high = 0; high < 256; high++) {
      const bytes = Array(8).fill(low).concat(Array(8).fill(high)),
        first = decodeNesChrTile(bytes)[0]!;
      for (let x = 0; x < 8; x++)
        if (first[x] !== ((low >> (7 - x)) & 1) + 2 * ((high >> (7 - x)) & 1))
          throw new Error(`Wrong planar pixel at ${low}/${high}/${x}`);
    }
  expect(
    decodeNesChrTile([
      null,
      ...Array(7).fill(0),
      128,
      ...Array(7).fill(null),
    ])[0],
  ).toEqual([
    { mask: 2, value: 2 },
    ...Array.from({ length: 7 }, () => ({ mask: 2, value: 0 })),
  ]);
});
