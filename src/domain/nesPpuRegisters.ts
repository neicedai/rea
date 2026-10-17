import type { NesRomMetadata } from "./nes.js";
import { clearNesDmaRequest } from "./nesCpuDma.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import {
  nesByteBits,
  nesByteProof,
  joinNesBytes,
  type NesByteValue,
} from "./nesByteValue.js";
import {
  ppuBits,
  ppuSmall,
  ppuReplace,
  ppuBusAddress,
  ppuIncrement,
} from "./nesPpuAddress.js";
import {
  readNesPpuMemory,
  readNesPpuPalette,
  writeNesPpuMemory,
} from "./nesPpuMemory.js";
import { latchAfterPpuRead } from "./nesLatchMapper.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import { isMmc5State } from "./nesMmc5.js";
import { readMmc5RetainedPpu } from "./nesMmc5RetainedPpu.js";
import { mmc5NametableChoices, type NesMmc5Fetch } from "./nesMmc5Ppu.js";
import type { NesMmc5TilePosition } from "./nesMmc5RenderingState.js";
import {
  readNesOam,
  writeNesOam,
  drainUnknownNesOam,
  applyNesOamDmaMemory,
} from "./nesOam.js";
import type {
  NesPpuState,
  NesPpuRegisters,
  NesPpuSource,
  NesPpuCpuOperation,
  NesPpuBusOperation,
  NesPpuByteOrigin,
  NesPpuBusRead,
  NesOamDmaOperation,
  NesPpuOperation,
} from "./nesPpuState.js";

export const nesPpuRegisterView = (
  state: NesPpuState,
): NesPpuCpuOperation["before"] => {
  const {
    control,
    mask,
    status,
    status_origin,
    v,
    t,
    fine_x,
    write_toggle,
    io_latch,
  } = state;
  return structuredClone({
    control,
    mask,
    status,
    status_origin,
    v,
    t,
    fine_x,
    write_toggle,
    io_latch,
    read_buffer: state.read_buffer.value,
    dma_reads: state.dma_reads,
    ...(state.oam === null
      ? {}
      : {
          oam: {
            model: state.oam.model,
            retention: state.oam.retention,
            address: state.oam.address,
            reads: state.oam.reads,
            address_writes: state.oam.address_writes,
            dma_pending: state.oam.dma_pending,
          },
        }),
  });
};
export const initializeNesPpu = (input: NesPpuState): NesPpuState => {
  const state = structuredClone(input);
  if (state.oam?.retention === "unobserved") state.oam.cells = {};
  if (
    state.read_buffer.value !== null &&
    state.read_buffer.sources.length === 0
  )
    state.read_buffer.sources = [
      {
        kind: "register",
        field: "read-buffer",
        value: state.read_buffer.value,
        mask: 255,
        origin: { kind: "initial-register", field: "read-buffer" },
      },
    ];
  return state;
};
const nonRendering = (state: NesPpuState) =>
  state.access_phase === "non-rendering" || nesByteBits(state.mask, 24) === 0;
const registerSource = (
  state: NesPpuState,
  field: "io-latch" | "status",
  mask: number,
): NesPpuSource => ({
  kind: "register",
  field,
  mask,
  value: field === "io-latch" ? state.io_latch.value : state.status,
  origin: structuredClone(
    field === "io-latch" ? state.io_latch.origin : state.status_origin,
  ),
});
const latchRead = (
  mapper: NesMapperState,
  address: number | null,
  optional = false,
): void => {
  if (isMmc5State(mapper) && "ppu" in mapper && (address === null || optional))
    mapper.ppu.phase = "unknown";
  if (mapper.mapper !== 9 && mapper.mapper !== 10) return;
  const next =
    address === null
      ? { ...mapper, latch_0: null, latch_1: null }
      : latchAfterPpuRead(mapper, address);
  mapper.latch_0 =
    optional && mapper.latch_0 !== next.latch_0 ? null : next.latch_0;
  mapper.latch_1 =
    optional && mapper.latch_1 !== next.latch_1 ? null : next.latch_1;
};
const busRead = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  address: number | null,
  chr?: Uint8Array,
  qualification: {
    fetch?: NesMmc5Fetch | undefined;
    tile?: NesMmc5TilePosition | undefined;
  } = { fetch: "ppudata" },
): NesPpuBusRead => {
  if (address === null) {
    latchRead(mapper, null);
    return {
      status: "ppu-memory",
      address,
      bank: null,
      file_offset: null,
      value: null,
      sources: [],
      reason: "unknown-ppu-address",
    };
  }
  const mmc5Read = isMmc5State(mapper)
    ? readMmc5RetainedPpu(header, mapper, state, address, {
        ...qualification,
        chr,
      })
    : null;
  const result =
    mmc5Read ?? readNesPpuMemory(header, mapper, state, address, chr);
  const source = result.sources.length === 1 ? result.sources[0]! : null;
  const windows = mapperMapping(header, mapper, {
    chrRamSize: state.chr_ram_size,
  }).chr_windows;
  const window = windows.find(
    (w) => address >= w.start && address < w.start + w.size,
  );
  const bank =
    source === null
      ? null
      : source.kind === "rom"
        ? Math.floor(
            (source.file_offset - header.chrRom.offset) /
              (window?.size ?? 1024),
          )
        : source.kind === "memory"
          ? Math.floor(source.address / (window?.size ?? 1024))
          : null;
  latchRead(mapper, address);
  const base = {
    status: "ppu-memory" as const,
    address,
    bank: mmc5Read !== null ? mmc5Read.bank : bank,
    file_offset:
      mmc5Read !== null
        ? mmc5Read.file_offset
        : source?.kind === "rom"
          ? source.file_offset
          : null,
    sources: result.sources,
    reason: result.reason,
    ...(mmc5Read === null ? {} : { mmc5: mmc5Read.mmc5 }),
  };
  return typeof result.value === "number"
    ? { ...base, value: result.value }
    : result.value === null
      ? { ...base, value: null }
      : { ...base, value: null, known_bits: result.value };
};
const baseOperation = (
  state: NesPpuState,
  index: number,
): NesPpuCpuOperation => ({
  kind: "cpu-port",
  event_index: index,
  before: nesPpuRegisterView(state),
  after: nesPpuRegisterView(state),
  read: null,
  bus_reads: [],
  ppu_address: null,
  write: null,
});

const applyPaired = (
  registers: NesPpuRegisters,
  address: number,
  byte: NesByteValue,
  toggle: 0 | 1,
  blank: boolean,
): void => {
  if (address === 0x2005) {
    if (toggle === 0) {
      registers.t.low = ppuReplace(registers.t.low, 31, byte, -3);
      registers.fine_x = ppuSmall(byte, 7);
    } else {
      registers.t.low = ppuReplace(registers.t.low, 224, byte, 2);
      registers.t.high = ppuSmall(
        ppuReplace(ppuReplace(registers.t.high, 3, byte, -6), 112, byte, 4),
        127,
      );
    }
  } else if (toggle === 0) {
    const bits = ppuBits(byte);
    registers.t.high = ppuSmall(
      nesByteProof((bits.mask & 63) | 64, bits.value & 63),
      127,
    );
  } else {
    registers.t.low = byte;
    registers.v = blank ? { ...registers.t } : { low: null, high: null };
  }
  registers.write_toggle = toggle === 0 ? 1 : 0;
};
const controlWrite = (
  state: NesPpuState,
  address: number,
  byte: NesByteValue,
): void => {
  if (state.register_writes_enabled === false) return;
  const make = (): NesPpuRegisters => ({
    ...state,
    t: { ...state.t },
    v: { ...state.v },
  });
  const alternatives: NesPpuRegisters[] =
    state.register_writes_enabled === null ? [make()] : [];
  for (const toggle of state.write_toggle === null
    ? ([0, 1] as const)
    : [state.write_toggle]) {
    const next = make();
    if (address === 0x2000) {
      next.control = byte;
      next.t.high = ppuSmall(ppuReplace(next.t.high, 12, byte, 2), 127);
    } else if (address === 0x2001) next.mask = byte;
    else applyPaired(next, address, byte, toggle, nonRendering(state));
    alternatives.push(next);
    if (address === 0x2000 || address === 0x2001) break;
  }
  state.control = alternatives.map((s) => s.control).reduce(joinNesBytes);
  state.mask = alternatives.map((s) => s.mask).reduce(joinNesBytes);
  state.fine_x = ppuSmall(
    alternatives.map((s) => s.fine_x).reduce(joinNesBytes),
    7,
  );
  state.write_toggle = alternatives.every(
    (s) => s.write_toggle === alternatives[0]!.write_toggle,
  )
    ? alternatives[0]!.write_toggle
    : null;
  for (const word of ["v", "t"] as const)
    state[word] = {
      low: alternatives.map((s) => s[word].low).reduce(joinNesBytes),
      high: ppuSmall(
        alternatives.map((s) => s[word].high).reduce(joinNesBytes),
        127,
      ),
    };
};

export const writeNesPpuCpu = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  {
    address,
    value,
    index,
    dmcReadsModeled = false,
  }: {
    address: number;
    value: NesByteValue;
    index: number;
    dmcReadsModeled?: boolean;
  },
): NesPpuCpuOperation | null => {
  if (!dmcReadsModeled && address === 0x4015 && nesByteBits(value, 16) !== 0) {
    const operation = baseOperation(state, index);
    state.dma_reads = "unobserved";
    operation.write = {
      status: "unverified",
      destinations: [],
      invalidated_spaces: [],
      reason: "unobserved-dmc-enablement",
    };
    operation.after = nesPpuRegisterView(state);
    return operation;
  }
  if (address === 0x4014) {
    if (state.oam !== null) {
      const operation = baseOperation(state, index);
      state.oam.dma_pending = { status: "pending", page: value };
      operation.after = nesPpuRegisterView(state);
      return operation;
    }
    const bits = ppuBits(value);
    if ((bits.value & bits.mask & 224) !== (32 & bits.mask)) return null;
    const operation = baseOperation(state, index);
    state.dma_reads = "unobserved";
    invalidateNesDmaPpuReads(mapper, state, value, index);
    operation.write = {
      status: "unverified",
      destinations: [],
      invalidated_spaces: [],
      reason: "unobserved-oam-dma-register-reads",
    };
    operation.after = nesPpuRegisterView(state);
    return operation;
  }
  if (address < 0x2000 || address > 0x3fff) return null;
  const register = 0x2000 | (address & 7),
    operation = baseOperation(state, index),
    blank = nonRendering(state);
  state.io_latch = { value, origin: { kind: "event-write", index } };
  if ([0x2000, 0x2001, 0x2005, 0x2006].includes(register)) {
    const high = ppuBits(state.v.high),
      couldDisable =
        nesByteBits(value, 8) !== 8 && nesByteBits(value, 16) !== 16;
    if (
      register === 0x2001 &&
      !blank &&
      couldDisable &&
      state.register_writes_enabled !== false &&
      (high.value & high.mask & 60) === (60 & high.mask)
    ) {
      state.palette = {};
      operation.write = {
        status: "unverified",
        destinations: [],
        invalidated_spaces: ["palette"],
        reason: "unverified-palette-disable-transition",
      };
    }
    controlWrite(state, register, value);
  } else if (register === 0x2003 || register === 0x2004) {
    if (state.oam === null)
      operation.write = {
        status: "unverified",
        destinations: [],
        invalidated_spaces: [],
        reason: "oam-unmodeled",
      };
    else if (register === 0x2003) {
      state.oam.address = blank ? value : null;
      if (!blank || state.oam.address_writes !== "uncorrupted") {
        state.oam.cells = {};
        operation.write = {
          status: "unverified",
          destinations: [],
          invalidated_spaces: ["oam"],
          reason: !blank
            ? "unverified-oam-rendering-address"
            : "unobserved-oam-address-corruption",
        };
      }
    } else operation.write = writeNesOam(state.oam, value, index, blank);
  } else if (register === 0x2007) {
    if (blank) {
      operation.ppu_address = ppuBusAddress(state.v);
      operation.write = writeNesPpuMemory(header, mapper, state, {
        address: operation.ppu_address,
        addressProof: state.v,
        value,
        index,
        cpuPort: true,
      });
      state.v = ppuIncrement(state.v, state.control);
    } else {
      const exramUnverified =
        isMmc5State(mapper) &&
        [0, 1, 2, 3].some((page) =>
          mmc5NametableChoices(mapper, 0x2000 + page * 1024).some(
            (choice) => choice.source === "exram",
          ),
        );
      if (exramUnverified && isMmc5State(mapper)) mapper.exram = {};
      state.chr_ram = {};
      state.nametable = {};
      state.palette = {};
      state.v = { low: null, high: null };
      operation.write = {
        status: "unverified",
        destinations: [],
        invalidated_spaces: exramUnverified
          ? ["chr-ram", "nametable", "palette", "mmc5-exram"]
          : ["chr-ram", "nametable", "palette"],
        reason: "unverified-rendering-access",
      };
    }
  }
  operation.after = nesPpuRegisterView(state);
  return operation;
};

export const readNesPpuCpu = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  {
    address,
    index,
    chr,
  }: { address: number | null; index: number; chr?: Uint8Array | undefined },
): {
  value: NesByteValue;
  origin: NesPpuByteOrigin | null;
  operation: NesPpuCpuOperation;
} | null => {
  const pending = state.oam?.dma_pending;
  const hasPending = pending !== undefined && pending.status !== "none";
  if (address !== null && (address < 0x2000 || address > 0x3fff) && !hasPending)
    return null;
  const operation = baseOperation(state, index);
  if (hasPending) {
    invalidateNesDmaPpuReads(
      mapper,
      state,
      pending.status === "pending" ? pending.page : null,
      index,
    );
    operation.write = drainUnknownNesOam(state, index, nonRendering(state));
  }
  if (address !== null && (address < 0x2000 || address > 0x3fff)) {
    operation.after = nesPpuRegisterView(state);
    return { value: null, origin: null, operation };
  }
  if (address === null) {
    const next = ppuIncrement(state.v, state.control);
    state.v =
      nonRendering(state) && state.dma_reads === "absent"
        ? {
            low: joinNesBytes(state.v.low, next.low),
            high: ppuSmall(joinNesBytes(state.v.high, next.high), 127),
          }
        : { low: null, high: null };
    latchRead(
      mapper,
      nonRendering(state) ? ppuBusAddress(operation.before.v) : null,
      true,
    );
    state.write_toggle = state.write_toggle === 0 ? 0 : null;
    state.status = joinNesBytes(state.status, ppuReplace(state.status, 128, 0));
    state.status_origin = { kind: "event-read", index };
    state.read_buffer = { value: null, sources: [] };
    state.io_latch = { value: null, origin: { kind: "event-read", index } };
    operation.after = nesPpuRegisterView(state);
    return { value: null, origin: null, operation };
  }
  const register = 0x2000 | (address & 7);
  let alternatives: NesPpuByteOrigin["alternatives"];
  if (register === 0x2002) {
    const value = ppuReplace(state.io_latch.value, 224, state.status);
    alternatives = [
      {
        mode: "register",
        value,
        sources: [
          registerSource(state, "io-latch", 31),
          registerSource(state, "status", 224),
        ],
        reason: null,
      },
    ];
    state.status = ppuReplace(state.status, 128, 0);
    state.status_origin = { kind: "event-read", index };
    state.write_toggle = 0;
  } else if (register === 0x2007 && nonRendering(state)) {
    const bus = ppuBusAddress(state.v),
      old = structuredClone(state.read_buffer);
    operation.ppu_address = bus;
    const refill = busRead(header, mapper, state, bus, chr);
    operation.bus_reads.push(refill);
    alternatives = [
      {
        mode: "buffered",
        value: old.value,
        sources: old.sources,
        reason: old.value === null ? "unobserved-read-buffer" : null,
      },
    ];
    if (
      bus !== null &&
      bus >= 0x3f00 &&
      state.palette_read_mode !== "buffered"
    ) {
      const palette = readNesPpuPalette(state, bus),
        gray = nesByteBits(state.mask, 1);
      const filtered = ppuSmall(ppuReplace(palette.value, 15, 0), 63);
      const low =
        gray === 0
          ? palette.value
          : gray === 1
            ? filtered
            : ppuSmall(joinNesBytes(palette.value, filtered), 63);
      const direct = {
        mode: "palette" as const,
        value: ppuReplace(state.io_latch.value, 63, low),
        sources: [...palette.sources, registerSource(state, "io-latch", 192)],
        reason: null,
        palette_mask: state.mask,
      };
      alternatives =
        state.palette_read_mode === "direct"
          ? [direct]
          : [
              ...alternatives,
              {
                mode: "unobserved",
                value: ppuReplace(state.io_latch.value, 63, null),
                sources: [registerSource(state, "io-latch", 192)],
                reason: "unqualified-palette-read",
              },
            ];
    } else if (bus === null && state.palette_read_mode !== "buffered") {
      const high = ppuBits(state.v.high);
      if ((high.value & high.mask & 63) === (63 & high.mask)) {
        const unknownPalette = {
          mode: "unobserved" as const,
          value: ppuReplace(state.io_latch.value, 63, null),
          sources: [registerSource(state, "io-latch", 192)],
          reason: "unknown-palette-address",
        };
        alternatives =
          nesByteBits(state.v.high, 63) === 63 &&
          state.palette_read_mode === "direct"
            ? [unknownPalette]
            : [...alternatives, unknownPalette];
      }
    }
    state.read_buffer = {
      value:
        refill.value ?? ("known_bits" in refill ? refill.known_bits : null),
      sources: structuredClone(refill.sources),
    };
    state.v = ppuIncrement(state.v, state.control);
  } else if (register === 0x2004 && state.oam !== null && nonRendering(state)) {
    const oam = readNesOam(state.oam);
    const stored = {
      mode: "register" as const,
      value: oam.value,
      sources: oam.sources,
      reason: null,
    };
    const open = {
      mode: "register" as const,
      value: state.io_latch.value,
      sources: [registerSource(state, "io-latch", 255)],
      reason: "unqualified-oam-readability",
    };
    alternatives =
      state.oam.reads === "supported"
        ? [stored]
        : state.oam.reads === "open-bus"
          ? [open]
          : [stored, open];
  } else if (register === 0x2007 || register === 0x2004) {
    if (register === 0x2004 && state.oam !== null) {
      state.oam.cells = {};
      state.oam.address = null;
      operation.write = {
        status: "unverified",
        destinations: [],
        invalidated_spaces: ["oam"],
        reason: "unverified-oam-rendering-read",
      };
    }
    alternatives = [
      {
        mode: "unobserved",
        value: null,
        sources: [],
        reason:
          register === 0x2004
            ? state.oam === null
              ? "oam-unmodeled"
              : "unverified-oam-rendering-read"
            : "unverified-rendering-access",
      },
    ];
    if (register === 0x2007) {
      state.v = { low: null, high: null };
      state.read_buffer = { value: null, sources: [] };
      latchRead(mapper, null);
    }
  } else
    alternatives = [
      {
        mode: "register",
        value: state.io_latch.value,
        sources: [registerSource(state, "io-latch", 255)],
        reason: null,
      },
    ];
  if (state.dma_reads === "unobserved" && register === 0x2007) {
    alternatives = [
      {
        mode: "unobserved",
        value: null,
        sources: [],
        reason: "unobserved-dma-reads",
      },
    ];
    state.v = { low: null, high: null };
    state.read_buffer = { value: null, sources: [] };
    latchRead(mapper, null);
  } else if (state.dma_reads === "unobserved" && register === 0x2002)
    alternatives = alternatives.map((read) => ({
      ...read,
      value: joinNesBytes(read.value, ppuReplace(read.value, 128, 0)),
      reason: "unobserved-dma-status-race",
    }));
  const value = alternatives.map((read) => read.value).reduce(joinNesBytes),
    origin: NesPpuByteOrigin = {
      kind: "ppu-register",
      cpu_address: address,
      register_address: register,
      alternatives,
    };
  state.io_latch = { value, origin: { kind: "event-read", index } };
  operation.read = origin;
  operation.after = nesPpuRegisterView(state);
  return { value, origin, operation };
};

/** DMA page reads from PPU-register mirrors can invalidate address/buffer/latch facts. */
const invalidateNesDmaPpuReads = (
  mapper: NesMapperState,
  state: NesPpuState,
  page: NesByteValue,
  index: number,
): void => {
  const bits = ppuBits(page);
  if ((bits.value & bits.mask & 224) !== (32 & bits.mask)) return;
  state.v = { low: null, high: null };
  state.read_buffer = { value: null, sources: [] };
  state.write_toggle = state.write_toggle === 0 ? 0 : null;
  state.status = joinNesBytes(state.status, ppuReplace(state.status, 128, 0));
  state.status_origin = { kind: "event-write", index };
  state.io_latch = { value: null, origin: { kind: "event-write", index } };
  latchRead(mapper, null);
};

export const startNesOamDma = (
  mapper: NesMapperState,
  state: NesPpuState,
  page: number,
  index: number,
): Extract<NesPpuOperation, { kind: "oam-dma-start" }> => {
  const before = nesPpuRegisterView(state);
  clearNesDmaRequest(state, mapper);
  return {
    kind: "oam-dma-start",
    event_index: index,
    before,
    after: nesPpuRegisterView(state),
    page,
    bus_reads: [],
    ppu_address: null,
    write: null,
  };
};

export const applyNesOamDma = (
  mapper: NesMapperState,
  state: NesPpuState,
  page: NesByteValue,
  values: readonly NesByteValue[],
  index: number,
): NesOamDmaOperation => {
  const before = nesPpuRegisterView(state),
    start = structuredClone(state.oam!.address),
    pending = state.oam!.dma_pending;
  const p = ppuBits(page),
    queued = ppuBits(pending.status === "pending" ? pending.page : null);
  const effective = nesByteProof(p.mask | queued.mask, p.value | queued.value);
  invalidateNesDmaPpuReads(mapper, state, effective, index);
  const write = applyNesOamDmaMemory(state, values, index, nonRendering(state));
  return {
    kind: "oam-dma",
    event_index: index,
    before,
    after: nesPpuRegisterView(state),
    page: effective,
    start_address: start,
    bus_reads: [],
    ppu_address: null,
    write,
  };
};

/** Actual external PPU bus events do not read/write the internal palette overlay or CPU read buffer. */
export const accessNesPpuBus = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  event:
    | {
        kind: "ppu-read";
        address: number;
        mmc5_fetch?: NesMmc5Fetch | undefined;
        mmc5_tile?: NesMmc5TilePosition | undefined;
      }
    | { kind: "ppu-write"; address: number; value: NesByteValue },
  index: number,
  chr?: Uint8Array,
): NesPpuBusOperation => {
  const operation: NesPpuBusOperation = {
    kind: "ppu-bus",
    event_index: index,
    ppu_address: event.address,
    bus_reads: [],
    write: null,
  };
  if (event.kind === "ppu-read")
    operation.bus_reads.push(
      busRead(header, mapper, state, event.address, chr, {
        fetch: event.mmc5_fetch,
        tile: event.mmc5_tile,
      }),
    );
  else
    operation.write = writeNesPpuMemory(header, mapper, state, {
      address: event.address,
      addressProof: { low: event.address & 255, high: event.address >> 8 },
      value: event.value,
      index,
    });
  return operation;
};
