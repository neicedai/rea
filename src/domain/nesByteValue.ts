import { z } from "zod";

/** Exact set-bit predicates within the owning byte range, without repeated 128-value enums. */
const setByteBitSchema = (bit: number): Record<string, unknown> => {
  if (bit === 0) return { not: { multipleOf: 2 } };
  const width = 1 << bit;
  if (bit === 1)
    return {
      enum: Array.from({ length: 256 }, (_, value) => value).filter(
        (value) => (value & width) !== 0,
      ),
    };
  const ranges = Array.from({ length: 128 / width }, (_, index) => ({
    minimum: width + index * width * 2,
    maximum: width * 2 - 1 + index * width * 2,
  }));
  return ranges.length === 1 ? (ranges[0] ?? {}) : { anyOf: ranges };
};

export const nesKnownBitsSchema = z
  .strictObject({
    mask: z.number().int().min(1).max(254),
    value: z.number().int().min(0).max(255),
  })
  .refine(({ mask, value }) => (value & ~mask) === 0, {
    message: "Partial byte value must be zero outside its known-bit mask",
    path: ["value"],
  })
  .meta({
    // JSON Schema has no bitwise operator; each set value bit requires the same mask bit.
    allOf: Array.from({ length: 8 }, (_, bit) => {
      const set = setByteBitSchema(bit);
      return {
        if: { properties: { value: set }, required: ["value"] },
        then: { properties: { mask: set }, required: ["mask"] },
      };
    }),
  })
  .describe(
    "Partial byte proof: only bits set in mask are known, and value has zero in all other bits. The complete byte remains null. Mapper replay preserves this evidence. MMC1 interprets proven D7/D0 serial bits and retains partial PRG/CHR selectors; MMC3 bank registers retain partial bytes; other register models may retain an unknown complete value.",
  );
export type NesKnownBits = z.infer<typeof nesKnownBitsSchema>;
export const nesKnownByteValueSchema = z.union([
  z.number().int().min(0).max(255),
  nesKnownBitsSchema,
]);
export const nesByteValueSchema = nesKnownByteValueSchema.nullable();
export type NesByteValue = z.infer<typeof nesByteValueSchema>;

/** Shared two-bit index/selector proof; both known bits use a complete number. */
export const nesTwoBitValueSchema = z
  .union([
    z.number().int().min(0).max(3),
    nesKnownBitsSchema
      .safeExtend({
        mask: z.union([z.literal(1), z.literal(2)]),
        value: z.number().int().min(0).max(2),
      })
      .meta(nesKnownBitsSchema.meta() ?? {}),
  ])
  .nullable();
export type NesTwoBitValue = z.infer<typeof nesTwoBitValueSchema>;
export const nesTwoBitProof = (mask: number, value: number): NesTwoBitValue => {
  const bits = mask & 3,
    known = value & bits;
  return bits === 0
    ? null
    : bits === 3
      ? known
      : bits === 1
        ? { mask: 1, value: known }
        : { mask: 2, value: known };
};

/** Canonical derived bit envelope: a full byte, partial proof, or explicit unknown. */
export const nesByteProof = (mask: number, value: number): NesByteValue => {
  const bits = mask & 255,
    known = value & bits;
  return bits === 0
    ? null
    : bits === 255
      ? known
      : { mask: bits, value: known };
};

/** AND bus drivers prove a zero from either side and a one only from both. */
export const andNesBytes = (
  left: NesByteValue,
  right: NesByteValue,
): NesByteValue => {
  const l = typeof left === "number" ? { mask: 255, value: left } : left;
  const r = typeof right === "number" ? { mask: 255, value: right } : right;
  const zeros =
    ((l?.mask ?? 0) & ~(l?.value ?? 0)) | ((r?.mask ?? 0) & ~(r?.value ?? 0));
  const ones = (l?.value ?? 0) & (r?.value ?? 0);
  return nesByteProof(zeros | ones, ones);
};

/** Concrete bytes consistent with a canonical full or partial source proof. */
export const nesByteCandidates = (byte: NesByteValue): number[] =>
  typeof byte === "number"
    ? [byte]
    : Array.from({ length: 256 }, (_, n) => n).filter(
        (n) => byte === null || (n & byte.mask) === byte.value,
      );

/** Resolve only the requested physical address bits, never fill unknown bits with zero. */
export const nesByteBits = (
  value: NesByteValue | undefined,
  mask: number,
): number | null => {
  if (mask === 0) return 0;
  if (value == null) return null;
  if (typeof value === "number") return value & mask;
  return (value.mask & mask) === mask ? value.value & mask : null;
};

/** Retain only bit facts shared by every possible byte source or write outcome. */
export const joinNesBytes = (
  left: NesByteValue,
  right: NesByteValue,
): NesByteValue => {
  const l = typeof left === "number" ? { mask: 255, value: left } : left;
  const r = typeof right === "number" ? { mask: 255, value: right } : right;
  if (l === null || r === null) return null;
  const mask = l.mask & r.mask & ~(l.value ^ r.value) & 255;
  const value = l.value & mask;
  return nesByteProof(mask, value);
};
