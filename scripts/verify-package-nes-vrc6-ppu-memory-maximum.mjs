import assert from "node:assert/strict";
import {
  CHR,
  initial,
  graphicsPpu,
} from "./verify-package-nes-vrc6-ppu-memory-fixture.mjs";

/** Every physical ROM page and both CIRAM pages remain compatible. */
export function vrc6PpuMemoryMaximumInput(path, facet = "combined") {
  return {
    path,
    initial: { ...initial(24, null), chr_banks: Array(8).fill(null) },
    initial_ppu: graphicsPpu(),
    events: [],
    ...(facet === "pattern" || facet === "combined"
      ? { ppu_pattern_table: 0 }
      : {}),
    ...(facet === "sprites" || facet === "combined"
      ? { ppu_sprites: true }
      : {}),
    ...(facet === "combined" ? { ppu_nametable: 1 } : {}),
    ...(facet === "viewport" || facet === "combined"
      ? {
          ppu_viewport: {
            model: "frozen-viewport",
            origin_x: 256,
            origin_y: 0,
          },
        }
      : {}),
  };
}
/** Validate complete maximum candidate pools without dropping byte payloads. */
export function verifyVrc6PpuMemoryMaximumResult(
  result,
  bytes,
  facet = "combined",
) {
  const trace = result.trace;
  assert.equal(trace.status, "derived");
  const device = trace.ppu_trace;
  const verify = (pages, ciram) => {
    assert.equal(pages.length, ciram ? 258 : 256);
    if (ciram)
      assert.deepEqual(
        pages.filter((page) => typeof page === "number"),
        [0, 1024],
      );
    const rom = pages.filter((page) => typeof page === "object");
    assert.deepEqual(
      rom.map((page) => page.file_offset),
      Array.from({ length: 256 }, (_, index) => CHR + index * 1024),
    );
    for (const page of rom) {
      assert.equal(page.kind, "rom");
      assert.equal(
        page.bytes_hex,
        bytes
          .subarray(page.file_offset, page.file_offset + 1024)
          .toString("hex"),
      );
    }
  };
  if (facet === "pattern" || facet === "combined")
    verify(device.pattern_table.source_pages, false);
  if (facet === "sprites" || facet === "combined")
    verify(device.sprites.source_pages, false);
  if (facet === "combined") verify(device.nametable.source_pages, true);
  if (facet === "viewport" || facet === "combined") {
    verify(device.viewport.chr_source_pages, false);
    assert.equal(device.viewport.nametables.length, 4);
    for (const table of device.viewport.nametables)
      verify(table.source_pages, true);
    assert.equal(device.viewport.modes[0].coverage.examined_pixels, 61440);
  }
}
