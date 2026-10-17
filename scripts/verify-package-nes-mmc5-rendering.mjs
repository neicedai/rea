import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed oracle with different capacity, tile positions, scroll, bank bytes and source data. */
export async function verifyPackageMmc5Rendering(invoke, workspace) {
  const chrOffset = 16 + 65536,
    bytes = Buffer.alloc(chrOffset + 524288);
  bytes.set([78, 69, 83, 26, 4, 64, 80, 8]);
  for (let offset = 0; offset < 524288; offset++)
    bytes[chrOffset + offset] =
      ((offset >> 10) * 11 + (offset & 1023) * 5 + 7) & 255;
  const path = join(workspace, "packaged-mmc5-rendering.nes");
  await writeFile(path, bytes);
  const initial = {
    mapper: 5,
    ppu_mask: 8,
    ppu_control: 32,
    exram_mode: 1,
    exram_written: true,
    nametable_control: 255,
    fill_tile: 7,
    fill_attribute: 0,
    chr_mode: 0,
    chr_upper: 3,
    split: [210, 38, 11],
    exram: { 147: 66, 972: 172 },
    ppu: { model: "mmc5-background", pin92_high: true, split_wiring: null },
  };
  const events = [
    { kind: "mmc5-render-frame" },
    { kind: "cpu-write", address: 0x5201, value: 9 },
    {
      kind: "ppu-read",
      address: 0x2c0b,
      mmc5_fetch: "background",
      mmc5_tile: { column: 19, line: "current" },
    },
    { kind: "ppu-read", address: 0x2fc2, mmc5_fetch: "background" },
    { kind: "ppu-read", address: 0x1422, mmc5_fetch: "background" },
    { kind: "cpu-write", address: 0x5202, value: 13 },
    { kind: "cpu-write", address: 0x5130, value: 0 },
    { kind: "ppu-read", address: 0x142a, mmc5_fetch: "background" },
  ];
  const evidence = await invoke("trace-nes-mapper-events", {
      path,
      initial,
      events,
    }),
    trace = evidence.normalized_result.trace;
  assert.equal(trace.status, "derived");
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(trace.steps[2].read_source.value, 66);
  assert.deepEqual(trace.steps[2].read_source.mmc5.rendering.split_tiles, [
    { address: 147, value: 66 },
  ]);
  assert.equal(trace.steps[3].read_source.value, 255);
  assert.deepEqual(trace.steps[3].read_source.mmc5.rendering.split_attributes, [
    { address: 972, value: 172, shift: 2 },
  ]);
  for (const [index, bank, plane] of [
    [4, 11, 0],
    [7, 13, 8],
  ]) {
    const source = trace.steps[index].read_source;
    const offsets = [2, 6].map(
      (row) => chrOffset + bank * 4096 + 0x420 + plane + row,
    );
    assert.equal(source.status, "unknown-chr-offset");
    assert.equal(source.bank, bank * 4 + 1);
    assert.equal(source.file_offset, null);
    assert.deepEqual(source.mmc5.rom_sources, {
      status: "examined",
      file_offsets: offsets,
    });
    assert.deepEqual(source.mmc5.rendering.pattern_rows, [2, 6]);
    for (const offset of offsets) {
      if (source.value !== null) assert.equal(source.value, bytes[offset]);
      else if (source.known_bits)
        assert.equal(
          bytes[offset] & source.known_bits.mask,
          source.known_bits.value,
        );
    }
  }
  assert.equal(trace.final.ppu.split_y, 38);
  const resumed = (
    await invoke("trace-nes-mapper-events", {
      path,
      initial: trace.steps[4].state,
      events: events.slice(5),
    })
  ).normalized_result.trace;
  assert.deepEqual(resumed.final, trace.final);
  assert.deepEqual(
    resumed.steps.map(({ index: _index, ...s }) => s),
    trace.steps.slice(5).map(({ index: _index, ...s }) => s),
  );
  const prefetch = (
    await invoke("trace-nes-mapper-events", {
      path,
      initial: trace.final,
      events: [
        { kind: "mmc5-render-frame" },
        {
          kind: "ppu-read",
          address: 0x2000,
          mmc5_fetch: "background",
          mmc5_tile: { column: 19, line: "next" },
        },
      ],
    })
  ).normalized_result.trace;
  assert.equal(prefetch.final.ppu.split_y, 9);
  assert.equal(prefetch.final.ppu.tile_y, 10);
  assert.equal(prefetch.final.ppu.split_tiles[0].address, 51);
  await verifyExtended(invoke, { path, bytes, chrOffset });
  const unresolved = (
    await invoke("trace-nes-mapper-events", {
      path,
      initial: {
        ...initial,
        exram_mode: 0,
        ppu_control: 0,
        chr_mode: 3,
        chr_banks: [2, ...Array(11).fill(null)],
        chr_bank_modes: [3, ...Array(11).fill(null)],
        chr_bank_upper: [0, ...Array(11).fill(null)],
        ppu: {
          ...initial.ppu,
          phase: "unknown",
          tile_column: 0,
          paths: ["normal"],
        },
      },
      events: [{ kind: "ppu-read", address: 0, mmc5_fetch: "background" }],
    })
  ).normalized_result.trace.steps[0].read_source;
  assert.equal(unresolved.value, null);
  assert.equal(unresolved.file_offset, null);
  assert.deepEqual(unresolved.mmc5.rom_sources, {
    status: "unresolved",
    reason: "rendering-context",
    file_offsets: [chrOffset + 2048],
  });
  assert.deepEqual(unresolved.mmc5.rendering.paths, ["normal", "split"]);
  assert.deepEqual(await readFile(path), bytes);
  return {
    split_wiring_sources: true,
    held_scroll_and_prefetch: true,
    extended_latch_live_upper: true,
  };
}

async function verifyExtended(invoke, { path, bytes, chrOffset }) {
  const initial = {
    mapper: 5,
    ppu_mask: 16,
    exram_mode: 1,
    exram_written: true,
    nametable_control: 255,
    fill_tile: 41,
    split: [0, 0, 0],
    chr_upper: 0,
    exram: { 26: 65 },
    ppu: { model: "mmc5-background", pin92_high: true },
  };
  const trace = (
    await invoke("trace-nes-mapper-events", {
      path,
      initial,
      events: [
        { kind: "ppu-read", address: 0x281a, mmc5_fetch: "background" },
        { kind: "ppu-read", address: 0x2bc6, mmc5_fetch: "background" },
        { kind: "cpu-write", address: 0x5130, value: 1 },
        { kind: "ppu-read", address: 0x1293, mmc5_fetch: "background" },
        { kind: "cpu-write", address: 0x5c1a, value: 255 },
        { kind: "cpu-write", address: 0x5130, value: 2 },
        { kind: "ppu-read", address: 0x129b, mmc5_fetch: "background" },
      ],
    })
  ).normalized_result.trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.steps[0].read_source.value, 41);
  assert.deepEqual(trace.steps[0].read_source.mmc5.nametable_sources, ["fill"]);
  assert.equal(trace.steps[1].read_source.value, 85);
  assert.equal(trace.final.exram["26"], null);
  assert.deepEqual(trace.final.ppu.extended_attribute, {
    address: 26,
    value: 65,
  });
  for (const [index, bank, offset] of [
    [3, 65, 0x293],
    [6, 1, 0x29b],
  ]) {
    const expected = chrOffset + bank * 4096 + offset,
      source = trace.steps[index].read_source;
    assert.equal(source.file_offset, expected);
    assert.equal(source.value, bytes[expected]);
    assert.deepEqual(source.mmc5.rom_sources, {
      status: "examined",
      file_offsets: [expected],
    });
    assert.deepEqual(source.mmc5.registers, []);
  }
}
