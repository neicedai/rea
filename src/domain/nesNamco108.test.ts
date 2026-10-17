import { expect, it } from "vitest";
import {
  applyNamco108Write,
  isNamco108State,
  namco108HasFixedPrg,
  nesNamco108StateSchema,
} from "./nesNamco108.js";
import { writeNesSelectedBank } from "./nesBankRegisters.js";
import type { NesByteValue } from "./nesByteValue.js";
import { parseNesHeader } from "./nes.js";
import {
  mapperMapping,
  standardNesChrCandidates,
} from "./nesMapperTraceMapping.js";

const state = (mapper: 76 | 206) =>
  nesNamco108StateSchema.parse({ mapper, banks: [0, 1, 2, 3, 4, 5, 6, 7] });
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});
const header = (
  mapper: 76 | 206,
  prgUnits: number,
  chrUnits: number,
  {
    submapper = 0,
    trainer = false,
  }: { submapper?: number; trainer?: boolean } = {},
) => {
  const bytes = Buffer.alloc(
    16 + (trainer ? 512 : 0) + prgUnits * 16384 + chrUnits * 8192,
  );
  bytes.set([
    78,
    69,
    83,
    26,
    prgUnits,
    chrUnits,
    ((mapper & 15) << 4) | (trainer ? 4 : 0),
    (mapper & 240) | 8,
    submapper << 4,
  ]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

it("retains strict separately discriminated Mapper 76/206 states and unknown reset registers", () => {
  for (const mapper of [76, 206]) {
    expect(nesNamco108StateSchema.parse({ mapper })).toEqual({
      mapper,
      bank_select: null,
      banks: Array(8).fill(null),
    });
    expect(isNamco108State({ mapper })).toBe(true);
    for (const extra of [
      { variant: "namco109" },
      { banks: Array(7).fill(0) },
      { banks: Array(9).fill(0) },
      { bank_select: 256 },
      { bank_select: { mask: 7, value: 8 } },
      { bank_select: { mask: 255, value: 0 } },
    ])
      expect(
        nesNamco108StateSchema.safeParse({ mapper, ...extra }).success,
      ).toBe(false);
  }
  expect(isNamco108State({ mapper: 4 })).toBe(false);
  expect(nesNamco108StateSchema.safeParse({ mapper: 4 }).success).toBe(false);
});

it("decodes only 8000–9FFF even/odd aliases and preserves ignored selector/data bits", () => {
  for (const mapper of [76, 206] as const)
    for (const select of [0x8000, 0x8002, 0x9ffe])
      for (const data of [0x8001, 0x8003, 0x9fff]) {
        const selected = applyNamco108Write(state(mapper), write(select, 0xe6));
        expect(selected.effect).toBe("bank-select");
        expect(selected.state.bank_select).toBe(0xe6);
        const updated = applyNamco108Write(selected.state, write(data, 0xff));
        expect(updated).toEqual({
          effect: "bank-data",
          state: {
            ...state(mapper),
            bank_select: 0xe6,
            banks: [0, 1, 2, 3, 4, 5, 255, 7],
          },
        });
      }
  for (const mapper of [76, 206] as const)
    for (const address of [
      0, 0x6000, 0x7fff, 0xa000, 0xa001, 0xc000, 0xe001, 0xffff,
    ]) {
      const initial = state(mapper),
        before = structuredClone(initial);
      expect(applyNamco108Write(initial, write(address, 255))).toEqual({
        state: before,
        effect: "outside-mapper",
      });
      expect(initial).toEqual(before);
    }
});

it("retains R0/R1 raw writes on Mapper 76 and does not project data at the register boundary", () => {
  let current = state(76);
  for (const index of [0, 1]) {
    current = applyNamco108Write(current, write(0x8000, index)).state;
    current = applyNamco108Write(current, write(0x8001, 0xc1 + index)).state;
  }
  expect(current.banks).toEqual([0xc1, 0xc2, 2, 3, 4, 5, 6, 7]);
  current = applyNamco108Write(current, {
    ...write(0x8000, null),
    known_bits: { mask: 7, value: 3 },
  }).state;
  current = applyNamco108Write(current, {
    ...write(0x8001, null),
    known_bits: { mask: 240, value: 160 },
  }).state;
  expect(current.bank_select).toEqual({ mask: 7, value: 3 });
  expect(current.banks[3]).toEqual({ mask: 240, value: 160 });
});

it("preserves common facts when an uncertain PRG-register destination may write either R6 or R7", () => {
  const previous = nesNamco108StateSchema.parse({
    mapper: 76,
    bank_select: { mask: 6, value: 6 },
    banks: [0, 1, 2, 3, 4, 5, 0xa0, 0xa1],
  });
  expect(applyNamco108Write(previous, write(0x8001, 0xa1))).toEqual({
    effect: "bank-data",
    state: {
      ...previous,
      banks: [0, 1, 2, 3, 4, 5, { mask: 254, value: 160 }, 0xa1],
    },
  });
});

const values = (proof: NesByteValue): number[] =>
  Array.from({ length: 256 }, (_, value) => value).filter((value) =>
    typeof proof === "number"
      ? value === proof
      : proof === null || (value & proof.mask) === proof.value,
  );
const envelope = (numbers: readonly number[]): NesByteValue => {
  const mask = numbers.reduce(
      (mask, value) => mask & ~(numbers[0]! ^ value),
      255,
    ),
    value = numbers[0]! & mask;
  return mask === 0 ? null : mask === 255 ? value : { mask, value };
};

it("matches concrete register writes for every three-bit selector proof, including unknown byte proofs", () => {
  const banks: NesByteValue[] = [
      0,
      255,
      { mask: 240, value: 160 },
      null,
      1,
      254,
      16,
      17,
    ],
    before = structuredClone(banks);
  for (let mask = 0; mask < 8; mask++)
    for (let value = 0; value < 8; value++) {
      if ((value & ~mask) !== 0) continue;
      const selector: NesByteValue = mask === 0 ? null : { mask, value },
        selections = [...new Set(values(selector).map((value) => value & 7))];
      for (const byte of [0, 255, { mask: 240, value: 160 }, null]) {
        const expected = banks.map((old, index) =>
          envelope(
            selections.flatMap((selected) =>
              values(selected === index ? byte : old),
            ),
          ),
        );
        expect(writeNesSelectedBank(banks, selector, byte)).toEqual(expected);
        expect(banks).toEqual(before);
      }
    }
});

it("does not apply Mapper 206's fixed-PRG submapper rule to Mapper 76", () => {
  for (const [mapper, submapper, fixed] of [
    [206, 1, true],
    [206, 0, false],
    [76, 0, false],
    [76, 1, false],
  ] as const) {
    const bytes = Buffer.alloc(16 + 32768 + 8192);
    bytes.set([
      78,
      69,
      83,
      26,
      2,
      1,
      (mapper & 15) << 4,
      (mapper & 240) | 8,
      submapper << 4,
    ]);
    const header = parseNesHeader(bytes);
    if (!header.ok) throw new Error(header.error);
    expect(namco108HasFixedPrg(header.value)).toBe(fixed);
  }
});

it.each([76, 206] as const)(
  "requires full low-four-bit view identity while retaining partial physical windows for Mapper %s",
  (mapper) => {
    const parsed = header(mapper, 4, 1),
      partial = nesNamco108StateSchema.parse({
        mapper,
        banks: [0, 1, 2, 3, 4, 5, { mask: 7, value: 2 }, { mask: 7, value: 3 }],
      }),
      physical = mapperMapping(parsed, partial);
    expect(physical.prg_windows.map((window) => window.bank)).toEqual([
      2, 3, 6, 7,
    ]);
    expect(physical.prg_windows.map((window) => window.file_offset)).toEqual([
      16400, 24592, 49168, 57360,
    ]);
    expect(physical.prg_view).toBeNull();
    const complete = nesNamco108StateSchema.parse({
        mapper,
        banks: [
          0,
          1,
          2,
          3,
          4,
          5,
          { mask: 15, value: 10 },
          { mask: 15, value: 11 },
        ],
      }),
      selected = mapperMapping(parsed, complete);
    expect(selected.prg_windows).toEqual(physical.prg_windows);
    expect(selected.prg_view).toEqual({ mapper, r6: 10, r7: 11 });
    if (mapper === 206) {
      const fixed = mapperMapping(
        header(206, 2, 1, { submapper: 1 }),
        complete,
      );
      expect(fixed.prg_view).toBeNull();
      expect(fixed.prg_windows.map((window) => window.bank)).toEqual([
        0, 1, 2, 3,
      ]);
    }
  },
);

it("retains 16 KiB Mapper 76 aliases without inventing unknown complete selectors", () => {
  const parsed = header(76, 1, 1),
    initial = nesNamco108StateSchema.parse({
      mapper: 76,
      banks: [0, 1, 2, 3, 4, 5, { mask: 1, value: 1 }, { mask: 1, value: 0 }],
    }),
    mapping = mapperMapping(parsed, initial);
  expect(mapping.prg_windows).toEqual([
    { start: 0x8000, size: 8192, bank: 1, file_offset: 8208 },
    { start: 0xa000, size: 8192, bank: 0, file_offset: 16 },
    { start: 0xc000, size: 8192, bank: 0, file_offset: 16 },
    { start: 0xe000, size: 8192, bank: 1, file_offset: 8208 },
  ]);
  expect(mapping.prg_view).toBeNull();
});

it("maps only R2..R5 into four 2 KiB windows through the final byte of 128 KiB CHR", () => {
  const parsed = header(76, 8, 16, { trainer: true }),
    initial = nesNamco108StateSchema.parse({
      mapper: 76,
      bank_select: 255,
      banks: [255, 255, 63, 64, 33, 254, 0, 1],
    }),
    mapping = mapperMapping(parsed, initial);
  expect(mapping.chr_windows).toEqual([
    { start: 0, size: 2048, bank: 63, file_offset: 260624 },
    { start: 2048, size: 2048, bank: 0, file_offset: 131600 },
    { start: 4096, size: 2048, bank: 33, file_offset: 199184 },
    { start: 6144, size: 2048, bank: 62, file_offset: 258576 },
  ]);
  const ignored = nesNamco108StateSchema.parse({
    ...initial,
    bank_select: 0,
    banks: [0, 1, 63, 64, 33, 254, 0, 1],
  });
  expect(mapperMapping(parsed, ignored)).toEqual(mapping);
  const uncertain = nesNamco108StateSchema.parse({
    ...initial,
    banks: [255, 255, { mask: 62, value: 62 }, 64, 33, 254, 0, 1],
  });
  expect(mapperMapping(parsed, uncertain).chr_windows[0]).toEqual({
    start: 0,
    size: 2048,
    bank: null,
    file_offset: null,
  });
  expect(standardNesChrCandidates(uncertain, 0, 64)).toEqual([62, 63]);
});
