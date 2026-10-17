import assert from "node:assert/strict";
import {
  CHR,
  initial,
  nametableInput,
  geometry,
} from "./verify-package-nes-mmc5-frozen-background-fixture.mjs";

export function mmc5FrozenBackgroundMaximumInput(path) {
  const state = initial();
  state.exram_mode = 0;
  state.split = [0xc0, 17, null];
  state.ppu.split_wiring = "sl";
  state.exram = Object.fromEntries(
    Array.from({ length: 1024 }, (_, address) => [address, address & 255]),
  );
  return nametableInput(path, {
    initial: state,
    ppu_mmc5_background: { nametable: geometry(0, null) },
  });
}

const attributeAddress = (address) =>
  960 + ((address >> 7) & 7) * 8 + ((address & 31) >> 2);
const attributeShift = (address) =>
  (((address >> 5) & 2) + ((address & 2) >> 1)) * 2;

function snapshots(table, projected, bytes) {
  assert.equal(table.chr_source_page_bytes, 1024);
  assert.equal(table.chr_source_pages.length, 1024);
  assert.deepEqual(
    projected.chr_pages,
    Array.from({ length: 1024 }, (_, n) => n),
  );
  for (const [bank, source] of table.chr_source_pages.entries()) {
    assert.equal(source.kind, "rom");
    assert.equal(source.file_offset, CHR + bank * 1024);
    assert.equal(
      source.bytes_hex,
      Buffer.from(
        bytes.subarray(CHR + bank * 1024, CHR + (bank + 1) * 1024),
      ).toString("hex"),
    );
  }
  assert.equal("chr_source_pages" in projected, false);
}

function sources(projected) {
  assert.equal(projected.source_pairs.length, 1024);
  const addresses = [];
  for (const pair of projected.source_pairs) {
    const address = pair.tile_address,
      attribute = attributeAddress(address);
    addresses.push(address);
    assert.deepEqual(pair.tile_source, { kind: "mmc5-exram" });
    assert.equal(pair.tile, address & 255);
    assert.deepEqual(pair.tile_origin, { kind: "initial-exram", address });
    assert.deepEqual(pair.attribute, {
      source: { kind: "mmc5-exram" },
      address: attribute,
      value: attribute & 255,
      origin: { kind: "initial-exram", address: attribute },
      shift: attributeShift(address),
    });
    assert.equal(
      pair.coupling,
      address === attribute ? "tile-split-attribute" : "independent",
    );
  }
  assert.deepEqual(
    addresses.sort((a, b) => a - b),
    Array.from({ length: 1024 }, (_, n) => n),
  );
  assert.deepEqual(projected.pattern_sets, [
    {
      kind: "4k",
      banks: Array.from({ length: 256 }, (_, n) => n),
    },
  ]);
  for (const branch of projected.branches) {
    assert.equal(branch.path, "split");
    assert.equal(branch.pattern_set, 0);
    assert.equal(branch.unresolved_reason, null);
  }
}

function geometryRows(projected) {
  let coordinates = Array.from({ length: 256 }, (_, n) => n);
  for (let y = 0; y < 240; y++) {
    assert.deepEqual(projected.geometry_rows[y], {
      query_y: y,
      ordinary_row: y & 7,
      split_y: coordinates,
    });
    coordinates = [
      ...new Set(
        coordinates.map((value) =>
          value === 239 || value === 255 ? 0 : value + 1,
        ),
      ),
    ].sort((a, b) => a - b);
    assert.equal(projected.rows[y].length, 32);
    for (const reference of projected.rows[y]) {
      const state = projected.row_states[reference];
      assert.ok(state);
      assert.equal(state.geometry, y);
      assert.ok(state.branches.length > 0 && state.branches.length <= 32);
    }
  }
  assert.equal(projected.geometry_rows[0].split_y.length, 256);
  assert.deepEqual(
    projected.geometry_rows[16].split_y,
    Array.from({ length: 240 }, (_, n) => n),
  );
}

function expectedPixels(bytes, column, coordinates) {
  const pixel = Array(8).fill(0),
    palette = Array(8).fill(0);
  for (const y of coordinates) {
    const tileAddress = (y >> 3) * 32 + column,
      tile = tileAddress & 255,
      attribute = attributeAddress(tileAddress) & 255,
      subpalette = (attribute >> attributeShift(tileAddress)) & 3;
    for (let bank = 0; bank < 256; bank++) {
      const address = CHR + bank * 4096 + tile * 16 + (y & 7),
        low = bytes[address],
        high = bytes[address + 8];
      for (let x = 0; x < 8; x++) {
        const value = ((low >> (7 - x)) & 1) | (((high >> (7 - x)) & 1) << 1);
        pixel[x] |= 1 << value;
        palette[x] |= 1 << (value === 0 ? 0 : subpalette * 4 + value);
      }
    }
  }
  return { pixel, palette };
}

function samples(projected, bytes) {
  for (const y of [0, 1, 7, 15, 16, 239])
    for (const column of [1, 2, 7, 31]) {
      const state = projected.row_states[projected.rows[y][column]],
        coordinates = projected.geometry_rows[y].split_y,
        expected = expectedPixels(bytes, column, coordinates),
        coarse = [...new Set(coordinates.map((n) => n >> 3))];
      assert.deepEqual(state.pixel_index_masks, expected.pixel);
      assert.deepEqual(state.palette_index_masks, expected.palette);
      const branches = state.branches.map((index) => projected.branches[index]);
      assert.deepEqual(
        branches.map((branch) => branch.split_coarse_y).sort((a, b) => a - b),
        coarse,
      );
      for (const branch of branches) {
        const address = branch.split_coarse_y * 32 + column,
          pair = projected.source_pairs[branch.source_pair];
        assert.equal(pair.tile_address, address);
        assert.deepEqual(
          branch.pattern_rows,
          coordinates
            .filter((n) => n >> 3 === branch.split_coarse_y)
            .map((n) => n & 7),
        );
      }
    }
}

/** Validate a complete always-split qualified facet against original authored bytes. */
export function verifyMmc5FrozenBackgroundMaximumResult(result, bytes) {
  const trace = result.trace;
  assert.equal(trace.status, "derived", trace.reason);
  const table = trace.ppu_trace.nametable,
    projected = table.mmc5_background;
  assert.equal(table.attributes_model, "effective-quadrant-envelope");
  assert.equal(projected.interpretation, "mmc5-frozen-background");
  assert.deepEqual(projected.qualification, geometry(0, null));
  assert.equal(projected.columns, 32);
  assert.equal(projected.first_tile_fine_x, 0);
  snapshots(table, projected, bytes);
  sources(projected);
  geometryRows(projected);
  samples(projected, bytes);
}
