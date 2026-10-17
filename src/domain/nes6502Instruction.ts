import type { NesKnownBits } from "./nesByteValue.js";
import { nesCpuByte, setNesCpuByte } from "./nesCpuRegister.js";
import type { Nes6502Context } from "./nes6502Context.js";
export type Nes6502InstructionContext = Pick<
  Nes6502Context,
  | "bus"
  | "callDepth"
  | "controllers"
  | "cpu"
  | "popValue"
  | "push"
  | "read"
  | "readMapperDummy"
  | "readValue"
  | "readVector"
  | "write"
>;
import type { Nes6502Opcode } from "./nes6502Opcodes.js";
import {
  nes6502BranchCondition,
  nes6502BranchTarget,
} from "./nes6502Branches.js";
import type { NesCodeStopReason, NesCodeVector } from "./nesCodeTrace.js";
import {
  nesAdd,
  nesArr,
  nesLogic,
  nesLogicByte,
  nesUnofficialImmediate,
  nesCompare,
  nesShift,
  nesIncrement,
  nesStatusValue,
  setNesNz,
  setNesStatusValue,
} from "./nes6502Alu.js";

type Outcome = (
  | { readonly next: number }
  | { readonly reason: NesCodeStopReason; readonly successors?: number[] }
) & { readonly interruptVector?: NesCodeVector };
const word = (low: number | null, high: number | null): number | null =>
  low === null || high === null ? null : low | (high << 8);
const indexed = (
  base: number | null,
  index: number | null,
  mask = 65535,
): number | null =>
  base === null || index === null ? null : (base + index) & mask;

const indexedBusAddress = (
  context: Nes6502InstructionContext,
  base: number | null,
  register: "x" | "y",
  alwaysDummy: boolean,
): number | null => {
  const index = context.cpu[register];
  const address = indexed(base, index);
  if (context.bus !== null && (base === null || index === null)) {
    let crossing: boolean | null = null;
    if (!alwaysDummy && index !== 0) {
      if (base === null) {
        context.bus.unresolved(null);
        return address;
      }
      const proof = nesCpuByte(context.cpu, register);
      for (let candidate = 0; candidate < 256; candidate++) {
        if (
          typeof proof === "object" &&
          proof !== null &&
          (candidate & proof.mask) !== proof.value
        )
          continue;
        const crosses = (base & 255) + candidate > 255;
        if (crossing !== null && crossing !== crosses) {
          context.bus.unresolved(null);
          return address;
        }
        crossing = crosses;
      }
    }
    if (alwaysDummy || crossing === true) context.readMapperDummy(null);
    return address;
  }
  if (base === null || index === null) {
    // An unresolved optional read must not silently leave a device pointer intact.
    if (
      base === null ||
      (((base & 0xf800) === 0x4800 ||
        (base >= 0x2000 && base <= 0x3fff) ||
        (context.controllers !== null && (base & 0xff00) === 0x4000)) &&
        (alwaysDummy || (base & 255) !== 0))
    )
      context.readMapperDummy(null);
  } else if (alwaysDummy || (base & 0xff00) !== (address! & 0xff00))
    context.readMapperDummy((base & 0xff00) | (address! & 255));
  return address;
};

const addressOf = (
  context: Nes6502InstructionContext,
  mode: Nes6502Opcode["mode"],
  low: number,
  absolute: number,
  alwaysDummy = false,
): number | null => {
  switch (mode) {
    case "zp":
      return low;
    case "zpx":
      if (context.bus !== null) context.readMapperDummy(low);
      return indexed(low, context.cpu.x, 255);
    case "zpy":
      if (context.bus !== null) context.readMapperDummy(low);
      return indexed(low, context.cpu.y, 255);
    case "abs":
      return absolute;
    case "abx":
      return indexedBusAddress(context, absolute, "x", alwaysDummy);
    case "aby":
      return indexedBusAddress(context, absolute, "y", alwaysDummy);
    case "izx": {
      if (context.bus !== null) context.readMapperDummy(low);
      const pointer = indexed(low, context.cpu.x, 255);
      return word(
        context.read(pointer, "pointer"),
        context.read(pointer === null ? null : (pointer + 1) & 255, "pointer"),
      );
    }
    case "izy":
      return indexedBusAddress(
        context,
        word(
          context.read(low, "pointer"),
          context.read((low + 1) & 255, "pointer"),
        ),
        "y",
        alwaysDummy,
      );
    default:
      return null;
  }
};
/** Apply only a resolved instruction path. Boundaries leave the instruction unapplied. */
export const applyNes6502Instruction = (
  context: Nes6502InstructionContext,
  decoded: Nes6502Opcode,
  bytes: readonly number[],
  {
    pc,
    branchTaken,
    fetchJsrHigh,
  }: {
    readonly pc: number;
    readonly branchTaken?: boolean;
    readonly fetchJsrHigh?: () => number | null;
  },
): Outcome => {
  const op = decoded.mnemonic;
  const cpu = context.cpu;
  const next = (pc + decoded.length) & 65535;
  const low = bytes[1] ?? 0;
  const absolute = low | ((bytes[2] ?? 0) << 8);
  const branch = nes6502BranchCondition(op);
  if (branch !== null) {
    const { flag, expected } = branch;
    const target = nes6502BranchTarget(next, low);
    if (cpu[flag] === null && (target !== next || context.bus !== null)) {
      if (branchTaken === undefined)
        return { reason: "unknown-branch", successors: [next, target] };
      // Restrict this path to the caller-selected condition, preserving the assumption in the trace.
      cpu[flag] = branchTaken ? expected : !expected;
    }
    const taken = cpu[flag] === expected;
    if (taken && context.bus !== null) {
      context.readMapperDummy(next);
      if ((next & 0xff00) !== (target & 0xff00))
        context.readMapperDummy((next & 0xff00) | (target & 255));
    }
    return { next: taken ? target : next };
  }
  if (op === "JMP") {
    const target =
      decoded.mode === "abs"
        ? absolute
        : word(
            context.read(absolute, "pointer"),
            context.read(
              (absolute & 0xff00) | ((absolute + 1) & 255),
              "pointer",
            ),
          );
    return target === null
      ? { reason: "unknown-control-target" }
      : { next: target };
  }
  if (
    op === "BRK" ||
    op === "JSR" ||
    op === "RTS" ||
    op === "RTI" ||
    op === "PHA" ||
    op === "PHP" ||
    op === "PLA" ||
    op === "PLP"
  )
    return stackInstruction(context, op, pc, absolute, next, fetchJsrHigh);
  if (
    context.bus !== null &&
    (decoded.mode === "imp" || decoded.mode === "acc")
  )
    context.readMapperDummy(next);
  if (op === "ANC" || op === "ALR" || op === "AXS") {
    nesUnofficialImmediate(cpu, low, op);
    return { next };
  }
  if (op === "ARR") {
    nesArr(cpu, low);
    return { next };
  }
  if (op === "NOP" && decoded.mode !== "imp" && decoded.mode !== "imm") {
    context.readMapperDummy(addressOf(context, decoded.mode, low, absolute));
    return { next };
  }
  if (implied(context, op)) return { next };
  const alwaysDummy = [
    "STA",
    "STX",
    "STY",
    "SAX",
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
  ].includes(op);
  const address = addressOf(context, decoded.mode, low, absolute, alwaysDummy);
  // Capture a memory operand once, preserving the same proof for every consumer.
  // Immediate/accumulator operands and stores do not perform a memory data read.
  const accumulator = nesCpuByte(cpu, "a");
  const operandProof: { value: number | null; known_bits?: NesKnownBits } =
    decoded.mode === "imm"
      ? { value: low }
      : decoded.mode === "acc"
        ? typeof accumulator === "object" && accumulator !== null
          ? { value: null, known_bits: accumulator }
          : { value: accumulator }
        : op === "STA" || op === "STX" || op === "STY" || op === "SAX"
          ? { value: null }
          : context.readValue(address);
  const value = operandProof.value;
  const proof = value ?? operandProof.known_bits ?? null;
  switch (op) {
    case "LAS":
      setNesCpuByte(cpu, "a", nesCpuByte(cpu, "sp"));
      nesLogic(cpu, proof, "AND");
      setNesCpuByte(cpu, "x", nesCpuByte(cpu, "a"));
      setNesCpuByte(cpu, "sp", nesCpuByte(cpu, "a"));
      break;
    case "LAX":
      setNesCpuByte(cpu, "x", proof);
      setNesCpuByte(cpu, "a", proof);
      setNesNz(cpu, proof);
      break;
    case "SAX":
      if (address === null) return { reason: "unknown-write-address" };
      context.write(
        address,
        nesLogicByte(nesCpuByte(cpu, "a"), nesCpuByte(cpu, "x"), "AND"),
      );
      break;
    case "LDA":
      setNesCpuByte(cpu, "a", proof);
      setNesNz(cpu, proof);
      break;
    case "LDX":
      setNesCpuByte(cpu, "x", proof);
      setNesNz(cpu, proof);
      break;
    case "LDY":
      setNesCpuByte(cpu, "y", proof);
      setNesNz(cpu, proof);
      break;
    case "STA":
    case "STX":
    case "STY":
      if (address === null) return { reason: "unknown-write-address" };
      context.write(
        address,
        nesCpuByte(cpu, op === "STA" ? "a" : op === "STX" ? "x" : "y"),
      );
      break;
    case "ADC":
    case "SBC":
      nesAdd(cpu, value ?? operandProof.known_bits ?? null, op === "SBC");
      break;
    case "CMP":
    case "CPX":
    case "CPY":
      nesCompare(
        cpu,
        nesCpuByte(cpu, op === "CMP" ? "a" : op === "CPX" ? "x" : "y"),
        value ?? operandProof.known_bits ?? null,
      );
      break;
    case "AND":
    case "ORA":
    case "EOR": {
      nesLogic(cpu, value ?? operandProof.known_bits ?? null, op);
      break;
    }
    case "BIT": {
      const mask = value === null ? (operandProof.known_bits?.mask ?? 0) : 255;
      const bits = value ?? operandProof.known_bits?.value ?? 0;
      const and = nesLogicByte(nesCpuByte(cpu, "a"), proof, "AND");
      cpu.z =
        typeof and === "number"
          ? and === 0
          : and !== null && and.value !== 0
            ? false
            : null;
      cpu.n = (mask & 128) === 0 ? null : (bits & 128) !== 0;
      cpu.v = (mask & 64) === 0 ? null : (bits & 64) !== 0;
      break;
    }
    case "SLO":
    case "RLA":
    case "SRE":
    case "RRA":
    case "ASL":
    case "LSR":
    case "ROL":
    case "ROR":
    case "INC":
    case "DCP":
    case "ISC":
    case "DEC": {
      if (decoded.mode !== "acc" && address === null)
        return { reason: "unknown-write-address" };
      const modified =
        op === "INC" || op === "DEC" || op === "DCP" || op === "ISC"
          ? nesIncrement(
              cpu,
              value ?? operandProof.known_bits ?? null,
              op === "INC" || op === "ISC" ? 1 : -1,
            )
          : nesShift(
              cpu,
              value ?? operandProof.known_bits ?? null,
              op === "SLO"
                ? "ASL"
                : op === "RLA"
                  ? "ROL"
                  : op === "SRE"
                    ? "LSR"
                    : op === "RRA"
                      ? "ROR"
                      : op,
            );
      if (op === "RRA") nesAdd(cpu, modified, false);
      else if (op === "SLO" || op === "RLA" || op === "SRE")
        nesLogic(
          cpu,
          modified,
          op === "SLO" ? "ORA" : op === "RLA" ? "AND" : "EOR",
        );
      else if (op === "DCP") nesCompare(cpu, nesCpuByte(cpu, "a"), modified);
      else if (op === "ISC") nesAdd(cpu, modified, true);
      if (decoded.mode === "acc") setNesCpuByte(cpu, "a", modified);
      else if (address !== null) {
        // NMOS RMW latches its operand before either write, even if the first switches ROM banks.
        context.write(address, proof, false, "dummy");
        context.write(address, modified, true);
      }
      break;
    }
    default:
      return { reason: "unsupported-opcode" };
  }
  return { next };
};

const implied = (
  context: Nes6502InstructionContext,
  op: Nes6502Opcode["mnemonic"],
): boolean => {
  const cpu = context.cpu;
  switch (op) {
    case "CLC":
      cpu.c = false;
      return true;
    case "SEC":
      cpu.c = true;
      return true;
    case "CLD":
      cpu.d = false;
      return true;
    case "SED":
      cpu.d = true;
      return true;
    case "CLI":
      cpu.i = false;
      return true;
    case "SEI":
      cpu.i = true;
      return true;
    case "CLV":
      cpu.v = false;
      return true;
    case "NOP":
      return true;
    case "TXS":
    case "TAX":
    case "TAY":
    case "TXA":
    case "TYA":
    case "TSX": {
      const transfers = {
        TXS: ["x", "sp"],
        TAX: ["a", "x"],
        TAY: ["a", "y"],
        TXA: ["x", "a"],
        TYA: ["y", "a"],
        TSX: ["sp", "x"],
      } as const;
      const [source, destination] = transfers[op];
      const value = nesCpuByte(cpu, source);
      setNesCpuByte(cpu, destination, value);
      if (op !== "TXS") setNesNz(cpu, value);
      return true;
    }
    case "INX":
    case "DEX":
      setNesCpuByte(
        cpu,
        "x",
        nesIncrement(cpu, nesCpuByte(cpu, "x"), op === "INX" ? 1 : -1),
      );
      return true;
    case "INY":
    case "DEY":
      setNesCpuByte(
        cpu,
        "y",
        nesIncrement(cpu, nesCpuByte(cpu, "y"), op === "INY" ? 1 : -1),
      );
      return true;
    default:
      return false;
  }
};

const stackInstruction = (
  context: Nes6502InstructionContext,
  op: "BRK" | "JSR" | "RTS" | "RTI" | "PHA" | "PHP" | "PLA" | "PLP",
  pc: number,
  absolute: number,
  next: number,
  fetchJsrHigh: (() => number | null) | undefined,
): Outcome => {
  const cpu = context.cpu;
  // JSR depth is local to this trace; qualified bus continuations retain CPU/RAM facts.
  if (cpu.sp === null)
    return {
      reason:
        op === "RTS" && context.bus === null && context.callDepth === 0
          ? "return"
          : "unknown-stack",
    };
  if (context.bus !== null) {
    if (op !== "JSR") context.readMapperDummy(next);
    if (
      op === "JSR" ||
      op === "RTS" ||
      op === "RTI" ||
      op === "PLA" ||
      op === "PLP"
    )
      context.readMapperDummy(256 + cpu.sp);
  }
  switch (op) {
    case "BRK": {
      const preview = context.readVector("irq");
      if (context.bus === null && preview.target === null)
        return { reason: "unresolved-vector", interruptVector: preview.reads };
      const ret = (pc + 2) & 65535;
      context.push(ret >> 8);
      context.push(ret & 255, true);
      // PHP/BRK stack copies have B and unused bits set, and retain the old I.
      const status = nesStatusValue(cpu);
      context.push(status.value ?? status.known_bits ?? null, true);
      cpu.i = true;
      const { reads: interruptVector, target } =
        context.bus === null ? preview : context.readVector("irq", true);
      if (target === null)
        return { reason: "unresolved-vector", interruptVector };
      return { next: target, interruptVector };
    }
    case "JSR": {
      const ret = (pc + 2) & 65535;
      context.push(ret >> 8);
      context.push(ret & 255, true);
      const high = fetchJsrHigh?.();
      if (fetchJsrHigh !== undefined && high == null)
        return { reason: "unmapped-instruction" };
      context.callDepth++;
      return { next: high == null ? absolute : (absolute & 255) | (high << 8) };
    }
    case "RTI": {
      const status = context.readValue(256 + ((cpu.sp + 1) & 255), "stack");
      setNesStatusValue(cpu, status);
      const target = word(
        context.read(256 + ((cpu.sp + 2) & 255), "stack"),
        context.read(256 + ((cpu.sp + 3) & 255), "stack"),
      );
      if (target === null) return { reason: "unknown-control-target" };
      setNesCpuByte(cpu, "sp", (cpu.sp + 3) & 255);
      return { next: target };
    }
    case "RTS": {
      const ret = word(
        context.read(256 + ((cpu.sp + 1) & 255), "stack"),
        context.read(256 + ((cpu.sp + 2) & 255), "stack"),
      );
      if (context.bus !== null) context.readMapperDummy(ret);
      if (ret === null)
        return {
          reason:
            context.bus === null && context.callDepth === 0
              ? "return"
              : "unknown-control-target",
        };
      setNesCpuByte(cpu, "sp", (cpu.sp + 2) & 255);
      context.callDepth = Math.max(0, context.callDepth - 1);
      return { next: (ret + 1) & 65535 };
    }
    case "PHA":
      context.push(nesCpuByte(cpu, "a"));
      break;
    case "PHP": {
      const status = nesStatusValue(cpu);
      context.push(status.value ?? status.known_bits ?? null);
      break;
    }
    case "PLA": {
      const source: { value: number | null; known_bits?: NesKnownBits } =
        context.popValue();
      setNesCpuByte(cpu, "a", source.value ?? source.known_bits ?? null);
      setNesNz(cpu, source.value ?? source.known_bits ?? null);
      break;
    }
    case "PLP":
      setNesStatusValue(cpu, context.popValue());
      break;
  }
  return { next };
};
