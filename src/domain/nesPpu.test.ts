import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import {
  nesPpuFixture,
  nesPpuFixtureState,
  nesPpuUploadFixture,
} from "./nesPpu.fixture.js";
import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsTraceSchema,
  nesMapperEventSnapshot,
} from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { exploreNesCode } from "./nesCodeExplorationDerivation.js";
import { exploreNesCodeInputSchema } from "./nesCodeExploration.js";

const events = async (
  operations: unknown[],
  extra: Record<string, unknown> = {},
  fixture = nesPpuFixture(),
  initial: unknown = { mapper: 0 },
) => {
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/ppu.nes",
    initial,
    initial_ppu: nesPpuFixtureState(extra),
    events: operations,
  });
  const result = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header.value, input.initial, input.events, {
      initialPpu: input.initial_ppu,
      chr: fixture.bytes.subarray(fixture.chrOffset),
    }),
  );
  if (result.status !== "derived" || !("ppu_trace" in result))
    throw new Error(JSON.stringify(result));
  return result;
};
const write = (address: number, value: number | null) => ({
  kind: "cpu-write",
  address,
  value,
});
const read = (address: number | null) => ({ kind: "cpu-read", address });

it("shares scroll/address toggle, uses mirrored registers and increments 1/32", async () => {
  const result = await events(
    [
      write(0x200d, 0xad),
      write(0x2005, 0x53),
      read(0x3ffa),
      write(0x200e, 0x7f),
      write(0x2006, 0xff),
      write(0x2000, 4),
      write(0x200f, 0x2f),
    ],
    { status: 0xe0, io_latch: { value: 0x1b } },
  );
  const ppu = result.ppu_trace;
  expect(ppu.operations[1]).toMatchObject({
    kind: "cpu-port",
    after: {
      fine_x: 5,
      t: { low: 85, high: { mask: 115, value: 49 } },
      write_toggle: 0,
    },
  });
  expect(result.steps[2]).toMatchObject({ cpu_read: { value: 0xf3 } });
  expect(ppu.final).toMatchObject({
    v: { low: 31, high: 64 },
    t: { low: 255, high: 51 },
    write_toggle: 0,
  });
  expect(ppu.final.palette["31"]).toMatchObject({
    value: 47,
    origin: { kind: "event-write", index: 6 },
  });
  expect(ppu.operations[6]!.ppu_address).toBe(0x3fff);
});

it("distinguishes delayed buffer, direct palette, grayscale and external underlay", async () => {
  const result = await events(
    [
      read(0x2007),
      read(0x2002),
      read(0x2000),
      { kind: "ppu-write", address: 0x3f00, value: 0xab },
    ],
    {
      v: { low: 16, high: 63 },
      status: 0xe0,
      mask: 1,
      io_latch: { value: 0xc0 },
      read_buffer: { value: 0x11 },
      palette: { "0": 0x21 },
      nametable: { "1808": 0x77 },
    },
  );
  expect(
    result.steps
      .slice(0, 3)
      .map((s) => ("cpu_read" in s ? s.cpu_read.value : null)),
  ).toEqual([0xe0, 0xe0, 0xe0]);
  expect(result.ppu_trace.final).toMatchObject({
    status: 0x60,
    read_buffer: { value: 0x77 },
    palette: { "0": 0x21 },
  });
  expect(result.ppu_trace.final.nametable["1792"]).toMatchObject({
    value: 0xab,
  });
  expect(result.steps[0]!.read_source).toBeNull();
  expect(result.ppu_trace.operations[0]!.bus_reads[0]).toMatchObject({
    address: 0x3f10,
    value: 0x77,
    sources: [{ kind: "memory", space: "nametable", address: 1808 }],
  });
});

it("keeps a possible unknown palette address from falsely proving the old buffer", async () => {
  const result = await events([read(0x2007)], {
    v: { low: 0, high: { mask: 31, value: 31 } },
    io_latch: { value: 128 },
    read_buffer: { value: 63 },
  });
  expect(result.steps[0]).toMatchObject({
    cpu_read: { value: null, known_bits: { mask: 64, value: 0 } },
  });
  const operation = result.ppu_trace.operations[0]!;
  if (operation.kind !== "cpu-port") throw new Error("Expected CPU port read");
  expect(operation.read!.alternatives).toHaveLength(2);
  const buffered = await events([read(0x2007)], {
    palette_read_mode: "buffered",
    v: { low: 0, high: null },
    read_buffer: { value: 63 },
  });
  expect(buffered.steps[0]).toMatchObject({ cpu_read: { value: 63 } });
});

it("joins uncertain destinations, retains only old common bits and never invents missing bytes", async () => {
  const result = await events([write(0x2007, 0xa5)], {
    v: { low: { mask: 252, value: 0 }, high: 0 },
    chr_ram: { "0": 0xa5, "1": 0xa7 },
  });
  expect(result.ppu_trace.final.chr_ram).toEqual({
    "0": {
      value: 0xa5,
      origin: { kind: "initial-memory", space: "chr-ram", address: 0 },
    },
    "1": {
      value: { mask: 253, value: 165 },
      origin: { kind: "initial-memory", space: "chr-ram", address: 1 },
    },
  });
  expect(result.ppu_trace.operations[0]!.write).toMatchObject({
    status: "uncertain",
    destinations: [
      { space: "chr-ram", address: 0 },
      { space: "chr-ram", address: 1 },
      { space: "chr-ram", address: 2 },
      { space: "chr-ram", address: 3 },
    ],
  });
});

it("retains ignored warmup writes and conservative DMA/rendering effects", async () => {
  const warm = await events([write(0x2006, 4)], {
    register_writes_enabled: false,
    v: { low: 1, high: 2 },
    t: { low: 3, high: 4 },
  });
  expect(warm.ppu_trace.final).toMatchObject({
    v: { low: 1, high: 2 },
    t: { low: 3, high: 4 },
    write_toggle: 0,
    io_latch: { value: 4 },
  });
  const dma = await events([write(0x4015, 16), read(null), read(0x2007)], {
    v: { low: 0, high: 0 },
    read_buffer: { value: 0xa5 },
  });
  expect(dma.ppu_trace.final).toMatchObject({
    dma_reads: "unobserved",
    v: { low: null, high: null },
  });
  expect(dma.steps[2]).toMatchObject({ cpu_read: { value: null } });
  const rendering = await events([write(0x2007, 7)], {
    access_phase: "unknown",
    mask: 24,
    chr_ram: { "0": 3 },
    nametable: { "0": 4 },
    palette: { "0": 5 },
  });
  expect(rendering.ppu_trace.final).toMatchObject({
    chr_ram: {},
    nametable: {},
    palette: {},
  });
  expect(
    rendering.ppu_trace.operations[0]!.write!.invalidated_spaces,
  ).toHaveLength(3);
});

it("reads the old MMC2 bank before changing its latch", async () => {
  const fixture = nesPpuFixture([0x60], { mapper: 9, chrSize: 32768 });
  const result = await events(
    [read(0x2007), read(0x2007)],
    {
      chr_ram_size: null,
      v: { low: 216, high: 15 },
      read_buffer: { value: 0x11 },
    },
    fixture,
    { mapper: 9, prg_bank: 0, latch_0: "fe", chr_fd_0: 2, chr_fe_0: 3 },
  );
  expect(nesMapperEventSnapshot(result, result.steps[0]!)!.state).toMatchObject(
    { latch_0: "fd" },
  );
  expect(
    result.ppu_trace.operations.map((op) => op.bus_reads[0]!.file_offset),
  ).toEqual([
    fixture.chrOffset + 3 * 4096 + 0xfd8,
    fixture.chrOffset + 2 * 4096 + 0xfd9,
  ]);
  expect(result.steps[1]).toMatchObject({
    cpu_read: { value: fixture.bytes[fixture.chrOffset + 3 * 4096 + 0xfd8] },
  });
});
describe("PPU state in source instructions", () => {
  it("uploads ROM bytes, reports writer events and agrees with immutable replay/exploration", async () => {
    const fixture = nesPpuUploadFixture(),
      header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const input = traceNesCodeInputSchema.parse({
      path: "/upload.nes",
      initial: { mapper: 0 },
      initial_ppu: nesPpuFixtureState({ next_event_index: 17 }),
    });
    const source = fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset);
    const trace = nesCodeTraceSchema.parse(
      await deriveNesCode(header.value, source, input),
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.stop.reason).toBe("return");
    expect(trace.final_cpu.a).toBe(fixture.values[1]);
    const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
    if (mapped.status !== "derived" || !("ppu_trace" in mapped))
      throw new Error("Missing PPU trace");
    expect(mapped.ppu_trace.frontier).toEqual([]);
    expect(mapped.ppu_trace.coverage).toEqual({
      bus_reads: 3,
      unknown_bus_sources: 0,
      unknown_bus_values: 0,
    });
    expect(mapped.ppu_trace.final.chr_ram).toMatchObject(
      Object.fromEntries(
        fixture.values.map((value, address) => [address, { value }]),
      ),
    );
    expect(mapped.final_mapping).toMatchObject({
      chr_source: "ram-assumed",
      chr_windows: [
        { bank: 0, file_offset: null },
        { bank: 1, file_offset: null },
      ],
    });
    const replay = await events(
      mapped.steps.map((s) => s.event),
      { next_event_index: 17 },
      fixture,
    );
    expect(replay).toEqual(mapped);
    const exploration = await exploreNesCode(
      header.value,
      source,
      exploreNesCodeInputSchema.parse(input),
    );
    expect(exploration).toMatchObject({
      status: "derived",
      paths: [{ trace }],
    });
    for (const instruction of trace.instructions)
      for (const read of instruction.data_reads)
        if (read.file_offset !== null)
          expect(read.value).toBe(fixture.bytes[read.file_offset]);
  });

  it("preserves hypothetical partial-read origins without committing an unapplied JMP", async () => {
    const fixture = nesPpuFixture([0x6c, 6, 0x20]),
      header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const input = traceNesCodeInputSchema.parse({
      path: "/frontier.nes",
      initial: { mapper: 0 },
      initial_ppu: nesPpuFixtureState({
        v: { low: 0, high: 0 },
        io_latch: { value: 0x55 },
        read_buffer: { value: { mask: 15, value: 3 } },
      }),
    });
    const trace = await deriveNesCode(
      header.value,
      fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
      input,
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
    if (mapped.status !== "derived" || !("ppu_trace" in mapped))
      throw new Error("Missing PPU trace");
    expect(trace).toMatchObject({
      instructions: [],
      stop: {
        reason: "unknown-control-target",
        data_reads: [
          { value: 0x55 },
          { value: null, known_bits: { mask: 15, value: 3 } },
        ],
      },
    });
    expect(mapped.steps).toEqual([]);
    expect(mapped.ppu_trace.final).toMatchObject({
      next_event_index: 0,
      v: { low: 0, high: 0 },
      read_buffer: { value: { mask: 15, value: 3 } },
    });
    expect(mapped.ppu_trace.coverage).toEqual({
      bus_reads: 0,
      unknown_bus_sources: 0,
      unknown_bus_values: 0,
    });
    expect(mapped.ppu_trace.frontier.map((op) => op.event_index)).toEqual([
      0, 1,
    ]);
  });
});

it("does not treat an omitted palette-read qualification as stable hardware timing", async () => {
  const result = await events([read(0x2007)], {
    palette_read_mode: null,
    v: { low: 0, high: 63 },
    mask: 1,
    io_latch: { value: 0xc0 },
    palette: { "0": 0x21 },
    read_buffer: { value: 0xe0 },
  });
  expect(result.steps[0]).toMatchObject({
    cpu_read: { value: null, known_bits: { mask: 192, value: 192 } },
  });
  const operation = result.ppu_trace.operations[0]!;
  if (operation.kind !== "cpu-port") throw new Error("Expected CPU port read");
  expect(operation.read!.alternatives[1]).toMatchObject({
    mode: "unobserved",
    reason: "unqualified-palette-read",
  });
});

it("reports unmodeled OAM writes without inventing owned memory effects", async () => {
  const result = await events([write(0x2003, 14), write(0x2004, 72)], {
    chr_ram: { "0": 0xa5 },
    read_buffer: { value: 0x39 },
  });
  expect(result.ppu_trace.operations.map((op) => op.write)).toEqual([
    {
      status: "unverified",
      destinations: [],
      invalidated_spaces: [],
      reason: "oam-unmodeled",
    },
    {
      status: "unverified",
      destinations: [],
      invalidated_spaces: [],
      reason: "oam-unmodeled",
    },
  ]);
  expect(result.ppu_trace.final).toMatchObject({
    chr_ram: { "0": 0xa5 },
    read_buffer: { value: 0x39 },
    io_latch: { value: 72 },
  });
});
