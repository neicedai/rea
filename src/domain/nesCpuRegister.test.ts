import { expect, it } from "vitest";
import { nesCpuStateSchema, traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { nesCpuByte, setNesCpuByte } from "./nesCpuRegister.js";
import {
  nesAdd,
  nesCompare,
  nesLogic,
  nesUnofficialImmediate,
  nesArr,
} from "./nes6502Alu.js";
import { nesByteCandidates, type NesByteValue } from "./nesByteValue.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { mmc5CpuFixtures } from "./nesMmc5Cpu.fixture.js";
import { parseNesHeader } from "./nes.js";

const envelope = (values: number[]): NesByteValue => {
  const and = values.reduce((a, b) => a & b, 255),
    or = values.reduce((a, b) => a | b, 0),
    mask = ~(and ^ or) & 255;
  return mask === 0 ? null : mask === 255 ? and : { mask, value: and };
};

it("keeps partial register snapshots immutable and clears overwritten proofs", () => {
  const cpu = nesCpuStateSchema.parse({
    register_bits: { a: { mask: 3, value: 0 }, x: { mask: 128, value: 128 } },
  });
  const before = { ...cpu };
  setNesCpuByte(cpu, "a", 0);
  expect(nesCpuByte(cpu, "a")).toBe(0);
  expect(nesCpuByte(before, "a")).toEqual({ mask: 3, value: 0 });
  expect(nesCpuByte(cpu, "x")).toEqual({ mask: 128, value: 128 });
  setNesCpuByte(cpu, "x", null);
  expect("register_bits" in cpu).toBe(false);
});

it("matches arithmetic, comparison and stable unofficial operations for partial accumulator inputs", () => {
  const lefts: NesByteValue[] = [
    { mask: 3, value: 0 },
    { mask: 128, value: 128 },
    { mask: 240, value: 160 },
    { mask: 85, value: 0 },
    { mask: 170, value: 170 },
  ];
  for (const left of lefts)
    for (const right of [0, 1, 127, 128, 255])
      for (const carry of [false, true, null]) {
        const base = nesCpuStateSchema.parse({
          c: carry,
          register_bits: { a: left },
        });
        const candidates = nesByteCandidates(left),
          cs = carry === null ? [0, 1] : [Number(carry)];
        for (const subtract of [false, true]) {
          const actual = structuredClone(base),
            values = candidates.flatMap((a) =>
              cs.map((c) => (a + (subtract ? right ^ 255 : right) + c) & 255),
            );
          nesAdd(actual, right, subtract);
          expect(nesCpuByte(actual, "a")).toEqual(envelope(values));
        }
        const compared = structuredClone(base);
        nesCompare(compared, left, right);
        const carries = candidates.map((a) => a >= right),
          zeros = candidates.map((a) => a === right),
          negatives = candidates.map((a) => ((a - right) & 128) !== 0);
        const common = (values: boolean[]) =>
          values.every((v) => v === values[0]) ? values[0] : null;
        expect([compared.c, compared.z, compared.n]).toEqual([
          common(carries),
          common(zeros),
          common(negatives),
        ]);
        for (const op of ["AND", "ORA", "EOR"] as const) {
          const cpu = structuredClone(base);
          nesLogic(cpu, right, op);
          expect(nesCpuByte(cpu, "a")).toEqual(
            envelope(
              candidates.map((a) =>
                op === "AND" ? a & right : op === "ORA" ? a | right : a ^ right,
              ),
            ),
          );
        }
        for (const op of ["ANC", "ALR"] as const) {
          const cpu = structuredClone(base);
          nesUnofficialImmediate(cpu, right, op);
          expect(nesCpuByte(cpu, "a")).toEqual(
            envelope(
              candidates.map((a) =>
                op === "ANC" ? a & right : (a & right) >>> 1,
              ),
            ),
          );
        }
        const arr = structuredClone(base);
        nesArr(arr, right);
        expect(nesCpuByte(arr, "a")).toEqual(
          envelope(
            candidates.flatMap((a) =>
              cs.map((c) => ((a & right) >>> 1) | (c << 7)),
            ),
          ),
        );
      }
});

it("preserves caller CPU facts during snapshot continuation", async () => {
  const fixture = mmc5CpuFixtures().find((f) => f.name === "partial-product")!;
  const parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const input = traceNesCodeInputSchema.parse({
    path: "/fixture.nes",
    ...fixture.input,
    max_instructions: 1,
  });
  const prefix = await deriveNesCode(
    parsed.value,
    fixture.bytes.subarray(
      fixture.prgOffset,
      fixture.prgOffset + fixture.prgSize,
    ),
    input,
  );
  if (prefix.status !== "derived" || prefix.mapper_trace.status !== "derived")
    throw new Error("Expected prefix");
  expect(prefix.final_cpu).toMatchObject({
    a: null,
    register_bits: { a: { mask: 3, value: 0 } },
  });
  const continuedInput = traceNesCodeInputSchema.parse({
    ...input,
    initial: prefix.mapper_trace.final,
    cpu: prefix.final_cpu,
    entry: prefix.stop.address,
    max_instructions: 64,
  });
  const before = structuredClone(continuedInput);
  const continued = await deriveNesCode(
    parsed.value,
    fixture.bytes.subarray(
      fixture.prgOffset,
      fixture.prgOffset + fixture.prgSize,
    ),
    continuedInput,
  );
  expect(continued).toMatchObject({
    stop: { reason: "return" },
    final_cpu: { a: 0x55 },
  });
  expect(continuedInput).toEqual(before);
});
