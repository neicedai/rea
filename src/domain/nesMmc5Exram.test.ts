import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesByteValueSchema, type NesByteValue } from "./nesByteValue.js";
import {
  nesMmc5StateSchema,
  applyMmc5Write,
  applyMmc5Reset,
} from "./nesMmc5.js";
import { readMmc5Cpu, writeMmc5Exram } from "./nesMmc5Cpu.js";
import {
  mmc5NametableChoices,
  readMmc5Ppu,
  writeMmc5Ppu,
} from "./nesMmc5Ppu.js";
import {
  mmc5BackgroundPaths,
  readMmc5BackgroundPpu,
} from "./nesMmc5Rendering.js";
import {
  mmc5RenderingFixture,
  mmc5ExtendedInput,
} from "./nesMmc5Rendering.fixture.js";
import {
  nesMmc5ExramSchema,
  readMmc5ExramCell,
  updateMmc5ExramCell,
  admitMmc5ExramOrigins,
} from "./nesMmc5Exram.js";

const oldOrigin = { kind: "event-write" as const, index: 9 };
const state = () =>
  nesMmc5StateSchema.parse({
    mapper: 5,
    exram_mode: 2,
    exram_written: true,
    nametable_control: 170,
    exram: { "0": { value: 165, origin: oldOrigin } },
  });
const partialModes: NesByteValue[] = [
  null,
  { mask: 1, value: 0 },
  { mask: 1, value: 1 },
  { mask: 2, value: 0 },
  { mask: 2, value: 2 },
  { mask: 3, value: 0 },
  { mask: 3, value: 1 },
  { mask: 3, value: 2 },
  { mask: 3, value: 3 },
];
const possibleModes = (proof: NesByteValue) => {
  const bits = typeof proof === "number" ? { mask: 255, value: proof } : proof;
  return [0, 1, 2, 3].filter(
    (value) => bits === null || (value & bits.mask) === bits.value,
  );
};
const commonByte = (values: (number | null)[]): NesByteValue => {
  if (values.includes(null)) return null;
  const first = values[0]!;
  if (first === null) throw new Error("Missing oracle byte");
  let mask = 255;
  for (const value of values) {
    if (value === null) throw new Error("Missing oracle byte");
    mask &= ~(first ^ value);
  }
  return mask === 255
    ? first
    : mask === 0
      ? null
      : { mask, value: first & mask };
};

it("preserves legacy bare cells and projects initial physical sources without manufacturing event history", () => {
  const bare = { "0": 165, "1": { mask: 240, value: 160 }, "2": null };
  expect(nesMmc5ExramSchema.parse(bare)).toEqual(bare);
  const s = nesMmc5StateSchema.parse({ mapper: 5, exram: bare });
  expect(readMmc5ExramCell(s, 0)).toEqual({
    address: 0,
    value: 165,
    origin: { kind: "initial-exram", address: 0 },
  });
  expect(readMmc5ExramCell(s, 2)).toEqual({
    address: 2,
    value: null,
    origin: null,
  });
  expect(readMmc5ExramCell(s, 3)).toEqual({
    address: 3,
    value: null,
    origin: null,
  });
  const partial = readMmc5ExramCell(s, 1);
  if (typeof partial.value !== "object" || partial.value === null)
    throw new Error("Missing partial proof");
  partial.value.value = 0;
  expect(s.exram).toEqual(bare);
  expect(admitMmc5ExramOrigins(s, null)).toBeNull();
  writeMmc5Exram(s, 0x5c00, 23);
  expect(s.exram["0"]).toBeNull();
  s.exram_mode = 2;
  expect(writeMmc5Exram(s, 0x5c00, 23)).toBe("exram-write");
  expect(s.exram["0"]).toBe(23);
});

it("shares retained absolute origins across CPU and PPU writes, CPU reads and ordinary nametable reads", () => {
  const s = state();
  expect(writeMmc5Exram(s, 0x5c00, 106, undefined, 10)).toBe("exram-write");
  expect(readMmc5ExramCell(s, 0)).toEqual({
    address: 0,
    value: 106,
    origin: { kind: "event-write", index: 10 },
  });
  expect(readMmc5Cpu(s, 0x5c00)).toMatchObject({
    value: 106,
    source: { cell_address: 0, cell_value: 106, access: "readable" },
  });
  applyMmc5Write(
    s,
    { address: 0x5104, value: 0, preceded_by_cpu_write: null },
    true,
    11,
  );
  expect(writeMmc5Ppu(s, 0x3000, 109, 12)).toBe("exram-write");
  expect(readMmc5ExramCell(s, 0)).toEqual({
    address: 0,
    value: 109,
    origin: { kind: "event-write", index: 12 },
  });
  const f = mmc5RenderingFixture(),
    header = parseNesHeader(f.bytes);
  if (!header.ok) throw new Error(header.error);
  expect(
    readMmc5Ppu(header.value, s, 0x2000, { fetch: "ppudata" }),
  ).toMatchObject({ status: "exram", value: 109, file_offset: null });
  expect(admitMmc5ExramOrigins(s, 13)).toBeNull();
  expect(nesMmc5StateSchema.parse(structuredClone(s))).toEqual(s);
});

it("matches all partial CPU modes and frame qualifications while retaining only the proving earlier source on joins", () => {
  for (const mode of partialModes)
    for (const inFrame of [true, false, null]) {
      const s = state();
      s.exram_mode = mode;
      const outcomes = possibleModes(mode).map((candidate) =>
        candidate === 3
          ? 165
          : candidate === 2 || inFrame === true
            ? 167
            : null,
      );
      const expected = commonByte(outcomes);
      writeMmc5Exram(s, 0x5c00, 167, inFrame, 10);
      const actual = readMmc5ExramCell(s, 0);
      expect(actual.value).toEqual(expected);
      expect(actual.origin).toEqual(
        expected === null
          ? null
          : outcomes.every((value) => value === 167)
            ? { kind: "event-write", index: 10 }
            : oldOrigin,
      );
    }
  const readonly = state(),
    before = structuredClone(readonly.exram);
  readonly.exram_mode = 3;
  expect(writeMmc5Exram(readonly, 0x5c00, null, true, 10)).toBe(
    "exram-write-ignored",
  );
  expect(readonly.exram).toEqual(before);
  readonly.exram_mode = 0;
  readonly.exram_written = false;
  writeMmc5Exram(readonly, 0x5c00, 23, true, 11);
  expect(readMmc5ExramCell(readonly, 0)).toEqual({
    address: 0,
    value: null,
    origin: null,
  });
});

it("joins all partial ordinary nametable selectors and ExRAM modes without inventing a last writer", () => {
  for (const selector of partialModes)
    for (const mode of partialModes) {
      const s = state();
      s.nametable_control = selector;
      s.exram_mode = mode;
      const outcomes = possibleModes(selector).flatMap((selected) =>
        possibleModes(mode).map((access) =>
          selected === 2 && access < 2 ? 167 : 165,
        ),
      );
      writeMmc5Ppu(s, 0x2000, 167, 10);
      const actual = readMmc5ExramCell(s, 0);
      expect(actual.value).toEqual(commonByte(outcomes));
      expect(actual.origin).toEqual(
        outcomes.every((value) => value === 167)
          ? { kind: "event-write", index: 10 }
          : oldOrigin,
      );
    }
  const s = state();
  expect(
    updateMmc5ExramCell(s, 0, 90, {
      access: "conditional-write",
      eventIndex: 10,
    }),
  ).toEqual({ address: 0, value: null, origin: null, disposition: "joined" });
  expect(s.exram["0"]).toBeNull();
});

it("retains selector/source/bank correlation and the ExRAM storage atom in ordinary choices", () => {
  const s = state();
  s.nametable_control = 228;
  s.exram_mode = 0;
  s.fill_tile = 17;
  s.fill_attribute = 2;
  expect(mmc5NametableChoices(s, 0x2000)).toEqual([
    { selector: 0, source: "ciram", bank: 0, value: null },
  ]);
  expect(mmc5NametableChoices(s, 0x2400)).toEqual([
    { selector: 1, source: "ciram", bank: 1, value: null },
  ]);
  expect(mmc5NametableChoices(s, 0x2800)).toEqual([
    {
      selector: 2,
      source: "exram",
      bank: null,
      value: 165,
      cell: { address: 0, value: 165, origin: oldOrigin },
    },
  ]);
  expect(mmc5NametableChoices(s, 0x2c00)).toEqual([
    { selector: 3, source: "fill", bank: null, value: 17 },
  ]);
  expect(mmc5NametableChoices(s, 0x2fc0)).toEqual([
    { selector: 3, source: "fill", bank: null, value: 170 },
  ]);
});

it("preserves captured ExRAM byte origins through overwrite, reset and continuation", () => {
  const f = mmc5RenderingFixture(),
    header = parseNesHeader(f.bytes);
  if (!header.ok) throw new Error(header.error);
  const s = nesMmc5StateSchema.parse(mmc5ExtendedInput.initial);
  if (!("ppu" in s)) throw new Error("Missing background state");
  s.exram["37"] = { value: 131, origin: oldOrigin };
  readMmc5BackgroundPpu(header.value, s, 0x2425, {
    fetch: "background",
    tile: { column: 5, line: "current" },
  });
  readMmc5BackgroundPpu(header.value, s, 0x27c1, { fetch: "background" });
  expect(s.ppu.extended_attribute).toEqual({
    address: 37,
    value: 131,
    origin: oldOrigin,
  });
  applyMmc5Write(
    s,
    { address: 0x5c25, value: 68, preceded_by_cpu_write: null },
    true,
    12,
  );
  expect(readMmc5ExramCell(s, 37)).toEqual({
    address: 37,
    value: 68,
    origin: { kind: "event-write", index: 12 },
  });
  applyMmc5Reset(s);
  expect(s.ppu.extended_attribute).toEqual({
    address: 37,
    value: 131,
    origin: oldOrigin,
  });
  const resumed = nesMmc5StateSchema.parse(structuredClone(s));
  expect(resumed).toEqual(s);
  expect(admitMmc5ExramOrigins(resumed, 13)).toBeNull();
  expect(admitMmc5ExramOrigins(resumed, 12)).toMatch(/precede/u);
  expect(admitMmc5ExramOrigins(resumed, null)).toMatch(/require/u);
});

it("admits legacy held captures and rejects mismatched physical or future retained origins", () => {
  const legacy = nesMmc5StateSchema.parse({
    mapper: 5,
    ppu: {
      model: "mmc5-background",
      extended_attribute: { address: 7, value: 34 },
    },
  });
  expect(admitMmc5ExramOrigins(legacy, null)).toBeNull();
  for (const target of ["storage", "extended", "tile", "attribute"] as const) {
    const s = nesMmc5StateSchema.parse({
      mapper: 5,
      ppu: { model: "mmc5-background" },
    });
    if (!("ppu" in s)) throw new Error("Missing background state");
    const cell = {
      address: 7,
      value: 34,
      origin: { kind: "initial-exram" as const, address: 8 },
    };
    if (target === "storage")
      s.exram["7"] = { value: cell.value, origin: cell.origin };
    else if (target === "extended") s.ppu.extended_attribute = cell;
    else if (target === "tile") s.ppu.split_tiles = [cell];
    else s.ppu.split_attributes = [{ ...cell, shift: 2 }];
    expect(admitMmc5ExramOrigins(s, 10)).toMatch(/same physical/u);
    cell.origin.address = 7;
    expect(admitMmc5ExramOrigins(s, 10)).toBeNull();
  }
  const future = state();
  expect(admitMmc5ExramOrigins(future, 9)).toMatch(/precede/u);
  expect(admitMmc5ExramOrigins(future, null)).toMatch(/require/u);
  expect(nesMmc5ExramSchema.safeParse({ "1024": 0 }).success).toBe(false);
  expect(
    nesMmc5ExramSchema.safeParse({
      "0": {
        value: 23,
        origin: { kind: "cpu-write", instruction_index: 0, write_index: 0 },
      },
    }).success,
  ).toBe(false);
});

it("selects frozen possible background paths independently of held rendering history", () => {
  const s = nesMmc5StateSchema.parse(mmc5ExtendedInput.initial);
  if (!("ppu" in s)) throw new Error("Missing background state");
  const before = mmc5BackgroundPaths(s, 5);
  expect(before).toEqual({ paths: ["extended"], splitColumns: [] });
  s.ppu.phase = "pattern-high";
  s.ppu.paths = ["split"];
  s.ppu.extended_attribute = {
    address: 7,
    value: nesByteValueSchema.parse({ mask: 192, value: 128 }),
  };
  expect(mmc5BackgroundPaths(s, 5)).toEqual(before);
  const without = nesMmc5StateSchema.parse({
    mapper: 5,
    exram_mode: 1,
    ppu_mask: 24,
    split: [0, 0, 0],
  });
  expect(mmc5BackgroundPaths(without, 5)).toEqual({
    paths: ["normal", "extended"],
    splitColumns: [],
  });
});

it("uses the supplied ordinary CIRAM byte once before capturing a normal background tile", () => {
  const f = mmc5RenderingFixture(),
    header = parseNesHeader(f.bytes);
  if (!header.ok) throw new Error(header.error);
  const s = nesMmc5StateSchema.parse({
    ...mmc5ExtendedInput.initial,
    exram_mode: 0,
    nametable_control: 0,
  });
  if (!("ppu" in s)) throw new Error("Missing background state");
  const ordinary = readMmc5Ppu(header.value, s, 0x2000, {
    fetch: "background",
    ordinary: true,
  });
  expect(ordinary.value).toBeNull();
  const tile = readMmc5BackgroundPpu(header.value, s, 0x2000, {
    fetch: "background",
    tile: { column: 0, line: "current" },
    ordinaryRead: { ...ordinary, value: 17 },
  });
  expect(tile.value).toBe(17);
  expect(s.ppu).toMatchObject({
    phase: "attribute",
    paths: ["normal"],
    tile_value: 17,
  });
  const attribute = readMmc5BackgroundPpu(header.value, s, 0x23c0, {
    fetch: "background",
    ordinaryRead: { ...ordinary, value: 85 },
  });
  expect(attribute.value).toBe(85);
  expect(s.ppu.phase).toBe("pattern-low");
  const pattern = readMmc5BackgroundPpu(header.value, s, 0x110, {
    fetch: "background",
    chr: f.bytes.subarray(f.chrOffset),
  });
  expect(pattern.mmc5).toMatchObject({
    rendering: { fetch: "pattern-low", reason: null, paths: ["normal"] },
  });
  expect(s.ppu.phase).toBe("pattern-high");
});
