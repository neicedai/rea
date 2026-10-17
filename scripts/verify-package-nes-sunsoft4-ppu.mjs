import assert from "node:assert/strict";
import {
  CHR,
  mapped,
  ppu,
  write,
} from "./verify-package-nes-sunsoft4-fixture.mjs";

const snapshot = (trace, index) => {
  const step = trace.steps[index];
  return "mapper_snapshot" in step
    ? { ...trace.mapper_snapshots[step.mapper_snapshot], ...step }
    : step;
};
export async function sunsoft4PpuWorkflows({ call, path, bytes }) {
  await nametableModes({ call, path });
  await mixedMux({ call, path });
  await missingCiram({ call, path });
  await cpuBuffer({ call, path });
  await viewport({ call, path, bytes });
}
async function nametableModes({ call, path }) {
  const events = [
    { kind: "ppu-write", address: 0x2000, value: 255 },
    ...[16, 17, 18, 19].flatMap((mode) => [
      write(0xefff, mode),
      ...[0x2000, 0x2400, 0x2800, 0x2c00].map((address) => ({
        kind: "ppu-read",
        address,
      })),
    ]),
  ];
  const rom = (
    await call("trace-nes-mapper-events", {
      path,
      initial: mapped,
      initial_ppu: { ...ppu, nametable: { 0: 0x37 } },
      events,
    })
  ).trace;
  assert.deepEqual(
    rom.steps
      .filter((item) => item.event.kind === "ppu-read")
      .map((item) => item.read_source.file_offset),
    [
      133, 134, 133, 134, 133, 133, 134, 134, 133, 133, 133, 133, 134, 134, 134,
      134,
    ].map((page) => CHR + page * 1024),
  );
  assert.equal(rom.ppu_trace.operations[0].write.status, "ignored");
  assert.equal(rom.ppu_trace.final.nametable[0], 0x37);
  const ciramEvents = [
    write(0xe000, 0),
    { kind: "ppu-write", address: 0x2000, value: 0x37 },
    { kind: "ppu-write", address: 0x2400, value: 0x69 },
    write(0xe000, 1),
    { kind: "ppu-read", address: 0x2400 },
    write(0xe000, 2),
    { kind: "ppu-read", address: 0x2c00 },
    write(0xe000, 3),
    { kind: "ppu-read", address: 0x2000 },
  ];
  const input = {
    path,
    initial: mapped,
    initial_ppu: ppu,
    events: ciramEvents,
  };
  const ciram = (await call("trace-nes-mapper-events", input)).trace;
  assert.deepEqual(
    ciram.steps
      .filter((item) => item.event.kind === "ppu-read")
      .map((item) => item.read_source.value),
    [0x37, 0x37, 0x69],
  );
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: snapshot(ciram, 4).state,
      initial_ppu: {
        ...ciram.ppu_trace.final,
        next_event_index: ciram.ppu_trace.initial.next_event_index + 5,
      },
      events: ciramEvents.slice(5),
    })
  ).trace;
  assert.deepEqual(continued.final_mapping, ciram.final_mapping);
  assert.deepEqual(
    continued.steps
      .filter((item) => item.event.kind === "ppu-read")
      .map((item) => item.read_source.value),
    [0x37, 0x69],
  );
}
async function mixedMux({ call, path }) {
  const origin = { kind: "initial-memory", space: "nametable", address: 0 };
  const input = {
    path,
    initial: {
      ...mapped,
      control: { mask: 3, value: 0 },
      nametable_banks: [{ mask: 127, value: 5 }, 0x86],
    },
    initial_ppu: { ...ppu, nametable: { 0: { value: 0x85, origin } } },
    events: [
      { kind: "ppu-read", address: 0x2000 },
      { kind: "ppu-write", address: 0x2000, value: 0xc5 },
      { kind: "ppu-read", address: 0x2000 },
    ],
  };
  const trace = (await call("trace-nes-mapper-events", input)).trace;
  assert.ok(
    trace.final_mapping.nametable_windows.every(
      (window) =>
        window.source === "unknown" &&
        window.bank === null &&
        window.file_offset === null,
    ),
  );
  const first = trace.steps[0].read_source;
  assert.equal(first.value, 0x85);
  assert.deepEqual(first.sources.map((source) => source.kind).sort(), [
    "memory",
    "rom",
  ]);
  assert.equal(
    first.sources.find((source) => source.kind === "rom").file_offset,
    CHR + 133 * 1024,
  );
  assert.equal(trace.ppu_trace.operations[1].write.status, "uncertain");
  assert.deepEqual(trace.ppu_trace.final.nametable[0], {
    value: { mask: 191, value: 133 },
    origin,
  });
  assert.deepEqual(trace.steps[2].read_source.known_bits, {
    mask: 191,
    value: 133,
  });
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: trace.final,
      initial_ppu: trace.ppu_trace.final,
      events: [
        write(0xe000, 0),
        { kind: "ppu-read", address: 0x2000 },
        write(0xe000, 16),
        { kind: "ppu-read", address: 0x2000 },
      ],
    })
  ).trace;
  assert.deepEqual(continued.steps[1].read_source.known_bits, {
    mask: 191,
    value: 133,
  });
  assert.equal(continued.steps[3].read_source.value, 133);
  assert.equal(continued.steps[3].read_source.file_offset, CHR + 133 * 1024);
}
async function cpuBuffer({ call, path }) {
  const input = {
    path,
    initial: mapped,
    entry: 0xc380,
    initial_ppu: {
      ...ppu,
      v: { low: 0, high: 32 },
      read_buffer: { value: 73 },
    },
  };
  const trace = (await call("trace-nes-code", input)).code_trace;
  assert.equal(trace.stop.reason, "return");
  assert.deepEqual(
    trace.instructions
      .filter((item) => item.mnemonic === "LDA")
      .map((item) => item.data_reads[0].value),
    [73, 133, 133],
  );
  assert.deepEqual(trace.mapper_trace.ppu_trace.final.v, { low: 3, high: 32 });
  assert.equal(trace.mapper_trace.ppu_trace.final.read_buffer.value, 133);
  assert.equal(
    trace.mapper_trace.ppu_trace.final.read_buffer.sources[0].file_offset,
    CHR + 133 * 1024 + 2,
  );
  const replay = (
    await call("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      initial_ppu: input.initial_ppu,
      events: trace.mapper_trace.steps.map((item) => item.event),
    })
  ).trace;
  assert.deepEqual(replay, trace.mapper_trace);
  const direct = (
    await call("trace-nes-code", {
      ...input,
      entry: 0xc3c0,
      initial_ppu: {
        ...ppu,
        v: { low: 0, high: 63 },
        palette: { 0: 15 },
        io_latch: { value: 0 },
        palette_read_mode: "direct",
      },
    })
  ).code_trace;
  assert.equal(direct.final_cpu.a, 15);
  const buffer = direct.mapper_trace.ppu_trace.final.read_buffer;
  assert.equal(buffer.value, 134);
  assert.equal(buffer.sources[0].file_offset, CHR + 134 * 1024 + 0x300);
}
async function missingCiram({ call, path }) {
  const input = {
    path,
    initial: { ...mapped, control: { mask: 3, value: 0 } },
    initial_ppu: {
      ...ppu,
      nametable_layout: null,
      v: { low: 0, high: 32 },
      read_buffer: { value: 73 },
    },
    events: [{ kind: "cpu-read", address: 0x2007 }],
  };
  const first = (await call("trace-nes-mapper-events", input)).trace;
  assert.equal(first.steps[0].cpu_read.value, 73);
  assert.equal(first.ppu_trace.final.read_buffer.value, null);
  assert.deepEqual(
    first.ppu_trace.final.read_buffer.sources
      .map((source) => source.kind)
      .sort(),
    ["rom", "unknown"],
  );
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: first.final,
      initial_ppu: first.ppu_trace.final,
    })
  ).trace;
  assert.equal(continued.steps[0].cpu_read.value, null);
  assert.equal(continued.ppu_trace.final.read_buffer.value, null);
  assert.deepEqual(
    continued.ppu_trace.final.read_buffer.sources
      .map((source) => source.kind)
      .sort(),
    ["rom", "unknown"],
  );
}
async function viewport({ call, path, bytes }) {
  const palette = {};
  for (let address = 0; address < 32; address++)
    if (![16, 20, 24, 28].includes(address))
      palette[address] = address === 0 ? 15 : (address * 3 + 1) & 63;
  const input = {
    path,
    initial: mapped,
    entry: 0xc3c0,
    ppu_nametable: 0,
    ppu_viewport: { model: "frozen-viewport", origin_x: 0, origin_y: 0 },
    initial_ppu: {
      ...ppu,
      mask: 10,
      v: { low: 0, high: 32 },
      read_buffer: { value: 73 },
      palette,
      oam: {
        model: "oam-memory",
        retention: "stable",
        address_writes: "uncorrupted",
        dma_pending: { status: "none" },
      },
    },
  };
  const code = (await call("trace-nes-code", input)).code_trace;
  assert.equal(code.final_cpu.a, 73);
  assert.deepEqual(code.mapper_trace.ppu_trace.final.v, { low: 1, high: 32 });
  const final = code.mapper_trace.ppu_trace;
  const table = final.nametable;
  assert.equal(table.coverage.unknown_tile_indices, 0);
  assert.ok(table.cells.every((cell) => cell.tile_index === 133));
  assert.ok(table.attributes.every((attribute) => attribute.value === 133));
  const screen = final.viewport;
  for (const [index, page] of screen.nametables.entries()) {
    const source = page.source_pages[0],
      bank = index % 2 === 0 ? 133 : 134;
    assert.equal(source.kind, "rom");
    assert.equal(source.file_offset, CHR + bank * 1024);
    assert.equal(
      source.bytes_hex,
      bytes
        .subarray(CHR + bank * 1024, CHR + (bank + 1) * 1024)
        .toString("hex"),
    );
  }
  const mode = screen.modes[0];
  assert.equal(mode.sprite_height, 8);
  assert.equal(mode.coverage.examined_pixels, 61440);
  assert.equal(mode.coverage.unknown_code_pixels, 0);
  assert.equal(mode.coverage.ambiguous_code_pixels, 0);
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 256; x++) {
      const pixel = 34 & (128 >> (x & 7)) ? 3 : 0;
      const quadrant = ((y >> 4) & 1) * 2 + ((x >> 4) & 1);
      const address = pixel === 0 ? 0 : ((133 >> (quadrant * 2)) & 3) * 4 + 3;
      const code = palette[address],
        observed = mode.pixel_states[mode.rows[y][x]];
      assert.deepEqual(observed, {
        palette_mask: 1 << address,
        code_mask: (1n << BigInt(code)).toString(16).padStart(16, "0"),
        layers: pixel === 0 ? 1 : 2,
        front_sprites: "0000000000000000",
        visible_sprites: "0000000000000000",
      });
    }
  const replay = (
    await call("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      initial_ppu: input.initial_ppu,
      ppu_nametable: input.ppu_nametable,
      ppu_viewport: input.ppu_viewport,
      events: code.mapper_trace.steps.map((item) => item.event),
    })
  ).trace;
  assert.deepEqual(replay, code.mapper_trace);
}
