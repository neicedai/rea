import { scheduler } from "node:timers/promises";
import { isBandaiState, applyBandaiWrite } from "./nesBandai.js";
import { isMmc5State, applyMmc5Write, mmc5RamAdmission } from "./nesMmc5.js";
import { admitMmc5ExramOrigins } from "./nesMmc5Exram.js";
import {
  isNamco163State,
  hasNamco163ChipRam,
  applyNamco163Write,
} from "./nesNamco163.js";
import { invalidateNamco163Phase } from "./nesNamco163Ram.js";
import { isFme7State, applyFme7Write } from "./nesFme7.js";
import { isH3001State, applyH3001Write } from "./nesH3001.js";
import { isSunsoft3State, applySunsoft3Write } from "./nesSunsoft3.js";
import { isSunsoft4State, applySunsoft4Write } from "./nesSunsoft4.js";
import { isVrc3State, applyVrc3Write } from "./nesVrc3.js";
import {
  isIrem78State,
  applyIrem78Write,
  irem78PrgCandidates,
} from "./nesIrem78.js";
import { isJ87State, applyJ87Write } from "./nesJ87.js";
import { isNamco108State, applyNamco108Write } from "./nesNamco108.js";
import { writeNesSelectedBank } from "./nesBankRegisters.js";
import { bandaiEepromAdmission } from "./nesBandaiEeprom.js";
import { nesBoardSelection } from "./nesBoardSelection.js";
import { isVrc6State, applyVrc6Write } from "./nesVrc6.js";
import { nesVrcBoard } from "./nesVrcBoard.js";
import { isVrc2State } from "./nesVrc2.js";
import { nesPrgRamLayout } from "./nesPrgRamLayout.js";
import { vrc4Board, isVrc4State, applyVrc4Write } from "./nesVrc4.js";
import {
  joinNesBytes,
  andNesBytes,
  nesByteBits,
  type NesByteValue,
} from "./nesByteValue.js";
import { nesMapper34Board } from "./nesMapper34.js";
import { applyNesLatchWrite } from "./nesLatchMapper.js";
import type { NesRomMetadata } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { normalizeNesPrgViews, type NesPrgView } from "./nesPrgViews.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import type {
  NesMapperState,
  NesMapperWrite,
  NesMapperTrace,
  NesMapperTraceStep,
} from "./nesMapperTrace.js";

/** One producing loop for admission, synchronous consumers, and cancellable replay. */
function* nesMapperTraceBatches(
  header: NesRomMetadata,
  initial: NesMapperState,
  writes: readonly NesMapperWrite[],
  prg?: Uint8Array,
  ppuNextEventIndex?: number,
): Generator<void, NesMapperTrace, void> {
  const layout = resolveNesMapperLayout(
    header,
    undefined,
    nesBoardSelection(initial),
  );
  if (!layout.ok) return { status: "unsupported", reason: layout.error };
  if (isMmc5State(initial)) {
    const origins = admitMmc5ExramOrigins(initial, ppuNextEventIndex ?? null);
    if (origins !== null) return { status: "unsupported", reason: origins };
    const reason = mmc5RamAdmission(header, initial);
    if (reason !== null) return { status: "unsupported", reason };
  }
  if (isBandaiState(initial)) {
    const failure = bandaiEepromAdmission(header, initial);
    if (failure !== null) return { status: "unsupported", reason: failure };
  }
  if (
    header.chrRom.size > 0 &&
    (header.chrRamSize ?? 0) + (header.chrNvramSize ?? 0) > 0
  )
    return {
      status: "unsupported",
      reason:
        "Combined CHR ROM and RAM declarations require a separate bank-source wiring model.",
    };
  if (header.mapper !== initial.mapper)
    return {
      status: "unsupported",
      reason: "Initial state mapper does not match the cartridge header.",
    };
  if (
    isVrc4State(initial) !==
    (vrc4Board(header, "wiring" in initial ? initial.wiring : undefined) !==
      null)
  )
    return {
      status: "unsupported",
      reason:
        "Initial VRC4 state requires variant vrc4 and matching header-selected or explicitly assumed VRC4 wiring; VRC2 states must omit variant.",
    };
  if (
    isVrc4State(initial) &&
    initial.prg_ram_wiring !== null &&
    nesPrgRamLayout(header, initial) === null
  )
    return {
      status: "unsupported",
      reason:
        "VRC4 prg_ram_wiring requires a matching single-chip NES 2.0 RAM/NVRAM declaration: 2 KiB for internal-2k or 8 KiB for external-8k.",
    };
  if (
    isVrc2State(initial) &&
    initial.mapper === 23 &&
    initial.latch_present === true &&
    (header.prgRamSize ?? 0) + (header.prgNvramSize ?? 0) > 0
  )
    return {
      status: "unsupported",
      reason:
        "VRC2b one-bit latch wiring cannot be established with declared PRG RAM/NVRAM.",
    };
  let state = structuredClone(initial);
  if (hasNamco163ChipRam(state))
    invalidateNamco163Phase(state.chip_ram, state.prg_banks[0] ?? null);
  const views = new Map<string, NesPrgView>();
  const retainView = (mapping: ReturnType<typeof mapperMapping>) => {
    const view = mapping.prg_view;
    if (view !== null) views.set(JSON.stringify(view), view);
    return view;
  };
  const initialMapping = mapperMapping(header, state);
  retainView(initialMapping);
  const steps: NesMapperTraceStep[] = [];
  let unknownPrgSteps = 0;
  for (const [index, write] of writes.entries()) {
    if (index % 128 === 0) yield;
    const next = applyMappedNesMapperWrite(header, state, write, { prg });
    state = next.state;
    const mapping = mapperMapping(header, state);
    if (mapping.prg_windows.some((window) => window.bank === null))
      unknownPrgSteps++;
    steps.push({
      index,
      write: { ...write },
      effect: next.effect,
      state: structuredClone(state),
      prg_view: retainView(mapping),
      mapping,
    });
  }
  return {
    status: "derived",
    initial: structuredClone(initial),
    initial_mapping: initialMapping,
    steps,
    final: state,
    final_mapping: steps.at(-1)?.mapping ?? initialMapping,
    nes_prg_views: normalizeNesPrgViews(views.values()),
    coverage: {
      supplied_writes: writes.length,
      processed_writes: steps.length,
      unknown_prg_steps: unknownPrgSteps,
    },
  };
}

/** Deterministic register interpretation, conditional on supplied writes and timing. */
export const deriveNesMapperTrace = (
  header: NesRomMetadata,
  initial: NesMapperState,
  writes: readonly NesMapperWrite[],
  prg?: Uint8Array,
  ppuNextEventIndex?: number,
): NesMapperTrace => {
  const batches = nesMapperTraceBatches(
    header,
    initial,
    writes,
    prg,
    ppuNextEventIndex,
  );
  let batch = batches.next();
  while (!batch.done) batch = batches.next();
  return batch.value;
};

/** Let timers and other requests run between bounded write batches. */
export const deriveNesMapperTraceWithCancellation = async (
  header: NesRomMetadata,
  initial: NesMapperState,
  writes: readonly NesMapperWrite[],
  prg: Uint8Array | undefined,
  {
    signal,
    ppuNextEventIndex,
  }: {
    signal?: AbortSignal | undefined;
    ppuNextEventIndex?: number | undefined;
  } = {},
): Promise<NesMapperTrace> => {
  signal?.throwIfAborted();
  const batches = nesMapperTraceBatches(
    header,
    initial,
    writes,
    prg,
    ppuNextEventIndex,
  );
  let batch = batches.next();
  while (!batch.done) {
    await scheduler.yield();
    signal?.throwIfAborted();
    batch = batches.next();
  }
  signal?.throwIfAborted();
  return batch.value;
};

type Change = Pick<NesMapperTraceStep, "state" | "effect">;
type Mmc1 = Extract<NesMapperState, { mapper: 1 }>;

/** Resolve bus conflicts against the pre-write mapping and immutable PRG snapshot. */
export const applyMappedNesMapperWrite = (
  header: NesRomMetadata,
  state: NesMapperState,
  write: NesMapperWrite,
  bus: {
    prg: Uint8Array | undefined;
    mmc5_in_frame?: boolean | null;
    ppu_event_index?: number;
  },
): Change & {
  readonly rom_bus: {
    readonly value: NesByteValue;
    readonly sources: {
      readonly file_offset: number;
      readonly value: number;
    }[];
  } | null;
} => {
  const conflictPossible =
    write.address >= 0x8000 &&
    (([2, 3, 7].includes(state.mapper) && header.submapper !== 1) ||
      (state.mapper === 11 && state.bus_conflicts !== "none") ||
      (state.mapper === 34 && nesMapper34Board(header) === "BNROM") ||
      [66, 78, 180].includes(state.mapper));
  const sources: { file_offset: number; value: number }[] = [];
  const window = mapperMapping(header, state).prg_windows.find(
    (window) =>
      write.address >= window.start &&
      write.address < window.start + window.size,
  );
  let romValue: NesByteValue =
    window?.file_offset == null
      ? null
      : (bus.prg?.[
          window.file_offset -
            header.prgRom.offset +
            write.address -
            window.start
        ] ?? null);
  if (
    conflictPossible &&
    window?.file_offset != null &&
    typeof romValue === "number"
  )
    sources.push({
      file_offset: window.file_offset + write.address - window.start,
      value: romValue,
    });
  if (
    isIrem78State(state) &&
    window?.file_offset == null &&
    write.address >= 0x8000 &&
    bus.prg !== undefined
  ) {
    const banks =
      write.address >= 0xc000
        ? [header.prgRom.size / 16384 - 1]
        : irem78PrgCandidates(state, header.prgRom.size / 16384);
    const values: NesByteValue[] = banks.map((bank) => {
      const index = bank * 16384 + (write.address & 16383),
        value = bus.prg?.[index] ?? null;
      if (conflictPossible && value !== null)
        sources.push({ file_offset: header.prgRom.offset + index, value });
      return value;
    });
    romValue = values.length === 0 ? null : values.reduce(joinNesBytes);
  }
  const change = applyNesMapperWrite(state, write, {
    header,
    ...(bus.mmc5_in_frame === undefined
      ? {}
      : { mmc5_in_frame: bus.mmc5_in_frame }),
    ...(bus.ppu_event_index === undefined
      ? {}
      : { ppu_event_index: bus.ppu_event_index }),
    romValue,
  });
  return {
    ...change,
    rom_bus: conflictPossible ? { value: romValue, sources } : null,
  };
};

/** Apply one CPU bus write; shared by supplied traces and source instruction derivation. */
export const applyNesMapperWrite = (
  previous: NesMapperState,
  write: NesMapperWrite,
  bus: {
    header: NesRomMetadata;
    romValue: NesByteValue;
    mmc5_in_frame?: boolean | null;
    ppu_event_index?: number;
  },
): Change => {
  const state = structuredClone(previous);
  const byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  if (isMmc5State(state))
    return applyMmc5Write(state, write, bus.mmc5_in_frame, bus.ppu_event_index);
  if (isNamco163State(state)) return applyNamco163Write(state, write);
  if (isFme7State(state)) return applyFme7Write(state, write);
  if (isH3001State(state)) return applyH3001Write(state, write);
  if (isSunsoft3State(state)) return applySunsoft3Write(state, write);
  if (isSunsoft4State(state)) return applySunsoft4Write(state, write);
  if (isVrc3State(state)) return applyVrc3Write(state, write);
  if (isIrem78State(state)) return applyIrem78Write(state, write, bus.romValue);
  if (isJ87State(state)) return applyJ87Write(state, write);
  if (isNamco108State(state)) return applyNamco108Write(state, write);
  if (isBandaiState(state)) return applyBandaiWrite(bus.header, state, write);
  if (isVrc6State(state)) return applyVrc6Write(state, write);
  if (isVrc4State(state)) return applyVrc4Write(state, write, bus.header);
  if (state.mapper === 34 && nesMapper34Board(bus.header) === "NINA-001") {
    if (write.address === 0x7ffd) {
      state.prg_bank = nesByteBits(byte, 1);
      return { state, effect: "prg-bank" };
    }
    if (write.address === 0x7ffe || write.address === 0x7fff) {
      state[write.address === 0x7ffe ? "chr_bank_0" : "chr_bank_1"] =
        nesByteBits(byte, 15);
      return { state, effect: "chr-bank" };
    }
    return { state, effect: "outside-mapper" };
  }
  if (
    state.mapper === 23 &&
    write.address >= 0x6000 &&
    write.address <= 0x6fff
  ) {
    if (state.latch_present === false)
      return { state, effect: "outside-mapper" };
    const latched = state.latch_present === true ? nesByteBits(byte, 1) : null;
    state.latch_value = latched === null ? null : latched === 0 ? 0 : 1;
    return {
      state,
      effect:
        state.latch_present === true ? "latch-write" : "uncertain-latch-write",
    };
  }
  if (state.mapper === 0 || write.address < 32768)
    return { state, effect: "outside-mapper" };
  if (state.mapper === 34) {
    state.prg_bank = discreteBank(byte, bus.romValue, 2, 3);
    return { state, effect: "prg-bank" };
  }
  if (isVrc2State(state)) {
    const board = nesVrcBoard(
      bus.header,
      "wiring" in state ? state.wiring : undefined,
    );
    if (board?.family !== "vrc2") return { state, effect: "outside-mapper" };
    const register = write.address & 0xf000;
    if (register === 0x8000 || register === 0xa000) {
      state.prg_banks[register === 0x8000 ? 0 : 1] = byte;
      return { state, effect: "prg-bank" };
    }
    if (register === 0x9000) {
      state.control = byte;
      return { state, effect: "nametable" };
    }
    if (register >= 0xb000 && register <= 0xe000) {
      const port =
        ((write.address >> board.a0) & 1) |
        (((write.address >> board.a1) & 1) << 1);
      const index = ((register - 0xb000) / 0x1000) * 2 + (port >> 1);
      state[(port & 1) === 0 ? "chr_low" : "chr_high"][index] = byte;
      return { state, effect: "chr-bank" };
    }
    return { state, effect: "outside-mapper" };
  }
  if (state.mapper === 75) {
    const register = write.address & 0xf000;
    if (register === 0x8000 || register === 0xa000 || register === 0xc000) {
      state.prg_banks[(register - 0x8000) / 0x2000] = byte;
      return { state, effect: "prg-bank" };
    }
    if (register === 0x9000) {
      state.control = byte;
      return { state, effect: "register-commit" };
    }
    if (register >= 0xe000) {
      state.chr_banks[register === 0xe000 ? 0 : 1] = byte;
      return { state, effect: "chr-bank" };
    }
    return { state, effect: "outside-mapper" };
  }
  if (state.mapper === 33) {
    if (write.address >= 0xc000) return { state, effect: "outside-mapper" };
    const register = write.address & 0xa003;
    if (register === 0x8000 || register === 0x8001) {
      state.prg_banks[register & 1] = byte;
      return {
        state,
        effect: register === 0x8000 ? "register-commit" : "prg-bank",
      };
    }
    state.chr_banks[
      register < 0xa000 ? (register & 3) - 2 : (register & 3) + 2
    ] = byte;
    return { state, effect: "chr-bank" };
  }
  if (state.mapper === 32) {
    switch (write.address & 0xf000) {
      case 0x8000:
      case 0xa000:
        state.prg_banks[write.address < 0x9000 ? 0 : 1] = byte;
        return { state, effect: "prg-bank" };
      case 0x9000:
        if (bus.header.submapper === 1)
          return { state, effect: "outside-mapper" };
        state.control = byte;
        return { state, effect: "register-commit" };
      case 0xb000:
        state.chr_banks[write.address & 7] = byte;
        return { state, effect: "chr-bank" };
      default:
        return { state, effect: "outside-mapper" };
    }
  }
  if (state.mapper === 232) {
    if (write.address >= 0xc000) state.prg_bank = nesByteBits(byte, 3);
    else {
      const low = nesByteBits(byte, bus.header.submapper === 1 ? 16 : 8);
      const high = nesByteBits(byte, bus.header.submapper === 1 ? 8 : 16);
      state.prg_outer_bank =
        low === null
          ? high === null
            ? null
            : { mask: 2, value: high === 0 ? 0 : 2 }
          : high === null
            ? { mask: 1, value: low === 0 ? 0 : 1 }
            : (low === 0 ? 0 : 1) | (high === 0 ? 0 : 2);
    }
    return { state, effect: "prg-bank" };
  }
  if (state.mapper === 71) {
    if (write.address >= 0xc000) {
      state.prg_bank = nesByteBits(byte, bus.header.submapper === 1 ? 7 : 15);
      return { state, effect: "prg-bank" };
    }
    if (write.address < 0xa000 && bus.header.submapper === 1) {
      const page = nesByteBits(byte, 16);
      state.mirroring = page === null ? null : page === 0 ? 0 : 1;
      return { state, effect: "nametable" };
    }
    return { state, effect: "outside-mapper" };
  }
  if (state.mapper === 3) {
    state.chr_bank = discreteBank(
      byte,
      bus.romValue ?? null,
      bus.header.submapper ?? null,
      3,
    );
    return { state, effect: "chr-bank" };
  }
  if (state.mapper === 180) {
    state.prg_bank = discreteBank(byte, bus.romValue ?? null, 2, 7);
    return { state, effect: "prg-bank" };
  }
  if (state.mapper === 2) {
    state.prg_bank = discreteBank(
      byte,
      bus.romValue ?? null,
      bus.header.submapper ?? null,
      15,
    );
    return { state, effect: "prg-bank" };
  }
  if (state.mapper === 7) {
    state.prg_bank = discreteBank(
      byte,
      bus.romValue ?? null,
      bus.header.submapper ?? null,
      7,
    );
    const page = discreteBank(
      byte,
      bus.romValue ?? null,
      bus.header.submapper ?? null,
      16,
    );
    state.mirroring = page === null ? null : page === 0 ? 0 : 1;
    return { state, effect: "prg-bank" };
  }
  if (state.mapper === 11) {
    const policy =
      state.bus_conflicts === "and"
        ? 2
        : state.bus_conflicts === "none"
          ? 1
          : 0;
    state.prg_bank = discreteBank(byte, bus.romValue ?? null, policy, 3);
    const chr = discreteBank(byte, bus.romValue ?? null, policy, 240);
    state.chr_bank = chr === null ? null : chr >> 4;
    return { state, effect: "prg-chr-bank" };
  }
  if (state.mapper === 66) {
    const prg = discreteBank(byte, bus.romValue ?? null, 2, 48);
    state.prg_bank = prg === null ? null : prg >> 4;
    state.chr_bank = discreteBank(byte, bus.romValue ?? null, 2, 3);
    return { state, effect: "prg-chr-bank" };
  }
  if (state.mapper === 4)
    return mmc3Write(state, write, bus.header.submapper === 1);
  if (state.mapper === 9 || state.mapper === 10)
    return applyNesLatchWrite(state, write);
  if (write.value !== null && (write.value & 128) !== 0) {
    state.shift_bits = [];
    state.prg_mode = 3;
    return { state, effect: "serial-reset" };
  }
  if (write.value !== null && write.preceded_by_cpu_write === true)
    return { state, effect: "ignored-consecutive-write" };
  if (write.value === null) {
    // Only D7 and D0 affect the serial interface; ignore unrelated unknown bits.
    const mask = "known_bits" in write ? write.known_bits.mask : 0;
    const bits = "known_bits" in write ? write.known_bits.value : 0;
    const candidates = [
      ...((mask & 128) === 0 || (bits & 128) !== 0 ? [128] : []),
      ...((mask & 128) !== 0 && (bits & 128) !== 0
        ? []
        : (mask & 1) !== 0
          ? [bits & 1]
          : [0, 1]),
    ];
    const alternatives = candidates.map((value) =>
      applyNesMapperWrite(
        previous,
        {
          address: write.address,
          value,
          preceded_by_cpu_write: write.preceded_by_cpu_write,
        },
        bus,
      ),
    );
    if (alternatives.length === 1) return alternatives[0]!;
    return {
      state: alternatives
        .map((change) => change.state as Mmc1)
        .reduce(joinMmc1),
      effect: alternatives.every(
        (change) => change.effect === alternatives[0]!.effect,
      )
        ? alternatives[0]!.effect
        : "uncertain-serial-write",
    };
  }
  const shifted = shiftMmc1(state, write.address, (write.value & 1) as 0 | 1);
  if (write.preceded_by_cpu_write === false) return shifted;
  return {
    state: joinMmc1(previous as Mmc1, shifted.state as Mmc1),
    effect: "uncertain-serial-write",
  };
};

const shiftMmc1 = (state: Mmc1, address: number, bit: 0 | 1): Change => {
  if (state.shift_bits === null) {
    invalidateMmc1Register(state, address);
    return { state, effect: "uncertain-serial-write" };
  }
  state.shift_bits.push(bit);
  if (state.shift_bits.length < 5) return { state, effect: "serial-shift" };
  const bits = state.shift_bits;
  const field = (start: number, width: number): number | null => {
    const selected = bits.slice(start, start + width);
    return selected.some((bit) => bit === null)
      ? null
      : selected.reduce<number>(
          (value, bit, index) => value | ((bit ?? 0) << index),
          0,
        );
  };
  const bankField = (width: 4 | 5): NesByteValue => {
    const mask = bits
      .slice(0, width)
      .reduce<number>(
        (mask, bit, index) => mask | (bit === null ? 0 : 1 << index),
        0,
      );
    const value = bits
      .slice(0, width)
      .reduce<number>((value, bit, index) => value | ((bit ?? 0) << index), 0);
    return mmc1BankProof({ mask, value }, (1 << width) - 1);
  };
  state.shift_bits = [];
  switch (address & 0x6000) {
    case 0:
      state.prg_mode = field(2, 2) as Mmc1["prg_mode"];
      state.chr_mode = field(4, 1) as Mmc1["chr_mode"];
      state.mirroring = field(0, 2) as Mmc1["mirroring"];
      break;
    case 0x2000:
      state.chr_bank_0 = bankField(5);
      break;
    case 0x4000:
      state.chr_bank_1 = bankField(5);
      break;
    case 0x6000:
      state.prg_bank = bankField(4);
      state.prg_ram_disable_bit = field(4, 1) as Mmc1["prg_ram_disable_bit"];
      break;
  }
  return { state, effect: "register-commit" };
};

const invalidateMmc1Register = (state: Mmc1, address: number): void => {
  switch (address & 0x6000) {
    case 0:
      state.prg_mode = null;
      state.chr_mode = null;
      state.mirroring = null;
      break;
    case 0x2000:
      state.chr_bank_0 = null;
      break;
    case 0x4000:
      state.chr_bank_1 = null;
      break;
    case 0x6000:
      state.prg_bank = null;
      state.prg_ram_disable_bit = null;
      break;
  }
};

const joinMmc1 = (left: Mmc1, right: Mmc1): Mmc1 => {
  return {
    mapper: 1,
    prg_mode: left.prg_mode === right.prg_mode ? left.prg_mode : null,
    chr_mode: left.chr_mode === right.chr_mode ? left.chr_mode : null,
    mirroring: left.mirroring === right.mirroring ? left.mirroring : null,
    prg_bank: mmc1BankProof(joinNesBytes(left.prg_bank, right.prg_bank), 15),
    prg_ram_disable_bit:
      left.prg_ram_disable_bit === right.prg_ram_disable_bit
        ? left.prg_ram_disable_bit
        : null,
    chr_bank_0: mmc1BankProof(
      joinNesBytes(left.chr_bank_0, right.chr_bank_0),
      31,
    ),
    chr_bank_1: mmc1BankProof(
      joinNesBytes(left.chr_bank_1, right.chr_bank_1),
      31,
    ),
    shift_bits:
      left.shift_bits === null ||
      right.shift_bits === null ||
      left.shift_bits.length !== right.shift_bits.length
        ? null
        : left.shift_bits.map((bit, index) =>
            bit === right.shift_bits?.[index] ? bit : null,
          ),
  };
};

/** Canonical envelope for a four/five-bit serial register, including its complete value. */
const mmc1BankProof = (
  byte: NesByteValue,
  registerMask: number,
): NesByteValue => {
  const mask =
    typeof byte === "number" ? registerMask : (byte?.mask ?? 0) & registerMask;
  const value = (typeof byte === "number" ? byte : (byte?.value ?? 0)) & mask;
  return mask === 0 ? null : mask === registerMask ? value : { mask, value };
};

const mmc3Write = (
  state: Extract<NesMapperState, { mapper: 4 }>,
  write: NesMapperWrite,
  mmc6: boolean,
): Change => {
  if (mmc6) {
    const enabled = nesByteBits(state.bank_select, 32);
    if (enabled === 0) state.ram_protect = 0;
    else if (enabled === null)
      state.ram_protect = joinNesBytes(state.ram_protect, 0);
  }
  const value = write.value;
  const byte =
    value ?? ("known_bits" in write ? { ...write.known_bits } : null);
  switch (write.address & 0xe001) {
    case 0x8000:
      state.bank_select = byte;
      if (mmc6) {
        const enabled = nesByteBits(byte, 32);
        if (enabled === 0) state.ram_protect = 0;
        else if (enabled === null)
          state.ram_protect = joinNesBytes(state.ram_protect, 0);
      }
      return { state, effect: "bank-select" };
    case 0x8001: {
      state.banks = writeNesSelectedBank(state.banks, state.bank_select, byte);
      return { state, effect: "bank-data" };
    }
    case 0xa000:
      state.mirroring = nesByteBits(byte, 1) as 0 | 1 | null;
      return { state, effect: "nametable" };
    case 0xa001:
      state.ram_protect = !mmc6
        ? byte
        : nesByteBits(state.bank_select, 32) === null
          ? joinNesBytes(byte, 0)
          : nesByteBits(state.bank_select, 32) === 0
            ? 0
            : byte;
      return { state, effect: "ram-control" };
    case 0xc000:
      state.irq_latch = byte;
      return { state, effect: "irq-latch" };
    case 0xc001:
      state.last_irq_command = "reload";
      return { state, effect: "irq-reload" };
    case 0xe000:
      state.last_irq_command = "disable-acknowledge";
      return { state, effect: "irq-disable" };
    default:
      state.last_irq_command = "enable";
      return { state, effect: "irq-enable" };
  }
};

/** Join discrete latch possibilities without assuming unspecified bus wiring. */
const discreteBank = (
  cpu: NesByteValue,
  rom: NesByteValue,
  submapper: number | null,
  mask: number,
): number | null => {
  const conflicted = andNesBytes(cpu, rom);
  return nesByteBits(
    submapper === 1
      ? cpu
      : submapper === 2
        ? conflicted
        : joinNesBytes(cpu, conflicted),
    mask,
  );
};

/** Candidate register writes retained identically by code tracing and write replay. */
export const isNesMapperWriteAddress = (
  header: NesRomMetadata,
  address: number,
): boolean =>
  address >= 32768 ||
  (header.mapper === 5 && (address === 0x2000 || address === 0x2001)) ||
  (header.mapper === 5 && address >= 0x5000 && address <= 0x5206) ||
  (header.mapper === 5 && address >= 0x5c00 && address <= 0x5fff) ||
  (header.mapper === 19 && address >= 0x4800 && address <= 0x5fff) ||
  (header.mapper === 16 && address >= 0x6000 && address <= 0x7fff) ||
  (header.mapper === 87 && address >= 0x6000 && address <= 0x7fff) ||
  (header.mapper === 23 &&
    header.submapper === 3 &&
    address >= 0x6000 &&
    address <= 0x6fff) ||
  (header.mapper === 34 &&
    nesMapper34Board(header) === "NINA-001" &&
    address >= 0x7ffd &&
    address <= 0x7fff);
