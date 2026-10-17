import assert from "node:assert/strict";
import {
  CHR,
  graphicsInitial,
  graphicsPpu,
} from "./verify-package-nes-mmc5-ppu-memory-fixture.mjs";
export function mmc5PpuMemoryMaximumInput(path, facet = "combined") {
  return {
    path,
    initial: {
      ...graphicsInitial(),
      chr_banks: Array(12).fill(null),
      chr_bank_upper: Array(12).fill(null),
      exram_mode: 1,
    },
    initial_ppu: graphicsPpu(),
    events: [],
    ...(["combined", "pattern"].includes(facet)
      ? { ppu_pattern_table: 0 }
      : {}),
    ...(facet === "combined"
      ? {
          ppu_nametable: 0,
          ppu_sprites: true,
          ppu_viewport: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
        }
      : {}),
  };
}
export function verifyMmc5PpuMemoryMaximumResult(
  result,
  bytes,
  facet = "combined",
) {
  const trace = result.trace;
  assert.equal(trace.status, "derived", trace.reason);
  const pattern = trace.ppu_trace.pattern_table;
  assert.equal(pattern.source_pages.length, 1025);
  for (const block of pattern.blocks) {
    assert.equal(block.sources.length, 1025);
    assert.equal(Math.max(...block.sources), 1024);
  }
  for (let bank = 0; bank < 1024; bank++) {
    const source = pattern.source_pages[bank];
    assert.equal(source.kind, "rom");
    assert.equal(source.file_offset, CHR + bank * 1024);
    assert.equal(
      source.bytes_hex,
      Buffer.from(bytes)
        .subarray(CHR + bank * 1024, CHR + (bank + 1) * 1024)
        .toString("hex"),
    );
  }
  assert.deepEqual(pattern.source_pages[1024], {
    kind: "unknown",
    reason: "mmc5-rendering-context",
  });
  assert.equal(pattern.coverage.unknown_pixels, 16384);
  if (facet === "combined") {
    assert.equal(trace.ppu_trace.sprites.source_pages.length, 1024);
    assert.equal(trace.ppu_trace.viewport.chr_source_pages.length, 1025);
    for (const block of trace.ppu_trace.viewport.chr_blocks) {
      assert.ok(["background", "sprite"].includes(block.query_role));
      const sources = block.sources.map(
        (index) => trace.ppu_trace.viewport.chr_source_pages[index],
      );
      if (block.query_role === "background") {
        // pin92 is deliberately unqualified: both ordinary ROM and the
        // extended-rendering unknown branch belong to this maximum payload.
        assert.equal(sources.length, 1025);
        assert.deepEqual(
          sources.filter((source) => source.kind === "unknown"),
          [{ kind: "unknown", reason: "mmc5-rendering-context" }],
        );
      } else assert.equal(sources.length, 1024);
      assert.deepEqual(
        sources
          .filter((source) => source.kind === "rom")
          .map((source) => source.file_offset)
          .sort((a, b) => a - b),
        Array.from({ length: 1024 }, (_, bank) => CHR + bank * 1024),
      );
    }
  }
}
