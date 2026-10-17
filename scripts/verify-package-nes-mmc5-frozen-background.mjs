import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  nromFixture,
  initial,
  ppu,
  geometry,
  nametableInput,
} from "./verify-package-nes-mmc5-frozen-background-fixture.mjs";
import { verifyFrozenMmc5Nametables } from "./verify-package-nes-mmc5-frozen-background-nametable.mjs";
import { verifyFrozenMmc5Viewports } from "./verify-package-nes-mmc5-frozen-background-viewport.mjs";
import { verifyFrozenMmc5Continuation } from "./verify-package-nes-mmc5-frozen-background-continuation.mjs";
export { fixture as mmc5FrozenBackgroundFixture } from "./verify-package-nes-mmc5-frozen-background-fixture.mjs";
export {
  mmc5FrozenBackgroundMaximumInput,
  verifyMmc5FrozenBackgroundMaximumResult,
} from "./verify-package-nes-mmc5-frozen-background-maximum.mjs";

export const projection = (facet) => {
  const result = facet.mmc5_background;
  assert.equal(result?.interpretation, "mmc5-frozen-background");
  assert.equal(result.width, 256);
  assert.equal(result.height, 240);
  assert.equal(result.rows.length, 240);
  return result;
};
export const projectedPalette = (result, x, y) => {
  const position = x + result.first_tile_fine_x,
    row = result.row_states[result.rows[y][Math.floor(position / 8)]];
  assert.ok(row, `Missing projected row at ${x},${y}`);
  return row.palette_index_masks[position & 7];
};
export const projectedBranches = (result, x, y) => {
  const position = x + result.first_tile_fine_x,
    state = result.row_states[result.rows[y][Math.floor(position / 8)]];
  return state.branches.map((index) => ({
    branch: result.branches[index],
    pair: result.source_pairs[result.branches[index].source_pair],
    pattern: result.pattern_sets[result.branches[index].pattern_set],
  }));
};
export const romPages = (facet, bytes) => {
  const offsets = [];
  for (const reference of facet.mmc5_background.chr_pages) {
    const page = facet.chr_source_pages[reference];
    assert.ok(page, "Projection CHR reference is outside the facet pool");
    assert.equal(page.kind, "rom");
    assert.equal(
      page.bytes_hex,
      bytes.subarray(page.file_offset, page.file_offset + 1024).toString("hex"),
    );
    offsets.push(page.file_offset);
  }
  assert.equal(new Set(offsets).size, offsets.length);
};
export const viewportCode = (viewport, x, y) => {
  assert.equal(viewport.modes.length, 1);
  const mode = viewport.modes[0];
  return mode.pixel_states[mode.rows[y][x]].code_mask;
};
export const codeMask = (...codes) =>
  codes
    .reduce((mask, code) => mask | (1n << BigInt(code)), 0n)
    .toString(16)
    .padStart(16, "0");
export const frozenEqual = (actual, baseline) => {
  assert.deepEqual(actual.final, baseline.final);
  assert.deepEqual(actual.ppu_trace.final, baseline.ppu_trace.final);
  assert.deepEqual(actual.ppu_trace.operations, baseline.ppu_trace.operations);
  assert.deepEqual(actual.steps, baseline.steps);
};

/** Original-byte oracle; every invocation is a real caller-selected public workflow. */
export async function verifyPackageNesMmc5FrozenBackground(invoke, workspace) {
  const path = join(workspace, "mmc5-frozen-background.nes"),
    wrongPath = join(workspace, "mmc5-frozen-wrong-mapper.nes"),
    bytes = fixture(),
    wrongBytes = nromFixture(),
    hashes = new Map();
  for (const [file, content] of [
    [path, bytes],
    [wrongPath, wrongBytes],
  ]) {
    await writeFile(file, content);
    hashes.set(file, createHash("sha256").update(content).digest("hex"));
  }
  let workflows = 0;
  const call = async (command, input) => {
    workflows++;
    const evidence = await invoke(command, input);
    assert.equal(evidence.subject.digest.sha256, hashes.get(input.path));
    return evidence.normalized_result;
  };
  const eventTrace = async (input) => {
    const result = (await call("trace-nes-mapper-events", input)).trace;
    assert.equal(result.status, "derived", result.reason);
    return result;
  };
  const context = {
    path,
    bytes,
    call,
    eventTrace,
    projection,
    projectedPalette,
    projectedBranches,
    romPages,
    viewportCode,
    codeMask,
    frozenEqual,
  };
  await verifyFrozenMmc5Nametables(context);
  await verifyFrozenMmc5Viewports(context);
  await verifyFrozenMmc5Continuation(context);
  for (const [input, reason] of [
    [
      {
        path,
        initial: initial(),
        initial_ppu: ppu(),
        events: [],
        ppu_mmc5_background: { nametable: geometry() },
      },
      /ppu_nametable/,
    ],
    [
      {
        path,
        initial: initial(),
        initial_ppu: ppu(),
        events: [],
        ppu_mmc5_background: { viewport: geometry() },
      },
      /ppu_viewport/,
    ],
    [{ ...nametableInput(wrongPath), initial: { mapper: 0 } }, /Mapper 5/],
  ]) {
    const result = (await call("trace-nes-mapper-events", input)).trace;
    assert.equal(result.status, "unsupported");
    assert.match(result.reason, reason);
  }
  const omitted = await eventTrace({
    ...nametableInput(path),
    ppu_mmc5_background: null,
  });
  assert.equal(omitted.ppu_trace.nametable.mmc5_background, undefined);
  assert.equal(omitted.ppu_trace.nametable.coverage.unknown_tile_indices, 960);
  assert.deepEqual(omitted.ppu_trace.nametable.source_pages, [
    { kind: "unknown", reason: "mmc5-rendering-context" },
  ]);
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readFile(wrongPath), wrongBytes);
  return {
    ok: true,
    workflows,
    per_cell: true,
    split_geometry: true,
    correlated_pixels: true,
    source_replay: true,
    frozen_state: true,
    original_unchanged: true,
    scope:
      "Authored conditional frozen MMC5 per-cell/row extended and CL/SL split projections with explicit query geometry; no physical fetch, clock, observed frame, silicon timing or gameplay claim",
  };
}
