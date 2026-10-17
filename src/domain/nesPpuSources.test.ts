import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import {
  nesPpuFixture,
  nesPpuFixtureState,
  nesPpuUploadFixture,
} from "./nesPpu.fixture.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";
import {
  nesMapperEventsTraceSchema,
  traceNesMapperEventsInputSchema,
} from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { exploreNesCode } from "./nesCodeExplorationDerivation.js";
import { exploreNesCodeInputSchema } from "./nesCodeExploration.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { readNesPpuMemory } from "./nesPpuMemory.js";

const source = async (
  program: readonly number[],
  extra: Record<string, unknown> = {},
  cpu: unknown = {},
) => {
  const fixture = nesPpuFixture(program),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/ports.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState(extra),
    cpu,
  });
  const trace = nesCodeTraceSchema.parse(
    await deriveNesCode(
      header.value,
      fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
      input,
    ),
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
  if (mapped.status !== "derived" || !("ppu_trace" in mapped))
    throw new Error("Missing PPU report");
  return { trace, mapped };
};

it("preserves both NMOS reads and both ordered RMW writes at PPUDATA", async () => {
  const { trace, mapped } = await source(
    [0xfe, 7, 0x20, 0x60],
    {
      v: { low: 0, high: 0 },
      read_buffer: { value: 0xa5 },
      chr_ram: { "0": 44, "1": 55, "2": 66 },
    },
    { x: 0 },
  );
  expect(trace.instructions[0]).toMatchObject({
    mapper_event_range: { start: 0, count: 4 },
    writes: [
      { address: 0x2007, value: 44, preceded_by_cpu_write: false },
      { address: 0x2007, value: 45, preceded_by_cpu_write: true },
    ],
  });
  expect(mapped.ppu_trace.final).toMatchObject({
    v: { low: 4, high: 0 },
    read_buffer: { value: 55 },
    chr_ram: {
      "2": { value: 44, origin: { kind: "event-write", index: 2 } },
      "3": { value: 45, origin: { kind: "event-write", index: 3 } },
    },
  });
  expect(mapped.ppu_trace.operations.map((op) => op.ppu_address)).toEqual([
    0, 1, 2, 3,
  ]);
  expect(mapped.ppu_trace.frontier).toEqual([]);
});

it("keeps NOP port reads in event ranges without inventing semantic operands", async () => {
  const { trace, mapped } = await source(
    [0x1c, 7, 0x20, 0x60],
    { v: { low: 0, high: 0 } },
    { x: 0 },
  );
  expect(trace.instructions[0]).toMatchObject({
    mnemonic: "NOP",
    data_reads: [],
    mapper_event_range: { start: 0, count: 1 },
  });
  expect(mapped.ppu_trace.final.v).toEqual({ low: 1, high: 0 });
});

it("does not duplicate the last committed PPU write in an instruction-budget frontier", async () => {
  const fixture = nesPpuUploadFixture(),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const trace = await deriveNesCode(
    header.value,
    fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
    traceNesCodeInputSchema.parse({
      path: "/budget.nes",
      initial: { mapper: 0 },
      initial_ppu: nesPpuFixtureState(),
      max_instructions: 6,
    }),
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
  if (mapped.status !== "derived" || !("ppu_trace" in mapped))
    throw new Error("Missing PPU report");
  expect(trace.stop.reason).toBe("instruction-budget");
  expect(mapped.ppu_trace.final.chr_ram["0"]).toMatchObject({
    value: fixture.values[0],
  });
  expect(mapped.ppu_trace.frontier).toEqual([]);
});

it("replays separate branches from immutable physical PPU memory", async () => {
  const fixture = nesPpuFixture([
    0xad, 0x16, 0x40, 0xf0, 8, 0xa9, 0xaa, 0x8d, 7, 0x20, 0x4c, 0x12, 0xc1,
    0xa9, 0xbb, 0x8d, 7, 0x20, 0x60,
  ]);
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = exploreNesCodeInputSchema.parse({
    path: "/branches.nes",
    initial: { mapper: 0 },
    ppu_pattern_table: 0,
    initial_ppu: nesPpuFixtureState({ v: { low: 0, high: 0 } }),
  });
  const result = await exploreNesCode(
    header.value,
    fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
    input,
  );
  if (result.status !== "derived") throw new Error(result.reason);
  const leaves = result.paths.filter(
    (path) =>
      path.trace.status === "derived" && path.trace.stop.reason === "return",
  );
  expect(leaves).toHaveLength(2);
  for (const path of leaves) {
    if (path.trace.status !== "derived") throw new Error(path.trace.reason);
    const mapped = nesMapperEventsTraceSchema.parse(path.trace.mapper_trace);
    if (mapped.status !== "derived" || !("ppu_trace" in mapped))
      throw new Error("Missing PPU report");
    expect(mapped.ppu_trace.initial.chr_ram).toEqual({});
    expect(mapped.ppu_trace.final.chr_ram["0"]).toMatchObject({
      value: path.branch_choices[0]!.taken ? 0xbb : 0xaa,
    });
    if (!("pattern_table" in mapped.ppu_trace))
      throw new Error("Missing pattern table");
    expect(mapped.ppu_trace.pattern_table.tiles[0]!.byte_values[0]).toBe(
      path.branch_choices[0]!.taken ? 0xbb : 0xaa,
    );
    expect(mapped.ppu_trace.pattern_table.coverage.partial_pixels).toBe(8);
  }
  const prefix = result.paths[0]!.trace;
  if (prefix.status !== "derived") throw new Error(prefix.reason);
  const prefixMapper = nesMapperEventsTraceSchema.parse(prefix.mapper_trace);
  if (
    prefixMapper.status !== "derived" ||
    !("ppu_trace" in prefixMapper) ||
    !("pattern_table" in prefixMapper.ppu_trace)
  )
    throw new Error("Missing prefix pattern table");
  expect(
    prefixMapper.ppu_trace.pattern_table.tiles[0]!.byte_values[0],
  ).toBeNull();
  expect(input.initial_ppu!.chr_ram).toEqual({});
});

it("examines only compatible MMC1/MMC3 physical pattern banks under partial selectors", () => {
  for (const mapper of [1, 4] as const) {
    const fixture = nesPpuFixture([0x60], {
      mapper,
      chrSize: mapper === 1 ? 131072 : 262144,
    });
    const header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const ppu = nesPpuFixtureState({ chr_ram_size: null });
    for (const mode of [0, 1, null])
      for (const proof of [
        { mask: 2, value: 2 },
        { mask: 30, value: 10 },
        null,
      ]) {
        const state = nesMapperStateSchema.parse(
          mapper === 1
            ? { mapper, chr_mode: mode, chr_bank_0: proof, chr_bank_1: 5 }
            : {
                mapper,
                bank_select: mode === null ? null : mode * 128,
                banks: [proof, 7, 9, 10, 11, 12, 0, 1],
              },
        );
        for (const address of [0x0111, 0x0511, 0x1111, 0x1511]) {
          const expected = new Set<number>();
          for (let raw = 0; raw < (mapper === 1 ? 32 : 256); raw++) {
            if (proof !== null && (raw & proof.mask) !== proof.value) continue;
            for (const selectedMode of mode === null ? [0, 1] : [mode]) {
              let bank: number, size: number;
              if (mapper === 1) {
                size = 4096;
                bank =
                  selectedMode === 0
                    ? (raw & 30) + (address >> 12)
                    : address < 4096
                      ? raw
                      : 5;
              } else {
                size = 1024;
                const slot =
                  selectedMode === 0
                    ? address >> 10
                    : ((address >> 10) + 4) % 8;
                bank = [raw & 254, (raw & 254) + 1, 6, 7, 9, 10, 11, 12][slot]!;
              }
              expected.add(fixture.chrOffset + bank * size + (address % size));
            }
          }
          const read = readNesPpuMemory(
            header.value,
            state,
            ppu,
            address,
            fixture.bytes.subarray(fixture.chrOffset),
          );
          expect(
            read.sources.map((s) => (s.kind === "rom" ? s.file_offset : null)),
          ).toEqual([...expected].sort((a, b) => a - b));
        }
      }
  }
});

it("validates retained history, physical aliases and authenticated buffer sources", async () => {
  const fixture = nesPpuFixture([0x60], { chrSize: 8192 }),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  for (const [ppu, message] of [
    [
      {
        chr_ram_size: null,
        read_buffer: {
          value: 1,
          sources: [
            {
              kind: "memory",
              space: "chr-ram",
              address: 0,
              value: 1,
              mask: 255,
              origin: { kind: "initial-memory", space: "chr-ram", address: 0 },
            },
          ],
        },
      },
      "established external",
    ],
    [
      {
        chr_ram_size: null,
        read_buffer: {
          value: 1,
          sources: [
            {
              kind: "memory",
              space: "nametable",
              address: 3000,
              value: 1,
              mask: 255,
              origin: {
                kind: "initial-memory",
                space: "nametable",
                address: 3000,
              },
            },
          ],
        },
      },
      "declared backing",
    ],
    [
      {
        chr_ram_size: null,
        read_buffer: {
          value: 1,
          sources: [
            {
              kind: "register",
              field: "status",
              value: 1,
              mask: 255,
              origin: { kind: "initial-register", field: "status" },
            },
          ],
        },
      },
      "initial read-buffer",
    ],
    [{ chr_ram_size: 8192 }, "no CHR ROM"],
    [
      {
        chr_ram_size: null,
        next_event_index: 0,
        io_latch: { value: 1, origin: { kind: "event-read", index: 0 } },
      },
      "precede",
    ],
    [
      {
        chr_ram_size: null,
        read_buffer: {
          value: 1,
          sources: [
            {
              kind: "rom",
              file_offset: fixture.chrOffset,
              value: 1,
              mask: 255,
            },
          ],
        },
      },
      "authenticated",
    ],
    [
      { chr_ram_size: null, next_event_index: Number.MAX_SAFE_INTEGER },
      "identity",
    ],
  ] as const) {
    const input = traceNesMapperEventsInputSchema.parse({
      path: "/invalid.nes",
      initial: { mapper: 0 },
      initial_ppu: nesPpuFixtureState(ppu),
      events: [{ kind: "cpu-read", address: 0x2007 }],
    });
    expect(
      await deriveNesMapperEvents(header.value, input.initial, input.events, {
        initialPpu: input.initial_ppu,
        chr: fixture.bytes.subarray(fixture.chrOffset),
      }),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining(message),
    });
  }
  for (const state of [
    { palette: { "16": 1 } },
    { chr_ram: { "8192": 1 } },
    { palette: { "0": 64 } },
    { v: { high: 128 } },
  ])
    expect(() => nesPpuFixtureState(state)).toThrow();
});

it("retains a complete 8 KiB upload as deltas rather than per-event memory copies", async () => {
  const fixture = nesPpuFixture(),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/8k.nes",
    initial: { mapper: 0 },
    initial_ppu: nesPpuFixtureState(),
    max_steps: 8192,
    events: Array.from({ length: 8192 }, (_, address) => ({
      kind: "ppu-write",
      address,
      value: ((address * 19) ^ (address >> 5)) & 255,
    })),
  });
  const result = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header.value, input.initial, input.events, {
      initialPpu: input.initial_ppu,
    }),
  );
  if (result.status !== "derived" || !("ppu_trace" in result))
    throw new Error("Missing PPU report");
  expect(result.ppu_trace.final.next_event_index).toBe(8192);
  expect(Object.keys(result.ppu_trace.final.chr_ram)).toHaveLength(8192);
  for (let address = 0; address < 8192; address++)
    expect(result.ppu_trace.final.chr_ram[String(address)]).toEqual({
      value: ((address * 19) ^ (address >> 5)) & 255,
      origin: { kind: "event-write", index: address },
    });
  expect(
    result.ppu_trace.operations.every(
      (op) => op.kind === "ppu-bus" && !("before" in op) && !("after" in op),
    ),
  ).toBe(true);
}, 30_000);

it("retains invariant nametable pages under unknown MMC3 mirroring", () => {
  const fixture = nesPpuFixture([0x60], { mapper: 4 }),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const ppu = nesPpuFixtureState({ nametable: { "0": 0xa5, "1024": 0xbb } });
  const state = nesMapperStateSchema.parse({ mapper: 4 });
  for (const [address, physical, value] of [
    [0x2000, 0, 0xa5],
    [0x2c00, 1024, 0xbb],
  ]) {
    const read = readNesPpuMemory(header.value, state, ppu, address!);
    expect(read.value).toBe(value);
    expect(read.sources).toMatchObject([{ kind: "memory", address: physical }]);
  }
  const read = readNesPpuMemory(header.value, state, ppu, 0x2400);
  expect(read.value).toEqual({ mask: 225, value: 161 });
  expect(
    read.sources.map((s) => (s.kind === "memory" ? s.address : null)),
  ).toEqual([0, 1024]);
});

it("reuses complete mapper snapshots on restoration without merging IRQ changes", async () => {
  const fixture = nesPpuFixture([0x60], { mapper: 4 }),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/snapshots.nes",
    initial: {
      mapper: 4,
      bank_select: 0,
      banks: [0, 2, 4, 5, 6, 7, 0, 1],
      irq_latch: 1,
    },
    initial_irq: {
      model: "sharp",
      counter: 3,
      enabled: true,
      asserted: false,
      reload_pending: false,
    },
    initial_ppu: nesPpuFixtureState(),
    events: [
      { kind: "cpu-write", address: 0x8000, value: 6 },
      { kind: "cpu-write", address: 0x8001, value: 2 },
      { kind: "cpu-write", address: 0x8001, value: 0 },
      { kind: "mmc3-irq-clock" },
      { kind: "ppu-read", address: 0 },
    ],
  });
  const result = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header.value, input.initial, input.events, {
      initialPpu: input.initial_ppu,
      initialIrq: input.initial_irq,
    }),
  );
  if (result.status !== "derived" || !("ppu_trace" in result))
    throw new Error("Missing pooled PPU report");
  expect(result.steps.map((step) => step.mapper_snapshot)).toEqual([
    1, 2, 1, 3, 3,
  ]);
  expect(result.mapper_snapshots).toHaveLength(4);
  expect(
    result.mapper_snapshots[1]!.mapping.prg_windows.map((w) => w.bank),
  ).toEqual([0, 1, 6, 7]);
  expect(
    result.mapper_snapshots[2]!.mapping.prg_windows.map((w) => w.bank),
  ).toEqual([2, 1, 6, 7]);
  expect(result.mapper_snapshots[3]).toMatchObject({ irq: { counter: 2 } });
  expect(result.mapper_snapshots[1]).toMatchObject({ irq: { counter: 3 } });
  expect(result.coverage.unknown_pattern_reads).toBe(0);
  expect(result.ppu_trace.coverage).toEqual({
    bus_reads: 1,
    unknown_bus_sources: 0,
    unknown_bus_values: 1,
  });
  expect(result.steps[4]!.irq_clock).toBe(false);
  const broken = structuredClone(result);
  broken.steps[0]!.mapper_snapshot = 4;
  expect(nesMapperEventsTraceSchema.safeParse(broken).success).toBe(false);
});
