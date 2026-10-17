import { expect, it } from "vitest";
import {
  nesAdd,
  nesCompare,
  nesLogic,
  nesShift,
  nesIncrement,
} from "./nes6502Alu.js";
import { nesCpuStateSchema } from "./nesCodeTrace.js";
import type { NesByteValue } from "./nesByteValue.js";

const bytes = Array.from({ length: 256 }, (_, index) => index);
const operands: NesByteValue[] = [null, ...bytes];
const registerProof = (values: Set<number>) => {
  let and = 255,
    or = 0;
  for (const value of values) {
    and &= value;
    or |= value;
  }
  const mask = ~(and ^ or) & 255;
  return mask === 0 || mask === 255
    ? {}
    : { register_bits: { a: { mask, value: and } } };
};
for (let mask = 1; mask < 255; mask++)
  for (let value = 0; value < 256; value++)
    if ((value & ~mask) === 0) operands.push({ mask, value });

it.each(["AND", "ORA", "EOR"] as const)(
  "matches concrete byte outcomes for every partial operand pattern in %s",
  (operation) => {
    const initial = nesCpuStateSchema.parse({
      x: 17,
      y: 29,
      sp: 253,
      c: true,
      v: false,
      i: true,
      d: true,
    });
    let checked = 0;
    for (const operand of operands) {
      const candidates =
        typeof operand === "number"
          ? [operand]
          : bytes.filter(
              (value) =>
                operand === null || (value & operand.mask) === operand.value,
            );
      for (const accumulator of [null, 0, 1, 0x55, 0x80, 0xaa, 255]) {
        const values = new Set<number>();
        const negatives = new Set<boolean>();
        const zeros = new Set<boolean>();
        for (const a of accumulator === null ? bytes : [accumulator])
          for (const b of candidates) {
            const value =
              operation === "AND" ? a & b : operation === "ORA" ? a | b : a ^ b;
            values.add(value);
            negatives.add(value >= 128);
            zeros.add(value === 0);
          }
        const expected = {
          ...initial,
          a: values.size === 1 ? [...values][0]! : null,
          n: negatives.size === 1 ? [...negatives][0]! : null,
          z: zeros.size === 1 ? [...zeros][0]! : null,
          ...registerProof(values),
        };
        const actual = { ...initial, a: accumulator };
        nesLogic(actual, operand, operation);
        if (JSON.stringify(actual) !== JSON.stringify(expected))
          throw new Error(
            JSON.stringify({
              operation,
              accumulator,
              operand,
              actual,
              expected,
            }),
          );
        checked++;
      }
    }
    // Every bit is either unknown, known zero, or known one.
    expect(checked).toBe(3 ** 8 * 7);
  },
  20_000,
);

it("matches concrete comparison outcomes for every partial operand pattern at byte boundaries", () => {
  const initial = nesCpuStateSchema.parse({
    a: 19,
    x: 23,
    y: 31,
    sp: 253,
    c: false,
    v: true,
    i: true,
    d: false,
  });
  let checked = 0;
  for (const operand of operands) {
    const candidates =
      typeof operand === "number"
        ? [operand]
        : bytes.filter(
            (value) =>
              operand === null || (value & operand.mask) === operand.value,
          );
    for (const left of [null, 0, 1, 0x55, 0x7f, 0x80, 0x81, 0xaa, 255]) {
      const carries = new Set<boolean>();
      const negatives = new Set<boolean>();
      const zeros = new Set<boolean>();
      for (const a of left === null ? bytes : [left])
        for (const b of candidates) {
          carries.add(a >= b);
          negatives.add((a - b + 256) % 256 >= 128);
          zeros.add(a === b);
        }
      const expected = {
        ...initial,
        c: carries.size === 1 ? [...carries][0]! : null,
        n: negatives.size === 1 ? [...negatives][0]! : null,
        z: zeros.size === 1 ? [...zeros][0]! : null,
      };
      const actual = { ...initial };
      nesCompare(actual, left, operand);
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(JSON.stringify({ left, operand, actual, expected }));
      checked++;
    }
  }
  expect(checked).toBe(3 ** 8 * 9);
}, 20_000);

it.each([false, true])(
  "matches signed and unsigned arithmetic envelopes for SBC=%s",
  (subtract) => {
    const initial = nesCpuStateSchema.parse({
      x: 17,
      y: 23,
      sp: 253,
      i: true,
      d: true,
    });
    const signed = (value: number) => (value < 128 ? value : value - 256);
    let checked = 0;
    for (const operand of operands) {
      const candidates =
        typeof operand === "number"
          ? [operand]
          : bytes.filter(
              (value) =>
                operand === null || (value & operand.mask) === operand.value,
            );
      for (const accumulator of [null, 0, 127, 128, 255])
        for (const carry of [false, true, null]) {
          const results = new Set<number>();
          const carries = new Set<boolean>();
          const overflows = new Set<boolean>();
          const negatives = new Set<boolean>();
          const zeros = new Set<boolean>();
          for (const a of accumulator === null ? bytes : [accumulator])
            for (const b of candidates)
              for (const c of carry === null ? [false, true] : [carry]) {
                const unsigned = subtract
                  ? a - b - (c ? 0 : 1)
                  : a + b + (c ? 1 : 0);
                const signedResult = subtract
                  ? signed(a) - signed(b) - (c ? 0 : 1)
                  : signed(a) + signed(b) + (c ? 1 : 0);
                const result = ((unsigned % 256) + 256) % 256;
                results.add(result);
                carries.add(subtract ? unsigned >= 0 : unsigned > 255);
                overflows.add(signedResult < -128 || signedResult > 127);
                negatives.add(result >= 128);
                zeros.add(result === 0);
              }
          const expected = {
            ...initial,
            a: results.size === 1 ? [...results][0]! : null,
            c: carries.size === 1 ? [...carries][0]! : null,
            v: overflows.size === 1 ? [...overflows][0]! : null,
            n: negatives.size === 1 ? [...negatives][0]! : null,
            z: zeros.size === 1 ? [...zeros][0]! : null,
            ...registerProof(results),
          };
          const actual = { ...initial, a: accumulator, c: carry };
          nesAdd(actual, operand, subtract);
          if (JSON.stringify(actual) !== JSON.stringify(expected))
            throw new Error(
              JSON.stringify({
                subtract,
                accumulator,
                carry,
                operand,
                actual,
                expected,
              }),
            );
          checked++;
        }
    }
    expect(checked).toBe(3 ** 8 * 5 * 3);
  },
  30_000,
);

it.each(["ASL", "LSR", "ROL", "ROR"] as const)(
  "represents exactly the concrete shifted bytes for %s",
  (operation) => {
    const initial = nesCpuStateSchema.parse({
      a: 19,
      x: 23,
      y: 31,
      sp: 253,
      v: true,
      i: true,
      d: false,
    });
    let checked = 0;
    const expand = (value: NesByteValue) =>
      typeof value === "number"
        ? [value]
        : bytes.filter(
            (candidate) =>
              value === null || (candidate & value.mask) === value.value,
          );
    for (const operand of operands)
      for (const carry of [false, true, null]) {
        const results = new Set<number>();
        const carries = new Set<boolean>();
        const negatives = new Set<boolean>();
        const zeros = new Set<boolean>();
        for (const value of expand(operand))
          for (const c of carry === null ? [false, true] : [carry]) {
            const result =
              operation === "ASL"
                ? (value * 2) % 256
                : operation === "LSR"
                  ? Math.floor(value / 2)
                  : operation === "ROL"
                    ? (value * 2 + Number(c)) % 256
                    : Math.floor(value / 2) + (c ? 128 : 0);
            results.add(result);
            carries.add(
              operation === "ASL" || operation === "ROL"
                ? value >= 128
                : value % 2 === 1,
            );
            negatives.add(result >= 128);
            zeros.add(result === 0);
          }
        const expected = {
          ...initial,
          c: carries.size === 1 ? [...carries][0]! : null,
          n: negatives.size === 1 ? [...negatives][0]! : null,
          z: zeros.size === 1 ? [...zeros][0]! : null,
        };
        const actual = { ...initial, c: carry };
        const shifted = nesShift(actual, operand, operation);
        const concrete = [...results].sort((a, b) => a - b);
        if (
          JSON.stringify(expand(shifted)) !== JSON.stringify(concrete) ||
          JSON.stringify(actual) !== JSON.stringify(expected)
        )
          throw new Error(
            JSON.stringify({
              operation,
              operand,
              carry,
              shifted,
              actual,
              expected,
              concrete,
            }),
          );
        if (typeof shifted === "object" && shifted !== null) {
          expect(shifted.mask).toBeGreaterThan(0);
          expect(shifted.mask).toBeLessThan(255);
          expect(shifted.value & ~shifted.mask).toBe(0);
        }
        checked++;
      }
    expect(checked).toBe(3 ** 8 * 3);
  },
  20_000,
);

it.each([1, -1] as const)(
  "retains the maximal common writeback bits and exact flags for delta=%i",
  (delta) => {
    const initial = nesCpuStateSchema.parse({
      a: 17,
      x: 23,
      y: 31,
      sp: 253,
      c: true,
      v: true,
      i: true,
      d: true,
    });
    for (const operand of operands) {
      const candidates =
        typeof operand === "number"
          ? [operand]
          : bytes.filter(
              (value) =>
                operand === null || (value & operand.mask) === operand.value,
            );
      const results = candidates.map((value) => (value + delta + 256) % 256);
      let mask = 0,
        bits = 0;
      for (let bit = 1; bit <= 128; bit *= 2) {
        const allSet = results.every((value) => (value & bit) !== 0);
        const allClear = results.every((value) => (value & bit) === 0);
        if (allSet || allClear) mask += bit;
        if (allSet) bits += bit;
      }
      const expectedValue =
        mask === 0 ? null : mask === 255 ? bits : { mask, value: bits };
      const negative = results.map((value) => value >= 128);
      const zero = results.map((value) => value === 0);
      const expectedCpu = {
        ...initial,
        n: negative.every((flag) => flag === negative[0]) ? negative[0]! : null,
        z: zero.every((flag) => flag === zero[0]) ? zero[0]! : null,
      };
      const actualCpu = { ...initial };
      const actualValue = nesIncrement(actualCpu, operand, delta);
      if (
        JSON.stringify(actualValue) !== JSON.stringify(expectedValue) ||
        JSON.stringify(actualCpu) !== JSON.stringify(expectedCpu)
      )
        throw new Error(
          JSON.stringify({
            delta,
            operand,
            actualValue,
            expectedValue,
            actualCpu,
            expectedCpu,
          }),
        );
    }
    expect(operands).toHaveLength(3 ** 8);
  },
);
