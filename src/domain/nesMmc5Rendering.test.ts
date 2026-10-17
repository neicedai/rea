import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import {
  mmc5RenderingFixture,
  mmc5ExtendedInput,
  mmc5SplitInput,
} from "./nesMmc5Rendering.fixture.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsTraceSchema,
} from "./nesMapperEvents.js";
import { nesMmc5StateSchema } from "./nesMmc5.js";
import { readMmc5BackgroundPpu } from "./nesMmc5Rendering.js";
import { nextMmc5SplitY } from "./nesMmc5RenderingState.js";
import {
  nesByteCandidates,
  joinNesBytes,
  type NesByteValue,
} from "./nesByteValue.js";

const f = mmc5RenderingFixture(),
  parsed = parseNesHeader(f.bytes);
if (!parsed.ok) throw new Error(parsed.error);
const header = parsed.value,
  chr = f.bytes.subarray(f.chrOffset);
async function trace(raw: unknown) {
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/render.nes",
    ...(raw as object),
  });
  const result = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(header, input.initial, input.events, {
      chr,
      initialIrq: input.initial_irq,
    }),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  if ("mapper_snapshots" in result)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  return result;
}
const valueAt = (bank: number, offset: number) =>
  f.bytes[f.chrOffset + bank * 4096 + offset]!;

it("captures per-tile extended attributes, retains overwritten ExRAM facts and uses live upper bank bits", async () => {
  const before = structuredClone(mmc5ExtendedInput),
    result = await trace(mmc5ExtendedInput);
  expect(result.steps[1]!.read_source).toMatchObject({
    value: 17,
    mmc5: {
      nametable_sources: ["fill"],
      rendering: { paths: ["extended"], tile_y: 235 },
    },
  });
  expect(result.steps[2]!.read_source).toMatchObject({
    status: "exram",
    value: 170,
    mmc5: {
      registers: [],
      chr_sets: [],
      rendering: { extended_attribute: { address: 37, value: 131 } },
    },
  });
  for (const [index, bank, offset] of [
    [5, 67, 0x112],
    [9, 131, 0x11a],
  ])
    expect(result.steps[index!]!.read_source).toMatchObject({
      status: "chr-rom",
      file_offset: f.chrOffset + bank! * 4096 + offset!,
      value: valueAt(bank!, offset!),
      mmc5: {
        registers: [],
        rom_sources: {
          status: "examined",
          file_offsets: [f.chrOffset + bank! * 4096 + offset!],
        },
      },
    });
  expect(result.final).toMatchObject({
    exram: { "37": null },
    ppu: { phase: "idle", extended_attribute: { address: 37, value: 131 } },
  });
  expect(mmc5ExtendedInput).toEqual(before);
  const resumed = await trace({
    initial: result.steps[5]!.state,
    events: mmc5ExtendedInput.events.slice(6),
  });
  expect(resumed.final).toEqual(result.final);
  expect(resumed.steps.map(({ index: _index, ...s }) => s)).toEqual(
    result.steps.slice(6).map(({ index: _index, ...s }) => s),
  );
});

it("gives split priority, uses held scroll and quadrant palettes, and reads live split bank bytes", async () => {
  const result = await trace(mmc5SplitInput);
  expect(result.steps[1]!.read_source).toMatchObject({
    status: "exram",
    value: 33,
    mmc5: {
      nametable_sources: ["exram"],
      rendering: {
        paths: ["split"],
        split_tiles: [{ address: 933, value: 33 }],
      },
    },
  });
  expect(result.steps[3]!.read_source).toMatchObject({
    value: 85,
    mmc5: {
      rendering: {
        extended_attribute: null,
        split_attributes: [{ address: 1017, shift: 0, value: 109 }],
      },
    },
  });
  for (const [index, bank, offset] of [
    [4, 7, 0x213],
    [6, 9, 0x21b],
  ])
    expect(result.steps[index!]!.read_source).toMatchObject({
      file_offset: f.chrOffset + bank! * 4096 + offset!,
      value: valueAt(bank!, offset!),
      mmc5: { rendering: { pattern_rows: [3] } },
    });
  expect(result.final).toMatchObject({
    split: [144, 17, 9],
    ppu: { split_y: 236, tile_y: 235, phase: "unknown" },
  });
  expect(
    (
      await trace({
        initial: result.final,
        events: [{ kind: "mmc5-render-frame" }],
      })
    ).final,
  ).toMatchObject({ ppu: { split_y: 17 } });
});

it.each(["cl", "sl", null] as const)(
  "retains the physical fine-Y alternatives for wiring %s",
  async (split_wiring) => {
    const result = await trace({
      ...mmc5SplitInput,
      initial: {
        ...mmc5SplitInput.initial,
        ppu: { ...mmc5SplitInput.initial.ppu, split_wiring },
      },
    });
    const rows =
      split_wiring === "cl" ? [1] : split_wiring === "sl" ? [3] : [1, 3];
    expect(result.steps[4]!.read_source).toMatchObject({
      status: rows.length === 1 ? "chr-rom" : "unknown-chr-offset",
      bank: 28,
      mmc5: {
        rom_sources: {
          file_offsets: rows.map((row) => f.chrOffset + 7 * 4096 + 0x210 + row),
        },
        rendering: { pattern_rows: rows },
      },
    });
  },
);

it("matches every split side/threshold/column against an independent region oracle", () => {
  const state = nesMmc5StateSchema.parse(mmc5SplitInput.initial);
  if (!("ppu" in state)) throw new Error("Expected rendering state");
  state.ppu.split_y = 7;
  for (let control = 0; control < 256; control++)
    for (let column = 0; column < 32; column++) {
      state.split[0] = control;
      readMmc5BackgroundPpu(header, state, 0x2000, {
        fetch: "background",
        tile: { column, line: "current" },
      });
      const split =
        control >= 128 &&
        ((control & 64) === 0 ? column < control % 32 : column >= control % 32);
      expect(state.ppu.paths).toEqual([split ? "split" : "extended"]);
    }
});

it("covers all 2816 ordinary/extended/split byte origins without inferring absent screen coordinates", async () => {
  const result = await trace({
    initial: { mapper: 5, ppu: { model: "mmc5-background" } },
    events: [
      { kind: "ppu-read", address: 0x2000, mmc5_fetch: "background" },
      { kind: "ppu-read", address: 0x23c0, mmc5_fetch: "background" },
      { kind: "ppu-read", address: 0, mmc5_fetch: "background" },
    ],
  });
  const expected = new Set(
    Array.from({ length: 1024 }, (_, bank) => f.chrOffset + bank * 1024),
  );
  for (let bank = 0; bank < 256; bank++)
    for (let row = 0; row < 8; row++)
      expected.add(f.chrOffset + bank * 4096 + row);
  expect(expected.size).toBe(2816);
  expect(result.steps[2]!.read_source).toMatchObject({
    bank: null,
    file_offset: null,
    value: null,
    mmc5: {
      rom_sources: {
        status: "examined",
        file_offsets: [...expected].sort((a, b) => a - b),
      },
      rendering: { paths: ["normal", "extended", "split"] },
    },
  });
  expect(result.final).toMatchObject({ ppu: { tile_column: null } });
});

it("preserves invalid-origin rows and next-line prefetch without advancing the held scanline", async () => {
  const base = {
    ...mmc5SplitInput.initial,
    split: [0xc0, 239, 7],
    exram: { "0": 33 },
  };
  const events = [
    { kind: "mmc5-render-frame" },
    {
      kind: "ppu-read",
      address: 0x2000,
      mmc5_fetch: "background",
      mmc5_tile: { column: 0, line: "next" },
    },
  ];
  const result = await trace({ initial: base, events });
  expect(result.final).toMatchObject({
    ppu: { split_y: 239, tile_y: 0, split_tiles: [{ address: 0, value: 33 }] },
  });
  const line = await trace({
    initial: result.final,
    events: [{ kind: "mmc5-render-line" }],
  });
  expect(line.final).toMatchObject({ ppu: { split_y: 0 } });
  const invalid = await trace({
    initial: { ...base, split: [0xc0, 240, 7], exram: { "960": 34 } },
    events: [
      events[0],
      { ...events[1], mmc5_tile: { column: 0, line: "current" } },
    ],
  });
  expect(invalid.final).toMatchObject({
    ppu: {
      split_y: 240,
      tile_y: 240,
      split_tiles: [{ address: 960, value: 34 }],
    },
  });
});

it("matches all partial split-counter transitions against concrete wrap outcomes", () => {
  const next = Array.from({ length: 256 }, (_, y) => (y + 1) % 256);
  next[239] = 0;
  for (let mask = 0; mask < 256; mask++)
    for (let value = 0; value < 256; value++) {
      if ((value & ~mask) !== 0) continue;
      const input: NesByteValue =
        mask === 0 ? null : mask === 255 ? value : { mask, value };
      const expected = nesByteCandidates(input)
        .map<NesByteValue>((n) => next[n]!)
        .reduce(joinNesBytes);
      expect(nextMmc5SplitY(input)).toEqual(expected);
    }
});

it.each([
  { pin92_high: false, ppu_mask: 24, exram_mode: 1, paths: ["normal"] },
  { pin92_high: null, ppu_mask: 24, exram_mode: 1, paths: ["normal", "split"] },
  {
    pin92_high: true,
    ppu_mask: { mask: 8, value: 8 },
    exram_mode: { mask: 2, value: 0 },
    paths: ["split"],
  },
  {
    pin92_high: true,
    ppu_mask: { mask: 8, value: 0 },
    exram_mode: 1,
    paths: ["normal", "split"],
  },
  {
    pin92_high: true,
    ppu_mask: 24,
    exram_mode: { mask: 1, value: 0 },
    paths: ["normal", "split"],
  },
])(
  "joins gates, pin and modes without using an override as an ordinary source: %j",
  async ({ pin92_high, ppu_mask, exram_mode, paths }) => {
    const result = await trace({
      ...mmc5SplitInput,
      initial: {
        ...mmc5SplitInput.initial,
        ppu_mask,
        exram_mode,
        ppu: { ...mmc5SplitInput.initial.ppu, pin92_high },
      },
    });
    expect(result.steps[1]!.read_source).toMatchObject({
      mmc5: { rendering: { paths } },
    });
    const hasNormal = paths.includes("normal"),
      hasSplit = paths.includes("split");
    if (hasNormal && hasSplit)
      expect(result.steps[3]!.read_source).toMatchObject({
        status: "unknown-nametable-bank",
        value: null,
        known_bits: { mask: 170, value: 0 },
      });
    if (hasSplit && !hasNormal)
      expect(result.steps[1]!.read_source).toMatchObject({
        mmc5: { cell_address: 933, cell_value: 33 },
      });
  },
);

it.each([
  { kind: "cpu-write", address: 0x5104, value: 0 },
  { kind: "cpu-write", address: 0x5200, value: 128 },
  { kind: "cpu-write", address: 0x2001, value: 0 },
  { kind: "ppu-read", address: 0, mmc5_fetch: "sprite" },
  { kind: "ppu-read", address: 0x2000, mmc5_fetch: "dummy" },
  { kind: "ppu-read", address: 0 },
])(
  "invalidates active context on meaningful control/intervening fetch %j",
  async (event) => {
    const result = await trace({
      ...mmc5ExtendedInput,
      events: [
        ...mmc5ExtendedInput.events.slice(0, 3),
        event,
        mmc5ExtendedInput.events[5],
      ],
    });
    expect(result.steps[3]!.state).toMatchObject({
      ppu: {
        phase: "unknown",
        extended_attribute: { address: 37, value: 131 },
      },
    });
  },
);

it("does not reuse a stale tile latch after a missing or contradictory fetch", async () => {
  for (const address of [0x111a, 0x1122]) {
    const result = await trace({
      ...mmc5ExtendedInput,
      events: [
        ...mmc5ExtendedInput.events.slice(0, 3),
        { kind: "ppu-read", address, mmc5_fetch: "background" },
      ],
    });
    expect(result.steps[3]!.read_source).toMatchObject({
      value: null,
      file_offset: null,
      mmc5: {
        rom_sources: { status: "unresolved", reason: "rendering-context" },
      },
    });
  }
});

it("does not use an inactive outside-split column to prove a subsequent ordinary byte", async () => {
  const initial = {
    ...mmc5SplitInput.initial,
    exram_mode: 0,
    ppu_control: 0,
    chr_mode: 3,
    chr_banks: [5, ...Array(11).fill(null)],
    chr_bank_modes: [3, ...Array(11).fill(null)],
    chr_bank_upper: [0, ...Array(11).fill(null)],
    ppu: {
      ...mmc5SplitInput.initial.ppu,
      phase: "unknown",
      tile_column: 31,
      paths: ["normal"],
    },
  };
  const result = await trace({
    initial,
    events: [{ kind: "ppu-read", address: 0, mmc5_fetch: "background" }],
  });
  expect(result.steps[0]!.read_source).toMatchObject({
    value: null,
    file_offset: null,
    mmc5: {
      rom_sources: {
        status: "unresolved",
        reason: "rendering-context",
        file_offsets: [f.chrOffset + 5 * 1024],
      },
      rendering: {
        paths: ["normal", "split"],
        reason: "missing-tile",
        tile_column: 31,
      },
    },
  });
});
