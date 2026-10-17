import type { z } from "zod";
import type {
  nesDiscoveryRegisterDomainsSchema,
  nesDiscoveryFlagPredicatesSchema,
} from "./nesCodeDiscoveryDomainSchemas.js";
import { nesByteProof, type NesByteValue } from "./nesByteValue.js";

export type NesDiscoveryDomainSnapshot = z.infer<
  typeof nesDiscoveryRegisterDomainsSchema
>;
export type NesDiscoveryPredicateSnapshot = z.infer<
  typeof nesDiscoveryFlagPredicatesSchema
>;
export type NesDiscoveryPredicate = NonNullable<
  NesDiscoveryPredicateSnapshot["z"]
>;
export type NesDiscoveryDomainPool = readonly {
  index: number;
  bitmap_hex: string;
  count: number;
}[];
export const nesDiscoveryDomainRegisters = ["a", "x", "y", "sp"] as const;
const bits = Array.from({ length: 256 }, (_, value) => 1n << BigInt(value));
export const parseNesDiscoveryDomainBitmap = (bitmap: string): bigint | null =>
  /^[a-f0-9]{64}$/u.test(bitmap) ? BigInt(`0x${bitmap}`) : null;
export const nesDiscoveryDomainValues = (domain: bigint): number[] => {
  const values: number[] = [];
  for (let value = 0; value < 256; value++)
    if ((domain & bits[value]!) !== 0n) values.push(value);
  return values;
};
export const nesDiscoveryDomainEnvelope = (domain: bigint): NesByteValue => {
  let ones = 255,
    any = 0;
  for (const value of nesDiscoveryDomainValues(domain)) {
    ones &= value;
    any |= value;
  }
  return nesByteProof((~any | ones) & 255, ones);
};
/** This wire guard evaluates the stated predicate independently of producer transfers. */
export const nesDiscoveryPredicateTruth = (
  predicate: NesDiscoveryPredicate,
  flag: "c" | "z" | "n",
  value: number,
): boolean => {
  if (predicate.kind === "result")
    return flag === "z" ? value === 0 : (value & 128) !== 0;
  return flag === "c"
    ? value >= predicate.operand
    : flag === "z"
      ? value === predicate.operand
      : ((value - predicate.operand) & 255 & 128) !== 0;
};
