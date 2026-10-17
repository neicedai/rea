import type { NesMapperEvent, NesMapperIrqState } from "./nesMapperEvents.js";
import type {
  NesMapperState,
  NesMapperWrite,
  NesMapperTraceStep,
} from "./nesMapperTrace.js";
import { isVrc4State } from "./nesVrc4.js";
import { isVrc6State } from "./nesVrc6.js";
import { isBandaiState } from "./nesBandai.js";
import { isFme7State } from "./nesFme7.js";
import { isNamco163State } from "./nesNamco163.js";
import { isH3001State } from "./nesH3001.js";
import { isSunsoft3State } from "./nesSunsoft3.js";
import { isVrc3State } from "./nesVrc3.js";
import {
  isVrc3IrqState,
  clockVrc3CpuCycle,
  writeVrc3Irq,
} from "./nesVrc3Irq.js";
import {
  isSunsoft3IrqState,
  clockSunsoft3CpuCycle,
  writeSunsoft3Irq,
} from "./nesSunsoft3Irq.js";
import {
  isH3001IrqState,
  clockH3001CpuCycle,
  writeH3001Irq,
} from "./nesH3001Irq.js";
import { isVrcIrqState, clockVrcCpuCycle, writeVrcIrq } from "./nesVrcIrq.js";
import {
  isBandaiIrqState,
  clockBandaiCpuCycle,
  writeBandaiIrq,
} from "./nesBandaiIrq.js";
import {
  isFme7IrqState,
  clockFme7CpuCycle,
  writeFme7Irq,
} from "./nesFme7Irq.js";
import {
  isNamco163IrqState,
  clockNamco163CpuCycle,
  writeNamco163Irq,
} from "./nesNamco163Irq.js";

/** CPU-clocked cartridges share one dispatch rule across supplied events and source bus edges. */
export const nesCpuMapperIrqEvent = (
  irq: NesMapperIrqState,
): NesMapperEvent | null =>
  isVrc3IrqState(irq)
    ? { kind: "vrc3-cpu-cycle" }
    : isVrcIrqState(irq)
      ? { kind: "vrc-cpu-cycle" }
      : isBandaiIrqState(irq)
        ? { kind: "bandai-cpu-cycle" }
        : isFme7IrqState(irq)
          ? { kind: "fme7-cpu-cycle" }
          : isNamco163IrqState(irq)
            ? { kind: "namco163-cpu-cycle" }
            : isH3001IrqState(irq)
              ? { kind: "h3001-cpu-cycle" }
              : isSunsoft3IrqState(irq)
                ? { kind: "sunsoft3-cpu-cycle" }
                : null;

export const clockNesCpuMapperIrq = (
  irq: NesMapperIrqState,
  mapper: NesMapperState,
): { state: NesMapperIrqState; clock: boolean | null } => {
  if (isVrc3IrqState(irq) && isVrc3State(mapper))
    return clockVrc3CpuCycle(irq, mapper);
  if (isVrcIrqState(irq) && (isVrc4State(mapper) || isVrc6State(mapper)))
    return clockVrcCpuCycle(irq, mapper);
  if (isBandaiIrqState(irq) && isBandaiState(mapper))
    return clockBandaiCpuCycle(irq, mapper);
  if (isFme7IrqState(irq) && isFme7State(mapper))
    return clockFme7CpuCycle(irq, mapper);
  if (isNamco163IrqState(irq) && isNamco163State(mapper))
    return clockNamco163CpuCycle(irq, mapper);
  if (isH3001IrqState(irq) && isH3001State(mapper))
    return clockH3001CpuCycle(irq);
  if (isSunsoft3IrqState(irq) && isSunsoft3State(mapper))
    return clockSunsoft3CpuCycle(irq);
  return { state: irq, clock: false };
};

export const writeNesCpuMapperIrq = (
  irq: NesMapperIrqState,
  mapper: NesMapperState,
  write: NesMapperWrite,
  effect: NesMapperTraceStep["effect"],
): NesMapperIrqState => {
  if (isVrc3IrqState(irq) && isVrc3State(mapper))
    return writeVrc3Irq(irq, mapper, write);
  if (isVrcIrqState(irq) && (isVrc4State(mapper) || isVrc6State(mapper)))
    return writeVrcIrq(irq, mapper, effect);
  if (isBandaiIrqState(irq) && isBandaiState(mapper))
    return writeBandaiIrq(irq, mapper, write, effect);
  if (isFme7IrqState(irq) && isFme7State(mapper))
    return writeFme7Irq(irq, mapper, write);
  if (isNamco163IrqState(irq) && isNamco163State(mapper))
    return writeNamco163Irq(irq, write);
  if (isH3001IrqState(irq) && isH3001State(mapper))
    return writeH3001Irq(irq, mapper, write);
  if (isSunsoft3IrqState(irq) && isSunsoft3State(mapper))
    return writeSunsoft3Irq(irq, write);
  return irq;
};
