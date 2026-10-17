import { nesMapperEventSnapshot } from "./nesMapperEvents.js";
import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mmc5Fixture } from "./nesMmc5.fixture.js";
import { nesMmc5StateSchema, applyMmc5Write, mmc5Mapping } from "./nesMmc5.js";
import {
  mmc5ChrWindows,
  readMmc5Ppu,
  writeMmc5Ppu,
  nesMmc5PpuReadSchema,
} from "./nesMmc5Ppu.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { traceNesMapperEventsInputSchema } from "./nesMapperEvents.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";

const header = (chrSize = 1048576) => {
  const fixture = mmc5Fixture();
  const bytes = Buffer.alloc(fixture.prgOffset + fixture.prgSize + chrSize);
  fixture.bytes.copy(bytes);
  bytes[5] = chrSize / 8192;
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const state = () =>
  nesMmc5StateSchema.parse({
    mapper: 5,
    ppu_control: 32,
    ppu_mask: 24,
    exram_mode: 2,
    split: [0, null, null],
  });
const write = (s: ReturnType<typeof state>, address: number, value: number) =>
  applyMmc5Write(s, { address, value, preceded_by_cpu_write: null });

it("derives common CHR bytes from every physical source while retaining all source offsets", () => {
  const h = header(32768),
    s = state(),
    chr = Buffer.alloc(32768, 0x95);
  write(s, 0x5101, 3);
  write(s, 0x5130, 0);
  write(s, 0x5120, 3);
  const exact = nesMmc5PpuReadSchema.parse(
    readMmc5Ppu(h, s, 0x12, { fetch: "sprite", chr }),
  );
  expect(exact).toMatchObject({
    bank: 3,
    file_offset: h.chrRom.offset + 3 * 1024 + 0x12,
    value: 0x95,
    mmc5: {
      rom_sources: {
        status: "examined",
        file_offsets: [h.chrRom.offset + 3 * 1024 + 0x12],
      },
    },
  });
  s.chr_banks[0] = { mask: 29, value: 1 };
  const offsets = [1, 3].map((bank) => h.chrRom.offset + bank * 1024 + 0x12);
  for (const [other, proof] of [
    [0x95, 0x95],
    [0x97, { mask: 253, value: 149 }],
    [0x6a, null],
  ] as const) {
    chr[3 * 1024 + 0x12] = other;
    const read = nesMmc5PpuReadSchema.parse(
      readMmc5Ppu(h, s, 0x12, { fetch: "sprite", chr }),
    );
    expect(read).toMatchObject({
      status: "unknown-chr-bank",
      bank: null,
      file_offset: null,
      mmc5: { rom_sources: { status: "examined", file_offsets: offsets } },
    });
    expect("known_bits" in read ? read.known_bits : read.value).toEqual(proof);
  }
  s.chr_banks[0] = null;
  const all = readMmc5Ppu(h, s, 0x12, { fetch: "sprite", chr });
  expect("rom_sources" in all.mmc5 && all.mmc5.rom_sources).toMatchObject({
    status: "examined",
    file_offsets: Array.from(
      { length: 32 },
      (_, bank) => h.chrRom.offset + bank * 1024 + 0x12,
    ),
  });
  expect(chr[0x12]).toBe(0x95);
});

it("retains CHR uncertainty at rendering, RAM and missing-snapshot boundaries", () => {
  const s = state();
  s.exram_mode = 1;
  for (const [h, chr, reason] of [
    [header(32768), Buffer.alloc(32768), "rendering-context"],
    [header(0), Buffer.alloc(0), "chr-ram"],
    [header(32768), Buffer.alloc(1), "inconsistent-snapshot"],
  ] as const) {
    const fetch = reason === "rendering-context" ? "background" : "sprite";
    expect(readMmc5Ppu(h, s, 0, { fetch, chr })).toMatchObject({
      value: null,
      mmc5: { rom_sources: { status: "unresolved", reason, file_offsets: [] } },
    });
  }
});

it("uses bank-size units and captured upper bits for every CHR byte in all four modes", () => {
  const h = header(),
    s = state();
  const regs = [
    [7, 7, 7, 7, 7, 7, 7, 7],
    [3, 3, 3, 3, 7, 7, 7, 7],
    [1, 1, 3, 3, 5, 5, 7, 7],
    [0, 1, 2, 3, 4, 5, 6, 7],
  ];
  for (let mode = 0; mode < 4; mode++)
    for (let raw = 0; raw < 256; raw++) {
      write(s, 0x5101, mode);
      write(s, 0x5130, 3);
      for (let i = 0; i < 12; i++) write(s, 0x5120 + i, (raw + i) & 255);
      const width = 2 ** (3 - mode);
      for (const set of ["a", "b"] as const)
        for (const [slot, w] of mmc5ChrWindows(h, s, set).entries()) {
          const reg =
            set === "a"
              ? regs[mode]![slot]!
              : mode < 2
                ? 11
                : 8 + regs[mode]![slot & 3]!;
          const expected =
            ((3 * 256 + ((raw + reg) & 255)) * width + (slot % width)) % 1024;
          expect(w.bank, `${mode}/${raw}/${set}/${slot}`).toBe(expected);
          expect(w.file_offset).toBe(h.chrRom.offset + expected * 1024);
        }
      write(s, 0x5130, 0);
      expect(s.chr_bank_upper).toEqual(Array(12).fill(3));
    }
});

it("retains physical latches through size changes without inventing unspecified bits", () => {
  const h = header(),
    s = state();
  write(s, 0x5101, 3);
  write(s, 0x5130, 1);
  write(s, 0x5127, 5);
  write(s, 0x5101, 0);
  expect(mmc5ChrWindows(h, s, "a").map((w) => w.bank)).toEqual([
    256, 257, 258, 259, 260, 261, 262, 263,
  ]);
  write(s, 0x5130, 0);
  write(s, 0x5127, 3);
  expect(mmc5ChrWindows(h, s, "a").map((w) => w.bank)).toEqual([
    24, 25, 26, 27, 28, 29, 30, 31,
  ]);
  write(s, 0x5101, 3);
  expect(mmc5ChrWindows(h, s, "a")[7]!.bank).toBeNull();
  write(s, 0x5101, 2);
  write(s, 0x5127, 3);
  write(s, 0x5101, 3);
  expect(mmc5ChrWindows(h, s, "a")[7]!.bank).toBe(7);
  s.chr_bank_modes[7] = null;
  expect(mmc5ChrWindows(h, s, "a")[7]!.bank).toBeNull();
});

it("matches an independent latch-bit wiring table across every mode transition and raw byte", () => {
  // Each row maps physical latch bits 0..9 to the ten source bus bits.
  // null denotes an undocumented bit, whose possible values are both retained.
  const wiring = [
    [0, null, null, 0, 1, 2, 3, 4, 5, 6],
    [0, null, 0, 1, 2, 3, 4, 5, 6, 7],
    [0, 0, 1, 2, 3, 4, 5, 6, 7, 8],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  ];
  const selected = [
    [7, 7, 7, 7, 7, 7, 7, 7],
    [3, 3, 3, 3, 7, 7, 7, 7],
    [1, 1, 3, 3, 5, 5, 7, 7],
    [0, 1, 2, 3, 4, 5, 6, 7],
  ];
  const s = state(),
    headers = [header(32768), header()];
  s.chr_bank_upper.fill(3);
  for (let written = 0; written < 4; written++)
    for (let raw = 0; raw < 256; raw++) {
      s.chr_bank_modes.fill(written);
      s.chr_banks = s.chr_banks.map((_, index) => (raw + index) & 255);
      for (let current = 0; current < 4; current++)
        for (const h of headers) {
          s.chr_mode = current;
          const width = 2 ** (3 - current),
            mask = h.chrRom.size / 1024 - 1;
          for (const [slot, actual] of mmc5ChrWindows(h, s, "a").entries()) {
            const word = 768 + ((raw + selected[current]![slot]!) & 255),
              row = wiring[written]!;
            const fixed = row.reduce<number>(
              (n, input, bit) =>
                input === null ? n : n | (((word >> input) & 1) << bit),
              0,
            );
            const unknown = row.flatMap((input, bit) =>
              input === null ? [bit] : [],
            );
            const possibilities = new Set(
              Array.from({ length: 2 ** unknown.length }, (_, n) => {
                const latch = unknown.reduce(
                  (value, bit, index) => value | (((n >> index) & 1) << bit),
                  fixed,
                );
                return (
                  (Math.floor(latch / width) * width + (slot % width)) & mask
                );
              }),
            );
            expect(
              actual.bank,
              `${written}/${current}/${raw}/${slot}/${mask}`,
            ).toBe(possibilities.size === 1 ? [...possibilities][0] : null);
          }
        }
    }
});

it("resolves connected CHR bits, joins bank sets and decodes exact-address PPUCTRL", () => {
  const h = header(32768),
    s = state();
  s.chr_mode = 3;
  s.chr_banks.fill({ mask: 31, value: 5 });
  s.chr_bank_modes.fill(3);
  expect(mmc5ChrWindows(h, s, "a").every((w) => w.bank === 5)).toBe(true);
  s.chr_banks[8] = 6;
  expect(readMmc5Ppu(h, s, 0, { fetch: "sprite" }).bank).toBe(5);
  expect(readMmc5Ppu(h, s, 0, { fetch: "background" }).bank).toBe(6);
  expect(readMmc5Ppu(h, s, 0).bank).toBeNull();
  s.last_chr_set = "background";
  expect(readMmc5Ppu(h, s, 0, { fetch: "ppudata" }).bank).toBe(6);
  write(s, 0x2008, 0);
  expect(s.ppu_control).toBe(32);
  write(s, 0x2000, 0);
  expect(readMmc5Ppu(h, s, 0, { fetch: "background" }).bank).toBe(5);
  expect(mmc5Mapping(h, s).chr_windows.every((w) => w.bank === 5)).toBe(true);
});

it("preserves fill proofs, zero pages, ExRAM mirrors and independent nametable sources", () => {
  const h = header(),
    s = state();
  s.nametable_control = 0xe4;
  s.exram_mode = 0;
  s.exram["17"] = 0xa5;
  s.fill_tile = 0x27;
  s.fill_attribute = { mask: 1, value: 1 };
  expect(mmc5Mapping(h, s)).toMatchObject({
    mirroring: "custom",
    nametable_windows: [
      { source: "ciram", bank: 0 },
      { source: "ciram", bank: 1 },
      { source: "exram" },
      { source: "fill" },
    ],
  });
  expect(readMmc5Ppu(h, s, 0x2811, { fetch: "ppudata" })).toMatchObject({
    status: "exram",
    value: 165,
    mmc5: { cell_address: 17, cell_value: 165 },
  });
  expect(readMmc5Ppu(h, s, 0x3811, { fetch: "ppudata" })).toMatchObject({
    status: "exram",
    value: 165,
  });
  expect(readMmc5Ppu(h, s, 0x2fbf, { fetch: "ppudata" })).toMatchObject({
    status: "fill-mode",
    value: 39,
  });
  expect(readMmc5Ppu(h, s, 0x2fc0, { fetch: "ppudata" })).toMatchObject({
    status: "fill-mode",
    value: null,
    known_bits: { mask: 85, value: 85 },
  });
  s.exram_mode = 3;
  expect(readMmc5Ppu(h, s, 0x2811, { fetch: "ppudata" })).toMatchObject({
    status: "constant-zero",
    value: 0,
  });
  expect(s.exram["17"]).toBe(165);
  s.nametable_control = { mask: 2, value: 2 };
  s.fill_tile = 0;
  expect(readMmc5Ppu(h, s, 0x2011, { fetch: "ppudata" })).toMatchObject({
    status: "unknown-nametable-bank",
    value: 0,
  });
  for (const [control, mirroring] of [
    [0, "one-screen-a"],
    [85, "one-screen-b"],
    [68, "vertical"],
    [80, "horizontal"],
  ] as const) {
    s.nametable_control = control;
    expect(mmc5Mapping(h, s).mirroring).toBe(mirroring);
  }
});

it("uses the exact PPUMASK substitution gate, including proven single enable bits and ignored mirrors", () => {
  const h = header(32768),
    s = state();
  s.chr_mode = 3;
  s.chr_bank_modes.fill(3);
  s.chr_banks.fill(5);
  s.chr_banks[8] = 6;
  s.ppu_mask = 0;
  s.exram_mode = 1;
  s.split[0] = 128;
  s.nametable_control = 255;
  s.fill_attribute = 2;
  expect(readMmc5Ppu(h, s, 0, { fetch: "background" })).toMatchObject({
    status: "unknown-chr-bank",
    mmc5: { chr_sets: ["a", "b"], limitation: null },
  });
  expect(readMmc5Ppu(h, s, 0x23c0, { fetch: "background" })).toMatchObject({
    status: "fill-mode",
    value: 170,
    mmc5: { limitation: null },
  });
  write(s, 0x2009, 24);
  expect(s.ppu_mask).toBe(0);
  s.exram_mode = 2;
  applyMmc5Write(s, {
    address: 0x2001,
    value: null,
    known_bits: { mask: 8, value: 8 },
    preceded_by_cpu_write: null,
  });
  expect(readMmc5Ppu(h, s, 0, { fetch: "background" }).bank).toBe(6);
  expect(readMmc5Ppu(h, s, 0, { fetch: "sprite" }).bank).toBe(5);
  s.ppu_mask = null;
  expect(readMmc5Ppu(h, s, 0, { fetch: "sprite" }).bank).toBeNull();
  s.last_chr_set = "background";
  expect(readMmc5Ppu(h, s, 0, { fetch: "ppudata" }).bank).toBe(6);
});

it("joins uncertain PPU ExRAM writes and ignores writes without corrupting storage", () => {
  const s = state();
  s.nametable_control = 170;
  s.exram_mode = 0;
  expect(writeMmc5Ppu(s, 0x23ff, 165)).toBe("exram-write");
  expect(s.exram["1023"]).toBe(165);
  s.exram_mode = { mask: 1, value: 0 };
  expect(writeMmc5Ppu(s, 0x33ff, 167)).toBe("uncertain-exram-write");
  expect(s.exram["1023"]).toEqual({ mask: 253, value: 165 });
  s.exram_mode = 2;
  expect(writeMmc5Ppu(s, 0x23ff, 0)).toBe("exram-write-ignored");
  expect(s.exram["1023"]).toEqual({ mask: 253, value: 165 });
  expect(writeMmc5Ppu(s, 0x3f00, 0)).toBe("outside-mapper");
  expect(Object.keys(s.exram)).toEqual(["1023"]);
});

it("does not substitute ordinary banks or fill data for rendering overrides", () => {
  const h = header(),
    s = state();
  s.chr_mode = 3;
  s.chr_banks.fill(4);
  s.chr_bank_modes.fill(3);
  s.chr_bank_upper.fill(0);
  s.exram_mode = 1;
  s.nametable_control = 255;
  s.fill_attribute = 2;
  expect(readMmc5Ppu(h, s, 0, { fetch: "background" })).toMatchObject({
    status: "unknown-chr-bank",
    file_offset: null,
    mmc5: { limitation: "extended-attributes" },
  });
  expect(readMmc5Ppu(h, s, 0x23c0, { fetch: "background" })).toMatchObject({
    value: null,
    mmc5: { limitation: "extended-attributes" },
  });
  expect(readMmc5Ppu(h, s, 0, { fetch: "sprite" }).bank).toBe(4);
  expect(readMmc5Ppu(h, s, 0x23c0, { fetch: "ppudata" }).value).toBe(170);
  s.exram_mode = 0;
  s.split[0] = 128;
  expect(
    readMmc5Ppu(h, s, 0x2000, { fetch: "background" }).mmc5.limitation,
  ).toBe("vertical-split");
  expect(readMmc5Ppu(h, s, 0x3f00).mmc5.limitation).toBeNull();
});

it("replays PPU ExRAM stores, preserves snapshots and rejects other mapper qualifications", async () => {
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/game.nes",
    initial: { mapper: 5, nametable_control: 170, exram_mode: 0 },
    events: [
      { kind: "ppu-write", address: 8192, value: 106 },
      { kind: "ppu-read", address: 12288, mmc5_fetch: "ppudata" },
      { kind: "cpu-write", address: 0x5104, value: 2 },
      { kind: "cpu-read", address: 0x5c00 },
    ],
  });
  const before = structuredClone(input);
  const trace = await deriveNesMapperEvents(
    header(),
    input.initial,
    input.events,
  );
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.steps[1]!.read_source).toMatchObject({
    status: "exram",
    value: 106,
  });
  expect(trace.steps[3]).toMatchObject({ cpu_read: { value: 106 } });
  expect(nesMapperEventSnapshot(trace, trace.steps[0]!)!.state).toMatchObject({
    exram_mode: 0,
    exram: { "0": 106 },
  });
  expect(trace.coverage).toMatchObject({
    unknown_nametable_reads: 0,
    unknown_cpu_reads: 0,
  });
  expect(input).toEqual(before);
  expect(
    await deriveNesMapperEvents(
      { ...header(32768), mapper: 4 },
      nesMapperStateSchema.parse({ mapper: 4 }),
      input.events,
    ),
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("Mapper 5"),
  });
});

it("checks every partial fill palette against independently enumerated concrete bytes", () => {
  const h = header(),
    s = state();
  s.nametable_control = 255;
  for (let mask = 0; mask < 256; mask++)
    for (let value = 0; value < 256; value++)
      if ((value & ~mask) === 0) {
        s.fill_attribute =
          mask === 0 ? null : mask === 255 ? value : { mask, value };
        const concrete = Array.from({ length: 256 }, (_, n) => n)
          .filter((n) => (n & mask) === value)
          .map((n) => (n % 4) * 85);
        const and = concrete.reduce((a, b) => a & b),
          or = concrete.reduce((a, b) => a | b),
          known = 255 & ~(and ^ or);
        const read = readMmc5Ppu(h, s, 0x23c0, { fetch: "ppudata" });
        expect(
          read.value ?? ("known_bits" in read ? read.known_bits : null),
        ).toEqual(
          known === 0
            ? null
            : known === 255
              ? and
              : { mask: known, value: and },
        );
      }
});
