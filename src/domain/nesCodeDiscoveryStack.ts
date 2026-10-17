import type { NesDiscoverySuccessor } from "./nesCodeDiscoveryTransfer.js";
import type { NesCodeDiscoveryMemory } from "./nesCodeDiscoveryMemory.js";
import { nesCpuByte, setNesCpuByte } from "./nesCpuRegister.js";
import { nesStatusValue, setNesNz, setNesStatusValue } from "./nes6502Alu.js";
type StackOutcome = Pick<
  NesDiscoverySuccessor,
  "kind" | "address" | "reason" | "return_proof"
>;
const stackReturn = (memory: NesCodeDiscoveryMemory): StackOutcome => {
  const physicalSp = memory.cpu.sp;
  const opaqueToken =
    memory.state.frame.kind === "opaque" &&
    memory.state.frame.intact &&
    memory.state.frame.relative_sp === 0;
  const lowRead = memory.popValue(),
    highRead = memory.popValue(),
    low = lowRead.value,
    high = highRead.value;
  if ((low === null || high === null) && opaqueToken)
    return {
      kind: "return",
      address: null,
      reason: null,
      return_proof: "opaque-token",
    };
  return {
    kind: "return",
    address:
      low === null || high === null ? null : ((low | (high << 8)) + 1) & 65535,
    reason:
      low === null || high === null
        ? physicalSp === null
          ? "return-frame-unresolved"
          : "return-target-unresolved"
        : null,
    return_proof:
      lowRead.stack_proof === "physical-bytes" &&
      highRead.stack_proof === "physical-bytes"
        ? "physical-bytes"
        : "relative-bytes",
  };
};
export const transferNesDiscoveryStack = (
  memory: NesCodeDiscoveryMemory,
  op: string,
  { pc, next, absolute }: { pc: number; next: number; absolute: number },
): StackOutcome[] | null => {
  const outcome = (
    kind: StackOutcome["kind"],
    address: number | null,
    reason: string | null = null,
  ): StackOutcome => ({ kind, address, reason });
  if (op === "JSR") {
    const ret = (pc + 2) & 65535;
    memory.push(ret >> 8);
    memory.push(ret & 255, true);
    return [outcome("call", absolute)];
  }
  if (op === "RTS") {
    return [stackReturn(memory)];
  }
  if (op === "RTI")
    return [outcome("return", null, "interrupt-frame-unmodeled")];
  if (["PHA", "PHP", "PLA", "PLP"].includes(op)) {
    switch (op) {
      case "PHA":
        memory.push(nesCpuByte(memory.cpu, "a"));
        break;
      case "PHP": {
        const status = nesStatusValue(memory.cpu);
        memory.push(status.value ?? status.known_bits ?? null);
        break;
      }
      case "PLA": {
        const value = memory.popValue(),
          byte =
            value.value ?? ("known_bits" in value ? value.known_bits : null);
        setNesCpuByte(memory.cpu, "a", byte);
        setNesNz(memory.cpu, byte);
        break;
      }
      case "PLP":
        setNesStatusValue(memory.cpu, memory.popValue());
        break;
    }
    return [outcome("fallthrough", next)];
  }
  if (op === "BRK") return [outcome("jump", null, "interrupt-frame-unmodeled")];
  return null;
};
