import type { NesApuState } from "./nesApu.js";
import type { NesDmcTransferType } from "./nesDmcTiming.js";
import {
  nesByteBits,
  nesByteCandidates,
  type NesByteValue,
} from "./nesByteValue.js";
import { apuRegister, apuSetCounter } from "./nesApuUnits.js";

export type NesDmcDeliveryKind =
  | "normal"
  | "implicit-stop"
  | "duplicate"
  | "unknown";

const nearBoundary = (state: NesApuState): boolean => {
  const dmc = state.dmc!;
  return (
    (dmc.bits_remaining === null || dmc.bits_remaining === 1) &&
    (dmc.timer_remaining === null || dmc.timer_remaining <= 2)
  );
};
const mayDuplicate = (
  state: NesApuState,
  boundary: boolean | null,
  periods: readonly number[],
): boolean => {
  const dmc = state.dmc!;
  return (
    dmc.cpu_timing!.duplication !== "disabled" &&
    boundary !== false &&
    (dmc.bits_remaining === null || dmc.bits_remaining === 8) &&
    (dmc.timer_remaining === null || periods.includes(dmc.timer_remaining))
  );
};

type DeliveryProof = {
  output_boundary: boolean | null;
  periods: readonly number[];
  transfer?: NesDmcTransferType;
  post_phase: "get" | "put" | null;
};
const knownImplicitWindow = (
  state: NesApuState,
  phase: DeliveryProof["post_phase"],
): boolean => {
  const dmc = state.dmc!;
  return (
    dmc.bits_remaining === 1 &&
    dmc.timer_remaining !== null &&
    dmc.timer_remaining <= 2 &&
    phase === "put"
  );
};

/** Qualified initial-load history owns these windows; live 4013 cannot create it. */
export const classifyNesDmcDelivery = (
  state: NesApuState,
  proof: DeliveryProof,
): NesDmcDeliveryKind => {
  const dmc = state.dmc!,
    timing = dmc.cpu_timing;
  if (timing === null) return "normal";
  const request = timing.request,
    selected =
      proof.transfer ?? (request.status === "pending" ? request.type : null);
  if (selected === "duplicate" || selected === "reload") return "normal";
  const lengths = nesByteCandidates(apuRegister(state, 0x4013)),
    loop = nesByteBits(apuRegister(state, 0x4010), 64);
  if (!lengths.includes(0) || loop === 64) return "normal";
  const duplicate = mayDuplicate(state, proof.output_boundary, proof.periods);
  if (!nearBoundary(state) && !duplicate) return "normal";
  if (
    selected === null ||
    lengths.length !== 1 ||
    loop !== 0 ||
    state.dmc_remaining.value.min !== 1 ||
    state.dmc_remaining.value.max !== 1
  )
    return "unknown";
  if (duplicate)
    return proof.output_boundary === true && timing.duplication === "enabled"
      ? "duplicate"
      : "unknown";
  // The bus owner determines whether this stop aborts or discards its reload.
  return knownImplicitWindow(state, proof.post_phase)
    ? "implicit-stop"
    : "unknown";
};

/** Matching post-clock numbers alone do not establish a same-edge reset. */
export const contradictsNesDmcBoundary = (
  state: NesApuState,
  boundary: boolean | null,
  periods: readonly number[],
): boolean => {
  if (boundary !== true) return false;
  const dmc = state.dmc!;
  return (
    (dmc.bits_remaining !== null && dmc.bits_remaining !== 8) ||
    (dmc.timer_remaining !== null && !periods.includes(dmc.timer_remaining)) ||
    (state.frame_clocks === "cpu-ordered" &&
      state.frame_sequencer.cpu_phase === "get")
  );
};

/** These branches follow the successful read; IRQ and DAC keep its normal effects. */
export const applyNesDmcDelivery = (
  state: NesApuState,
  value: NesByteValue,
  cycleIndex: number,
  delivery: "implicit-stop" | "duplicate",
): void => {
  const dmc = state.dmc!,
    timing = dmc.cpu_timing!,
    origin = { kind: "dmc-read" as const, index: state.next_event_index },
    trigger = { ...origin, cycle_index: cycleIndex },
    starts = new Set(
      nesByteCandidates(apuRegister(state, 0x4012)).map(
        (address) => 0xc000 + address * 64,
      ),
    );
  dmc.shift = structuredClone(value);
  dmc.shift_origin = origin;
  dmc.current_address =
    starts.size === 1 ? starts.values().next().value! : null;
  apuSetCounter(state.dmc_remaining, [1], origin);
  if (delivery === "implicit-stop")
    timing.stop = {
      status: "pending",
      cause: "implicit",
      delay: 3,
      origin: trigger,
    };
  else {
    dmc.silence = false;
    dmc.buffer = { status: "empty" };
    timing.request = {
      status: "pending",
      type: "duplicate",
      delay: 0,
      origin: trigger,
    };
  }
};
