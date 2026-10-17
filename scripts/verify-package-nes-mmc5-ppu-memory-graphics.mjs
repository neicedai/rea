import assert from "node:assert/strict";
import {
  CHR,
  graphicsInitial,
  graphicsPpu,
  initial,
  ppu,
} from "./verify-package-nes-mmc5-ppu-memory-fixture.mjs";
const unknown = { kind: "unknown", reason: "mmc5-rendering-context" };
const pages = (facet, block) =>
  block.sources.map((index) => facet.source_pages[index]);
const viewportPages = (viewport, role) => {
  const block = viewport.chr_blocks.find(
    (item) => item.ppu_address === 0 && item.query_role === role,
  );
  assert.ok(block, `Missing ${role} block at 0000`);
  return block.sources.map((index) => viewport.chr_source_pages[index]);
};
const pixel = (viewport, x, y) => {
  const mode = viewport.modes.find(
    (candidate) => candidate.sprite_height === 16,
  );
  assert.ok(mode);
  return mode.pixel_states[mode.rows[y][x]];
};
function verifyRomPages(sources, bytes) {
  for (const source of sources)
    if (source.kind === "rom")
      assert.equal(
        source.bytes_hex,
        bytes
          .subarray(source.file_offset, source.file_offset + 1024)
          .toString("hex"),
      );
}

/** Final graphics use qualified roles without executing the historical tile pipeline. */
async function normalGraphics({ eventTrace, bytes }) {
  const normal = await eventTrace({
    initial: graphicsInitial(),
    initial_ppu: graphicsPpu(),
    events: [],
    ppu_pattern_table: 0,
    ppu_nametable: 0,
    ppu_sprites: true,
    ppu_viewport: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
  });
  const graphics = normal.ppu_trace;
  assert.deepEqual(
    graphics.pattern_table.tiles[0].rows[0],
    Array.from({ length: 8 }, () => ({ choices: [1, 2] })),
  );
  assert.deepEqual(
    pages(graphics.pattern_table, graphics.pattern_table.blocks[0]).map(
      (source) => source.file_offset,
    ),
    [CHR + 1024, CHR + 5 * 1024],
  );
  assert.deepEqual(graphics.nametable.source_pages, [{ kind: "mmc5-exram" }]);
  assert.equal(graphics.nametable.cells[0].tile_index, 0);
  assert.equal(graphics.nametable.attributes[0].value, 0);
  assert.deepEqual(
    graphics.sprites.sprites[0].modes[0].rows[0],
    Array(8).fill(1),
  );
  assert.deepEqual(
    viewportPages(graphics.viewport, "background").map(
      (source) => source.file_offset,
    ),
    [CHR + 5 * 1024],
  );
  assert.deepEqual(
    viewportPages(graphics.viewport, "sprite").map(
      (source) => source.file_offset,
    ),
    [CHR + 1024],
  );
  assert.equal(pixel(graphics.viewport, 0, 0).code_mask, "0000000000000004");
  assert.equal(pixel(graphics.viewport, 16, 10).code_mask, "0000000000020000");
  assert.deepEqual(graphics.operations, []);
  assert.deepEqual(graphics.final.nametable, {});
  verifyRomPages(graphics.pattern_table.source_pages, bytes);
  verifyRomPages(graphics.sprites.source_pages, bytes);
  verifyRomPages(graphics.viewport.chr_source_pages, bytes);
}

async function generatedPages({ eventTrace }) {
  for (const source of ["fill", "zero"]) {
    const fill = source === "fill";
    const result = await eventTrace({
      initial: {
        ...initial(),
        nametable_control: fill ? 255 : 170,
        exram_mode: fill ? 0 : 2,
      },
      initial_ppu: ppu,
      ppu_nametable: 0,
      events: [],
    });
    assert.deepEqual(result.ppu_trace.nametable.source_pages, [
      fill
        ? { kind: "mmc5-fill", tile: 0x15, attribute: 0xfd }
        : { kind: "mmc5-zero" },
    ]);
    assert.equal(
      result.ppu_trace.nametable.cells[0].tile_index,
      fill ? 0x15 : 0,
    );
    assert.equal(
      result.ppu_trace.nametable.attributes[0].value,
      fill ? 0x55 : 0,
    );
    assert.deepEqual(result.ppu_trace.final.nametable, {});
    assert.equal(result.final.exram[0], 0xc0);
  }
}

async function unresolvedRendering({ eventTrace }) {
  const history = {
    model: "mmc5-background",
    pin92_high: true,
    split_wiring: "cl",
    phase: "pattern-low",
    paths: ["extended"],
    nametable_address: 0x2000,
    tile_column: 4,
    tile_y: 1,
    tile_value: 0,
    extended_attribute: { address: 0, value: 0 },
  };
  const extended = await eventTrace({
    initial: { ...graphicsInitial(), exram_mode: 1, ppu: history },
    initial_ppu: graphicsPpu(),
    events: [],
    ppu_pattern_table: 0,
    ppu_nametable: 0,
    ppu_sprites: true,
    ppu_viewport: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
  });
  assert.ok(
    extended.ppu_trace.pattern_table.source_pages.some(
      (source) => source.kind === "unknown" && source.reason === unknown.reason,
    ),
  );
  assert.equal(extended.ppu_trace.pattern_table.coverage.unknown_pixels, 16384);
  assert.deepEqual(viewportPages(extended.ppu_trace.viewport, "background"), [
    unknown,
  ]);
  assert.deepEqual(
    viewportPages(extended.ppu_trace.viewport, "sprite").map(
      (source) => source.file_offset,
    ),
    [CHR + 1024],
  );
  assert.deepEqual(
    extended.ppu_trace.sprites.sprites[0].modes[0].rows[0],
    Array(8).fill(1),
  );
  assert.ok(
    extended.ppu_trace.nametable.source_pages.some(
      (source) => source.kind === "unknown" && source.reason === unknown.reason,
    ),
  );
  assert.equal(extended.final.ppu.phase, "pattern-low");
  assert.equal(extended.final.ppu.tile_column, 4);
  assert.equal(extended.final.ppu.extended_attribute.value, 0);
}

export async function verifyMmc5MemoryGraphics(context) {
  await normalGraphics(context);
  await generatedPages(context);
  await unresolvedRendering(context);
}
