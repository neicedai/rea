import assert from "node:assert/strict";
import {
  CHR,
  initial,
  graphicsPpu,
} from "./verify-package-nes-vrc6-ppu-memory-fixture.mjs";

/** Concrete ROM NT page47, pattern page18, and one visible page5 sprite. */
export async function vrc6PpuGraphicsWorkflows({
  call,
  mapper,
  path,
  bytes,
  verifyPages,
  verifyBytes,
}) {
  const input = {
    path,
    initial: initial(mapper),
    entry: 0xe240,
    initial_ppu: graphicsPpu(),
    ppu_pattern_table: 0,
    ppu_nametable: 1,
    ppu_sprites: true,
    ppu_viewport: { model: "frozen-viewport", origin_x: 256, origin_y: 0 },
  };
  const trace = (await call("trace-nes-code", input)).code_trace;
  verifyBytes(trace, bytes);
  assert.equal(trace.final_cpu.a, 73);
  const device = trace.mapper_trace.ppu_trace;
  assert.equal(device.final.read_buffer.value, 0xa1);
  assert.equal(
    device.final.read_buffer.sources[0].file_offset,
    CHR + 47 * 1024,
  );
  assert.ok(device.nametable.cells.every((cell) => cell.tile_index === 0xa1));
  assert.ok(
    device.nametable.attributes.every((attribute) => attribute.value === 0xa1),
  );
  assert.deepEqual(
    device.sprites.sprites[0].modes[0].rows[0],
    [0, 0, 0, 0, 0, 3, 0, 3],
  );
  assert.equal(device.sprites.sprites[0].offscreen_y, false);
  assert.equal(device.sprites.sprites[1].offscreen_y, true);
  for (const pages of [
    device.pattern_table.source_pages,
    device.nametable.source_pages,
    device.sprites.source_pages,
    device.viewport.chr_source_pages,
  ])
    verifyPages(pages, bytes);
  for (const [page, bank] of [46, 47, 50, 51].entries()) {
    const source = device.viewport.nametables[page].source_pages[0];
    assert.equal(source.kind, "rom");
    assert.equal(source.file_offset, CHR + bank * 1024);
    verifyPages([source], bytes);
  }
  const screen = device.viewport,
    mode = screen.modes[0],
    palette = input.initial_ppu.palette;
  const addresses = screen.palette_cells.map((cell) => cell.address);
  assert.equal(mode.sprite_height, 8);
  assert.deepEqual(mode.coverage, {
    examined_pixels: 61440,
    ambiguous_palette_pixels: 0,
    ambiguous_code_pixels: 0,
    unknown_code_pixels: 0,
  });
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 256; x++) {
      const background = 0x12 & (128 >> (x & 7)) ? 3 : 0;
      const quadrant = ((y >> 4) & 1) * 2 + ((x >> 4) & 1);
      const sprite =
        y >= 10 && y < 18 && x >= 16 && x < 24 && (5 & (128 >> (x - 16))) !== 0;
      const address = sprite
        ? 19
        : background === 0
          ? 0
          : ((0xa1 >> (quadrant * 2)) & 3) * 4 + 3;
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
  const replay = (
    await call("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      initial_ppu: input.initial_ppu,
      ppu_pattern_table: input.ppu_pattern_table,
      ppu_nametable: input.ppu_nametable,
      ppu_sprites: input.ppu_sprites,
      ppu_viewport: input.ppu_viewport,
      events: trace.mapper_trace.steps.map((step) => step.event),
    })
  ).trace;
  assert.deepEqual(replay, trace.mapper_trace);
}
