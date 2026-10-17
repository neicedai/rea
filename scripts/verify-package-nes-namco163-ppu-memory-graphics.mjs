import assert from "node:assert/strict";
import {
  CHR,
  initial,
  graphicsPpu,
} from "./verify-package-nes-namco163-ppu-memory-fixture.mjs";

/** CIRAM0 holds tile indices/attributes; CIRAM1 supplies background and sprite bits. */
export async function namco163PpuGraphicsWorkflows({
  call,
  path,
  bytes,
  verifyBytes,
  verifyPages,
}) {
  const input = {
    path,
    initial: initial(),
    entry: 0xe240,
    initial_ppu: graphicsPpu(),
    ppu_pattern_table: 0,
    ppu_nametable: 0,
    ppu_sprites: true,
    ppu_viewport: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
  };
  const trace = (await call("trace-nes-code", input)).code_trace;
  verifyBytes(trace, bytes);
  assert.equal(trace.final_cpu.a, 73);
  const device = trace.mapper_trace.ppu_trace;
  assert.equal(device.final.read_buffer.value, 0xaa);
  assert.deepEqual(device.final.read_buffer.sources[0], {
    kind: "memory",
    space: "nametable",
    address: 1024,
    mask: 255,
    value: 0xaa,
    origin: { kind: "initial-memory", space: "nametable", address: 1024 },
  });
  assert.deepEqual(
    device.pattern_table.blocks[0].sources.map(
      (index) => device.pattern_table.source_pages[index],
    ),
    [{ kind: "ciram", address: 1024 }],
  );
  assert.deepEqual(
    device.pattern_table.tiles[1].rows[0],
    [3, 2, 1, 0, 3, 2, 1, 0],
  );
  assert.deepEqual(
    device.sprites.sprites[0].modes[0].rows[0],
    [1, 1, 1, 1, 2, 2, 2, 2],
  );
  assert.ok(device.nametable.cells.every((cell) => cell.tile_index === 1));
  assert.ok(
    device.nametable.attributes.every((attribute) => attribute.value === 0x55),
  );
  assert.deepEqual(device.nametable.source_pages, [0]);
  assert.deepEqual(
    device.viewport.nametables.slice(0, 2).map((table) => table.source_pages),
    [[0], [1024]],
  );
  assert.deepEqual(
    device.viewport.nametables
      .slice(2)
      .map((table) => table.source_pages[0].file_offset),
    [CHR + 47 * 1024, CHR + 51 * 1024],
  );
  for (const pages of [
    device.pattern_table.source_pages,
    device.sprites.source_pages,
    device.viewport.chr_source_pages,
    ...device.viewport.nametables.map((table) => table.source_pages),
  ])
    verifyPages(pages, bytes);
  verifyViewport(device.viewport, input.initial_ppu.palette);
  const replay = (
    await call("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      initial_ppu: input.initial_ppu,
      ppu_pattern_table: 0,
      ppu_nametable: 0,
      ppu_sprites: true,
      ppu_viewport: input.ppu_viewport,
      events: trace.mapper_trace.steps.map((step) => step.event),
    })
  ).trace;
  assert.deepEqual(replay, trace.mapper_trace);
}

function verifyViewport(screen, palette) {
  const mode = screen.modes[0];
  const addresses = screen.palette_cells.map((cell) => cell.address);
  assert.deepEqual(mode.coverage, {
    examined_pixels: 61440,
    ambiguous_palette_pixels: 0,
    ambiguous_code_pixels: 0,
    unknown_code_pixels: 0,
  });
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 256; x++) {
      const background = [3, 2, 1, 0, 3, 2, 1, 0][x & 7];
      const sprite = y >= 10 && y < 18 && x >= 16 && x < 24;
      const address = sprite
        ? x < 20
          ? 17
          : 18
        : background === 0
          ? 0
          : 4 + background;
      assert.deepEqual(mode.pixel_states[mode.rows[y][x]], {
        palette_mask: 1 << addresses.indexOf(address),
        code_mask: (1n << BigInt(palette[address]))
          .toString(16)
          .padStart(16, "0"),
        layers: sprite ? 4 : background ? 2 : 1,
        front_sprites: sprite ? "0000000000000001" : "0000000000000000",
        visible_sprites: sprite ? "0000000000000001" : "0000000000000000",
      });
    }
}
