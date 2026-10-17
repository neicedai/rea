import type { Nes6502Opcode } from "./nes6502Opcodes.js";
import type { NesCpuState } from "./nesCodeTrace.js";
import type { NesCpuRegister } from "./nesCpuRegister.js";
import type { NesDiscoveryState } from "./nesCodeDiscoveryState.js";
import { nesDiscoveryPredicateTruth } from "./nesCodeDiscoveryPredicates.js";
import { nesDiscoveryValueLeader } from "./nesCodeDiscoveryValues.js";
import {
  nesDiscoveryDomainValues,
  nesDiscoveryMapDomain,
} from "./nesCodeDiscoveryDomains.js";
type AluInput = Pick<
  NesDiscoveryState,
  "cpu" | "register_domains" | "flag_predicates" | "values"
>;
/** A live carry carrier identifies the same original A candidate, before masking or rotating it. */
const mapWithCarry = (
  before: AluInput,
  operation: (value: number, carry: number) => number,
): bigint => {
  const predicate = before.flag_predicates.c;
  if (
    predicate !== null &&
    nesDiscoveryValueLeader(before.values, predicate.carrier_variable) ===
      nesDiscoveryValueLeader(before.values, 0)
  )
    return nesDiscoveryMapDomain(before.register_domains.a, (value) =>
      operation(
        value,
        Number(nesDiscoveryPredicateTruth("c", predicate, value)),
      ),
    );
  if (before.cpu.c !== null)
    return nesDiscoveryMapDomain(before.register_domains.a, (value) =>
      operation(value, Number(before.cpu.c)),
    );
  return (
    nesDiscoveryMapDomain(before.register_domains.a, (value) =>
      operation(value, 0),
    ) |
    nesDiscoveryMapDomain(before.register_domains.a, (value) =>
      operation(value, 1),
    )
  );
};
const truth = (
  domain: bigint,
  test: (value: number) => boolean,
): boolean | null => {
  let result: boolean | undefined;
  for (const value of nesDiscoveryDomainValues(domain)) {
    const next = test(value);
    if (result !== undefined && result !== next) return null;
    result = next;
  }
  return result ?? null;
};
const accumulatorImage = (
  opcode: Nes6502Opcode,
  before: AluInput,
  cpu: NesCpuState,
): Partial<Record<NesCpuRegister, bigint>> | null => {
  const op = opcode.mnemonic,
    domains = before.register_domains;
  if (opcode.mode === "acc" && ["ASL", "LSR", "ROL", "ROR"].includes(op)) {
    const result =
      op === "ASL" || op === "LSR"
        ? nesDiscoveryMapDomain(domains.a, (value) =>
            op === "ASL" ? value << 1 : value >> 1,
          )
        : mapWithCarry(before, (value, carry) =>
            op === "ROL" ? (value << 1) | carry : (value >> 1) | (carry << 7),
          );
    cpu.c = truth(
      domains.a,
      (value) => (value & (op === "ASL" || op === "ROL" ? 128 : 1)) !== 0,
    );
    return { a: result };
  }
  return null;
};
const stackDeltas: Readonly<Record<string, number>> = {
  JSR: -2,
  RTS: 2,
  PHA: -1,
  PHP: -1,
  PLA: 1,
  PLP: 1,
};
/** Exact unary images preserve holes; unsupported binary correlations use the executed ALU envelope. */
export const exactNesDiscoveryAluDomains = (
  opcode: Nes6502Opcode,
  operand: number | null,
  before: AluInput,
  cpu: NesCpuState,
): Partial<Record<NesCpuRegister, bigint>> => {
  const op = opcode.mnemonic,
    domains = before.register_domains;
  if (op === "INX" || op === "DEX")
    return {
      x: nesDiscoveryMapDomain(
        domains.x,
        (value) => value + (op === "INX" ? 1 : -1),
      ),
    };
  if (op === "INY" || op === "DEY")
    return {
      y: nesDiscoveryMapDomain(
        domains.y,
        (value) => value + (op === "INY" ? 1 : -1),
      ),
    };
  const delta = stackDeltas[op];
  if (delta !== undefined)
    return { sp: nesDiscoveryMapDomain(domains.sp, (value) => value + delta) };
  if (
    operand !== null &&
    (op === "AND" || op === "ORA" || op === "EOR" || op === "ANC")
  ) {
    const result = nesDiscoveryMapDomain(domains.a, (value) =>
      op === "AND" || op === "ANC"
        ? value & operand
        : op === "ORA"
          ? value | operand
          : value ^ operand,
    );
    if (op === "ANC") cpu.c = truth(result, (value) => (value & 128) !== 0);
    return { a: result };
  }
  if (operand !== null && op === "LAS") {
    const result = nesDiscoveryMapDomain(
      domains.sp,
      (value) => value & operand,
    );
    return { a: result, x: result, sp: result };
  }
  const accumulator = accumulatorImage(opcode, before, cpu);
  if (accumulator !== null) return accumulator;
  if (operand !== null && (op === "ALR" || op === "ARR")) {
    const masked = nesDiscoveryMapDomain(domains.a, (value) => value & operand);
    if (op === "ALR") {
      cpu.c = truth(masked, (value) => (value & 1) !== 0);
      return { a: nesDiscoveryMapDomain(masked, (value) => value >> 1) };
    }
    const result = mapWithCarry(
      before,
      (value, carry) => ((value & operand) >> 1) | (carry << 7),
    );
    cpu.c = truth(result, (value) => (value & 64) !== 0);
    cpu.v = truth(result, (value) => ((value >> 6) ^ (value >> 5)) % 2 !== 0);
    return { a: result };
  }
  return {};
};
