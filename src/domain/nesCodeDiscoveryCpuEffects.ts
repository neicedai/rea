import type { Nes6502Opcode } from "./nes6502Opcodes.js";
import type { NesCpuState } from "./nesCodeTrace.js";
import { setNesCpuByte } from "./nesCpuRegister.js";
import { nesDiscoveryRegisterEffect } from "./nesCodeDiscoveryRegisterRelations.js";
const carryWriters = new Set([
  "CLC",
  "SEC",
  "CMP",
  "CPX",
  "CPY",
  "ADC",
  "SBC",
  "ASL",
  "LSR",
  "ROL",
  "ROR",
  "ANC",
  "ALR",
  "ARR",
  "AXS",
  "DCP",
  "ISC",
  "SLO",
  "RLA",
  "SRE",
  "RRA",
  "PLP",
  "RTI",
]);
const nzMemoryWriters = new Set([
  "CMP",
  "CPX",
  "CPY",
  "BIT",
  "ASL",
  "LSR",
  "ROL",
  "ROR",
  "INC",
  "DEC",
  "DCP",
  "ISC",
  "SLO",
  "RLA",
  "SRE",
  "RRA",
  "PLP",
  "RTI",
]);
const overflowWriters = new Set([
  "ADC",
  "SBC",
  "ARR",
  "BIT",
  "PLP",
  "RTI",
  "ISC",
  "RRA",
  "CLV",
]);
const readModifyWrites = new Set([
  "ASL",
  "LSR",
  "ROL",
  "ROR",
  "INC",
  "DEC",
  "DCP",
  "ISC",
  "SLO",
  "RLA",
  "SRE",
  "RRA",
]);
/** Semantic write sets invalidate relations even when the resulting numeric flag happens to agree. */
export const nesDiscoveryWrittenFlags = (
  opcode: Nes6502Opcode,
): ("c" | "z" | "n" | "v")[] => {
  const result: ("c" | "z" | "n" | "v")[] = [];
  if (carryWriters.has(opcode.mnemonic)) result.push("c");
  if (
    nzMemoryWriters.has(opcode.mnemonic) ||
    nesDiscoveryRegisterEffect(opcode).written.some(
      (register) => register !== "sp",
    )
  )
    result.push("z", "n");
  if (overflowWriters.has(opcode.mnemonic)) result.push("v");
  return result;
};
/** An unresolved RMW still changes its CPU results; only its physical destination is unknown. */
export const havocUnresolvedNesDiscoveryWrite = (
  cpu: NesCpuState,
  opcode: Nes6502Opcode,
): void => {
  if (opcode.mode === "acc" || !readModifyWrites.has(opcode.mnemonic)) return;
  for (const register of nesDiscoveryRegisterEffect(opcode).written)
    setNesCpuByte(cpu, register, null);
  for (const flag of nesDiscoveryWrittenFlags(opcode)) cpu[flag] = null;
};
