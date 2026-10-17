import { nesVrcIrqStateSchema } from "./nesVrcIrq.js";
import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { vrc6Fixture } from "./nesVrc6.fixture.js";
import { nesVrc6StateSchema, vrc6PpuMapping } from "./nesVrc6.js";
import {
  nesMapperStateSchema,
  nesMapperWriteSchema,
} from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { traceNesMapperEventsInputSchema } from "./nesMapperEvents.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { resolveNesMapperLayout } from "./nesMapper.js";

const header = () => {
  const parsed = parseNesHeader(vrc6Fixture(24).bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const raw = [0x81, 0x88, 0x90, 0x99, 0xa0, 0xa9, 0xb1, 0xb8];
// Concrete chip table: register sources for low control nibble 0..F.
const ntRegs = [
  [6, 6, 7, 7],
  [4, 5, 6, 7],
  [6, 7, 6, 7],
  [6, 7, 6, 7],
  [6, 7, 6, 7],
  [4, 5, 6, 7],
  [6, 6, 7, 7],
  [6, 6, 7, 7],
  [6, 6, 7, 7],
  [4, 5, 6, 7],
  [6, 7, 6, 7],
  [6, 7, 6, 7],
  [6, 7, 6, 7],
  [4, 5, 6, 7],
  [6, 6, 7, 7],
  [6, 6, 7, 7],
];
const forced: Record<number, number[]> = {
  0: [0, 1, 0, 1],
  3: [0, 0, 1, 1],
  4: [0, 0, 1, 1],
  7: [0, 1, 0, 1],
  8: [0, 0, 0, 0],
  11: [1, 1, 1, 1],
  12: [1, 1, 1, 1],
  15: [0, 0, 0, 0],
};
const expected = (control: number) => {
  const mode = control & 3,
    force = (control & 32) !== 0;
  const regs =
    mode === 0
      ? [0, 1, 2, 3, 4, 5, 6, 7]
      : mode === 1
        ? [0, 0, 1, 1, 2, 2, 3, 3]
        : [0, 1, 2, 3, 4, 4, 5, 5];
  const chr = regs.map((reg, slot) =>
    force && (mode === 1 || (mode >= 2 && slot >= 4))
      ? (raw[reg]! & 254) | (slot & 1)
      : raw[reg]!,
  );
  const rom = (control & 16) !== 0,
    override = force ? forced[control & 15] : undefined;
  const nt = ntRegs[control & 15]!.map((reg, slot) => {
    const value =
      override === undefined ? raw[reg]! : (raw[reg]! & 254) | override[slot]!;
    return { source: rom ? "chr-rom" : "ciram", bank: rom ? value : value & 1 };
  });
  return { chr, nt };
};

it("matches all 64 B003 PPU modes against independent concrete page tables", () => {
  const h = header();
  for (let control = 0; control < 64; control++) {
    const actual = vrc6PpuMapping(
      h,
      nesVrc6StateSchema.parse({ mapper: 24, control, chr_banks: raw }),
    );
    const oracle = expected(control);
    expect(actual.chr).toEqual(oracle.chr);
    expect(
      actual.nametables.map(({ source, bank }) => ({ source, bank })),
    ).toEqual(oracle.nt);
    for (const window of actual.nametables)
      expect(window.file_offset).toBe(
        window.source === "chr-rom"
          ? h.chrRom.offset + window.bank! * 1024
          : null,
      );
  }
});

it("joins every partial six-bit control proof without selecting an unproven source", () => {
  const h = header();
  for (let ternary = 0; ternary < 729; ternary++) {
    let n = ternary,
      mask = 0,
      value = 0;
    for (let bit = 0; bit < 6; bit++) {
      const digit = n % 3;
      n = Math.floor(n / 3);
      if (digit) {
        mask |= 1 << bit;
        if (digit === 2) value |= 1 << bit;
      }
    }
    const control = mask === 0 ? null : { mask, value };
    const candidates = Array.from({ length: 64 }, (_, v) => v)
      .filter((v) => (v & mask) === value)
      .map(expected);
    const actual = vrc6PpuMapping(
      h,
      nesVrc6StateSchema.parse({ mapper: 26, control, chr_banks: raw }),
    );
    expect(actual.chr).toEqual(
      Array.from({ length: 8 }, (_, slot) =>
        candidates.every((c) => c.chr[slot] === candidates[0]!.chr[slot])
          ? candidates[0]!.chr[slot]
          : null,
      ),
    );
    for (let slot = 0; slot < 4; slot++) {
      const sameSource = candidates.every(
        (c) => c.nt[slot]!.source === candidates[0]!.nt[slot]!.source,
      );
      expect(actual.nametables[slot]!.source).toBe(
        sameSource ? candidates[0]!.nt[slot]!.source : "unknown",
      );
      expect(actual.nametables[slot]!.bank).toBe(
        sameSource &&
          candidates.every(
            (c) => c.nt[slot]!.bank === candidates[0]!.nt[slot]!.bank,
          )
          ? candidates[0]!.nt[slot]!.bank
          : null,
      );
    }
  }
});

it.each([24, 26] as const)(
  "traces Mapper %i RAM, audio facts and 16/8 KiB switching with source provenance",
  async (mapper) => {
    const { bytes, initial } = vrc6Fixture(mapper);
    const parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const input = traceNesCodeInputSchema.parse({ path: "/vrc6.nes", initial });
    const trace = await deriveNesCode(
      parsed.value,
      bytes.subarray(528, 528 + 65536),
      input,
    );
    if (trace.status !== "derived" || trace.mapper_trace.status !== "derived")
      throw new Error(JSON.stringify(trace));
    expect(trace.stop.reason).toBe("return");
    expect(trace.final_cpu.a).toBe(0x77);
    expect(trace.instructions.find((i) => i.address === 0xbfff)).toMatchObject({
      bytes_hex: "a95a",
      file_offsets: [528 + 6 * 8192 - 1, 528 + 4 * 8192],
    });
    expect(
      trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
    ).toEqual([4, 5, 4, 7]);
    expect(trace.mapper_trace.final).toMatchObject({
      audio_registers: [null, null, null, 7, null, null, 128, null, null, null],
    });
    expect(
      trace.instructions
        .find((i) => i.mnemonic === "INC")
        ?.writes.map((w) => w.value),
    ).toEqual([0x44, 0x45]);
    const replay = deriveNesMapperTrace(
      parsed.value,
      input.initial,
      trace.instructions.flatMap((i) => i.writes),
    );
    if (replay.status !== "derived") throw new Error(replay.reason);

    expect(replay.final).toEqual(trace.mapper_trace.final);
    expect(replay.final_mapping).toEqual(trace.mapper_trace.final_mapping);
    expect(replay.nes_prg_views).toEqual(trace.mapper_trace.nes_prg_views);
    const layout = resolveNesMapperLayout(parsed.value, [
      trace.mapper_trace.final_mapping.prg_view!,
    ]);
    if (!layout.ok) throw new Error(layout.error);
    expect(layout.value.mappings.slice(-4).map((w) => w.bank)).toEqual([
      4, 5, 4, 7,
    ]);
  },
);

it.each([24, 26] as const)(
  "keeps Mapper %i CPU cycle IRQ clocks separate from writes and PPU reads",
  async (mapper) => {
    const { bytes, port } = vrc6Fixture(mapper);
    const parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const input = traceNesMapperEventsInputSchema.parse({
      path: "/vrc6.nes",
      initial: { mapper },
      initial_irq: { model: "vrc6" },
      events: [
        { kind: "cpu-write", address: port(0xf000, 0), value: 254 },
        { kind: "cpu-write", address: port(0xf000, 1), value: 7 },
        { kind: "ppu-read", address: 0 },
        { kind: "vrc-cpu-cycle" },
        { kind: "vrc-cpu-cycle" },
        { kind: "cpu-write", address: port(0xf000, 2), value: 0 },
      ],
    });
    const trace = await deriveNesMapperEvents(
      parsed.value,
      input.initial,
      input.events,
      { initialIrq: input.initial_irq },
    );
    if (trace.status !== "derived") throw new Error(trace.reason);

    expect(trace.steps[2]?.irq).toMatchObject({
      counter: 254,
      asserted: false,
      prescaler: [341],
    });
    expect(trace.steps[4]?.irq).toMatchObject({
      model: "vrc6",
      counter: 254,
      asserted: true,
      prescaler: null,
    });
    expect(trace.final_irq).toMatchObject({
      counter: 254,
      asserted: false,
      prescaler: null,
    });
    expect(
      (
        await deriveNesMapperEvents(parsed.value, input.initial, input.events, {
          initialIrq: nesVrcIrqStateSchema.parse({ model: "vrc4" }),
        })
      ).status,
    ).toBe("unsupported");
  },
);

it("uses only connected selector bits and rejects separate PCB capacities", () => {
  const h = header();
  const initial = nesMapperStateSchema.parse({
    mapper: 24,
    prg_bank_16k: { mask: 1, value: 1 },
    prg_bank_8k: { mask: 7, value: 5 },
    control: 0x21,
    chr_banks: Array.from({ length: 8 }, () => ({ mask: 254, value: 254 })),
  });
  const trace = deriveNesMapperTrace(h, initial, []);
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    null,
    null,
    5,
    7,
  ]);
  expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
    254, 255, 254, 255, 254, 255, 254, 255,
  ]);
  for (const changed of [
    { ...h, submapper: 1 },
    { ...h, mirroring: "four-screen" as const },
    { ...h, chrRom: { ...h.chrRom, size: 524288 } },
  ])
    expect(deriveNesMapperTrace(changed, initial, []).status).toBe(
      "unsupported",
    );
  const unknown = deriveNesMapperTrace(h, initial, [
    nesMapperWriteSchema.parse({ address: 0xd000, value: null }),
  ]);
  expect(unknown.status).toBe("derived");
});

it("retains forced CIRAM pages and pattern aliases without inventing unobserved bytes", async () => {
  const h = header();
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/vrc6.nes",
    initial: { mapper: 24, control: 0x20 },
    events: [
      { kind: "ppu-read", address: 0x2401 },
      { kind: "ppu-read", address: 0x3401 },
      { kind: "ppu-read", address: 0x3f00 },
    ],
  });
  const trace = await deriveNesMapperEvents(h, input.initial, input.events);
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.steps.map((s) => s.read_source)).toEqual([
    { status: "ciram-unobserved", bank: 1, file_offset: null },
    { status: "ciram-unobserved", bank: 1, file_offset: null },
    { status: "outside-pattern-tables", bank: null, file_offset: null },
  ]);
  expect(trace.coverage).toMatchObject({
    unknown_nametable_reads: 2,
    unknown_pattern_reads: 0,
  });
  const unknownMode = vrc6PpuMapping(
    h,
    nesVrc6StateSchema.parse({ mapper: 24, chr_banks: Array(8).fill(4) }),
  );
  expect(unknownMode.chr).toEqual([4, null, 4, null, 4, null, 4, null]);
  expect(
    unknownMode.nametables.every(
      (w) => w.source === "unknown" && w.file_offset === null,
    ),
  ).toBe(true);
});

it.each([0, 5, 0x55])(
  "rejects PRG RAM assumptions for unestablished capacity %i",
  async (declaration) => {
    const { bytes, initial } = vrc6Fixture(24, declaration);
    const parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const trace = await deriveNesCode(
      parsed.value,
      bytes.subarray(528, 528 + 65536),
      traceNesCodeInputSchema.parse({
        path: "/vrc6.nes",
        initial,
        entry: 0x6000,
        initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x60 }],
      }),
    );
    expect(trace.status).toBe("unsupported");
  },
);

it("resumes a VRC6 scanline divider without implicit write cycles", async () => {
  const h = header();
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/vrc6.nes",
    initial: { mapper: 24, irq_latch: 254, irq_control: 3, irq_enabled: true },
    initial_irq: {
      model: "vrc6",
      counter: 254,
      prescaler: [341],
      asserted: false,
    },
    events: Array.from({ length: 341 }, () => ({ kind: "vrc-cpu-cycle" })),
  });
  const trace = await deriveNesMapperEvents(h, input.initial, input.events, {
    initialIrq: input.initial_irq,
  });
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.steps.flatMap((s, i) => (s.irq_clock ? [i] : []))).toEqual([
    113, 227, 340,
  ]);
  const first = await deriveNesMapperEvents(
    h,
    input.initial,
    input.events.slice(0, 150),
    { initialIrq: input.initial_irq },
  );
  if (first.status !== "derived") throw new Error(first.reason);

  const rest = await deriveNesMapperEvents(
    h,
    first.final,
    input.events.slice(150),
    { initialIrq: first.final_irq },
  );
  if (rest.status !== "derived") throw new Error(rest.reason);

  expect(rest.final_irq).toEqual(trace.final_irq);
});

it("retains the known 16 KiB pair on a small cartridge with unknown raw selectors", () => {
  const bytes = Buffer.alloc(528 + 16384 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 1, 1, 0x84, 0x18]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const trace = deriveNesMapperTrace(
    parsed.value,
    nesMapperStateSchema.parse({ mapper: 24 }),
    [],
  );
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.initial_mapping.prg_windows.map((w) => w.bank)).toEqual([
    0,
    1,
    null,
    1,
  ]);
  expect(trace.initial_mapping.prg_view).toBeNull();
  const layout = resolveNesMapperLayout(parsed.value);
  if (!layout.ok) throw new Error(layout.error);
  expect(layout.value.mappings.map((w) => w.bank)).toEqual([0, 1, 0, 1]);
});
