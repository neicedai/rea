import { err, ok, type Result } from "./result.js";
import {
  clockNesDmcTiming,
  nesDmcReadReady,
  nesDmcTimingPhase,
  stopNesDmcReader,
  type NesDmcStopProof,
} from "./nesDmcTiming.js";
import {
  clockNesDmcOutput,
  clockNesDmcTimer,
  writeNesDmc,
  fillNesDmcBuffer,
  type NesDmcRead,
} from "./nesDmc.js";
import {
  nesByteBits,
  joinNesBytes,
  nesByteCandidates,
  nesByteProof,
  type NesByteValue,
} from "./nesByteValue.js";
import {
  nesApuRegisters,
  type NesApuState,
  type NesApuOrigin,
  type NesApuOperation,
  type NesApuCpuRead,
} from "./nesApu.js";
import {
  apuFlags,
  apuJoinFlag,
  apuRange,
  apuRegister,
  apuSetCounter,
  apuSetFlag,
  apuLengthTable,
  apuQuarterClock,
  apuHalfClock,
  apuHigh,
} from "./nesApuUnits.js";
import type { NesMapperEvent } from "./nesMapperEvents.js";
import {
  clockNesApuFrame,
  queueNesApuFrameReset,
  type NesApuFrameSignals,
} from "./nesApuFrame.js";

type Failure = {
  kind: "invalid-apu-state" | "invalid-apu-event";
  reason: string;
};
type Cell = NesApuOperation["changes"][number]["after"];
const facts = (state: NesApuState): Map<string, Cell> => {
  const result = new Map<string, Cell>();
  for (const [address, value] of Object.entries(state.registers))
    result.set(`registers.${address}`, value);
  for (const [index, value] of state.lengths.entries())
    result.set(`lengths.${index}`, value);
  for (const [index, value] of state.pulse_timers.entries()) {
    result.set(`pulse_timers.${index}.low`, value.low);
    result.set(`pulse_timers.${index}.high`, value.high);
  }
  for (const [index, unit] of state.envelopes.entries())
    for (const field of ["start", "divider", "decay"] as const)
      result.set(`envelopes.${index}.${field}`, unit[field]);
  for (const [index, unit] of state.sweeps.entries())
    for (const field of ["reload", "divider"] as const)
      result.set(`sweeps.${index}.${field}`, unit[field]);
  for (const field of [
    "triangle_linear",
    "triangle_reload",
    "dmc_remaining",
    "frame_irq",
    "dmc_irq",
  ] as const)
    result.set(field, state[field]);
  if (state.frame_clocks === "explicit")
    result.set("frame_reset_pending", state.frame_reset_pending);
  if (state.dmc != null)
    for (const field of [
      "current_address",
      "buffer",
      "shift",
      "shift_origin",
      "bits_remaining",
      "silence",
      "level",
      "timer_remaining",
      "cpu_timing",
    ] as const)
      result.set(`dmc.${field}`, {
        model: "dmc-fact",
        value: state.dmc[field],
        origin: state.dmc.origin,
      });
  return result;
};
export const admitNesApu = (state: NesApuState): Result<null, Failure> => {
  if ((state.dmc_reads === "explicit") !== (state.dmc != null))
    return err({
      kind: "invalid-apu-state",
      reason:
        "DMC reader/output requires dmc_reads explicit and initial_apu.dmc together.",
    });
  if (state.dmc != null) {
    const timingPhase = nesDmcTimingPhase(state);
    const pendingStop = state.dmc.cpu_timing?.stop;
    const pendingRequest = state.dmc.cpu_timing?.request;
    if (
      pendingStop?.status === "pending" &&
      pendingStop.cause === "implicit" &&
      pendingStop.delay === 4
    )
      return err({
        kind: "invalid-apu-state",
        reason: "An implicit DMC stop cannot retain more than three CPU edges.",
      });
    if (
      pendingStop?.status === "pending" &&
      ((pendingStop.cause === "explicit" &&
        pendingStop.origin.kind === "dmc-read") ||
        (pendingStop.cause === "implicit" &&
          pendingStop.origin.kind === "event-write"))
    )
      return err({
        kind: "invalid-apu-state",
        reason: "DMC stop cause contradicts its retained write/read origin.",
      });
    if (
      pendingStop?.status === "pending" &&
      timingPhase !== (pendingStop.delay % 2 === 0 ? "get" : "put")
    )
      return err({
        kind: "invalid-apu-state",
        reason:
          "DMC request and delayed-stop histories contradict their shared get/put phase.",
      });
    if (
      state.frame_clocks === "cpu-ordered" &&
      timingPhase !== null &&
      state.frame_sequencer.cpu_phase !== null &&
      state.frame_sequencer.cpu_phase !== timingPhase
    )
      return err({
        kind: "invalid-apu-state",
        reason:
          "DMC delayed request/stop history contradicts the retained get/put phase.",
      });
    if (
      state.dmc.cpu_timing !== null &&
      (state.dmc.region !== "ntsc" || state.dmc.clocks !== "cpu-ordered")
    )
      return err({
        kind: "invalid-apu-state",
        reason: "2A03 DMC DMA timing requires CPU-ordered NTSC DMC clocks.",
      });
    if (
      state.dmc.cpu_timing?.request.status === "none" &&
      nesDmcReadReady(state) === true
    )
      return err({
        kind: "invalid-apu-state",
        reason:
          "A ready DMC reader must retain its pending or unknown DMA request history.",
      });
    if (
      state.dmc.cpu_timing?.request.status === "pending" &&
      (state.dmc_remaining.value.max === 0 ||
        (nesByteBits(apuRegister(state, 0x4015), 16) === 0 &&
          state.dmc.cpu_timing.stop.status === "none") ||
        ((state.dmc.cpu_timing.request.delay === 0 ||
          state.dmc.cpu_timing.request.type === "reload") &&
          state.dmc.buffer.status === "full"))
    )
      return err({
        kind: "invalid-apu-state",
        reason:
          "A pending DMC request contradicts the retained reader/enable/buffer facts.",
      });
    if (
      state.dmc.clocks === "cpu-ordered" &&
      (state.frame_clocks !== "cpu-ordered" ||
        state.frame_sequencer.region !== state.dmc.region)
    )
      return err({
        kind: "invalid-apu-state",
        reason:
          "CPU-ordered DMC timing requires a matching CPU-ordered APU region.",
      });
    const origins = [
      state.dmc.shift_origin,
      ...(state.dmc.buffer.status === "full" ? [state.dmc.buffer.origin] : []),
      ...(pendingStop?.status === "pending" ? [pendingStop.origin] : []),
      ...(pendingRequest?.status === "pending" &&
      pendingRequest.type === "duplicate"
        ? [pendingRequest.origin]
        : []),
    ];
    if (
      origins.some(
        (origin) => "index" in origin && origin.index >= state.next_event_index,
      )
    )
      return err({
        kind: "invalid-apu-state",
        reason: "DMC buffer/shift/stop origins must precede next_event_index.",
      });
  }
  if (
    state.frame_clocks === "cpu-ordered" &&
    state.frame_sequencer.reset_delay.max === 0
  ) {
    const selected = nesByteBits(apuRegister(state, 0x4017), 128),
      limit = state.frame_sequencer.region === "ntsc" ? 29829 : 33253;
    if (
      selected !== null &&
      ((state.frame_sequencer.five_step !== null &&
        state.frame_sequencer.five_step !== (selected !== 0)) ||
        (selected === 0 &&
          state.frame_sequencer.position !== null &&
          state.frame_sequencer.position.min > limit))
    )
      return err({
        kind: "invalid-apu-state",
        reason:
          "APU active mode/phase contradicts the retained 4017 selector without a pending reset.",
      });
  }
  if (
    state.frame_clocks === "cpu-ordered" &&
    "index" in state.frame_sequencer.origin &&
    state.frame_sequencer.origin.index >= state.next_event_index
  )
    return err({
      kind: "invalid-apu-state",
      reason: "APU sequencer origin must precede next_event_index.",
    });
  for (const [field, fact] of facts(state))
    if ("index" in fact.origin && fact.origin.index >= state.next_event_index)
      return err({
        kind: "invalid-apu-state",
        reason: `APU ${field} origin must precede next_event_index.`,
      });
  for (const [index, length] of state.lengths.entries())
    if (
      nesByteBits(apuRegister(state, 0x4015), 1 << index) === 0 &&
      length.value.min > 0
    )
      return err({
        kind: "invalid-apu-state",
        reason:
          "A disabled APU channel cannot retain a definitely nonzero length counter.",
      });
  if (
    nesByteBits(apuRegister(state, 0x4015), 16) === 0 &&
    state.dmc_remaining.value.min > 0 &&
    (state.dmc?.cpu_timing == null ||
      state.dmc.cpu_timing.stop.status === "none")
  )
    return err({
      kind: "invalid-apu-state",
      reason:
        "A disabled DMC cannot retain definitely positive bytes remaining.",
    });
  if (
    (nesByteBits(apuRegister(state, 0x4017), 64) === 64 &&
      state.frame_irq.value === true) ||
    (nesByteBits(apuRegister(state, 0x4010), 128) === 0 &&
      state.dmc_irq.value === true)
  )
    return err({
      kind: "invalid-apu-state",
      reason: "An inhibited APU IRQ cannot be asserted in the supplied state.",
    });
  return ok(null);
};
export const initializeNesApu = (initial: NesApuState): NesApuState => {
  const state = structuredClone(initial);
  if (state.dmc?.cpu_timing?.request.status === "pending") {
    if (
      state.dmc.cpu_timing.request.delay === 0 ||
      state.dmc.cpu_timing.request.type === "reload"
    )
      state.dmc.buffer = { status: "empty" };
    if (state.dmc_remaining.value.min === 0)
      apuSetCounter(
        state.dmc_remaining,
        [1, state.dmc_remaining.value.max],
        state.dmc.origin,
      );
  }
  for (const [index, length] of state.lengths.entries())
    if (
      nesByteBits(apuRegister(state, 0x4015), 1 << index) === 0 &&
      length.value.max !== 0
    )
      apuSetCounter(length, [0], state.registers[0x4015]!.origin);
  if (
    nesByteBits(apuRegister(state, 0x4017), 64) === 64 &&
    state.frame_irq.value !== false
  )
    apuSetFlag(state.frame_irq, [false], state.registers[0x4017]!.origin);
  if (
    nesByteBits(apuRegister(state, 0x4010), 128) === 0 &&
    state.dmc_irq.value !== false
  )
    apuSetFlag(state.dmc_irq, [false], state.registers[0x4010]!.origin);
  if (
    nesByteBits(apuRegister(state, 0x4015), 16) === 0 &&
    (state.dmc?.cpu_timing == null ||
      state.dmc.cpu_timing.stop.status === "none") &&
    state.dmc_remaining.value.max !== 0
  )
    apuSetCounter(state.dmc_remaining, [0], state.registers[0x4015]!.origin);
  return state;
};

/** Capture physical register/counter effects once for both CPU and supplied-event adapters. */
export const advanceNesApu = (
  state: NesApuState,
  event: NesMapperEvent,
  dmcRead?: NesDmcRead,
): Result<
  {
    operation: NesApuOperation;
    read: NesApuCpuRead | null;
    dmc_stop?: NesDmcStopProof;
  } | null,
  Failure
> => {
  if (
    event.kind === "apu-dmc-read" ||
    event.kind === "apu-dmc-cpu-read" ||
    event.kind === "apu-dmc-clock" ||
    event.kind === "apu-dmc-stop"
  ) {
    if (state.dmc == null || state.dmc_reads !== "explicit")
      return err({
        kind: "invalid-apu-event",
        reason: "DMC events require initial_apu.dmc and explicit DMA reads.",
      });
    if (event.kind === "apu-dmc-read" && dmcRead === undefined)
      return err({
        kind: "invalid-apu-event",
        reason: "Qualified DMC get requires its mapper/file read proof.",
      });
    if (event.kind === "apu-dmc-clock" && state.dmc.clocks !== "explicit")
      return err({
        kind: "invalid-apu-event",
        reason:
          "Explicit DMC output clocks cannot mix with CPU-ordered DMC timing.",
      });
    if (
      event.kind === "apu-dmc-stop" &&
      (state.frame_clocks !== "cpu-ordered" ||
        state.frame_sequencer.cpu_phase !== "put" ||
        state.dmc.cpu_timing?.stop.status !== "pending" ||
        state.dmc.cpu_timing.stop.delay !== 1)
    )
      return err({
        kind: "invalid-apu-event",
        reason:
          "apu-dmc-stop requires a pending explicit stop due on the known current put cycle.",
      });
  }
  if (
    state.frame_clocks === "explicit" &&
    event.kind === "apu-frame-reset" &&
    state.frame_reset_pending.value === false
  )
    return err({
      kind: "invalid-apu-event",
      reason: "apu-frame-reset requires a pending or unknown 4017 reset.",
    });
  if (
    ((event.kind === "apu-cpu-cycle" || event.kind === "apu-cpu-phase") &&
      state.frame_clocks !== "cpu-ordered") ||
    ((event.kind === "apu-frame-clock" || event.kind === "apu-frame-reset") &&
      state.frame_clocks !== "explicit")
  )
    return err({
      kind: "invalid-apu-event",
      reason:
        "APU CPU edges require cpu-ordered framing; qualified unit clocks/resets require explicit framing. These clock models cannot be mixed.",
    });
  const before = structuredClone(facts(state)),
    index = state.next_event_index,
    effects: NesApuOperation["effects"] = [];
  invalidateDmc(state, index, effects);
  let read: NesApuCpuRead | null = null;
  let frameClock: NesApuFrameSignals | null = null;
  let dmcStop: NesDmcStopProof | null = null;
  if (event.kind === "apu-dmc-stop") {
    dmcStop = stopNesDmcReader(state);
    effects.push("dmc-stop");
  } else if (event.kind === "apu-dmc-read") {
    const failure = fillNesDmcBuffer(state, dmcRead!);
    if (failure !== null)
      return err({ kind: "invalid-apu-event", reason: failure });
    effects.push("dmc-read");
  } else if (event.kind === "apu-dmc-cpu-read") {
    const failure = fillNesDmcBuffer(
      state,
      {
        address: event.address,
        value: event.value,
        source: { kind: "cpu-dma", index, cycle_index: event.cycle_index },
      },
      event.output_boundary,
    );
    if (failure !== null)
      return err({ kind: "invalid-apu-event", reason: failure });
    effects.push("dmc-read");
    const timing = state.dmc!.cpu_timing;
    if (
      timing?.request.status === "pending" &&
      timing.request.type === "duplicate"
    )
      effects.push("dmc-duplicate");
    if (
      timing?.stop.status === "pending" &&
      timing.stop.cause === "implicit" &&
      timing.stop.origin.kind === "dmc-read" &&
      timing.stop.origin.index === index
    )
      effects.push("dmc-implicit-stop-queued");
  } else if (event.kind === "apu-dmc-clock") {
    clockNesDmcOutput(state.dmc!, index);
    effects.push("dmc-clock");
  }
  if (event.kind === "apu-cpu-phase" && state.frame_clocks === "cpu-ordered") {
    if (
      (state.frame_sequencer.cpu_phase !== null &&
        state.frame_sequencer.cpu_phase !== event.phase) ||
      (nesDmcTimingPhase(state) !== null &&
        nesDmcTimingPhase(state) !== event.phase)
    )
      return err({
        kind: "invalid-apu-event",
        reason: "Qualified CPU phase contradicts the retained APU phase.",
      });
    state.frame_sequencer.cpu_phase = event.phase;
    state.frame_sequencer.origin = { kind: "phase-assumption", index };
    effects.push("phase-assumption");
  }
  if (
    event.kind === "cpu-write" &&
    nesApuRegisters.some((address) => address === event.address)
  )
    writeApu(
      state,
      event.address,
      event.value ?? ("known_bits" in event ? event.known_bits : null),
      effects,
    );
  else if (event.kind === "cpu-read" && event.address === 0x4015) {
    if (state.dmc_reads === "unobserved" && state.dmc_remaining.value.max > 0)
      apuSetFlag(state.frame_irq, [...apuFlags(state.frame_irq.value), false], {
        kind: "unobserved-dmc",
        index,
      });
    read = readStatus(state);
    apuSetFlag(state.frame_irq, [false], { kind: "status-read", index });
    effects.push("status-read");
  } else if (event.kind === "cpu-read" && event.address === null) {
    apuSetFlag(state.frame_irq, [...apuFlags(state.frame_irq.value), false], {
      kind: "status-read",
      index,
    });
    effects.push("unknown-read-address");
  } else if (
    event.kind === "apu-cpu-cycle" &&
    state.frame_clocks === "cpu-ordered"
  ) {
    const mayDmcBoundary =
      state.dmc != null &&
      (state.dmc.timer_remaining === null || state.dmc.timer_remaining === 1) &&
      (state.dmc.bits_remaining === null || state.dmc.bits_remaining === 1);
    if (state.dmc?.clocks === "cpu-ordered") {
      clockNesDmcTimer(state);
      effects.push("dmc-clock");
    }
    const mode = nesByteBits(apuRegister(state, 0x4017), 128),
      inhibit = nesByteBits(apuRegister(state, 0x4017), 64),
      origin: NesApuOrigin = { kind: "event-clock", index };
    frameClock = clockNesApuFrame(
      state.frame_sequencer,
      {
        fiveStep: mode === null ? null : mode !== 0,
        inhibit: inhibit === null ? null : inhibit !== 0,
      },
      index,
    );
    dmcStop = clockNesDmcTiming(state, mayDmcBoundary);
    if (dmcStop !== null) effects.push("dmc-stop");
    clockUnits(state, frameClock.quarter, frameClock.half, origin);
    if (frameClock.quarter !== false)
      effects.push(
        frameClock.quarter === true
          ? "quarter-clock"
          : "possible-quarter-clock",
      );
    if (frameClock.half !== false)
      effects.push(
        frameClock.half === true ? "half-clock" : "possible-half-clock",
      );
    if (frameClock.irq !== false) {
      apuSetFlag(
        state.frame_irq,
        frameClock.irq === true
          ? [true]
          : [...apuFlags(state.frame_irq.value), true],
        origin,
      );
      effects.push(
        frameClock.irq === true ? "frame-irq" : "possible-frame-irq",
      );
    }
    if (frameClock.reset !== false)
      effects.push(
        frameClock.reset === true
          ? "frame-reset-complete"
          : "possible-frame-reset",
      );
  } else if (event.kind === "apu-frame-clock") {
    const origin: NesApuOrigin = { kind: "event-clock", index };
    if (event.clock !== "irq") {
      apuQuarterClock(state, origin);
      effects.push("quarter-clock");
    }
    if (event.clock.startsWith("quarter-half")) {
      apuHalfClock(state, origin);
      effects.push("half-clock");
    }
    if (event.clock.endsWith("irq")) {
      const values = nesByteCandidates(apuRegister(state, 0x4017));
      apuSetFlag(
        state.frame_irq,
        values.flatMap((value) =>
          (value & 192) === 0 ? [true] : apuFlags(state.frame_irq.value),
        ),
        origin,
      );
      effects.push("frame-irq");
    }
  } else if (
    event.kind === "apu-frame-reset" &&
    state.frame_clocks === "explicit"
  ) {
    const origin: NesApuOrigin = { kind: "event-clock", index },
      mode = nesByteBits(apuRegister(state, 0x4017), 128);
    if (mode !== 0) {
      const previous = structuredClone(state);
      apuQuarterClock(state, origin);
      apuHalfClock(state, origin);
      if (mode === null) joinUnitStates(state, previous, origin);
      effects.push("quarter-clock", "half-clock");
    }
    apuSetFlag(state.frame_reset_pending, [false], origin);
    effects.push("frame-reset-complete");
  }
  const changes: NesApuOperation["changes"] = [];
  for (const [field, after] of facts(state)) {
    const previous = before.get(field) ?? null;
    if (
      "model" in after &&
      previous !== null &&
      "model" in previous &&
      JSON.stringify(after.value) === JSON.stringify(previous.value)
    )
      continue;
    if (JSON.stringify(previous) !== JSON.stringify(after))
      changes.push({ field, before: previous, after: structuredClone(after) });
  }
  if (effects.length === 0 && changes.length === 0) return ok(null);
  return ok({
    operation: {
      event_index: index,
      kind:
        event.kind === "apu-frame-clock" ||
        event.kind === "apu-frame-reset" ||
        event.kind === "apu-cpu-cycle" ||
        event.kind === "apu-cpu-phase" ||
        event.kind === "apu-dmc-read" ||
        event.kind === "apu-dmc-cpu-read" ||
        event.kind === "apu-dmc-clock" ||
        event.kind === "apu-dmc-stop" ||
        event.kind === "cpu-write" ||
        event.kind === "cpu-read"
          ? event.kind
          : "unobserved-dmc",
      address:
        event.kind === "cpu-write" || event.kind === "cpu-read"
          ? event.address
          : null,
      changes,
      effects,
      frame_clock: frameClock,
    },
    read,
    ...(dmcStop === null ? {} : { dmc_stop: dmcStop }),
  });
};

function invalidateDmc(
  state: NesApuState,
  index: number,
  effects: NesApuOperation["effects"],
): void {
  if (state.dmc_reads !== "unobserved" || state.dmc_remaining.value.max === 0)
    return;
  const origin: NesApuOrigin = { kind: "unobserved-dmc", index },
    control = apuRegister(state, 0x4010),
    loop = nesByteBits(control, 64),
    length = nesByteCandidates(apuRegister(state, 0x4013)).map(
      (value) => value * 16 + 1,
    );
  apuSetCounter(
    state.dmc_remaining,
    [
      loop === 64 && state.dmc_remaining.value.min > 0 ? 1 : 0,
      loop === 0
        ? state.dmc_remaining.value.max
        : Math.max(state.dmc_remaining.value.max, ...length),
    ],
    origin,
  );
  if (nesByteBits(control, 128) !== 0 && loop !== 64)
    apuSetFlag(state.dmc_irq, [...apuFlags(state.dmc_irq.value), true], origin);
  effects.push("dmc-uncertainty");
}
function writeApu(
  state: NesApuState,
  address: number,
  byte: NesByteValue,
  effects: NesApuOperation["effects"],
): void {
  const origin: NesApuOrigin = {
      kind: "event-write",
      index: state.next_event_index,
    },
    values = nesByteCandidates(byte);
  const previousRemaining = { ...state.dmc_remaining.value };
  state.registers[address] = { value: structuredClone(byte), origin };
  effects.push("register-write");
  if (address === 0x4015) {
    for (const [index, length] of state.lengths.entries())
      apuSetCounter(
        length,
        values.flatMap((value) =>
          value & (1 << index) ? [length.value.min, length.value.max] : [0],
        ),
        origin,
      );
    const lengths = nesByteCandidates(apuRegister(state, 0x4013)).map(
        (value) => value * 16 + 1,
      ),
      remaining = state.dmc_remaining.value;
    const counts = values.flatMap((value) =>
      !(value & 16)
        ? state.dmc?.cpu_timing != null
          ? [remaining.min, remaining.max]
          : [0]
        : remaining.min > 0
          ? [remaining.min, remaining.max]
          : [...lengths, ...(remaining.max > 0 ? [1, remaining.max] : [])],
    );
    if (
      state.dmc?.cpu_timing == null ||
      Math.min(...counts) !== remaining.min ||
      Math.max(...counts) !== remaining.max
    )
      apuSetCounter(state.dmc_remaining, counts, origin);
    apuSetFlag(state.dmc_irq, [false], origin);
    if (nesByteBits(byte, 16) !== 0 && state.dmc == null)
      state.dmc_reads = "unobserved";
    effects.push("channel-enables");
  } else if (address === 0x4010 && nesByteBits(byte, 128) !== 128) {
    apuSetFlag(
      state.dmc_irq,
      nesByteBits(byte, 128) === 0
        ? [false]
        : [...apuFlags(state.dmc_irq.value), false],
      origin,
    );
  } else if (address === 0x4017) {
    if (state.frame_clocks === "explicit")
      apuSetFlag(state.frame_reset_pending, [true], origin);
    else queueNesApuFrameReset(state.frame_sequencer, state.next_event_index);
    if (nesByteBits(byte, 64) !== 0)
      apuSetFlag(
        state.frame_irq,
        nesByteBits(byte, 64) === 64
          ? [false]
          : [...apuFlags(state.frame_irq.value), false],
        origin,
      );
    effects.push("frame-reset-queued");
  }
  if (state.dmc != null) writeNesDmc(state, address, byte, previousRemaining);
  const channel = [0x4003, 0x4007, 0x400b, 0x400f].indexOf(address);
  if (channel >= 0) {
    const enabled = nesByteBits(apuRegister(state, 0x4015), 1 << channel),
      counts = values.map((value) => apuLengthTable[value >> 3]!);
    apuSetCounter(
      state.lengths[channel]!,
      enabled === 0 ? [0] : enabled === null ? [0, ...counts] : counts,
      origin,
    );
    if (channel === 2) {
      apuSetFlag(state.triangle_reload, [true], origin);
      effects.push("linear-reload");
    } else {
      apuSetFlag(
        state.envelopes[channel === 3 ? 2 : channel]!.start,
        [true],
        origin,
      );
      effects.push("envelope-start");
    }
    effects.push("length-load");
  }
  if (address === 0x4001 || address === 0x4005) {
    apuSetFlag(
      state.sweeps[address === 0x4001 ? 0 : 1]!.reload,
      [true],
      origin,
    );
    effects.push("sweep-reload");
  }
  for (const index of [0, 1]) {
    const low = 0x4002 + index * 4,
      timer = state.pulse_timers[index]!;
    if (address === low) timer.low = { value: byte, origin };
    else if (address === low + 1) timer.high = { value: apuHigh(byte), origin };
  }
}
function readStatus(state: NesApuState): NesApuCpuRead {
  let mask = 0,
    value = 0;
  const active = [
    ...state.lengths.map((counter) => counter.value),
    state.dmc_remaining.value,
  ].map((counter) =>
    counter.min > 0 ? true : counter.max === 0 ? false : null,
  );
  for (const [index, bit] of [
    ...active,
    state.frame_irq.value,
    state.dmc_irq.value,
  ].entries()) {
    const physical = index < 5 ? index : index + 1;
    if (bit !== null) {
      mask |= 1 << physical;
      if (bit) value |= 1 << physical;
    }
  }
  const proof = nesByteProof(mask, value),
    source = {
      kind: "apu-status" as const,
      index: state.next_event_index,
      lengths: structuredClone(state.lengths),
      dmc_remaining: structuredClone(state.dmc_remaining),
      frame_irq: structuredClone(state.frame_irq),
      dmc_irq: structuredClone(state.dmc_irq),
    };
  return {
    address: 0x4015,
    value: null,
    source,
    ...(proof !== null && typeof proof === "object"
      ? { known_bits: proof }
      : {}),
  };
}
function joinUnitStates(
  state: NesApuState,
  previous: NesApuState,
  origin: NesApuOrigin,
): void {
  for (const [index, timer] of state.pulse_timers.entries())
    for (const field of ["low", "high"] as const) {
      const prior = previous.pulse_timers[index]![field],
        joined = joinNesBytes(timer[field].value, prior.value),
        value = field === "high" ? apuHigh(joined) : joined;
      timer[field] =
        JSON.stringify(value) === JSON.stringify(prior.value)
          ? structuredClone(prior)
          : { value, origin };
    }
  const old = facts(previous);
  for (const [field, fact] of facts(state)) {
    if (field.startsWith("registers.") || field.startsWith("pulse_timers."))
      continue;
    const before = old.get(field)!;
    if ("model" in fact || "model" in before) continue;
    if (JSON.stringify(fact) === JSON.stringify(before)) continue;
    if (
      typeof fact.value === "object" &&
      fact.value !== null &&
      "min" in fact.value &&
      typeof before.value === "object" &&
      before.value !== null &&
      "min" in before.value
    )
      fact.value = apuRange([
        fact.value.min,
        fact.value.max,
        before.value.min,
        before.value.max,
      ]);
    else if (
      (typeof fact.value === "boolean" || fact.value === null) &&
      (typeof before.value === "boolean" || before.value === null)
    )
      fact.value = apuJoinFlag([
        ...apuFlags(fact.value),
        ...apuFlags(before.value),
      ]);
    fact.origin = origin;
  }
}

function clockUnits(
  state: NesApuState,
  quarter: boolean | null,
  half: boolean | null,
  origin: NesApuOrigin,
): void {
  for (const [signal, apply] of [
    [quarter, apuQuarterClock],
    [half, apuHalfClock],
  ] as const) {
    if (signal === false) continue;
    const previous = signal === null ? structuredClone(state) : null;
    apply(state, origin);
    if (previous !== null) joinUnitStates(state, previous, origin);
  }
}
