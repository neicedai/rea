import {
  joinNesBytes,
  nesByteBits,
  type NesByteValue,
} from "./nesByteValue.js";
import type {
  NesBandaiEepromState,
  NesBandaiEepromRead,
} from "./nesBandaiEepromState.js";
import type { NesBandaiState } from "./nesBandai.js";
import type { NesRomMetadata } from "./nes.js";
import { err, ok, type Result } from "./result.js";

const capacity = (state: NesBandaiEepromState) =>
  state.model === "x24c01" ? 128 : 256;
const candidates = (value: NesByteValue, size = 256): number[] =>
  Array.from({ length: size }, (_, n) => n).filter((n) =>
    typeof value === "number"
      ? n === value
      : value === null || (n & value.mask) === value.value,
  );
const envelope = (values: number[]): NesByteValue =>
  values.reduce<NesByteValue>(
    (joined, v, index) => (index === 0 ? v : joinNesBytes(joined, v)),
    null,
  );
const mapByte = (value: NesByteValue, f: (n: number) => number) =>
  envelope(candidates(value).map(f));
const shiftIn = (value: NesByteValue, bit: number | null): NesByteValue => {
  const shifted = mapByte(value, (n) => (n << 1) & 255);
  return bit === null
    ? joinNesBytes(
        shifted,
        mapByte(shifted, (n) => n | 1),
      )
    : mapByte(shifted, (n) => n | bit);
};
const master = (control: NesByteValue): number | null => {
  const direction = nesByteBits(control, 128),
    data = nesByteBits(control, 64);
  return direction === 128 || data === 64
    ? 1
    : direction === 0 && data === 0
      ? 0
      : null;
};
const bus = (host: number | null, device: number | null) =>
  host === 0 || device === 0 ? 0 : host === 1 && device === 1 ? 1 : null;
const byteAt = (state: NesBandaiEepromState): NesByteValue => {
  const addresses = candidates(state.address, capacity(state));
  return addresses.reduce<NesByteValue>((value, address, i) => {
    const byte = state.bytes.find((b) => b.address === address)?.value ?? null;
    return i === 0 ? byte : joinNesBytes(value, byte);
  }, null);
};
const readIndex = (
  state: NesBandaiEepromState,
  control: NesByteValue,
): number | null => {
  const scl = nesByteBits(control, 32);
  if (state.phase !== "read" || scl === null) return null;
  const index = state.bit_index - (scl === 32 ? 1 : 0);
  return index >= 0 && index < 8 ? index : null;
};
const device = (
  state: NesBandaiEepromState,
  control: NesByteValue,
): number | null => {
  if (state.busy === true) return 1;
  if (state.phase === "unknown") return null;
  if (state.phase === "ack") return state.ack_stage === 0 ? 1 : state.ack_bit;
  if (state.phase !== "read") return 1;
  const index = readIndex(state, control);
  if (index === null) return null;
  const value = nesByteBits(byteAt(state), 1 << (7 - index));
  return value === null ? null : value === 0 ? 0 : 1;
};

/** Only D4 is electrically established; all other CPU bus bits remain unknown. */
export const readBandaiEeprom = (
  state: NesBandaiEepromState | undefined,
  control: NesByteValue,
  address: number,
): NesBandaiEepromRead => {
  const unknown = { address, value: null, source: null } as const;
  if (state === undefined || address < 0x6000 || address > 0x7fff)
    return unknown;
  const host = master(control),
    slave = device(state, control),
    bit = bus(host, slave);
  if (bit === null) return unknown;
  const kind =
    host === 0
      ? "master-low"
      : state.phase === "ack" && slave === 0
        ? "device-ack"
        : state.phase === "read" && state.busy !== true
          ? "device-data"
          : "released-pullup";
  return {
    address,
    value: null,
    known_bits: { mask: 16, value: bit === 0 ? 0 : 16 },
    source: {
      model: state.model,
      kind,
      pointer: kind === "device-data" ? state.address : null,
      bit_index: kind === "device-data" ? readIndex(state, control) : null,
      byte_value: kind === "device-data" ? byteAt(state) : null,
    },
  };
};

export const bandaiEepromAdmission = (
  header: NesRomMetadata,
  state: NesBandaiState,
): string | null => {
  const eeprom = "eeprom" in state ? state.eeprom : undefined;
  if (eeprom === undefined) return null;
  const scl = nesByteBits(state.eeprom_control, 32);
  if (
    (["command", "address", "write"].includes(eeprom.phase) &&
      eeprom.bit_index > 7) ||
    (eeprom.phase === "read" &&
      ((scl === 32 && eeprom.bit_index === 0) ||
        (scl === 0 && eeprom.bit_index === 8))) ||
    ((eeprom.phase === "ack" || eeprom.phase === "master-ack") &&
      ((eeprom.ack_stage === 0 &&
        (eeprom.phase === "master-ack" || scl === 0)) ||
        (eeprom.ack_stage === 1 && scl === 32) ||
        (eeprom.ack_stage === 2 && scl === 0)))
  )
    return "EEPROM serial phase, bit index or ACK stage conflicts with the supplied control clock level.";
  if (
    ("variant" in state && state.variant === "fcg") ||
    (state.mapper !== 16 && state.mapper !== 159)
  )
    return "Serial EEPROM requires a matching LZ93D50 Bandai board.";
  if (state.mapper === 159 && eeprom.model !== "x24c01")
    return "Mapper 159 identifies X24C01, not X24C02.";
  if (
    header.headerVersion === "nes2" &&
    header.prgNvramSize !== capacity(eeprom)
  )
    return "EEPROM model conflicts with the declared NES 2.0 NVRAM capacity or absence.";
  return null;
};

const losePhase = (state: NesBandaiEepromState) => {
  state.phase = "unknown";
  state.next_phase = "unknown";
  if (state.busy !== true) state.pending_unknown = true;
};
const stageByte = (state: NesBandaiEepromState, value: NesByteValue) => {
  const addresses = candidates(state.address, capacity(state));
  for (const address of addresses) {
    const previous = state.pending.find((p) => p.address === address);
    if (previous === undefined)
      state.pending.push({ address, value, definite: addresses.length === 1 });
    else if (addresses.length === 1) {
      previous.value = value;
      previous.definite = true;
    } else previous.value = joinNesBytes(previous.value, value);
  }
  const mask = state.page_size - 1;
  state.address = mapByte(state.address, (n) => (n & ~mask) | ((n + 1) & mask));
};
const receiveByte = (state: NesBandaiEepromState) => {
  const phase = state.phase,
    value = state.shift;
  state.phase = "ack";
  state.ack_stage = 0;
  state.ack_bit = 0;
  state.next_phase = "write";
  if (phase === "command") {
    if (state.busy === true) {
      state.ack_bit = 1;
      state.next_phase = "ignore";
      return;
    }
    if (state.busy === null) {
      state.ack_bit = null;
      state.next_phase = "unknown";
      return;
    }
    if (state.model === "x24c02") {
      const target = nesByteBits(value, 254);
      const possible = candidates(value).some((v) => (v & 254) === 0xa0);
      if (!possible) {
        state.ack_bit = 1;
        state.next_phase = "ignore";
        return;
      }
      if (target === null) {
        state.ack_bit = null;
        state.next_phase = "unknown";
        return;
      }
    } else state.address = mapByte(value, (n) => n >> 1);
    const direction = nesByteBits(value, 1);
    state.next_phase =
      direction === 1
        ? "read"
        : direction === 0
          ? state.model === "x24c01"
            ? "write"
            : "address"
          : "unknown";
  } else if (phase === "address") state.address = value;
  else stageByte(state, value);
};
const enterNext = (state: NesBandaiEepromState) => {
  state.phase = state.next_phase;
  state.bit_index = 0;
  state.shift = 0;
  state.ack_stage = 0;
};
const rising = (state: NesBandaiEepromState, sda: number | null) => {
  if (["command", "address", "write"].includes(state.phase)) {
    state.shift = shiftIn(state.shift, sda);
    if (++state.bit_index === 8) receiveByte(state);
  } else if (state.phase === "ack" && state.ack_stage === 1)
    state.ack_stage = 2;
  else if (state.phase === "read") state.bit_index++;
  else if (state.phase === "master-ack") {
    state.ack_stage = 2;
    state.next_phase = sda === 0 ? "read" : sda === 1 ? "ignore" : "unknown";
  }
};
const falling = (state: NesBandaiEepromState) => {
  if (state.phase === "ack") {
    if (state.ack_stage === 0) state.ack_stage = 1;
    else if (state.ack_stage === 2) enterNext(state);
  } else if (state.phase === "read" && state.bit_index === 8) {
    state.address = mapByte(state.address, (n) => (n + 1) % capacity(state));
    state.phase = "master-ack";
    state.ack_stage = 1;
  } else if (state.phase === "master-ack" && state.ack_stage === 2)
    enterNext(state);
};

/** Ordered control levels own serial edges; calls and CPU/IRQ cycles never imply write completion. */
export const writeBandaiEepromControl = (
  previous: NesBandaiEepromState,
  old: NesByteValue,
  control: NesByteValue,
): NesBandaiEepromState => {
  const state = structuredClone(previous);
  const before = nesByteBits(old, 32),
    after = nesByteBits(control, 32);
  if (before === null || after === null) {
    losePhase(state);
    return state;
  }
  if (before === 32 && after === 32) {
    const slave = device(state, old),
      a = bus(master(old), slave),
      b = bus(master(control), slave);
    if (a === 1 && b === 0) {
      if (state.pending.length > 0 && state.busy !== true)
        state.pending_unknown = true;
      state.phase = "command";
      state.bit_index = 0;
      state.shift = 0;
    } else if (a === 0 && b === 1) {
      if (state.pending.length > 0 || state.pending_unknown) state.busy = true;
      state.phase = "idle";
    } else if (
      (a === null || b === null) &&
      (master(old) !== master(control) || master(old) === null)
    )
      losePhase(state);
  } else if (before === 0 && after === 32)
    rising(state, bus(master(control), device(state, old)));
  else if (before === 32 && after === 0) falling(state);
  return state;
};

/** An explicit caller completion assumption commits the staged page; no save file is written. */
export const completeBandaiEepromWrite = (
  previous: NesBandaiEepromState,
): Result<NesBandaiEepromState, string> => {
  if (previous.busy !== true)
    return err(
      "EEPROM completion requires a known pending write cycle started by STOP.",
    );
  const state = structuredClone(previous);
  if (state.pending_unknown || state.pending.length === 0)
    state.bytes = state.bytes.map((b) => ({ ...b, value: null }));
  else
    for (const pending of state.pending) {
      const cell = state.bytes.find((b) => b.address === pending.address);
      const value = pending.definite
        ? pending.value
        : joinNesBytes(cell?.value ?? null, pending.value);
      if (cell === undefined)
        state.bytes.push({ address: pending.address, value });
      else cell.value = value;
    }
  state.pending = [];
  state.pending_unknown = false;
  state.busy = false;
  return ok(state);
};
