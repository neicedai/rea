import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesMapperEvent, NesMapperIrqState } from "./nesMapperEvents.js";
import { isMmc5State } from "./nesMmc5.js";
import { isMmc5IrqState } from "./nesMmc5Irq.js";
import { isNamco163State } from "./nesNamco163.js";
import { isNamco163IrqState } from "./nesNamco163Irq.js";
import { isFme7State } from "./nesFme7.js";
import { isFme7IrqState } from "./nesFme7Irq.js";
import { isBandaiState, bandaiBoard } from "./nesBandai.js";
import { isBandaiIrqState } from "./nesBandaiIrq.js";
import { isVrc4State } from "./nesVrc4.js";
import { isVrc6State } from "./nesVrc6.js";
import { isVrc3State } from "./nesVrc3.js";
import { isVrc3IrqState } from "./nesVrc3Irq.js";
import { isVrcIrqState } from "./nesVrcIrq.js";
import type { NesMmc3IrqState } from "./nesMmc3Irq.js";
import { isH3001State } from "./nesH3001.js";
import { admitH3001Irq, isH3001IrqState } from "./nesH3001Irq.js";
import { isSunsoft3State } from "./nesSunsoft3.js";
import {
  admitSunsoft3Irq,
  isSunsoft3IrqState,
  type NesSunsoft3IrqState,
} from "./nesSunsoft3Irq.js";

const irqClockFamilies = (events: readonly NesMapperEvent[]) => {
  const hasMmc3 = events.some(
    (event) =>
      event.kind === "mmc3-irq-clock" ||
      event.kind === "ppu-a12" ||
      event.kind === "cpu-m2-fall",
  );
  const hasVrc = events.some((event) => event.kind === "vrc-cpu-cycle");
  const hasVrc3 = events.some((event) => event.kind === "vrc3-cpu-cycle");
  const hasBandai = events.some((event) => event.kind === "bandai-cpu-cycle");
  const hasFme7 = events.some((event) => event.kind === "fme7-cpu-cycle");
  const hasNamco163 = events.some(
    (event) => event.kind === "namco163-cpu-cycle",
  );
  const hasMmc5 = events.some(
    (event) =>
      event.kind === "mmc5-cpu-cycle" ||
      event.kind === "mmc5-reset" ||
      "ppu_status" in event,
  );
  const hasH3001 = events.some((event) => event.kind === "h3001-cpu-cycle");
  const hasSunsoft3 = events.some(
    (event) => event.kind === "sunsoft3-cpu-cycle",
  );
  return {
    hasMmc3,
    hasVrc,
    hasVrc3,
    hasBandai,
    hasFme7,
    hasNamco163,
    hasMmc5,
    hasH3001,
    hasSunsoft3,
  };
};

const admitSunsoft3Events = (
  initial: NesMapperState,
  irq: NesSunsoft3IrqState,
  families: ReturnType<typeof irqClockFamilies>,
): string | null => {
  if (!isSunsoft3State(initial))
    return "Sunsoft-3 IRQ model requires Mapper 67.";
  if (
    Object.entries(families).some(
      ([family, present]) => family !== "hasSunsoft3" && present,
    )
  )
    return "Other clock families do not drive the Sunsoft-3 counter.";
  return admitSunsoft3Irq(irq, initial);
};

const admitMmc3Events = (
  header: NesRomMetadata,
  initial: NesMapperState,
  irq: NesMmc3IrqState | null,
  families: ReturnType<typeof irqClockFamilies>,
): string | null => {
  const { hasMmc3, hasVrc } = families;
  if (hasMmc3 && initial.mapper !== 4)
    return "MMC3 IRQ analysis requires Mapper 4.";
  if (hasVrc)
    return "VRC CPU cycles require explicit initial_irq with model vrc4 or vrc6.";
  if (irq !== null && initial.mapper !== 4)
    return "MMC3 IRQ analysis requires Mapper 4.";
  if (hasMmc3 && irq === null)
    return "MMC3 IRQ clocks require an explicit initial_irq model; omitted counters and flags remain unknown.";
  if (irq === null) return null;
  if (header.submapper === 3 && irq.model !== "mc-acc")
    return "MC-ACC IRQ analysis requires the mc-acc model.";
  if (
    irq.model === "mc-acc" &&
    header.submapper !== null &&
    header.submapper !== 3
  )
    return "The mc-acc IRQ model requires legacy Mapper 4 or NES 2.0 submapper 3.";
  if (
    irq.model === "mc-acc"
      ? irq.a12_filter !== null
      : irq.mcacc_prescaler !== null
  )
    return "IRQ filter state does not match the selected model.";
  return null;
};

export const admitNesMapperIrqEvents = (
  header: NesRomMetadata,
  initial: NesMapperState,
  events: readonly NesMapperEvent[],
  initialIrq: NesMapperIrqState | null,
): string | null => {
  const families = irqClockFamilies(events);
  const {
    hasMmc3,
    hasVrc,
    hasBandai,
    hasFme7,
    hasNamco163,
    hasMmc5,
    hasH3001,
    hasSunsoft3,
  } = families;
  if (isVrc3IrqState(initialIrq)) {
    if (!isVrc3State(initial)) return "VRC3 IRQ model requires Mapper 73.";
    return Object.entries(families).some(
      ([family, present]) => family !== "hasVrc3" && present,
    )
      ? "Other clock families do not drive the VRC3 counter."
      : null;
  }
  if (families.hasVrc3)
    return "VRC3 CPU cycles require matching explicit initial_irq model vrc3.";
  if (isSunsoft3IrqState(initialIrq))
    return admitSunsoft3Events(initial, initialIrq, families);
  if (hasSunsoft3)
    return "Sunsoft-3 CPU cycles require matching explicit initial_irq model sunsoft3.";
  if (isH3001IrqState(initialIrq)) {
    if (!isH3001State(initial)) return "H3001 IRQ model requires Mapper 65.";
    if (hasMmc3 || hasVrc || hasBandai || hasFme7 || hasNamco163 || hasMmc5)
      return "Other clock families do not drive the H3001 counter.";
    return admitH3001Irq(initialIrq, initial);
  }
  if (hasH3001)
    return "H3001 CPU cycles require matching explicit initial_irq model h3001.";
  if (isMmc5IrqState(initialIrq)) {
    if (!isMmc5State(initial)) return "MMC5 scanline model requires Mapper 5.";
    return hasMmc3 || hasVrc || hasBandai || hasFme7 || hasNamco163
      ? "Other clock families do not drive the MMC5 scanline model."
      : null;
  }
  if (hasMmc5)
    return "MMC5 cycles/reset/PPUSTATUS facts require matching explicit initial_irq model mmc5.";
  if (isNamco163IrqState(initialIrq)) {
    if (!isNamco163State(initial))
      return "Namco 163 IRQ model requires an explicit Mapper 19 namco163 state.";
    if (hasMmc3 || hasVrc || hasBandai || hasFme7)
      return "Other clock families do not drive the Namco 163 counter.";
    return null;
  }
  if (hasNamco163)
    return "Namco 163 CPU cycles require matching explicit initial_irq model namco163.";
  if (isFme7IrqState(initialIrq)) {
    if (!isFme7State(initial))
      return "FME-7 IRQ model requires Mapper 69 and its explicit chip variant.";
    if (hasMmc3 || hasVrc || hasBandai)
      return "Other clock families do not drive the FME-7 counter.";
    return null;
  }
  if (hasFme7)
    return "FME-7 CPU cycles require matching explicit initial_irq model fme7.";
  if (isBandaiIrqState(initialIrq)) {
    const board = isBandaiState(initial)
      ? bandaiBoard(header, "variant" in initial ? initial.variant : undefined)
      : null;
    if (
      board === null ||
      initialIrq.model !== (board === "fcg" ? "bandai-fcg" : "bandai-lz93d50")
    )
      return "Bandai IRQ model requires a matching FCG-1/2 or LZ93D50 board interpretation.";
    if (hasVrc || hasMmc3)
      return "VRC/MMC3 clocks do not drive the Bandai counter model.";
    return null;
  }
  if (hasBandai)
    return "Bandai CPU cycles require a matching explicit Bandai initial_irq model.";
  if (isVrcIrqState(initialIrq)) {
    if (
      initialIrq.model === "vrc4"
        ? !isVrc4State(initial)
        : !isVrc6State(initial)
    )
      return `${initialIrq.model.toUpperCase()} IRQ analysis requires a matching explicit board state.`;
    if (hasMmc3)
      return "MMC3 signal/clock events do not drive a VRC IRQ model.";
    return null;
  }
  return admitMmc3Events(header, initial, initialIrq, families);
};
