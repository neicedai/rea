import { expect, it } from "vitest";
import { mmc5Product, readMmc5Cpu } from "./nesMmc5Cpu.js";
import { nesMmc5StateSchema } from "./nesMmc5.js";
import {
  nesMapperStateSchema,
  nesMapperWriteSchema,
} from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { parseNesHeader } from "./nes.js";
import { mmc5Fixture } from "./nesMmc5.fixture.js";
import { nesByteCandidates, type NesByteValue } from "./nesByteValue.js";

it("matches all 65,536 unsigned multiplier inputs in both result bytes", () => {
  for (let a = 0; a < 256; a++)
    for (let b = 0; b < 256; b++)
      expect(mmc5Product(a, b)).toEqual({
        low: (a * b) & 255,
        high: (a * b) >>> 8,
      });
});

const ternaryByte = (index: number): NesByteValue => {
  let mask = 0,
    value = 0;
  for (let bit = 0; bit < 8; bit++) {
    const digit = index % 3;
    index = Math.floor(index / 3);
    if (digit !== 0) {
      mask |= 1 << bit;
      if (digit === 2) value |= 1 << bit;
    }
  }
  return mask === 0 ? null : mask === 255 ? value : { mask, value };
};
const envelope = (values: number[]): NesByteValue => {
  const and = values.reduce((a, b) => a & b, 255),
    or = values.reduce((a, b) => a | b, 0),
    mask = ~(and ^ or) & 255;
  return mask === 0 ? null : mask === 255 ? and : { mask, value: and };
};
it("preserves exact common product bits for every partial byte with representative partners", () => {
  for (let i = 0; i < 6561; i++) {
    const a = ternaryByte(i),
      raw = nesByteCandidates(a);
    for (const b of [0, 1, 2, 3, 128, 255]) {
      const expected = {
        low: envelope(raw.map((n) => (n * b) & 255)),
        high: envelope(raw.map((n) => (n * b) >>> 8)),
      };
      expect(mmc5Product(a, b)).toEqual(expected);
      expect(mmc5Product(b, a)).toEqual(expected);
    }
  }
  expect(mmc5Product(null, null)).toEqual({ low: null, high: null });
  expect(
    mmc5Product({ mask: 1, value: 0 }, { mask: 1, value: 0 }).low,
  ).toMatchObject({ mask: 3, value: 0 });
});

it("retains raw factors across reads and decodes only exact multiplier addresses", () => {
  const state = nesMmc5StateSchema.parse({ mapper: 5, multiplier: [255, 255] });
  expect(readMmc5Cpu(state, 0x5205)).toMatchObject({
    value: 1,
    source: {
      kind: "mmc5-multiply",
      product_byte: "low",
      multiplicand: 255,
      multiplier: 255,
    },
  });
  expect(readMmc5Cpu(state, 0x5206)).toMatchObject({ value: 254 });
  expect(state.multiplier).toEqual([255, 255]);
  for (const address of [0x5204, 0x5207, 0x5305, 0x5bff, 0x6000])
    expect(readMmc5Cpu(state, address)).toBeNull();
});

it("joins ExRAM reads/writes across all partial mode bits, retaining readonly bytes and omission", () => {
  const parsed = parseNesHeader(mmc5Fixture().bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  for (const mode of [
    null,
    0,
    1,
    2,
    3,
    { mask: 1, value: 0 },
    { mask: 1, value: 1 },
    { mask: 2, value: 0 },
    { mask: 2, value: 2 },
  ]) {
    const initial = nesMapperStateSchema.parse({
      mapper: 5,
      exram_mode: mode,
      exram_written: true,
      exram: { "0": 0xa5, "1023": 0x60 },
    });
    const trace = deriveNesMapperTrace(parsed.value, initial, [
      nesMapperWriteSchema.parse({ address: 0x5c00, value: 0xa7 }),
    ]);
    if (trace.status !== "derived" || trace.final.mapper !== 5)
      throw new Error("Expected MMC5 trace");
    const modes = [...new Set(nesByteCandidates(mode).map((m) => m & 3))];
    const expected =
      modes.includes(0) || modes.includes(1)
        ? null
        : modes.length === 1
          ? modes[0] === 2
            ? 0xa7
            : 0xa5
          : { mask: 253, value: 165 };
    expect(trace.final.exram["0"]).toEqual(expected);
    expect(trace.final.exram["1023"]).toBe(0x60);
    expect(readMmc5Cpu(trace.final, 0x5c00)?.value).toBe(
      modes.every((m) => m >= 2) && typeof expected === "number"
        ? expected
        : null,
    );
  }
  const initial = nesMapperStateSchema.parse({ mapper: 5, exram_mode: 3 });
  const trace = deriveNesMapperTrace(parsed.value, initial, [
    nesMapperWriteSchema.parse({ address: 0x5c00, value: 0xa7 }),
  ]);
  if (trace.status !== "derived" || trace.final.mapper !== 5)
    throw new Error("Expected MMC5 trace");
  expect(trace.final.exram).toEqual({});
});

it("retains reset-mode bytes while requiring a known 5104 write before proving access", () => {
  const state = nesMapperStateSchema.parse({
    mapper: 5,
    exram_mode: 3,
    exram: { "0": 106 },
  });
  if (state.mapper !== 5) throw new Error("Expected MMC5");
  expect(readMmc5Cpu(state, 0x5c00)).toMatchObject({
    value: null,
    source: { access: "unknown", written_since_reset: null, cell_value: 106 },
  });
  state.exram_written = false;
  expect(readMmc5Cpu(state, 0x5c00)).toMatchObject({
    value: null,
    source: { access: "unknown", written_since_reset: false, cell_value: 106 },
  });
  state.exram_written = true;
  expect(readMmc5Cpu(state, 0x5c00)).toMatchObject({
    value: 106,
    source: { access: "readable", written_since_reset: true },
  });
});
