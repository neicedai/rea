import assert from "node:assert/strict";
import {
  CHR,
  initial,
  graphicsPpu,
} from "./verify-package-nes-namco163-ppu-memory-fixture.mjs";

/** Pattern disable uncertainty admits all ROM pages; NT always substitutes E0..FF. */
export function namco163PpuMemoryMaximumInput(path, facet = "combined") {
  return {
    path,
    initial: {
      ...initial({ mask: 63, value: 1 }),
      chr_banks: Array(8).fill(null),
      nametable_banks: Array(4).fill(null),
    },
    initial_ppu: graphicsPpu(),
    events: [],
    ...(facet === "pattern" || facet === "combined"
      ? { ppu_pattern_table: 0 }
      : {}),
    ...(facet === "sprites" || facet === "combined"
      ? { ppu_sprites: true }
      : {}),
    ...(facet === "nametable" || facet === "combined"
      ? { ppu_nametable: 1 }
      : {}),
    ...(facet === "viewport" || facet === "combined"
      ? { ppu_viewport: { model: "frozen-viewport", origin_x: 0, origin_y: 0 } }
      : {}),
  };
}
export function verifyNamco163PpuMemoryMaximumResult(
  result,
  bytes,
  facet = "combined",
) {
  assert.equal(result.trace.status, "derived");
  const device = result.trace.ppu_trace;
  const verify = (pages, pattern) => {
    assert.equal(pages.length, pattern ? 258 : 226);
    const rom = pages.filter(
      (page) => typeof page === "object" && page.kind === "rom",
    );
    assert.deepEqual(
      rom.map((page) => page.file_offset).sort((a, b) => a - b),
      Array.from(
        { length: pattern ? 256 : 224 },
        (_, page) => CHR + page * 1024,
      ),
    );
    assert.deepEqual(
      pattern
        ? pages
            .filter((page) => page.kind === "ciram")
            .map((page) => page.address)
            .sort((a, b) => a - b)
        : pages
            .filter((page) => typeof page === "number")
            .sort((a, b) => a - b),
      [0, 1024],
    );
    for (const page of rom)
      assert.equal(
        page.bytes_hex,
        bytes
          .subarray(page.file_offset, page.file_offset + 1024)
          .toString("hex"),
      );
  };
  if (facet === "pattern" || facet === "combined")
    verify(device.pattern_table.source_pages, true);
  if (facet === "sprites" || facet === "combined")
    verify(device.sprites.source_pages, true);
  if (facet === "nametable" || facet === "combined")
    verify(device.nametable.source_pages, false);
  if (facet === "viewport" || facet === "combined") {
    verify(device.viewport.chr_source_pages, true);
    assert.equal(device.viewport.nametables.length, 4);
    for (const table of device.viewport.nametables)
      verify(table.source_pages, false);
    assert.equal(device.viewport.modes[0].coverage.examined_pixels, 61440);
  }
}
