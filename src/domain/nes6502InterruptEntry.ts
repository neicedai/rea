import { nesStatusValue } from "./nes6502Alu.js";
import type { Nes6502Context } from "./nes6502Context.js";

/** Shared B=0 entry sequence; the caller owns commitment and writer identity. */
export const enterNes6502Interrupt = (
  context: Nes6502Context,
  kind: "nmi" | "irq",
  returnAddress: number,
) => {
  const status = nesStatusValue(context.cpu, false);
  if (context.bus !== null) {
    context.readMapperDummy(returnAddress);
    context.readMapperDummy(returnAddress);
  }
  context.push(returnAddress >> 8);
  context.push(returnAddress & 255, true);
  context.push(status.value ?? status.known_bits ?? null, true);
  context.cpu.i = true;
  return context.readVector(kind, context.bus !== null);
};
