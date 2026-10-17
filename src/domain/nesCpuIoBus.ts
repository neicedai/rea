import type { NesByteValue } from "./nesByteValue.js";
import {
  nesIoBits,
  replaceNesIoBits,
  andNesIoBits,
  type NesCpuIoState,
  type NesSourcedCpuIoState,
  type NesCpuIoOrigin,
} from "./nesCpuIo.js";
import type { NesDataRead, NesDmaIoRead } from "./nesCodeTrace.js";

const valueOf = (read: NesDataRead): NesByteValue =>
  read.value ?? ("known_bits" in read ? read.known_bits : null);
const sourceOf = (read: NesDataRead) => {
  const origin = read.mapper_origins[0];
  if (
    origin === undefined ||
    !["apu-status", "standard-controller", "held-controller"].includes(
      origin.kind,
    )
  )
    return null;
  const { byte_index, ...source } = origin;
  void byte_index;
  return source.kind === "apu-status" ||
    source.kind === "standard-controller" ||
    source.kind === "held-controller"
    ? source
    : null;
};
const setLatch = (
  state: NesSourcedCpuIoState,
  line: "cpu" | "external",
  byte: NesByteValue,
  driven: number,
  index: number,
) => {
  const key = line === "cpu" ? "cpu_latch" : "external_latch";
  state[key] = replaceNesIoBits(state[key], byte, driven);
  const known = nesIoBits(state[key]).mask;
  const origins: NesCpuIoOrigin[] = state.latch_origins[line].flatMap(
    (origin) => {
      const mask = origin.mask & ~driven & known;
      return mask === 0 ? [] : [{ ...origin, mask }];
    },
  );
  const mask = nesIoBits(byte).mask & driven;
  if (mask !== 0)
    origins.push({ mask, source: { kind: "cycle", line, index } });
  state.latch_origins[line] = origins;
};
const connectedCpu = (state: NesSourcedCpuIoState): void => {
  state.cpu_latch = structuredClone(state.external_latch);
  state.latch_origins.cpu = structuredClone(state.latch_origins.external);
};
const releaseController = (state: NesSourcedCpuIoState) => {
  state.active_controller = 0;
  state.held_controller = null;
};
const activeController = (
  state: NesSourcedCpuIoState,
  address: number | null,
  read: NesDataRead,
  index: number,
) => {
  if (address !== 0x4016 && address !== 0x4017) {
    releaseController(state);
    return;
  }
  state.active_controller = address === 0x4016 ? 1 : 2;
  const source = sourceOf(read);
  if (source?.kind === "held-controller") return;
  const bits = nesIoBits(valueOf(read));
  state.held_controller = {
    pin_value:
      bits.mask & 1 ? { mask: 1, value: (bits.value & 1) as 0 | 1 } : null,
    source: source?.kind === "standard-controller" ? source : null,
    cycle_index: index,
  };
};

/** One CPU path owns both electrical latches and controller /OE, including DMA cycles. */
export class NesCpuIoBus {
  readonly initial: NesCpuIoState;
  readonly initialized: NesSourcedCpuIoState;
  state: NesSourcedCpuIoState;
  constructor(initial: NesCpuIoState) {
    this.initial = structuredClone(initial);
    this.state = {
      ...structuredClone(initial),
      latch_origins:
        "latch_origins" in initial
          ? structuredClone(initial.latch_origins)
          : {
              cpu: this.initialOrigins(initial.cpu_latch, "cpu"),
              external: this.initialOrigins(initial.external_latch, "external"),
            },
    };
    this.initialized = structuredClone(this.state);
  }
  private initialOrigins(
    byte: NesByteValue,
    line: "cpu" | "external",
  ): NesCpuIoOrigin[] {
    const mask = nesIoBits(byte).mask;
    return mask === 0
      ? []
      : [{ mask, source: { kind: "initial-latch", line } }];
  }
  controllerMode(address: number | null): "new" | "hold" | "unknown" {
    if (address !== 0x4016 && address !== 0x4017) return "new";
    if (this.state.controller_clocking === "per-cycle") return "new";
    if (this.state.active_controller === null) return "unknown";
    return this.state.active_controller === (address === 0x4016 ? 1 : 2)
      ? "hold"
      : "new";
  }
  project(
    read: NesDataRead,
    index: number,
    externalDriven: number,
    externalOnly: boolean,
  ) {
    const state = structuredClone(this.state),
      raw = valueOf(read),
      address = read.address;
    const internal = !externalOnly && address === 0x4015;
    const controller =
      !externalOnly && (address === 0x4016 || address === 0x4017);
    if (internal) setLatch(state, "cpu", raw, 223, index);
    else {
      setLatch(state, "external", raw, controller ? 31 : externalDriven, index);
      connectedCpu(state);
    }
    activeController(state, controller ? address : null, read, index);
    const operation = internal
      ? "apu-status"
      : controller
        ? "controller"
        : externalDriven === 0
          ? externalOnly
            ? "external-open-bus"
            : "open-bus"
          : null;
    if (operation === null) return { read, state };
    const value = state.cpu_latch;
    const projected: NesDataRead = {
      address,
      value: typeof value === "number" ? value : null,
      ...(value !== null && typeof value === "object"
        ? { known_bits: value }
        : {}),
      file_offset: null,
      ram_origins: [],
      mapper_origins: [
        {
          kind: "cpu-io",
          byte_index: 0,
          operation,
          raw_value: raw,
          cpu_latch: this.state.cpu_latch,
          external_latch: this.state.external_latch,
          latch_origins: structuredClone(this.state.latch_origins),
          device_source: sourceOf(read),
        },
      ],
    };
    return { read: projected, state };
  }
  projectDma(
    external: NesDataRead,
    internal: NesDataRead,
    alias: 0x4015 | 0x4016 | 0x4017,
    externalDriven: number,
    index: number,
  ) {
    const state = structuredClone(this.state),
      pins = valueOf(internal),
      ext = valueOf(external);
    if (alias === 0x4015) {
      setLatch(state, "external", ext, externalDriven, index);
      setLatch(state, "cpu", pins, 223, index);
      releaseController(state);
    } else {
      if (externalDriven !== 0)
        setLatch(state, "external", ext, externalDriven, index);
      const low =
        externalDriven === 0 ? pins : andNesIoBits(state.external_latch, pins);
      setLatch(state, "external", low, 31, index);
      connectedCpu(state);
      activeController(state, alias, internal, index);
    }
    const io: NesDmaIoRead = {
      decoded_address: alias,
      internal_read: internal,
      cpu_value: state.cpu_latch,
      external_value: state.external_latch,
      before: {
        cpu_latch: this.state.cpu_latch,
        external_latch: this.state.external_latch,
        latch_origins: structuredClone(this.state.latch_origins),
      },
    };
    return { read: external, state, io, value: state.cpu_latch };
  }
  write(value: NesByteValue, index: number): void {
    setLatch(this.state, "cpu", value, 255, index);
    setLatch(this.state, "external", value, 255, index);
    releaseController(this.state);
  }
}
