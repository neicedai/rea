import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import {
  nesPpuFixture,
  nesPpuFixtureState,
  nesOamUploadFixture,
} from "./nesPpu.fixture.js";
import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsTraceSchema,
} from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { exploreNesCodeInputSchema } from "./nesCodeExploration.js";
import { exploreNesCode } from "./nesCodeExplorationDerivation.js";
import { nesOamTraceReadBytes } from "./nesCpuDmaBudget.js";
import { fme7Fixture } from "./nesFme7.fixture.js";

const oam = (extra: Record<string, unknown> = {}) => ({
  model: "oam-memory",
  retention: "stable",
  reads: "supported",
  address: 0,
  dma_pending: { status: "none" },
  ...extra,
});
const events = async (
  steps: unknown[],
  extra: Record<string, unknown> = {},
  ppu: Record<string, unknown> = {},
) => {
  const fixture = nesPpuFixture(),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/oam.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState({ oam: oam(extra), ...ppu }),
    events: steps,
  });
  const trace = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header.value, input.initial, input.events, {
      initialPpu: input.initial_ppu,
    }),
  );
  if (trace.status !== "derived" || !("ppu_trace" in trace))
    throw new Error(JSON.stringify(trace));
  return trace;
};
const write = (address: number, value: number) => ({
  kind: "cpu-write",
  address,
  value,
});
const read = (address: number) => ({ kind: "cpu-read", address });
const source = async (
  fixture = nesOamUploadFixture(),
  extra: Record<string, unknown> = {},
) => {
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/oam-source.nes",
    initial: { mapper: 0 },
    initial_ppu: fixture.initial_ppu,
    max_instructions: 1100,
    ...extra,
  });
  const code = nesCodeTraceSchema.parse(
    await deriveNesCode(
      header.value,
      fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
      input,
    ),
  );
  if (code.status !== "derived") throw new Error(code.reason);
  const mapped = nesMapperEventsTraceSchema.parse(code.mapper_trace);
  if (mapped.status !== "derived" || !("ppu_trace" in mapped))
    throw new Error("Missing PPU trace");
  return { code, mapped, input, header };
};

it("masks unimplemented OAM bits, wraps writes and preserves reads without advancing OAMADDR", async () => {
  const trace = await events(
    [
      write(0x2003, 254),
      write(0x200c, 255),
      write(0x2004, 0x91),
      write(0x2003, 254),
      read(0x3ffc),
      read(0x2004),
    ],
    { address_writes: "uncorrupted" },
  );
  expect(trace.ppu_trace.final.oam).toMatchObject({
    address: 254,
    cells: {
      254: { value: 227, origin: { kind: "event-write", index: 1 } },
      255: { value: 145, origin: { kind: "event-write", index: 2 } },
    },
  });
  expect(
    trace.steps
      .slice(4)
      .map((step) => ("cpu_read" in step ? step.cpu_read.value : null)),
  ).toEqual([227, 227]);
  const source = trace.steps[4]!;
  if (
    !("cpu_read" in source) ||
    source.cpu_read.source?.kind !== "ppu-register"
  )
    throw new Error("Missing OAM read source");
  expect(source.cpu_read.source.alternatives[0]!.sources).toContainEqual({
    kind: "oam-attribute-zeroes",
    value: 0,
    mask: 28,
    addresses: [254],
  });
});

it("keeps readability, retention and address-write corruption qualifications explicit", async () => {
  const corrupt = await events([write(0x2003, 0), read(0x2004)], {
    cells: { 0: 0x77 },
  });
  expect(corrupt.ppu_trace.final.oam!.cells).toEqual({});
  expect(corrupt.ppu_trace.operations[0]!.write?.reason).toBe(
    "unobserved-oam-address-corruption",
  );
  const unknown = await events([read(0x2004)], {
    retention: "unobserved",
    address: 2,
    cells: { 2: 227 },
  });
  expect(unknown.steps[0]).toMatchObject({
    cpu_read: { value: null, known_bits: { mask: 28, value: 0 } },
  });
  const open = await events(
    [read(0x2004)],
    { reads: "open-bus", cells: { 0: 0x77 } },
    { io_latch: { value: 0x35 } },
  );
  expect(open.steps[0]).toMatchObject({ cpu_read: { value: 0x35 } });
  const joined = await events(
    [read(0x2004)],
    { reads: null, cells: { 0: 0xa5 } },
    { io_latch: { value: 0xad } },
  );
  expect(joined.steps[0]).toMatchObject({
    cpu_read: { value: null, known_bits: { mask: 247, value: 165 } },
  });
});

it("queues replacement requests until an explicit completion and retains every rotated DMA source", async () => {
  const values = Array.from(
    { length: 256 },
    (_, offset) => (offset * 13 + 5) & 255,
  );
  const trace = await events(
    [write(0x4014, 1), write(0x4014, 2), { kind: "oam-dma", page: 2, values }],
    { address: 253 },
  );
  expect(trace.ppu_trace.final.oam!.address).toBe(253);
  expect(trace.ppu_trace.final.oam!.dma_pending).toEqual({ status: "none" });
  for (let address = 0; address < 256; address++)
    expect(trace.ppu_trace.final.oam!.cells[address]).toEqual({
      value: values[(address - 253) & 255]! & (address % 4 === 2 ? 227 : 255),
      origin: { kind: "dma-write", index: 2, address, start_address: 253 },
    });
  expect(trace.ppu_trace.final.io_latch).toEqual({
    value: values[255],
    origin: { kind: "dma-byte", index: 2, offset: 255 },
  });
  expect(trace.ppu_trace.operations[2]!.write).toMatchObject({
    range: { space: "oam", start: 0, size: 256 },
  });
  expect(trace.ppu_trace.coverage.bus_reads).toBe(0);
});

it("joins unknown DMA rotation and invalidates unobserved transfers without leaving stale bytes", async () => {
  const values = Array.from({ length: 256 }, (_, offset) => offset);
  const rotated = await events(
    [write(0x4014, 2), { kind: "oam-dma", page: 2, values }],
    { address: { mask: 254, value: 0 } },
  );
  expect(rotated.ppu_trace.final.oam!.cells[5]).toEqual({
    value: { mask: 254, value: 4 },
    origin: {
      kind: "dma-write",
      index: 1,
      address: 5,
      start_address: { mask: 254, value: 0 },
    },
  });
  const lost = await events([write(0x4014, 2), read(0x8000)], {
    cells: { 0: 0x77 },
  });
  expect(lost.ppu_trace.final.oam).toMatchObject({
    cells: {},
    address: 0,
    dma_pending: { status: "none" },
  });
  expect(lost.ppu_trace.operations[1]!.write?.reason).toBe(
    "unobserved-oam-dma-data",
  );
  const interference = await events(
    [write(0x4014, 2), { kind: "oam-dma", page: 2, values }],
    { cells: { 0: 0x77 } },
    { dma_reads: "unobserved" },
  );
  expect(interference.ppu_trace.final.oam).toMatchObject({
    cells: {},
    address: null,
  });
});

it("derives a full RAM-to-OAM source upload with original RAM writers and replayable packet values", async () => {
  const fixture = nesOamUploadFixture(),
    values = fixture.values;
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/oam-source.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState({ oam: oam(), next_event_index: 100 }),
    max_instructions: 1100,
  });
  const code = nesCodeTraceSchema.parse(
    await deriveNesCode(
      header.value,
      fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
      input,
    ),
  );
  if (code.status !== "derived") throw new Error(code.reason);
  expect(code.final_cpu.a).toBe(5);
  const transfer = code.instructions.find(
    (instruction) => "oam_dma_reads" in instruction,
  );
  if (transfer === undefined || !("oam_dma_reads" in transfer))
    throw new Error("Missing DMA read proof");
  expect(transfer.mnemonic).toBe("NOP");
  expect(transfer.data_reads).toEqual([]);
  for (const [offset, source] of transfer.oam_dma_reads.entries()) {
    expect(source).toMatchObject({
      address: 512 + offset,
      value: values[offset],
      file_offset: null,
      ram_origins: [
        {
          byte_index: 0,
          region: "internal-ram",
          ram_address: 512 + offset,
          instruction_index: 2 + offset * 4,
          write_index: 0,
        },
      ],
    });
    expect(code.instructions[2 + offset * 4]!.writes[0]!.value).toBe(
      values[offset],
    );
  }
  const mapped = nesMapperEventsTraceSchema.parse(code.mapper_trace);
  if (mapped.status !== "derived" || !("ppu_trace" in mapped))
    throw new Error("Missing PPU");
  expect(mapped.ppu_trace.final.oam!.cells[2]).toEqual({
    value: 3,
    origin: { kind: "dma-write", index: 102, address: 2, start_address: 0 },
  });
  expect(mapped.ppu_trace.final.next_event_index).toBe(104);
  expect(mapped.ppu_trace.frontier).toEqual([]);
  expect("oam_dma_reads" in code.stop).toBe(false);
  expect(
    await deriveNesMapperEvents(
      header.value,
      input.initial,
      mapped.steps.map((step) => step.event),
      { initialPpu: input.initial_ppu },
    ),
  ).toEqual(mapped);
});

it("keeps rendering and retention failures distinct from DMC interference", async () => {
  const values = Array(256).fill(1);
  const rendering = await events(
    [read(0x2004)],
    { cells: { 0: 17 } },
    { mask: 24, access_phase: "unknown" },
  );
  expect(rendering.ppu_trace.final.oam).toMatchObject({
    address: null,
    cells: {},
  });
  expect(rendering.ppu_trace.operations[0]!.write?.reason).toBe(
    "unverified-oam-rendering-read",
  );
  const decayed = await events(
    [write(0x4014, 2), { kind: "oam-dma", page: 2, values }],
    { retention: "unobserved" },
  );
  expect(decayed.ppu_trace.final.oam!.cells).toEqual({});
  expect(decayed.ppu_trace.final.io_latch.value).toBe(1);
  expect(decayed.ppu_trace.operations[1]!.write?.reason).toBe(
    "unobserved-oam-retention",
  );
  const conflict = await events(
    [write(0x4014, 2), { kind: "oam-dma", page: 2, values }],
    {},
    { dma_reads: "unobserved" },
  );
  expect(conflict.ppu_trace.operations[1]!.write?.reason).toBe(
    "unobserved-oam-dmc-interference",
  );
});

it("rejects contradictory packets, incompatible physical cells and forged continuation origins", async () => {
  const fixture = nesPpuFixture(),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const base = {
    path: "/invalid-oam.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState({ oam: oam() }),
    events: [],
  };
  const packet = { kind: "oam-dma", page: 2, values: Array(256).fill(1) };
  const noModel = traceNesMapperEventsInputSchema.parse({
    ...base,
    initial_ppu: nesPpuFixtureState(),
    events: [packet],
  });
  expect(
    await deriveNesMapperEvents(header.value, noModel.initial, noModel.events, {
      initialPpu: noModel.initial_ppu,
    }),
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("oam"),
  });
  expect(
    traceNesMapperEventsInputSchema.safeParse({
      ...base,
      events: [{ ...packet, values: Array(255).fill(1) }],
    }).success,
  ).toBe(false);
  for (const steps of [
    [packet],
    [write(0x4014, 3), packet],
    [write(0x4014, 2), read(0x8000), packet],
  ]) {
    const input = traceNesMapperEventsInputSchema.parse({
      ...base,
      events: steps,
    });
    expect(
      await deriveNesMapperEvents(header.value, input.initial, input.events, {
        initialPpu: input.initial_ppu,
      }),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("contradict"),
    });
  }
  for (const cells of [
    { 2: 255 },
    { 0: { value: 1, origin: { kind: "event-write", index: 1 } } },
    {
      0: {
        value: 1,
        origin: { kind: "dma-write", index: 0, address: 1, start_address: 0 },
      },
    },
  ]) {
    const input = traceNesMapperEventsInputSchema.parse({
      ...base,
      initial_ppu: nesPpuFixtureState({
        oam: oam({ cells }),
        next_event_index: 1,
      }),
    });
    expect(
      (
        await deriveNesMapperEvents(header.value, input.initial, [], {
          initialPpu: input.initial_ppu,
        })
      ).status,
    ).toBe("unsupported");
  }
});

it("authenticates ROM DMA reads and keeps device-page byte sources unknown", async () => {
  const fixture = nesOamUploadFixture({ viaRam: false, startAddress: 253 }),
    { code, mapped } = await source(fixture);
  const packet = code.instructions.find(
    (instruction) => "oam_dma_reads" in instruction,
  );
  if (packet === undefined || !("oam_dma_reads" in packet))
    throw new Error("Missing ROM DMA sources");
  for (const [offset, read] of packet.oam_dma_reads.entries())
    expect(read).toEqual({
      address: 0x8200 + offset,
      value: fixture.values[offset],
      file_offset: fixture.prgOffset + 512 + offset,
      ram_origins: [],
      mapper_origins: [],
    });
  expect(mapped.ppu_trace.final.oam!.cells[254]).toMatchObject({
    value: 2,
    origin: { kind: "dma-write", index: 102, address: 254, start_address: 253 },
  });
  const device = nesOamUploadFixture({ viaRam: false });
  device.bytes[device.programOffset + 6] = 0x20; // LDA source-page operand after LDA/STA OAMADDR.
  const traced = await source(device, {
    initial_ppu: {
      ...device.initial_ppu,
      v: { low: 7, high: 4 },
      read_buffer: { value: 42 },
    },
  });
  const capture = traced.code.instructions.find(
    (instruction) => "oam_dma_reads" in instruction,
  );
  if (capture === undefined || !("oam_dma_reads" in capture))
    throw new Error("Missing device-page DMA");
  expect(
    capture.oam_dma_reads.every(
      (read) =>
        read.value === null &&
        read.file_offset === null &&
        read.ram_origins.length === 0 &&
        read.mapper_origins.length === 0,
    ),
  ).toBe(true);
  expect(traced.mapped.ppu_trace.final.v).toEqual({ low: null, high: null });
});

it("retains complete hypothetical DMA proofs at an unapplied return without committing the transfer", async () => {
  const { code, mapped } = await source(nesOamUploadFixture({ tail: [0x60] }));
  expect(code.stop.reason).toBe("return");
  expect(
    "oam_dma_reads" in code.stop ? code.stop.oam_dma_reads.length : 0,
  ).toBe(256);
  expect(mapped.ppu_trace.final.oam).toMatchObject({
    cells: {},
    dma_pending: { status: "pending", page: 2 },
  });
  expect(mapped.ppu_trace.final.next_event_index).toBe(102);
  expect(mapped.ppu_trace.frontier.map((operation) => operation.kind)).toEqual([
    "oam-dma",
  ]);
  const budget = await source(nesOamUploadFixture(), {
    max_instructions: 1030,
  });
  expect(budget.code.stop.reason).toBe("instruction-budget");
  expect("oam_dma_reads" in budget.code.stop).toBe(false);
  expect(budget.mapped.ppu_trace.frontier).toEqual([]);
  expect(budget.mapped.ppu_trace.final.next_event_index).toBe(103);
});

it("bounds retained DMA source JSON before a whole packet or instruction can commit", async () => {
  for (const bytes of [0, 2000]) {
    const { code, mapped } = await source(nesOamUploadFixture(), {
      max_oam_dma_source_bytes: bytes,
    });
    expect(code.stop.reason).toBe("oam-dma-source-budget");
    if (!("oam_dma_frontier" in code.stop))
      throw new Error("Missing budget frontier");
    const frontier = code.stop.oam_dma_frontier;
    expect(frontier.available_source_bytes).toBe(bytes);
    expect(frontier.retained_source_bytes).toBe(nesOamTraceReadBytes(code));
    expect(frontier.retained_source_bytes).toBeLessThanOrEqual(bytes);
    expect(frontier.reads.length).toBeLessThan(256);
    expect(mapped.ppu_trace.final.oam).toMatchObject({
      cells: {},
      dma_pending: { status: "pending", page: 2 },
    });
    expect(mapped.steps).toHaveLength(2);
    expect(mapped.ppu_trace.frontier).toEqual([]);
    expect(mapped.ppu_trace.final.next_event_index).toBe(102);
  }
});

it("shares the source budget across explored prefixes and preserves independent branch OAM memory", async () => {
  const fixture = nesPpuFixture([
      0xa9, 2, 0x2c, 0x16, 0x40, 0x8d, 0x14, 0x40, 0xf0, 8, 0xa9, 0xaa, 0x8d, 4,
      0x20, 0x4c, 0x17, 0xc1, 0xa9, 0xbb, 0x8d, 4, 0x20, 0x60,
    ]),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = exploreNesCodeInputSchema.parse({
    path: "/oam-branches.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState({ oam: oam() }),
    initial_ram: Array.from({ length: 256 }, (_, offset) => ({
      address: 512 + offset,
      value: (offset * 13 + 5) & 255,
    })),
  });
  const result = await exploreNesCode(
    header.value,
    fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
    input,
  );
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.paths).toHaveLength(3);
  for (const path of result.paths) {
    if (path.trace.status !== "derived") throw new Error(path.trace.reason);
    const mapped = nesMapperEventsTraceSchema.parse(path.trace.mapper_trace);
    if (mapped.status !== "derived" || !("ppu_trace" in mapped))
      throw new Error("Missing branch PPU");
    if (path.branch_choices.length === 0) {
      expect(mapped.ppu_trace.final.oam!.cells).toEqual({});
      expect("oam_dma_reads" in path.trace.stop).toBe(true);
    } else
      expect(mapped.ppu_trace.final.oam!.cells[0]).toMatchObject({
        value: path.branch_choices[0]!.taken ? 187 : 170,
        origin: { kind: "event-write", index: 2 },
      });
  }
  const limit = nesOamTraceReadBytes(result.paths[0]!.trace) + 500;
  const limited = await exploreNesCode(
    header.value,
    fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
    { ...input, max_oam_dma_source_bytes: limit },
  );
  if (limited.status !== "derived") throw new Error(limited.reason);
  expect(limited.termination).toBe("oam-dma-source-budget");
  expect(
    limited.paths.reduce(
      (sum, path) => sum + nesOamTraceReadBytes(path.trace),
      0,
    ),
  ).toBeLessThanOrEqual(limit);
  expect(input.initial_ppu!.oam!.cells).toEqual({});
});

it("retains all 64 physical RAM-bank origins for every DMA byte within the default source budget", async () => {
  const fixture = fme7Fixture("fme7", 13);
  fixture.bytes.set(
    [0xa9, 0x60, 0x8d, 0x14, 0x40, 0xea, 0xad, 4, 0x20, 0x60],
    528 + 7 * 8192 + 256,
  );
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const initial_prg_ram = Array.from({ length: 64 }, (_, bank) =>
    Array.from({ length: 256 }, (_, offset) => ({
      bank,
      address: 0x6000 + offset,
      value: (offset * 13 + 5) & 255,
    })),
  ).flat();
  const input = traceNesCodeInputSchema.parse({
    path: "/oam-64-banks.nes",
    initial: {
      ...fixture.initial,
      bank_6000: { mask: 64, value: 64 },
      prg_ram_enable: "ungated",
    },
    initial_ppu: nesPpuFixtureState({ chr_ram_size: null, oam: oam() }),
    initial_prg_ram,
  });
  const code = nesCodeTraceSchema.parse(
    await deriveNesCode(
      header.value,
      fixture.bytes.subarray(528, 528 + 65536),
      input,
    ),
  );
  if (code.status !== "derived") throw new Error(code.reason);
  expect(code.stop.reason).toBe("return");
  const packet = code.instructions.find(
    (instruction) => "oam_dma_reads" in instruction,
  );
  if (packet === undefined || !("oam_dma_reads" in packet))
    throw new Error("Missing 64-bank DMA");
  for (const [offset, read] of packet.oam_dma_reads.entries()) {
    expect(read.ram_origins).toHaveLength(64);
    for (const [bank, origin] of read.ram_origins.entries())
      expect(origin).toEqual({
        byte_index: 0,
        region: "prg-ram",
        bank,
        ram_address: 0x6000 + offset,
        initial_prg_ram_index: bank * 256 + offset,
      });
  }
  expect(nesOamTraceReadBytes(code)).toBeLessThanOrEqual(
    input.max_oam_dma_source_bytes,
  );
});
