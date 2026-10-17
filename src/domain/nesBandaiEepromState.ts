import { z } from "zod";
import { nesByteValueSchema, nesKnownBitsSchema } from "./nesByteValue.js";

const bit = z.union([z.literal(0), z.literal(1)]);
const phase = z.enum([
  "unknown",
  "idle",
  "command",
  "address",
  "write",
  "ack",
  "read",
  "master-ack",
  "ignore",
]);
const storage = (capacity: number) => {
  const cell = z.strictObject({
    address: z
      .number()
      .int()
      .min(0)
      .max(capacity - 1),
    value: nesByteValueSchema,
  });
  const unique = <T extends { address: number }>(
    items: T[],
    ctx: z.RefinementCtx,
  ) => {
    const addresses = new Set<number>();
    for (const [index, item] of items.entries()) {
      if (addresses.has(item.address))
        ctx.addIssue({
          code: "custom",
          path: [index, "address"],
          message: "EEPROM physical byte addresses must be unique",
        });
      addresses.add(item.address);
    }
  };
  return {
    bytes: z
      .array(cell)
      .max(capacity)
      .superRefine(unique)
      .default([])
      .describe(
        "Sparse committed physical EEPROM byte assumptions; absent addresses are unknown, never erased-byte defaults. No CPU PRG RAM or save-file format is implied.",
      ),
    pending: z
      .array(cell.extend({ definite: z.boolean() }))
      .max(capacity)
      .superRefine(unique)
      .default([])
      .describe(
        "Page-buffer facts, including possible writes under partial pointers. They do not update committed bytes before STOP and an explicit write-completion event.",
      ),
  };
};
const fields = {
  phase: phase.default("unknown"),
  next_phase: z
    .enum(["unknown", "address", "write", "read", "ignore"])
    .default("unknown"),
  bit_index: z.number().int().min(0).max(8).default(0),
  shift: nesByteValueSchema.default(null),
  address: nesByteValueSchema.default(null),
  ack_stage: z.number().int().min(0).max(2).default(0),
  ack_bit: bit.nullable().default(null),
  busy: z
    .boolean()
    .nullable()
    .default(null)
    .describe(
      "Conventional explicit-completion model: no elapsed write time is inferred from control writes, CPU instructions or IRQ cycles. Omission leaves readiness unknown.",
    ),
  pending_unknown: z.boolean().default(false),
};
export const nesBandaiEepromStateSchema = z.union([
  z.strictObject({
    model: z.literal("x24c01"),
    page_size: z.literal(4).default(4),
    ...fields,
    address: z
      .union([
        z.number().int().min(0).max(127),
        nesKnownBitsSchema
          .refine(({ value }) => value < 128, {
            message: "X24C01 pointer cannot prove address bit 7 set",
          })
          .meta({
            ...nesKnownBitsSchema.meta(),
            properties: { value: { maximum: 127 } },
          }),
        z.null(),
      ])
      .default(null),
    ...storage(128),
  }),
  z.strictObject({
    model: z.literal("x24c02"),
    page_size: z
      .union([z.literal(4), z.literal(16)])
      .describe(
        "Required immutable chip revision assumption: early Xicor X24C02 uses four-byte pages; later revisions use sixteen. Capacity alone does not identify it.",
      ),
    ...fields,
    ...storage(256),
  }),
]);
export type NesBandaiEepromState = z.infer<typeof nesBandaiEepromStateSchema>;

export const nesBandaiEepromReadSourceSchema = z.strictObject({
  model: z.enum(["x24c01", "x24c02"]),
  kind: z.enum(["master-low", "device-ack", "device-data", "released-pullup"]),
  pointer: nesByteValueSchema,
  bit_index: z.number().int().min(0).max(7).nullable(),
  byte_value: nesByteValueSchema,
});
const read = z.strictObject({
  address: z.number().int().min(0).max(65535),
  value: z.null(),
  source: nesBandaiEepromReadSourceSchema.nullable(),
});
export const nesBandaiEepromReadSchema = z.union([
  read,
  read.extend({
    known_bits: z.strictObject({
      mask: z.literal(16),
      value: z.union([z.literal(0), z.literal(16)]),
    }),
  }),
]);
export type NesBandaiEepromRead = z.infer<typeof nesBandaiEepromReadSchema>;
