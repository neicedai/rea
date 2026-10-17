import { z } from "zod";
import type { NesApuState } from "./nesApu.js";
import { nesByteBits, type NesByteValue } from "./nesByteValue.js";
import { apuSetCounter } from "./nesApuUnits.js";

// A byte cannot be consumed twice within an instruction/entry. One initial
// request and an immediately emptied buffer can still require two gets.
// A 514-cycle OAM block can span one further 8*54-cycle NTSC byte boundary.
export const NES_DMC_STALL_CYCLES = 4;
export const NES_DMC_INLINE_TRANSFERS = 2;
export const NES_DMC_OAM_TRANSFERS = 3;

const eventIndex = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nesDmcReadOriginSchema = z.strictObject({
  kind: z.literal("dmc-read"),
  index: eventIndex,
  cycle_index: eventIndex,
});
export const nesDmcStopOriginSchema = z.union([
  z.strictObject({ kind: z.literal("initial-state") }),
  z.strictObject({
    kind: z.literal("event-write"),
    index: eventIndex,
  }),
  nesDmcReadOriginSchema,
]);
export type NesDmcStopOrigin = z.infer<typeof nesDmcStopOriginSchema>;
export type NesDmcTransferType = "load" | "reload" | "duplicate";
export type NesDmcStopProof = {
  cause: "explicit" | "implicit";
  origin: NesDmcStopOrigin;
  event_index: number;
};

export const nesDmcTimingSchema = z
  .strictObject({
    model: z.literal("2a03-dmc-dma"),
    duplication: z.enum(["enabled", "disabled", "unknown"]).prefault("unknown"),
    request: z
      .union([
        z.strictObject({ status: z.literal("none") }),
        z.strictObject({ status: z.literal("unknown") }),
        z.strictObject({
          status: z.literal("pending"),
          type: z.literal("load"),
          delay: z.number().int().min(0).max(4),
        }),
        z.strictObject({
          status: z.literal("pending"),
          type: z.literal("reload"),
          delay: z.number().int().min(0).max(1),
        }),
        z.strictObject({
          status: z.literal("pending"),
          type: z.literal("duplicate"),
          delay: z.literal(0),
          origin: nesDmcReadOriginSchema,
        }),
      ])
      .prefault({ status: "unknown" }),
    stop: z
      .union([
        z.strictObject({ status: z.literal("none") }),
        z.strictObject({ status: z.literal("unknown") }),
        z.strictObject({
          status: z.literal("pending"),
          cause: z.enum(["explicit", "implicit"]).prefault("explicit"),
          delay: z.number().int().min(1).max(4),
          origin: nesDmcStopOriginSchema,
        }),
      ])
      .prefault({ status: "unknown" }),
  })
  .describe(
    "Qualified NTSC 2A03 DMC request, stop and optional silicon duplication timing. Request delay counts remaining ordered CPU edges before the halt is eligible; zero remains latched through failed write-cycle halts. Ordinary ready reloads are requested immediately after an output byte boundary on either CPU phase. Caller-supplied reload delay one retains a latency qualification but proves no get/put parity; only fixed load or stop delays constrain phase. A duplicate request retains its triggering delivered-read event and actual get cycle and is a follow-up, not a fresh initial load. Independent stop delay includes the current edge and retains its explicit disabling write or implicit delivered-read origin; expiry clears effective reader bytes even if a subsequent enable left raw 4015 D4 set. Repeated disables do not restart a pending stop, and enables do not cancel it. Buffer, output and DAC survive reader stop. Request/stop omissions and the duplication selector retain unknown history; none is inferred from raw 4015 or post-clock bits/timer values. Source CPU/OAM bus arbitration owns halt/dummy/get and abort progress. These conditional model rules are not physical observations; unqualified silicon windows and unknown delivery phase remain unsupported.",
  );

export const nesDmcReadReady = (state: NesApuState): boolean | null => {
  if (state.dmc == null) return null;
  if (state.dmc_remaining.value.max === 0 || state.dmc.buffer.status === "full")
    return false;
  return state.dmc_remaining.value.min > 0 &&
    state.dmc.buffer.status === "empty"
    ? true
    : null;
};
/** Fixed load/stop delays constrain phase; caller reload latency does not. */
export const nesDmcTimingPhase = (
  state: NesApuState | null,
): "get" | "put" | null => {
  const request = state?.dmc?.cpu_timing?.request;
  if (
    request?.status === "pending" &&
    request.type === "load" &&
    request.delay > 0
  )
    return request.delay % 2 === 0 ? "get" : "put";
  // Stop delay includes its expiry edge, which is always a put.
  const stop = state?.dmc?.cpu_timing?.stop;
  return stop?.status === "pending"
    ? stop.delay % 2 === 0
      ? "get"
      : "put"
    : null;
};

export const writeNesDmcTiming = (
  state: NesApuState,
  byte: NesByteValue,
  previous: { min: number; max: number },
): void => {
  const timing = state.dmc?.cpu_timing;
  if (timing == null) return;
  const enabled = nesByteBits(byte, 16);
  if (enabled === 0) {
    if (timing.stop.status === "none") {
      const phase =
        state.frame_clocks === "cpu-ordered"
          ? state.frame_sequencer.cpu_phase
          : null;
      timing.stop =
        phase === null
          ? { status: "unknown" }
          : {
              status: "pending",
              cause: "explicit",
              delay: phase === "get" ? 4 : 3,
              origin: { kind: "event-write", index: state.next_event_index },
            };
    }
    return;
  }
  if (enabled === null || (previous.min === 0 && previous.max > 0)) {
    if (enabled === null && timing.stop.status === "none")
      timing.stop = { status: "unknown" };
    timing.request = { status: "unknown" };
    return;
  }
  if (previous.max === 0) {
    const phase =
      state.frame_clocks === "cpu-ordered"
        ? state.frame_sequencer.cpu_phase
        : null;
    timing.request =
      phase === null
        ? { status: "unknown" }
        : { status: "pending", type: "load", delay: phase === "get" ? 4 : 3 };
  }
};

/** Apply the due stop without advancing the CPU edge, phase or output timer. */
export const stopNesDmcReader = (
  state: NesApuState,
): NesDmcStopProof | null => {
  const timing = state.dmc?.cpu_timing;
  if (
    timing == null ||
    timing.stop.status !== "pending" ||
    timing.stop.delay !== 1
  )
    return null;
  const proof = {
    cause: timing.stop.cause,
    origin: timing.stop.origin,
    event_index: state.next_event_index,
  };
  const origin = {
    kind: "event-clock" as const,
    index: state.next_event_index,
  };
  apuSetCounter(state.dmc_remaining, [0], origin);
  state.dmc!.origin = origin;
  timing.stop = { status: "none" };
  timing.request = { status: "none" };
  return proof;
};

/** Stop owns effective reader depletion; bus arbitration consumes its proof. */
const clockNesDmcStop = (state: NesApuState): NesDmcStopProof | null => {
  const timing = state.dmc!.cpu_timing!;
  const stop = timing.stop;
  if (stop.status === "pending") {
    if (stop.delay === 1) return stopNesDmcReader(state);
    stop.delay--;
  } else if (stop.status === "unknown") {
    // Unknown prior stop history may expire on this edge. Do not claim a stop
    // or turn raw 4015 into proof of a cancelled pending disable.
    apuSetCounter(state.dmc_remaining, [0, state.dmc_remaining.value.max], {
      kind: "event-clock",
      index: state.next_event_index,
    });
    if (timing.request.status !== "none")
      timing.request = { status: "unknown" };
  }
  return null;
};

/** Called after the timer and frame phase consume this ordered CPU edge. */
export const clockNesDmcTiming = (
  state: NesApuState,
  mayBoundary: boolean,
): NesDmcStopProof | null => {
  const timing = state.dmc?.cpu_timing;
  if (timing == null) return null;
  const stopped = clockNesDmcStop(state);
  if (stopped !== null) return stopped;
  const request = timing.request;
  if (request.status === "unknown") return null;
  if (request.status === "pending") {
    if (request.delay > 0) {
      request.delay--;
      if (request.delay === 0 && request.type === "load") {
        const ready = nesDmcReadReady(state);
        if (ready === false) timing.request = { status: "none" };
        else if (ready === null) timing.request = { status: "unknown" };
      }
    }
    return null;
  }
  const buffer = state.dmc!.buffer.status;
  if (!mayBoundary || buffer === "full" || state.dmc_remaining.value.max === 0)
    return null;
  const ready = nesDmcReadReady(state);
  if (ready !== true) {
    timing.request = { status: "unknown" };
    return null;
  }
  timing.request = { status: "pending", type: "reload", delay: 0 };
  return null;
};

export const nesDmcStopWindowHazard = (
  state: NesApuState,
  transfer: NesDmcTransferType,
  stopped = false,
): boolean => {
  const dmc = state.dmc!;
  const control = state.registers[0x4010]?.value ?? null;
  const length = state.registers[0x4013]?.value ?? null;
  return (
    // A longer sample ends on a reload get normally. The implicit stop race
    // requires the initial one-byte load; live 4013 may have changed meanwhile.
    transfer === "load" &&
    (stopped ||
      (state.dmc_remaining.value.min <= 1 &&
        state.dmc_remaining.value.max >= 1)) &&
    nesByteBits(control, 64) !== 64 &&
    (length === null ||
      (typeof length === "number" && length === 0) ||
      (typeof length === "object" && length.value === 0)) &&
    (dmc.bits_remaining === null || dmc.bits_remaining === 1) &&
    (dmc.timer_remaining === null || dmc.timer_remaining <= 3)
  );
};
