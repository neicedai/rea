import { z } from "zod";
import {
  nesByteValueSchema,
  nesByteBits,
  nesByteCandidates,
  joinNesBytes,
  nesByteProof,
  nesKnownBitsSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesNamco163State } from "./nesNamco163.js";
import type { NesMapperWrite } from "./nesMapperTrace.js";

export const nesNamco163IrqStateSchema = z.strictObject({
  model: z.literal("namco163"),
  counter_low: nesByteValueSchema.default(null),
  counter_high: nesByteValueSchema
    .default(null)
    .describe(
      "High counter byte; only D0–D6 count. D7 is retained raw and does not replace irq_high.D7 enable.",
    ),
  asserted: z.boolean().nullable().default(null),
});
export type NesNamco163IrqState = z.infer<typeof nesNamco163IrqStateSchema>;
export const nesNamco163IrqReadSourceSchema = z.strictObject({
  kind: z.literal("namco163-irq-counter"),
  counter_low: nesByteValueSchema,
  counter_high: nesByteValueSchema,
  irq_high: nesByteValueSchema,
});
const counterRead = z.strictObject({
  address: z.number().int().min(0x5000).max(0x5fff),
  value: z.number().int().min(0).max(255).nullable(),
  source: nesNamco163IrqReadSourceSchema,
});
export const nesNamco163IrqReadSchema = z.union([
  counterRead,
  counterRead.extend({ value: z.null(), known_bits: nesKnownBitsSchema }),
]);
/** Reads do not acknowledge. The high port joins current count bits with the live enable bit. */
export const readNamco163Irq = (
  irq: NesNamco163IrqState,
  mapper: NesNamco163State,
  address: number | null,
): z.infer<typeof nesNamco163IrqReadSchema> | null => {
  if (address === null || address < 0x5000 || address >= 0x6000) return null;
  const bits = (byte: NesByteValue) =>
    typeof byte === "number"
      ? { mask: 255, value: byte }
      : (byte ?? { mask: 0, value: 0 });
  const high = bits(irq.counter_high),
    enabled = bits(mapper.irq_high);
  const value =
    address < 0x5800
      ? irq.counter_low
      : nesByteProof(
          (high.mask & 127) | (enabled.mask & 128),
          (high.value & 127) | (enabled.value & 128),
        );
  return {
    address,
    value: typeof value === "number" ? value : null,
    ...(value !== null && typeof value === "object"
      ? { known_bits: value }
      : {}),
    source: {
      kind: "namco163-irq-counter",
      counter_low: structuredClone(irq.counter_low),
      counter_high: structuredClone(irq.counter_high),
      irq_high: structuredClone(mapper.irq_high),
    },
  };
};
export const isNamco163IrqState = (
  state: { model: string } | null,
): state is NesNamco163IrqState => state?.model === "namco163";
const matches = (
  byte: NesByteValue,
  target: number,
  mask = 255,
): boolean | null => {
  const values = nesByteCandidates(byte),
    hit = values.filter((v) => (v & mask) === target).length;
  return hit === 0 ? false : hit === values.length ? true : null;
};
const both = (a: boolean | null, b: boolean | null) =>
  a === false || b === false ? false : a === true && b === true ? true : null;
const mapByte = (
  byte: NesByteValue,
  f: (v: number) => number,
): NesByteValue => {
  let proof: NesByteValue | undefined;
  for (const v of nesByteCandidates(byte))
    proof = proof === undefined ? f(v) : joinNesBytes(proof, f(v));
  return proof ?? null;
};
export const writeNamco163Irq = (
  previous: NesNamco163IrqState,
  write: NesMapperWrite,
): NesNamco163IrqState => {
  const port = write.address & 0xf800;
  if (port !== 0x5000 && port !== 0x5800) return { ...previous };
  const byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  return {
    ...previous,
    asserted: false,
    ...(port === 0x5000 ? { counter_low: byte } : { counter_high: byte }),
  };
};

/** A 15-bit saturating up-counter; only a transition from 7FFE to 7FFF asserts. */
export const clockNamco163CpuCycle = (
  previous: NesNamco163IrqState,
  mapper: NesNamco163State,
): { state: NesNamco163IrqState; clock: boolean | null } => {
  const enabled = nesByteBits(mapper.irq_high, 128);
  const highMax = matches(previous.counter_high, 127, 127);
  const atMax = both(matches(previous.counter_low, 255), highMax);
  if (enabled === 0 || atMax === true)
    return { state: { ...previous }, clock: false };
  const carry = matches(previous.counter_low, 255);
  const incrementedHigh = mapByte(previous.counter_high, (v) =>
    (v & 127) === 127 ? v : (v & 128) | ((v + 1) & 127),
  );
  const incrementedLow = mapByte(previous.counter_low, (v) => (v + 1) & 255);
  const saturatedLow = mapByte(previous.counter_low, (v) =>
    Math.min(v + 1, 255),
  );
  let low =
    highMax === true
      ? saturatedLow
      : highMax === false
        ? incrementedLow
        : joinNesBytes(incrementedLow, saturatedLow);
  let high =
    carry === false
      ? previous.counter_high
      : carry === true
        ? incrementedHigh
        : joinNesBytes(previous.counter_high, incrementedHigh);
  const triggered = both(matches(previous.counter_low, 254), highMax);
  let asserted =
    previous.asserted === true || triggered === true
      ? true
      : previous.asserted === false && triggered === false
        ? false
        : null;
  if (enabled === null) {
    low = joinNesBytes(previous.counter_low, low);
    high = joinNesBytes(previous.counter_high, high);
    if (previous.asserted !== asserted) asserted = null;
  }
  return {
    clock: enabled === null || atMax === null ? null : true,
    state: { ...previous, counter_low: low, counter_high: high, asserted },
  };
};
