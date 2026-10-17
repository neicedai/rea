import { z } from "zod";
import {
  nesByteBits,
  nesByteProof,
  nesByteCandidates,
  nesByteValueSchema,
  nesKnownBitsSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesMmc5State } from "./nesMmc5.js";
import { readMmc5ExramCell, updateMmc5ExramCell } from "./nesMmc5Exram.js";

/** Exact shared-bit product envelope; the finite 8-bit operands admit at most 65,536 products. */
export const mmc5Product = (
  a: NesByteValue,
  b: NesByteValue,
): { low: NesByteValue; high: NesByteValue } => {
  let mask = 65535,
    first: number | undefined;
  const right = nesByteCandidates(b);
  outer: for (const left of nesByteCandidates(a))
    for (const r of right) {
      const product = left * r;
      if (first === undefined) first = product;
      else mask &= ~(first ^ product);
      if (mask === 0) break outer;
    }
  const byte = (shift: number): NesByteValue => {
    const bits = (mask >> shift) & 255,
      value = ((first ?? 0) >> shift) & bits;
    return nesByteProof(bits, value);
  };
  return { low: byte(0), high: byte(8) };
};

export const nesMmc5MultiplySourceSchema = z.strictObject({
  kind: z.literal("mmc5-multiply"),
  product_byte: z.enum(["low", "high"]),
  multiplicand: nesByteValueSchema,
  multiplier: nesByteValueSchema,
});
export const nesMmc5ExramSourceSchema = z.strictObject({
  kind: z.literal("mmc5-exram"),
  cell_address: z.number().int().min(0).max(1023),
  access: z.enum(["readable", "open-bus", "unknown"]),
  mode: nesByteValueSchema,
  written_since_reset: z.boolean().nullable(),
  cell_value: nesByteValueSchema,
});
export const nesMmc5ReadSourceSchema = z.discriminatedUnion("kind", [
  nesMmc5MultiplySourceSchema,
  nesMmc5ExramSourceSchema,
]);
const read = z.strictObject({
  address: z.number().int().min(0).max(65535),
  value: z.null(),
  source: nesMmc5ReadSourceSchema.nullable(),
});
export const nesMmc5CpuReadSchema = z.union([
  read,
  read.extend({
    value: z.number().int().min(0).max(255),
    source: nesMmc5ReadSourceSchema,
  }),
  read.extend({
    value: z.null(),
    known_bits: nesKnownBitsSchema,
    source: nesMmc5ReadSourceSchema,
  }),
]);
export type NesMmc5CpuRead = z.infer<typeof nesMmc5CpuReadSchema>;

/** Reads do not mutate factors or RAM. Open bus is unknown, not a guessed byte. */
export const readMmc5Cpu = (
  state: NesMmc5State,
  address: number,
): NesMmc5CpuRead | null => {
  let source: z.infer<typeof nesMmc5ReadSourceSchema>, value: NesByteValue;
  if (address === 0x5205 || address === 0x5206) {
    const a = state.multiplier[0] ?? null,
      b = state.multiplier[1] ?? null;
    const part = address === 0x5205 ? "low" : "high";
    value = mmc5Product(a, b)[part];
    source = {
      kind: "mmc5-multiply",
      product_byte: part,
      multiplicand: a,
      multiplier: b,
    };
  } else if (address >= 0x5c00 && address <= 0x5fff) {
    const enabled = nesByteBits(state.exram_mode, 2);
    const initialized =
      state.exram_written === true ||
      (state.exram_written === null &&
        (nesByteBits(state.exram_mode, 1) === 0 || enabled === 0));
    const cellValue = readMmc5ExramCell(state, address - 0x5c00).value;
    value = enabled === 2 && initialized ? cellValue : null;
    source = {
      kind: "mmc5-exram",
      cell_address: address - 0x5c00,
      access:
        enabled === 2 && initialized
          ? "readable"
          : enabled === 0
            ? "open-bus"
            : "unknown",
      mode: state.exram_mode,
      written_since_reset: state.exram_written,
      cell_value: cellValue,
    };
  } else return null;
  return typeof value === "number"
    ? { address, value, source }
    : value === null
      ? { address, value: null, source }
      : { address, value: null, known_bits: value, source };
};

/** Ordinary/readonly modes are independent of rendering; restricted writes retain unknown hardware effects. */
export const writeMmc5Exram = (
  state: NesMmc5State,
  address: number,
  value: NesByteValue,
  ...history: [inFrame?: boolean | null, eventIndex?: number]
): "exram-write" | "exram-write-ignored" | "uncertain-exram-write" => {
  const [inFrame, eventIndex] = history;
  const modes = [
    ...new Set(nesByteCandidates(state.exram_mode).map((v) => v & 3)),
  ];
  const access = modes.map((mode) =>
    mode === 3
      ? "ignored"
      : state.exram_written !== false &&
          (mode === 2 || (mode < 2 && inFrame === true))
        ? "write"
        : "invalidate",
  );
  const selected = access.every((choice) => choice === "ignored")
    ? "ignored"
    : access.includes("invalidate")
      ? "invalidate"
      : access.every((choice) => choice === "write")
        ? "write"
        : "conditional-write";
  updateMmc5ExramCell(state, address - 0x5c00, value, {
    access: selected,
    eventIndex,
  });
  return selected === "write"
    ? "exram-write"
    : selected === "ignored"
      ? "exram-write-ignored"
      : "uncertain-exram-write";
};
