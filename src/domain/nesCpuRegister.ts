import { z } from "zod";
import { nesKnownBitsSchema, type NesByteValue } from "./nesByteValue.js";
import type { NesCpuState } from "./nesCodeTrace.js";

export type NesCpuRegister = "a" | "x" | "y" | "sp";
export const nesCpuRegisterBitsSchema = z
  .record(z.string().regex(/^(?:a|x|y|sp)$/), nesKnownBitsSchema)
  .refine((bits) => Object.keys(bits).length > 0, {
    message: "Omit register_bits when no partial register proof remains",
  })
  .meta({ minProperties: 1, maxProperties: 4 })
  .describe(
    "Partial register proofs. The corresponding complete-byte field must be null. Missing keys are unknown; no reset values are inferred.",
  );

export const nesCpuByte = (
  cpu: NesCpuState,
  register: NesCpuRegister,
): NesByteValue =>
  cpu[register] ??
  ("register_bits" in cpu ? (cpu.register_bits[register] ?? null) : null);

/** Copy-on-write proofs keep recorded CPU snapshots and caller input immutable. */
export const setNesCpuByte = (
  cpu: NesCpuState,
  register: NesCpuRegister,
  value: NesByteValue,
): void => {
  cpu[register] = typeof value === "number" ? value : null;
  const bits = "register_bits" in cpu ? { ...cpu.register_bits } : {};
  if (value !== null && typeof value === "object")
    bits[register] = { ...value };
  else Reflect.deleteProperty(bits, register);
  if (Object.keys(bits).length === 0)
    Reflect.deleteProperty(cpu, "register_bits");
  else Object.assign(cpu, { register_bits: bits });
};
