import assert from "node:assert/strict";
import {
  initial,
  geometry,
  viewportInput,
} from "./verify-package-nes-mmc5-frozen-background-fixture.mjs";

export async function verifyFrozenMmc5Viewports(context) {
  const { bytes, eventTrace, projection, romPages } = context;
  const inspect = async (input) => {
    const trace = await eventTrace(input),
      viewport = trace.ppu_trace.viewport;
    const projected = projection(viewport);
    romPages(viewport, bytes);
    return { trace, viewport, projected };
  };
  const selected = { ...context, inspect };
  await wiring(selected);
  await mixedGeometry(selected);
  await banksAndRows(selected);
}

async function wiring({
  path,
  inspect,
  projectedPalette,
  projectedBranches,
  viewportCode,
  codeMask,
}) {
  for (const [wiring, expected] of [
    ["cl", [9]],
    ["sl", [10]],
    [null, [9, 10]],
  ]) {
    const state = initial();
    state.split[0] = 0x85;
    state.ppu.split_wiring = wiring;
    const { viewport, projected } = await inspect(
      viewportInput(path, { initial: state }),
    );
    assert.equal(projected.first_tile_fine_x, 0);
    assert.deepEqual(projected.qualification, geometry(4));
    assert.equal(
      projectedPalette(projected, 0, 0),
      expected.reduce((mask, value) => mask | (1 << value), 0),
    );
    assert.equal(viewportCode(viewport, 0, 0), codeMask(...expected));
    const [{ branch, pair, pattern }] = projectedBranches(projected, 0, 0);
    assert.equal(branch.path, "split");
    assert.equal(branch.split_coarse_y, 29);
    assert.deepEqual(
      branch.pattern_rows,
      wiring === "cl" ? [1] : wiring === "sl" ? [3] : [1, 3],
    );
    assert.deepEqual(pattern, { kind: "4k", banks: [7] });
    assert.deepEqual(pair.tile_source, { kind: "mmc5-exram" });
    assert.equal(pair.tile_address, 932);
    assert.equal(pair.tile, 0x21);
    assert.deepEqual(pair.attribute, {
      source: { kind: "mmc5-exram" },
      address: 1017,
      value: 2,
      origin: { kind: "initial-exram", address: 1017 },
      shift: 0,
    });
  }
}

async function mixedGeometry({
  path,
  inspect,
  projectedPalette,
  projectedBranches,
  viewportCode,
  codeMask,
}) {
  const mixed = initial();
  mixed.split[0] = { mask: 127, value: 5 };
  const mixedResult = await inspect(viewportInput(path, { initial: mixed }));
  assert.equal(
    projectedPalette(mixedResult.projected, 0, 0),
    (1 << 5) | (1 << 10),
  );
  assert.equal(viewportCode(mixedResult.viewport, 0, 0), codeMask(5, 10));
  assert.deepEqual(
    projectedBranches(mixedResult.projected, 0, 0)
      .map(({ branch }) => branch.path)
      .sort(),
    ["extended", "split"],
  );
  // A logical atlas column of four is explicitly qualified as screen column three.
  // Fine X=3 makes the next screen tile begin at visible x=5, then modulo-32 wraps.
  const right = initial();
  right.split[0] = 0xc4;
  const fine = await inspect(
    viewportInput(path, {
      initial: right,
      ppu_viewport: { model: "frozen-viewport", origin_x: 35, origin_y: 9 },
      ppu_mmc5_background: { viewport: geometry(3) },
    }),
  );
  assert.equal(fine.projected.first_tile_fine_x, 3);
  assert.ok(fine.projected.rows.every((row) => row.length === 33));
  for (const [x, code] of [
    [0, 5],
    [4, 5],
    [5, 10],
    [253, 5],
  ]) {
    assert.equal(projectedPalette(fine.projected, x, 0), 1 << code);
    assert.equal(viewportCode(fine.viewport, x, 0), codeMask(code));
  }
}

async function banksAndRows({
  path,
  inspect,
  projectedPalette,
  projectedBranches,
  viewportCode,
  codeMask,
}) {
  const banks = initial();
  banks.chr_upper = { mask: 2, value: 2 };
  const paired = await inspect(viewportInput(path, { initial: banks }));
  assert.equal(projectedPalette(paired.projected, 0, 0), (1 << 5) | (1 << 6));
  assert.equal(viewportCode(paired.viewport, 0, 0), codeMask(5, 6));
  assert.deepEqual(projectedBranches(paired.projected, 0, 0)[0].pattern, {
    kind: "4k",
    banks: [129, 193],
  });
  const partialState = initial();
  partialState.split[0] = 0x85;
  const uncertainY = await inspect(
    viewportInput(path, {
      initial: partialState,
      ppu_mmc5_background: { viewport: geometry(4, { mask: 254, value: 234 }) },
    }),
  );
  assert.deepEqual(uncertainY.projected.geometry_rows[0].split_y, [234, 235]);
  assert.deepEqual(uncertainY.projected.geometry_rows[1].split_y, [235, 236]);
  assert.equal(
    projectedPalette(uncertainY.projected, 0, 0),
    (1 << 9) | (1 << 10),
  );
  assert.equal(
    projectedPalette(uncertainY.projected, 0, 1),
    (1 << 10) | (1 << 11),
  );
  for (const seed of [239, 240, 255]) {
    const state = initial();
    state.split[0] = 0x85;
    const { projected } = await inspect(
      viewportInput(path, {
        initial: state,
        ppu_mmc5_background: { viewport: geometry(4, seed) },
      }),
    );
    assert.deepEqual(projected.qualification, geometry(4, seed));
    let expected = seed;
    for (let y = 0; y < 240; y++) {
      assert.deepEqual(projected.geometry_rows[y], {
        query_y: y,
        ordinary_row: (9 + y) & 7,
        split_y: [expected],
      });
      if ([0, 1, 16].includes(y)) {
        const [{ branch, pair }] = projectedBranches(projected, 0, y);
        assert.equal(branch.split_coarse_y, expected >> 3);
        assert.deepEqual(branch.pattern_rows, [expected & 7]);
        assert.equal(pair.tile_address, (expected & 248) * 4 + 4);
      }
      expected = expected === 239 || expected === 255 ? 0 : expected + 1;
    }
  }
}
