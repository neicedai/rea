import { nesByteProof, type NesByteValue } from "./nesByteValue.js";
import type { NesCpuState } from "./nesCodeTrace.js";
import { setNesCpuByte, type NesCpuRegister } from "./nesCpuRegister.js";

export const nesDiscoveryRegisters = ["a", "x", "y", "sp"] as const;
export const nesDiscoveryAllBytes = (1n << 256n) - 1n;
const byteBits = Object.freeze(
  Array.from({ length: 256 }, (_, value) => 1n << BigInt(value)),
);
const valueBitMasks = Object.freeze(
  Array.from({ length: 8 }, (_, bit) =>
    byteBits.reduce(
      (mask, selected, value) =>
        (value & (1 << bit)) === 0 ? mask : mask | selected,
      0n,
    ),
  ),
);
export type NesDiscoveryRegisterDomains = Record<NesCpuRegister, bigint>;
export const nesDiscoveryByteDomain = (value: NesByteValue): bigint => {
  if (typeof value === "number") return byteBits[value]!;
  if (value === null) return nesDiscoveryAllBytes;
  let domain = nesDiscoveryAllBytes;
  for (let bit = 0; bit < 8; bit++)
    if ((value.mask & (1 << bit)) !== 0)
      domain &=
        (value.value & (1 << bit)) !== 0
          ? valueBitMasks[bit]!
          : nesDiscoveryAllBytes ^ valueBitMasks[bit]!;
  return domain;
};
export function* nesDiscoveryDomainValues(domain: bigint): Generator<number> {
  for (let value = 0; value < 256; value++)
    if ((domain & byteBits[value]!) !== 0n) yield value;
}
export const nesDiscoveryDomainHas = (domain: bigint, value: number): boolean =>
  (domain & byteBits[value]!) !== 0n;
export const nesDiscoveryDomainCount = (domain: bigint): number => {
  if (domain === nesDiscoveryAllBytes) return 256;
  let count = 0;
  for (let bits = domain; bits !== 0n; bits &= bits - 1n) count++;
  return count;
};
export const nesDiscoveryDomainProof = (domain: bigint): NesByteValue => {
  if (domain === 0n || domain === nesDiscoveryAllBytes) return null;
  let mask = 0,
    value = 0;
  for (let bit = 0; bit < 8; bit++) {
    const ones = domain & valueBitMasks[bit]!;
    if (ones === 0n) mask |= 1 << bit;
    else if (ones === domain) {
      mask |= 1 << bit;
      value |= 1 << bit;
    }
  }
  return nesByteProof(mask, value);
};
export const nesDiscoveryMapDomain = (
  domain: bigint,
  operation: (value: number) => number,
): bigint => {
  let result = 0n;
  for (const value of nesDiscoveryDomainValues(domain))
    result |= byteBits[operation(value) & 255]!;
  return result;
};
export const nesDiscoveryProjectDomains = (
  cpu: NesCpuState,
  domains: NesDiscoveryRegisterDomains,
): void => {
  for (const register of nesDiscoveryRegisters)
    setNesCpuByte(cpu, register, nesDiscoveryDomainProof(domains[register]));
};
