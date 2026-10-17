import assert from "node:assert/strict";
import {
  initial,
  ppu,
  geometry,
  nametableInput,
} from "./verify-package-nes-mmc5-frozen-background-fixture.mjs";

export async function verifyFrozenMmc5Nametables(context) {
  await extended(context);
  await aliases(context);
  await columnWrap(context);
}

async function extended(context) {
  const {
    path,
    bytes,
    eventTrace,
    projection,
    projectedPalette,
    projectedBranches,
    romPages,
    frozenEqual,
  } = context;
  const input = nametableInput(path),
    baseline = await eventTrace({
      path,
      initial: input.initial,
      initial_ppu: input.initial_ppu,
      events: [],
    }),
    full = await eventTrace(input),
    table = full.ppu_trace.nametable,
    projected = projection(table);
  frozenEqual(full, baseline);
  assert.equal(table.attributes_model, "effective-quadrant-envelope");
  assert.deepEqual(projected.qualification, geometry());
  assert.equal(projected.first_tile_fine_x, 0);
  assert.deepEqual(table.attributes[1].quadrants[0].choices, [1, 2]);
  for (const [x, address, tile, byte, bank, palette, pixel] of [
    [32, 36, 7, 0x41, 129, 1, 1],
    [40, 37, 8, 0x82, 130, 2, 2],
  ]) {
    assert.equal(projectedPalette(projected, x, 8), 1 << (palette * 4 + pixel));
    const branches = projectedBranches(projected, x, 8);
    assert.equal(branches.length, 1);
    const { branch, pair, pattern } = branches[0];
    assert.equal(branch.path, "extended");
    assert.deepEqual(branch.palette_choices, [palette]);
    assert.deepEqual(branch.pattern_rows, [0]);
    assert.deepEqual(pattern, { kind: "4k", banks: [bank] });
    assert.equal(pair.tile_source, 0);
    assert.equal(pair.tile_address, address);
    assert.equal(pair.tile, tile);
    assert.deepEqual(pair.attribute, {
      source: { kind: "mmc5-exram" },
      address,
      value: byte,
      origin: { kind: "initial-exram", address },
      shift: 6,
    });
  }
  romPages(table, bytes);
  // PPUCTRL's pattern-table bit and ordinary CHR mode cannot replace a per-tile 4K bank.
  const other = await eventTrace(
    nametableInput(path, {
      initial: { ...initial(), chr_mode: 0 },
      initial_ppu: { ...ppu(), control: 16 },
    }),
  );
  assert.equal(
    projectedPalette(projection(other.ppu_trace.nametable), 32, 8),
    1 << 5,
  );
  assert.deepEqual(
    projectedBranches(projection(other.ppu_trace.nametable), 32, 8)[0].pattern,
    { kind: "4k", banks: [129] },
  );
}

async function aliases({
  path,
  eventTrace,
  projection,
  projectedPalette,
  projectedBranches,
}) {
  const alias = await eventTrace(
    nametableInput(path, {
      initial: { ...initial(), nametable_control: 170 },
    }),
  );
  const paired = projectedBranches(
    projection(alias.ppu_trace.nametable),
    40,
    8,
  )[0].pair;
  assert.equal(paired.coupling, "tile-extended-attribute");
  assert.deepEqual(paired.tile_source, { kind: "mmc5-exram" });
  assert.equal(paired.tile_address, 37);
  assert.equal(paired.tile, 0x82);
  assert.deepEqual(paired.tile_origin, { kind: "initial-exram", address: 37 });
  assert.equal(paired.attribute.address, 37);
  assert.equal(paired.attribute.value, 0x82);
  assert.deepEqual(paired.attribute.origin, paired.tile_origin);
  assert.equal(
    projectedPalette(projection(alias.ppu_trace.nametable), 40, 8),
    1 << 11,
  );

  const partial = initial();
  partial.nametable_control = 170;
  partial.exram[37] = { mask: 127, value: 2 };
  const coupled = projection(
    (
      await eventTrace(
        nametableInput(path, {
          initial: partial,
        }),
      )
    ).ppu_trace.nametable,
  );
  // One physical byte is either02(tile2/palette0) or82(tile130/palette2).
  // Mixing those components would invent palette addresses3 and9.
  assert.equal(projectedPalette(coupled, 40, 8), (1 << 1) | (1 << 11));
  assert.ok(
    projectedBranches(coupled, 40, 8).every(
      ({ pair }) => pair.coupling === "tile-extended-attribute",
    ),
  );
}

async function columnWrap({
  path,
  eventTrace,
  projection,
  projectedPalette,
  projectedBranches,
}) {
  const state = initial();
  state.split[0] = 0xdf;
  state.exram[959] = 0x21;
  state.exram[1023] = 8;
  const wrapped = projection(
    (
      await eventTrace(
        nametableInput(path, {
          initial: state,
          ppu_mmc5_background: { nametable: geometry(31) },
        }),
      )
    ).ppu_trace.nametable,
  );
  assert.equal(projectedPalette(wrapped, 0, 0), 1 << 10);
  assert.equal(projectedBranches(wrapped, 0, 0)[0].pair.tile_address, 959);
  assert.equal(projectedPalette(wrapped, 8, 0), 1 << 5);
}
