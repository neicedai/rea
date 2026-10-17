import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mmc5Fixture } from "./nesMmc5.fixture.js";
import { nesPpuFixtureState } from "./nesPpu.fixture.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsTraceSchema,
  nesMapperEventSnapshot,
} from "./nesMapperEvents.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";
import { readMmc5ExramCell } from "./nesMmc5Exram.js";
import { Nes6502Context } from "./nes6502Context.js";

const fixture = (program: number[] = []) => {
  const f = mmc5Fixture(0);
  f.bytes.set(program, f.prgOffset + 7 * 8192);
  const chrOffset = f.prgOffset + f.prgSize;
  for (let offset = 0; offset < 32768; offset++)
    f.bytes[chrOffset + offset] = ((offset >> 10) ^ (offset * 11)) & 255;
  const parsed = parseNesHeader(f.bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return {
    ...f,
    header: parsed.value,
    prg: f.bytes.subarray(f.prgOffset, chrOffset),
    chr: f.bytes.subarray(chrOffset),
    chrOffset,
  };
};
const initial = (extra: Record<string, unknown> = {}) => ({
  mapper: 5,
  prg_mode: 3,
  prg_banks: [0, 128, 129, 130, 7],
  ram_wiring: "none",
  chr_mode: 3,
  chr_banks: Array<number>(12).fill(1),
  chr_bank_modes: Array<number>(12).fill(3),
  chr_bank_upper: Array<number>(12).fill(0),
  last_chr_set: "background",
  ppu_control: 32,
  ppu_mask: 24,
  exram_mode: 0,
  exram_written: true,
  nametable_control: 0,
  fill_tile: 53,
  fill_attribute: 2,
  split: [0, 0, 0],
  ...extra,
});
const ppu = (extra: Record<string, unknown> = {}) =>
  nesPpuFixtureState({
    chr_ram_size: null,
    nametable_layout: "ciram-2k",
    next_event_index: 100,
    v: { low: 0, high: 32 },
    io_latch: { value: 85 },
    read_buffer: { value: 17 },
    ...extra,
  });
const supplied = async (raw: unknown, f = fixture()) => {
  const input = traceNesMapperEventsInputSchema.parse(raw);
  const result = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(f.header, input.initial, input.events, {
      prg: f.prg,
      chr: f.chr,
      initialPpu: input.initial_ppu,
      initialIrq: input.initial_irq,
    }),
  );
  if (result.status !== "derived" || !("ppu_trace" in result))
    throw new Error(JSON.stringify(result));
  return { result, input, f };
};
const source = async (
  program: number[],
  extra: Record<string, unknown> = {},
) => {
  const f = fixture(program),
    input = traceNesCodeInputSchema.parse({
      path: "/retained-mmc5.nes",
      entry: 0xe000,
      initial: initial(),
      initial_ppu: ppu(),
      ...extra,
    });
  const result = nesCodeTraceSchema.parse(
    await deriveNesCode(f.header, f.prg, input, { chr: f.chr }),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  return { result, input, f };
};

it("runs qualified background tile/attribute/pattern reads once with the actual retained CIRAM tile", async () => {
  const { result, f } = await supplied({
    path: "/retained-mmc5.nes",
    initial: initial({ ppu: { model: "mmc5-background", pin92_high: true } }),
    initial_ppu: ppu({ nametable: { "0": 17, "960": 85 } }),
    events: [
      {
        kind: "ppu-read",
        address: 0x2000,
        mmc5_fetch: "background",
        mmc5_tile: { column: 0, line: "current" },
      },
      { kind: "ppu-read", address: 0x23c0, mmc5_fetch: "background" },
      { kind: "ppu-read", address: 0x110, mmc5_fetch: "background" },
      { kind: "ppu-read", address: 0x118, mmc5_fetch: "background" },
    ],
  });
  expect(
    result.steps.map((step) => {
      const snapshot = nesMapperEventSnapshot(result, step);
      if (snapshot?.state.mapper !== 5 || !("ppu" in snapshot.state))
        throw new Error("Missing rendering snapshot");
      return [snapshot.state.ppu.phase, snapshot.state.ppu.tile_value];
    }),
  ).toEqual([
    ["attribute", 17],
    ["pattern-low", 17],
    ["pattern-high", 17],
    ["idle", 17],
  ]);
  expect(
    result.ppu_trace.operations.map((operation) => operation.bus_reads.length),
  ).toEqual([1, 1, 1, 1]);
  expect(result.ppu_trace.operations[0]!.bus_reads[0]).toMatchObject({
    value: 17,
    sources: [{ kind: "memory", space: "nametable", address: 0, value: 17 }],
  });
  expect(result.ppu_trace.operations[2]!.bus_reads[0]).toMatchObject({
    value: f.chr[1024 + 0x110],
    sources: [{ kind: "rom", file_offset: f.chrOffset + 1024 + 0x110 }],
    mmc5: { rendering: { fetch: "pattern-low", reason: null } },
  });
  expect(result.ppu_trace.final.next_event_index).toBe(104);
  expect(result.ppu_trace.coverage).toMatchObject({
    bus_reads: 4,
    unknown_bus_values: 0,
  });
});

it("retains a proven normal CHR byte while reporting missing background tile history", async () => {
  const { result, input, f } = await supplied({
    path: "/retained-mmc5.nes",
    initial: initial({
      ppu: { model: "mmc5-background", pin92_high: true, phase: "unknown" },
    }),
    initial_ppu: ppu(),
    events: [{ kind: "ppu-read", address: 0x110, mmc5_fetch: "background" }],
  });
  const byte = f.chr[1024 + 0x110]!;
  expect(result.ppu_trace.operations[0]!.bus_reads[0]).toMatchObject({
    value: byte,
    sources: [
      { kind: "rom", file_offset: f.chrOffset + 1024 + 0x110, value: byte },
    ],
    mmc5: {
      rendering: {
        paths: ["normal"],
        fetch: "pattern-low",
        reason: "missing-tile",
      },
    },
  });
  expect(result.ppu_trace.operations[0]!.bus_reads[0]!.sources).toHaveLength(1);
  if (
    result.final.mapper !== 5 ||
    !("ppu" in result.final) ||
    input.initial.mapper !== 5 ||
    !("ppu" in input.initial)
  )
    throw new Error("Missing rendering state");
  expect(result.final.ppu).toMatchObject({
    phase: "unknown",
    nametable_address: null,
    tile_column: null,
    tile_value: null,
    pattern_address: null,
    extended_attribute: null,
    split_tiles: [],
    split_attributes: [],
  });
  expect(result.ppu_trace.coverage.unknown_bus_values).toBe(0);
});

it.each([
  {
    name: "ExRAM",
    mapper: {
      nametable_control: 170,
      exram_mode: 0,
      exram: {
        "0": { value: 106, origin: { kind: "event-write", index: 90 } },
      },
    },
    change: { kind: "ppu-write", address: 0x2000, value: 117 },
    value: 106,
    atom: {
      kind: "mmc5-exram",
      address: 0,
      value: 106,
      cell_value: 106,
      origin: { kind: "event-write", index: 90 },
    },
  },
  {
    name: "fill",
    mapper: { nametable_control: 255 },
    change: { kind: "cpu-write", address: 0x5106, value: 102 },
    value: 53,
    atom: {
      kind: "mmc5-fill",
      register: 0x5106,
      register_value: 53,
      value: 53,
    },
  },
  {
    name: "zero",
    mapper: { nametable_control: 170, exram_mode: 2, exram: { "0": 122 } },
    change: { kind: "cpu-write", address: 0x5104, value: 0 },
    value: 0,
    atom: { kind: "mmc5-zero", value: 0 },
  },
])(
  "retains captured $name PPUDATA sources across a storage/control change and continuation",
  async ({ mapper, change, value, atom }) => {
    const raw = {
      path: "/retained-mmc5.nes",
      initial: initial(mapper),
      initial_ppu: ppu(),
      events: [{ kind: "cpu-read", address: 0x2007 }, change],
    };
    const { result: prefix, f } = await supplied(raw);
    expect(prefix.ppu_trace.final.read_buffer).toMatchObject({
      value,
      sources: [atom],
    });
    const { result: resumed } = await supplied(
      {
        ...raw,
        initial: prefix.final,
        initial_ppu: prefix.ppu_trace.final,
        events: [{ kind: "cpu-read", address: 0x2007 }],
      },
      f,
    );
    const { result: whole } = await supplied(
      {
        ...raw,
        events: [...raw.events, { kind: "cpu-read", address: 0x2007 }],
      },
      f,
    );
    expect(resumed.steps[0]).toMatchObject({
      cpu_read: {
        value,
        source: { alternatives: [{ mode: "buffered", sources: [atom] }] },
      },
    });
    expect(resumed.final).toEqual(whole.final);
    expect(resumed.ppu_trace.final).toEqual(whole.ppu_trace.final);
    expect(resumed.ppu_trace.final.next_event_index).toBe(103);
    if (mapper.exram_mode === 0) {
      if (prefix.final.mapper !== 5) throw new Error("Missing MMC5 state");
      expect(readMmc5ExramCell(prefix.final, 0)).toEqual({
        address: 0,
        value: 117,
        origin: { kind: "event-write", index: 101 },
      });
    }
  },
);

it.each([
  {
    name: "unqualified rendering read",
    qualifications: { access_phase: "unknown", mask: 24 },
    access: { kind: "cpu-read", address: 0x2007 },
  },
  {
    name: "unobserved DMA repeats",
    qualifications: { dma_reads: "unobserved" },
    access: { kind: "cpu-read", address: 0x2007 },
  },
  {
    name: "DMA PPU mirror page",
    qualifications: {
      oam: {
        model: "oam-memory",
        retention: "stable",
        reads: "supported",
        dma_pending: { status: "pending", page: 0x20 },
      },
    },
    access: { kind: "oam-dma", page: 0x20, values: Array<number>(256).fill(0) },
  },
])(
  "invalidates an active MMC5 background phase on $name while preserving held captures",
  async ({ qualifications, access }) => {
    const oldCapture = {
      address: 7,
      value: 131,
      origin: { kind: "event-write", index: 89 },
    };
    const { result, f } = await supplied({
      path: "/retained-mmc5.nes",
      initial: initial({
        ppu: {
          model: "mmc5-background",
          pin92_high: true,
          phase: "pattern-high",
          paths: ["normal"],
          nametable_address: 0x2000,
          tile_column: 0,
          tile_value: 17,
          pattern_address: 0x110,
          extended_attribute: oldCapture,
        },
      }),
      initial_ppu: ppu(qualifications),
      events: [
        access,
        { kind: "ppu-read", address: 0x118, mmc5_fetch: "background" },
      ],
    });
    const afterAccess = nesMapperEventSnapshot(result, result.steps[0]!);
    expect(afterAccess?.state).toMatchObject({
      mapper: 5,
      ppu: {
        phase: "unknown",
        tile_value: 17,
        pattern_address: 0x110,
        extended_attribute: oldCapture,
      },
    });
    expect(result.steps[1]!.read_source).toMatchObject({
      value: f.chr[1024 + 0x118],
      mmc5: {
        rendering: {
          fetch: "pattern-high",
          paths: ["normal"],
          reason: "missing-tile",
          extended_attribute: oldCapture,
        },
      },
    });
    expect(result.final).toMatchObject({
      ppu: {
        phase: "unknown",
        tile_value: 17,
        pattern_address: 0x110,
        extended_attribute: oldCapture,
      },
    });
  },
);

it.each([0, 1])(
  "shares held mode %s frame facts between Context writes and supplied replay while retaining source admission",
  async (mode) => {
    const program = [
      0xa9, 90, 0x8d, 0, 0x5c, 0xa9, 2, 0x8d, 4, 0x51, 0xad, 0, 0x5c, 2,
    ];
    for (const inFrame of [true, false, null]) {
      const f = fixture(program),
        input = traceNesCodeInputSchema.parse({
          path: "/retained-mmc5.nes",
          entry: 0xe000,
          initial: initial({ exram_mode: mode }),
          initial_ppu: ppu({ next_event_index: 300 }),
          initial_cpu_bus: {
            model: "nmos-6502-bus",
            dma_reads: "absent",
            next_cycle_index: 7,
          },
          initial_irq: {
            model: "mmc5",
            in_frame: inFrame,
            enabled: false,
            pending: false,
            asserted: false,
            counter: 0,
          },
        });
      // Direct producer ownership can retain a supplied frame fact; public source admission does not infer PPU clocks.
      const context = new Nes6502Context(
        f.header,
        f.prg,
        structuredClone(input.initial),
        {
          cpu: structuredClone(input.cpu),
          initialRam: input.initial_ram,
          initialPrgRam: input.initial_prg_ram,
          initialPpu: input.initial_ppu,
          initialIrq: input.initial_irq,
          initialCpuBus: input.initial_cpu_bus,
          chr: f.chr,
        },
      );
      context.instructionIndex = 0;
      context.write(0x5c00, 90);
      context.instructionIndex = 1;
      context.writes = [];
      context.write(0x5104, 2);
      expect(context.read(0x5c00)).toBe(inFrame === true ? 90 : null);
      if (context.mapper.mapper !== 5)
        throw new Error("Missing Context MMC5 state");
      expect(readMmc5ExramCell(context.mapper, 0)).toEqual(
        inFrame === true
          ? {
              address: 0,
              value: 90,
              origin: { kind: "event-write", index: 300 },
            }
          : { address: 0, value: null, origin: null },
      );
      const operand = context.dataReads.at(-1)!;
      expect(operand.value).toBe(inFrame === true ? 90 : null);
      if (inFrame === true)
        expect(operand.mapper_origins).toMatchObject([
          {
            kind: "mmc5-exram",
            byte_source: { kind: "event-write", index: 300 },
          },
        ]);
      const replay = await deriveNesMapperEvents(
        f.header,
        input.initial,
        context.mapperEvents,
        {
          prg: f.prg,
          chr: f.chr,
          initialPpu: input.initial_ppu,
          initialIrq: input.initial_irq,
        },
      );
      if (replay.status !== "derived" || !("ppu_trace" in replay))
        throw new Error("Missing replay");
      expect(replay.final).toEqual(context.mapper);
      expect(replay.ppu_trace.final).toEqual(context.ppu);
      if (inFrame === true)
        expect(
          await deriveNesCode(f.header, f.prg, input, { chr: f.chr }),
        ).toMatchObject({
          status: "unsupported",
          reason: expect.stringContaining("qualified PPU signals"),
        });
    }
    const { result } = await source(program, {
      initial: initial({ exram_mode: mode }),
      initial_ppu: ppu({ next_event_index: 300 }),
    });
    expect(result.stop.reason).toBe("unsupported-opcode");
    if (
      result.mapper_trace.status !== "derived" ||
      result.mapper_trace.final.mapper !== 5
    )
      throw new Error("Missing committed source state");
    expect(readMmc5ExramCell(result.mapper_trace.final, 0)).toEqual({
      address: 0,
      value: null,
      origin: null,
    });
    expect(result.instructions.at(-1)!.data_reads[0]).toMatchObject({
      value: null,
      file_offset: null,
      mapper_origins: [],
    });
  },
);

it.each([null, 100])(
  "rejects retained ExRAM event origins with missing or nonpreceding PPU cursor %s",
  async (cursor) => {
    const f = fixture([2]),
      retained = initial({
        exram: {
          "0": { value: 106, origin: { kind: "event-write", index: 100 } },
        },
      }),
      selectedPpu = cursor === null ? null : ppu({ next_event_index: cursor });
    const eventInput = traceNesMapperEventsInputSchema.parse({
      path: "/retained-mmc5.nes",
      initial: retained,
      initial_ppu: selectedPpu,
      events: [],
    });
    const result = await deriveNesMapperEvents(
      f.header,
      eventInput.initial,
      [],
      { initialPpu: eventInput.initial_ppu, chr: f.chr },
    );
    expect(result).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("ExRAM"),
    });
    const codeInput = traceNesCodeInputSchema.parse({
      path: "/retained-mmc5.nes",
      entry: 0xe000,
      initial: retained,
      initial_ppu: selectedPpu,
    });
    expect(
      await deriveNesCode(f.header, f.prg, codeInput, { chr: f.chr }),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("ExRAM"),
    });
  },
);

it("retains an unapplied JMP's ExRAM buffer refill only in the PPU frontier", async () => {
  const { result, input } = await source([0x6c, 6, 0x20], {
    initial: initial({
      nametable_control: 170,
      exram: {
        "0": { value: 106, origin: { kind: "event-write", index: 90 } },
      },
    }),
    initial_ppu: ppu({ read_buffer: { value: null } }),
  });
  expect(result.instructions).toEqual([]);
  expect(result.stop.reason).toBe("unknown-control-target");
  const mapped = result.mapper_trace;
  if (mapped.status !== "derived" || !("ppu_trace" in mapped))
    throw new Error("Missing frontier trace");
  expect(mapped.steps).toEqual([]);
  expect(mapped.final).toEqual(input.initial);
  expect(mapped.ppu_trace.final.next_event_index).toBe(100);
  expect(mapped.ppu_trace.final.read_buffer.value).toBeNull();
  expect(mapped.ppu_trace.final.v).toEqual({ low: 0, high: 32 });
  expect(mapped.ppu_trace.coverage.bus_reads).toBe(0);
  expect(
    mapped.ppu_trace.frontier.map((operation) => operation.event_index),
  ).toEqual([100, 101]);
  expect(mapped.ppu_trace.frontier[1]!.bus_reads[0]).toMatchObject({
    value: 106,
    sources: [
      {
        kind: "mmc5-exram",
        address: 0,
        value: 106,
        origin: { kind: "event-write", index: 90 },
      },
    ],
  });
});

it.each([
  {
    name: "possible ExRAM",
    control: { mask: 1, value: 0 },
    mode: 0,
    invalidates: true,
  },
  { name: "mode-2 zero", control: 170, mode: 2, invalidates: false },
  { name: "mode-3 zero", control: 170, mode: 3, invalidates: false },
  { name: "read-only fill", control: 255, mode: 0, invalidates: false },
])(
  "scopes an unqualified rendering PPUDATA write for $name without erasing captured history",
  async ({ control, mode, invalidates }) => {
    const captured = {
      model: "mmc5-background",
      phase: "pattern-high",
      paths: ["normal"],
      tile_value: 17,
      pattern_address: 0x110,
      extended_attribute: {
        address: 7,
        value: 131,
        origin: { kind: "event-write", index: 89 },
      },
    };
    const raw = {
      path: "/retained-mmc5.nes",
      initial: initial({
        nametable_control: control,
        exram_mode: mode,
        exram: {
          "0": { value: 106, origin: { kind: "event-write", index: 90 } },
          "7": { value: 170, origin: { kind: "event-write", index: 91 } },
        },
        ppu: captured,
      }),
      initial_ppu: ppu({
        access_phase: "unknown",
        mask: 24,
        read_buffer: {
          value: 106,
          sources: [
            {
              kind: "mmc5-exram",
              address: 0,
              cell_value: 106,
              attribute_shift: null,
              value: 106,
              mask: 255,
              origin: { kind: "event-write", index: 90 },
            },
          ],
        },
      }),
      events: [{ kind: "cpu-write", address: 0x2007, value: 68 }],
    };
    const before = structuredClone(raw),
      { result, input } = await supplied(raw);
    if (input.initial.mapper !== 5 || input.initial_ppu === null)
      throw new Error("Missing initial MMC5/PPU state");
    expect(result.final).toMatchObject({
      exram: invalidates ? {} : input.initial.exram,
      ppu: captured,
    });
    if (result.final.mapper !== 5) throw new Error("Missing MMC5 state");
    expect(Object.keys(result.final.exram)).toEqual(
      invalidates ? [] : ["0", "7"],
    );
    expect(result.ppu_trace.final.read_buffer).toEqual(
      input.initial_ppu.read_buffer,
    );
    expect(result.ppu_trace.final.next_event_index).toBe(101);
    const operation = result.ppu_trace.operations[0]!;
    expect(operation.write).toMatchObject({
      status: "unverified",
      reason: "unverified-rendering-access",
    });
    if (invalidates)
      expect(operation.write?.invalidated_spaces).toContain("mmc5-exram");
    else
      expect(operation.write?.invalidated_spaces).not.toContain("mmc5-exram");
    expect(raw).toEqual(before);
  },
);
