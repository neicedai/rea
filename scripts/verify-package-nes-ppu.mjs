import { verifyPackageNesOam } from "./verify-package-nes-oam.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent trainer-free installed oracle; does not import source fixtures or mapper helpers. */
export async function verifyPackageNesPpu(invoke, workspace) {
  const profile = {
    model: "ppu-memory",
    register_writes_enabled: true,
    access_phase: "non-rendering",
    dma_reads: "absent",
    palette_read_mode: "direct",
    nametable_layout: "ciram-2k",
    control: 4,
    mask: 0,
    write_toggle: 0,
  };
  const bytes = Buffer.alloc(16 + 32768, 0xea);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 0, 2, 8]);
  bytes[11] = 0x70; // One 8 KiB CHR NVRAM chip, no CHR RAM or ROM.
  const program = [
    169, 0x12, 141, 6, 32, 169, 0x34, 141, 6, 32, 169, 0x3e, 141, 7, 32, 169,
    0x91, 141, 15, 32, 169, 0x12, 141, 6, 32, 169, 0x34, 141, 6, 32, 173, 7, 32,
    173, 7, 32, 96,
  ];
  bytes.set(program, 272);
  bytes.writeUInt16LE(0x8100, 16 + 32768 - 4);
  const path = join(workspace, "packaged-ppu-nvram.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    initial: { mapper: 0 },
    ppu_pattern_table: 1,
    initial_ppu: {
      ...profile,
      chr_ram_size: 8192,
      next_event_index: 501,
      read_buffer: { value: 0x11 },
    },
  };
  const evidence = await invoke("trace-nes-code", input),
    code = evidence.normalized_result.code_trace;
  assert.equal(code.status, "derived");
  assert.equal(code.stop.reason, "return");
  assert.equal(code.final_cpu.a, 0x3e);
  const mapped = code.mapper_trace,
    ppu = mapped.ppu_trace;
  assert.equal(mapped.status, "derived");
  assert.equal(mapped.mapper_snapshots.length, 1);
  assert.ok(mapped.steps.every((step) => step.mapper_snapshot === 0));
  assert.deepEqual(ppu.final.chr_ram[4660], {
    value: 0x3e,
    origin: { kind: "event-write", index: 503 },
  });
  assert.deepEqual(ppu.final.chr_ram[4692], {
    value: 0x91,
    origin: { kind: "event-write", index: 504 },
  });
  assert.deepEqual(ppu.final.v, { low: 0x74, high: 0x12 });
  assert.equal(ppu.final.read_buffer.value, 0x91);
  assert.equal(ppu.final.next_event_index, 509);
  assert.deepEqual(ppu.frontier, []);
  assert.deepEqual(
    ppu.pattern_table.source_pages,
    [4096, 5120, 6144, 7168].map((address) => ({ kind: "chr-ram", address })),
  );
  assert.equal(ppu.pattern_table.tiles[35].byte_values[4], 0x3e);
  assert.deepEqual(
    ppu.pattern_table.tiles[35].rows[4],
    [0, 0, 1, 1, 1, 1, 1, 0].map((value) => ({ mask: 1, value })),
  );
  assert.equal(ppu.pattern_table.tiles[37].byte_values[4], 0x91);
  for (const instruction of code.instructions) {
    const encoded = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries()) {
      assert.ok(Number.isInteger(offset));
      assert.equal(bytes[offset], encoded[index]);
    }
    for (const read of instruction.data_reads)
      if (read.address === 0x2007) {
        assert.equal(read.file_offset, null);
        assert.equal(read.mapper_origins[0].kind, "ppu-register");
      }
  }
  const replay = await invoke("trace-nes-mapper-events", {
    ...input,
    events: mapped.steps.map((step) => step.event),
  });
  assert.deepEqual(replay.normalized_result.trace, mapped);
  const explored = await invoke("explore-nes-code", input);
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    code,
  );
  const continued = await invoke("trace-nes-mapper-events", {
    path,
    initial: mapped.final,
    initial_ppu: ppu.final,
    events: [{ kind: "cpu-read", address: 0x200f }],
  });
  assert.equal(continued.normalized_result.trace.steps[0].cpu_read.value, 0x91);
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await readFile(path), bytes);

  const chrOffset = 16 + 65536,
    rom = Buffer.alloc(chrOffset + 16384);
  rom.set([78, 69, 83, 26, 4, 2, 64, 8]);
  for (let offset = 0; offset < 16384; offset++)
    rom[chrOffset + offset] = ((offset >> 10) * 29 + (offset & 1023) * 3) & 255;
  for (let bank = 1; bank < 16; bank += 2)
    rom[chrOffset + bank * 1024 + 7] = 0xb6;
  const chrPath = join(workspace, "packaged-ppu-mmc3-chr.nes");
  await writeFile(chrPath, rom);
  for (const mask of [15, 1]) {
    const initial = {
      mapper: 4,
      bank_select: 128,
      banks: [6, 8, 4, { mask, value: mask === 15 ? 5 : 1 }, 2, 3, 0, 1],
    };
    const result = await invoke("trace-nes-mapper-events", {
      path: chrPath,
      initial,
      ppu_pattern_table: 1,
      initial_ppu: {
        ...profile,
        chr_ram_size: null,
        control: 0,
        v: { low: 7, high: 4 },
        read_buffer: { value: 0x19 },
      },
      events: [
        { kind: "cpu-read", address: 0x2007 },
        { kind: "cpu-read", address: 0x2007 },
        { kind: "cpu-write", address: 0x8000, value: 0 },
        { kind: "ppu-read", address: 0x0407 },
      ],
    });
    const trace = result.normalized_result.trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.steps[0].cpu_read.value, 0x19);
    assert.equal(trace.steps[1].cpu_read.value, 0xb6);
    assert.equal(trace.ppu_trace.coverage.bus_reads, 3);
    assert.equal(
      trace.ppu_trace.coverage.unknown_bus_sources,
      mask === 15 ? 0 : 2,
    );
    const sources = trace.ppu_trace.operations[0].bus_reads[0].sources;
    const banks = mask === 15 ? [5] : [1, 3, 5, 7, 9, 11, 13, 15];
    assert.deepEqual(
      sources.map((source) => source.file_offset),
      banks.map((bank) => chrOffset + bank * 1024 + 7),
    );
    for (const source of sources)
      assert.equal(source.value, rom[source.file_offset]);
    assert.equal(
      trace.steps[3].read_source.file_offset,
      chrOffset + 7 * 1024 + 7,
    );
    assert.equal(trace.mapper_snapshots.length, 2);
    assert.deepEqual(
      trace.steps.map((step) => step.mapper_snapshot),
      [0, 0, 1, 1],
    );
    const pattern = trace.ppu_trace.pattern_table;
    assert.equal(pattern.table, 1);
    assert.equal(pattern.blocks[1].sources.length, mask === 15 ? 1 : 8);
    assert.equal(pattern.tiles[64].byte_values[7], 0xb6);
    for (const page of pattern.source_pages)
      assert.equal(
        page.bytes_hex,
        rom.subarray(page.file_offset, page.file_offset + 1024).toString("hex"),
      );
    assert.equal(
      result.subject.digest.sha256,
      createHash("sha256").update(rom).digest("hex"),
    );
  }
  const palette = await invoke("trace-nes-mapper-events", {
    path: chrPath,
    initial: { mapper: 4 },
    initial_ppu: {
      ...profile,
      chr_ram_size: null,
      control: 0,
      mask: 1,
      next_event_index: 60,
      v: { low: 20, high: 63 },
      io_latch: { value: 0xc0 },
      palette: { 4: 0x2b },
      nametable: { 1812: 0x87 },
    },
    events: [
      { kind: "cpu-read", address: 0x2007 },
      { kind: "ppu-write", address: 0x3f14, value: 0x67 },
    ],
  });
  const final = palette.normalized_result.trace.ppu_trace.final;
  assert.equal(palette.normalized_result.trace.steps[0].cpu_read.value, 0xe0);
  assert.equal(final.read_buffer.value, 0x87);
  assert.equal(final.nametable[1812].value, 0x67);
  assert.equal(final.palette[4], 0x2b);
  assert.equal(final.next_event_index, 62);
  const unqualified = await invoke("trace-nes-mapper-events", {
    path: chrPath,
    initial: { mapper: 4 },
    initial_ppu: {
      ...profile,
      chr_ram_size: null,
      control: 0,
      mask: 1,
      palette_read_mode: null,
      v: { low: 20, high: 63 },
      io_latch: { value: 0xc0 },
      palette: { 4: 0x2b },
      read_buffer: { value: 0xe0 },
    },
    events: [{ kind: "cpu-read", address: 0x2007 }],
  });
  assert.equal(
    unqualified.normalized_result.trace.steps[0].cpu_read.value,
    null,
  );
  assert.deepEqual(
    unqualified.normalized_result.trace.steps[0].cpu_read.known_bits,
    { mask: 192, value: 192 },
  );
  const unknown = await invoke("trace-nes-mapper-events", {
    path: chrPath,
    initial: { mapper: 4 },
    initial_ppu: {
      ...profile,
      chr_ram_size: null,
      dma_reads: "unobserved",
      v: { low: 0, high: 0 },
      read_buffer: { value: 0xa5 },
    },
    events: [{ kind: "cpu-read", address: 0x2007 }],
  });
  assert.equal(unknown.normalized_result.trace.steps[0].cpu_read.value, null);
  assert.deepEqual(unknown.normalized_result.trace.ppu_trace.final.v, {
    low: null,
    high: null,
  });
  assert.deepEqual(await readFile(chrPath), rom);
  await verifyNametable(invoke, chrPath, profile, rom);
  await verifyPackageNesOam(invoke, workspace, profile);
  await verifyPixelChoices(invoke, workspace, profile);
  return {
    workflows: 11,
    conditional_ppu_memory: true,
    original_unchanged: true,
  };
}

async function verifyPixelChoices(invoke, workspace, profile) {
  const chrOffset = 16 + 32768,
    bytes = Buffer.alloc(chrOffset + 32768),
    path = join(workspace, "packaged-ppu-pixel-choices.nes");
  bytes.set([78, 69, 83, 26, 2, 4, 48, 8]);
  bytes.set([234, 96], 16 + 0x4100);
  bytes.writeUInt16LE(0xc100, 16 + 32768 - 4);
  for (let bank = 0; bank < 4; bank++) {
    const pixel = [1, 2, 3, 1][bank],
      start = chrOffset + bank * 8192 + 23 * 16;
    bytes.fill(pixel & 1 ? 255 : 0, start, start + 8);
    bytes.fill(pixel & 2 ? 255 : 0, start + 8, start + 16);
  }
  await writeFile(path, bytes);
  const input = {
    path,
    initial: { mapper: 3 },
    ppu_pattern_table: 0,
    ppu_sprites: true,
    initial_ppu: {
      ...profile,
      chr_ram_size: null,
      control: 0,
      mask: 16,
      oam: {
        model: "oam-memory",
        retention: "stable",
        dma_pending: { status: "none" },
        cells: { 0: 30, 1: 23, 2: 0, 3: 10 },
      },
    },
  };
  const evidence = await invoke("trace-nes-code", input),
    code = evidence.normalized_result.code_trace;
  assert.equal(code.status, "derived");
  assert.deepEqual(code.instructions[0].file_offsets, [16 + 0x4100]);
  assert.equal(code.instructions[0].bytes_hex, "ea");
  const mapped = code.mapper_trace,
    ppu = mapped.ppu_trace,
    tile = ppu.pattern_table.tiles[23];
  assert.equal(tile.byte_values[0], null);
  assert.equal(tile.byte_values[8], null);
  const rows = Array.from({ length: 8 }, () =>
    Array.from({ length: 8 }, () => ({ choices: [1, 2, 3] })),
  );
  assert.deepEqual(tile.rows, rows);
  assert.deepEqual(ppu.sprites.sprites[0].modes[0].rows, rows);
  assert.deepEqual(
    ppu.pattern_table.blocks[0].sources.map(
      (index) => ppu.pattern_table.source_pages[index].file_offset,
    ),
    [0, 1, 2, 3].map((bank) => chrOffset + bank * 8192),
  );
  for (const page of ppu.pattern_table.source_pages)
    assert.equal(
      page.bytes_hex,
      bytes.subarray(page.file_offset, page.file_offset + 1024).toString("hex"),
    );
  const replay = await invoke("trace-nes-mapper-events", {
    ...input,
    events: mapped.steps.map((step) => step.event),
  });
  assert.deepEqual(replay.normalized_result.trace, mapped);
  const explored = await invoke("explore-nes-code", input);
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    code,
  );
  const continued = await invoke("trace-nes-mapper-events", {
    ...input,
    initial: mapped.final,
    initial_ppu: ppu.final,
    events: [],
  });
  assert.deepEqual(
    continued.normalized_result.trace.ppu_trace.pattern_table,
    ppu.pattern_table,
  );
  assert.deepEqual(
    continued.normalized_result.trace.ppu_trace.sprites,
    ppu.sprites,
  );
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyNametable(invoke, path, profile, rom) {
  const input = {
    path,
    initial: { mapper: 4 },
    ppu_nametable: 1,
    initial_ppu: {
      ...profile,
      chr_ram_size: null,
      control: 16,
      mask: 1,
      next_event_index: 1200,
      nametable: { 0: 137, 1024: 201, 960: 0, 1984: 3 },
      palette: { 0: 31, 1: 46, 4: 63 },
    },
    events: [],
  };
  const before = await invoke("trace-nes-mapper-events", input),
    trace = before.normalized_result.trace;
  assert.equal(trace.status, "derived");
  const map = trace.ppu_trace.nametable;
  assert.deepEqual(map.source_pages, [0, 1024]);
  assert.deepEqual(map.cells[0].tile_index, { mask: 191, value: 137 });
  assert.deepEqual(map.attributes[0].quadrants[0], {
    value: null,
    choices: [0, 3],
  });
  assert.deepEqual(map.pattern_tables, [1]);
  assert.deepEqual(map.palette_cells[1], { address: 1, value: 46, code: 32 });
  assert.deepEqual(map.palette_cells[2].code, { mask: 15, value: 0 });
  assert.ok(map.palettes.every((palette) => palette.cells[0] === 0));
  assert.equal(trace.ppu_trace.final.next_event_index, 1200);
  assert.equal(trace.ppu_trace.coverage.bus_reads, 0);
  const updated = await invoke("trace-nes-mapper-events", {
    ...input,
    events: [
      { kind: "cpu-write", address: 0xa000, value: 0 },
      { kind: "ppu-write", address: 0x2400, value: 102 },
    ],
  });
  const next = updated.normalized_result.trace;
  assert.deepEqual(next.ppu_trace.nametable.source_pages, [1024]);
  assert.equal(next.ppu_trace.nametable.cells[0].tile_index, 102);
  assert.deepEqual(next.ppu_trace.final.nametable[1024], {
    value: 102,
    origin: { kind: "event-write", index: 1201 },
  });
  assert.equal(next.ppu_trace.final.next_event_index, 1202);
  assert.equal(next.ppu_trace.operations.length, 1);
  const continued = await invoke("trace-nes-mapper-events", {
    ...input,
    initial: next.final,
    initial_ppu: next.ppu_trace.final,
  });
  assert.deepEqual(
    continued.normalized_result.trace.ppu_trace.nametable,
    next.ppu_trace.nametable,
  );
  assert.equal(
    continued.normalized_result.trace.ppu_trace.final.next_event_index,
    1202,
  );
  assert.equal(
    updated.subject.digest.sha256,
    createHash("sha256").update(rom).digest("hex"),
  );
  assert.deepEqual(await readFile(path), rom);
}
