import {
  nesByteBits,
  nesByteCandidates,
  nesByteProof,
  joinNesBytes,
  type NesByteValue,
} from "./nesByteValue.js";
import { ppuBits, ppuReplace } from "./nesPpuAddress.js";
import type {
  NesPpuState,
  NesOamState,
  NesPpuSource,
  NesPpuCpuOperation,
  NesPpuOrigin,
  NesOamDmaWrite,
} from "./nesPpuState.js";
import type { NesMapperEvent } from "./nesMapperEvents.js";

type Write = NonNullable<NesPpuCpuOperation["write"]>;
const factValue = (
  fact: NesOamState["cells"][string] | undefined,
): NesByteValue =>
  typeof fact === "object" && fact !== null && "origin" in fact
    ? fact.value
    : (fact ?? null);
const physical = (value: NesByteValue, address: number) =>
  address % 4 === 2 ? ppuReplace(value, 28, 0) : value;
export const nesOamAdmission = (ppu: NesPpuState): string | null => {
  if (ppu.oam === null) return null;
  for (const [key, fact] of Object.entries(ppu.oam.cells)) {
    const address = Number(key),
      bits = ppuBits(factValue(fact));
    if (address % 4 === 2 && (bits.value & bits.mask & 28) !== 0)
      return "OAM attribute cells cannot prove set unimplemented bits D2-D4.";
    if (typeof fact !== "object" || fact === null || !("origin" in fact))
      continue;
    const origin = fact.origin;
    if (
      origin.kind === "initial-register" ||
      origin.kind === "event-read" ||
      origin.kind === "dma-byte" ||
      (origin.kind === "initial-memory" &&
        (origin.space !== "oam" || origin.address !== address)) ||
      (origin.kind === "dma-write" && origin.address !== address)
    )
      return "OAM cell origins must identify the same physical cell or a preceding OAM write.";
    if (
      (origin.kind === "event-write" || origin.kind === "dma-write") &&
      origin.index >= ppu.next_event_index
    )
      return "Retained OAM writers must precede next_event_index.";
  }
  return null;
};

/** Queue validation precedes retained snapshots; CPU reads consume unobserved transfers. */
export const nesOamEventsAdmission = (
  ppu: NesPpuState | null,
  events: readonly NesMapperEvent[],
): string | null => {
  let pending = ppu?.oam?.dma_pending ?? { status: "unknown" as const };
  for (const [index, event] of events.entries()) {
    if (event.kind === "oam-dma" || event.kind === "oam-dma-start") {
      if (ppu?.oam == null)
        return "oam-dma requires initial_ppu.oam model oam-memory.";
      if (pending.status === "none")
        return `OAM DMA event ${index} contradicts the known empty DMA queue.`;
      if (pending.status === "pending") {
        const before = ppuBits(pending.page),
          after = ppuBits(event.page);
        if (((before.value ^ after.value) & before.mask & after.mask) !== 0)
          return `OAM DMA event ${index} contradicts the pending 4014 source page.`;
      }
      pending = { status: "none" };
    } else if (event.kind === "cpu-write" && event.address === 0x4014)
      pending = {
        status: "pending",
        page: event.value ?? ("known_bits" in event ? event.known_bits : null),
      };
    else if (event.kind === "cpu-read") pending = { status: "none" };
  }
  return null;
};

export const readNesOam = (
  oam: NesOamState,
): { value: NesByteValue; sources: NesPpuSource[] } => {
  const addresses = nesByteCandidates(oam.address),
    values: NesByteValue[] = [],
    sources: NesPpuSource[] = [];
  for (const address of addresses) {
    const fact = oam.cells[String(address)],
      value = factValue(fact);
    values.push(physical(value, address));
    sources.push({
      kind: "memory",
      space: "oam",
      address,
      value,
      mask: address % 4 === 2 ? 227 : 255,
      origin:
        fact === undefined
          ? null
          : typeof fact === "object" && fact !== null && "origin" in fact
            ? fact.origin
            : { kind: "initial-memory", space: "oam", address },
    });
  }
  const attributes = addresses.filter((address) => address % 4 === 2);
  if (attributes.length !== 0)
    sources.push({
      kind: "oam-attribute-zeroes",
      value: 0,
      mask: 28,
      addresses: attributes,
    });
  return { value: values.reduce(joinNesBytes), sources };
};

export const writeNesOam = (
  oam: NesOamState,
  value: NesByteValue,
  index: number,
  blank: boolean,
): Write => {
  if (!blank) {
    oam.address = null;
    oam.cells = {};
    return {
      status: "unverified",
      destinations: [],
      invalidated_spaces: ["oam"],
      reason: "unverified-oam-rendering-write",
    };
  }
  const addresses = nesByteCandidates(oam.address);
  if (oam.retention !== "stable") {
    oam.address = addresses
      .map<NesByteValue>((address) => (address + 1) & 255)
      .reduce(joinNesBytes);
    oam.cells = {};
    return {
      status: "unverified",
      destinations: addresses.map((address) => ({ space: "oam", address })),
      invalidated_spaces: ["oam"],
      reason: "unobserved-oam-retention",
    };
  }
  for (const address of addresses) {
    const byte = physical(value, address),
      previous = oam.cells[String(address)];
    if (addresses.length === 1)
      oam.cells[String(address)] = {
        value: byte,
        origin: { kind: "event-write", index },
      };
    else if (previous !== undefined) {
      const common = joinNesBytes(factValue(previous), byte);
      if (common === null) delete oam.cells[String(address)];
      else
        oam.cells[String(address)] =
          typeof previous === "object" &&
          previous !== null &&
          "origin" in previous
            ? { ...previous, value: common }
            : common;
    }
  }
  oam.address = addresses
    .map<NesByteValue>((address) => (address + 1) & 255)
    .reduce(joinNesBytes);
  return {
    status: addresses.length === 1 ? "written" : "uncertain",
    destinations: addresses.map((address) => ({ space: "oam", address })),
    invalidated_spaces: [],
    reason: addresses.length === 1 ? null : "unknown-oam-address",
  };
};

const invalidateNesOamDma = (
  ppu: NesPpuState,
  index: number,
  blank: boolean,
): void => {
  const oam = ppu.oam!;
  oam.cells = {};
  if (!blank || ppu.dma_reads !== "absent") oam.address = null;
  oam.dma_pending = { status: "none" };
  ppu.io_latch = { value: null, origin: { kind: "event-read", index } };
};
export const drainUnknownNesOam = (
  ppu: NesPpuState,
  index: number,
  blank: boolean,
): Write => {
  invalidateNesOamDma(ppu, index, blank);
  return {
    status: "unverified",
    destinations: [],
    invalidated_spaces: ["oam"],
    reason: "unobserved-oam-dma-data",
  };
};

export const applyNesOamDmaMemory = (
  ppu: NesPpuState,
  values: readonly NesByteValue[],
  index: number,
  blank: boolean,
): NesOamDmaWrite => {
  const oam = ppu.oam!,
    start = structuredClone(oam.address);
  oam.dma_pending = { status: "none" };
  if (!blank || ppu.dma_reads !== "absent") {
    invalidateNesOamDma(ppu, index, blank);
    return {
      status: "unverified",
      range: null,
      invalidated_spaces: ["oam"],
      reason: !blank
        ? "unverified-oam-rendering-transfer"
        : "unobserved-oam-dmc-interference",
    };
  }
  if (oam.retention !== "stable") {
    oam.cells = {};
    ppu.io_latch = {
      value: values[255]!,
      origin: { kind: "dma-byte", index, offset: 255 },
    };
    return {
      status: "unverified",
      range: { space: "oam", start: 0, size: 256 },
      invalidated_spaces: ["oam"],
      reason: "unobserved-oam-retention",
    };
  }
  const starts = nesByteCandidates(start);
  for (let address = 0; address < 256; address++) {
    const value = starts
      .map<NesByteValue>((offset) => values[(address - offset) & 255] ?? null)
      .reduce(joinNesBytes);
    const origin: NesPpuOrigin = {
      kind: "dma-write",
      index,
      address,
      start_address: start,
    };
    oam.cells[String(address)] = { value: physical(value, address), origin };
  }
  ppu.io_latch = {
    value: values[255]!,
    origin: { kind: "dma-byte", index, offset: 255 },
  };
  return {
    status: "written",
    range: { space: "oam", start: 0, size: 256 },
    invalidated_spaces: [],
    reason: null,
  };
};
