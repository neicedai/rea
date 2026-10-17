import {
  nesByteCandidates,
  nesByteBits,
  nesByteProof,
  type NesByteValue,
} from "./nesByteValue.js";
import type {
  NesApuCounter,
  NesApuFlag,
  NesApuOrigin,
  NesApuState,
} from "./nesApu.js";

const apuValues = (value: NesApuCounter["value"]): number[] =>
  Array.from(
    { length: value.max - value.min + 1 },
    (_, index) => value.min + index,
  );
export const apuFlags = (value: boolean | null): boolean[] =>
  value === null ? [false, true] : [value];
export const apuJoinFlag = (values: readonly boolean[]): boolean | null =>
  values.every((value) => value === values[0]) ? values[0]! : null;
export const apuRange = (
  values: readonly number[],
): NesApuCounter["value"] => ({
  min: Math.min(...values),
  max: Math.max(...values),
});
export const apuRegister = (
  state: NesApuState,
  address: number,
): NesByteValue => state.registers[address]?.value ?? null;
const apuByteValues = (
  state: NesApuState,
  address: number,
  mask = 255,
): number[] => [
  ...new Set(
    nesByteCandidates(apuRegister(state, address)).map((value) => value & mask),
  ),
];
export const apuHigh = (value: NesByteValue): NesByteValue => {
  const complete = nesByteBits(value, 7);
  if (complete !== null) return complete;
  if (value === null || typeof value === "number") return null;
  return value.mask & 7
    ? { mask: value.mask & 7, value: value.value & 7 }
    : null;
};
export const apuSetCounter = (
  counter: NesApuCounter,
  values: readonly number[],
  origin: NesApuOrigin,
): void => {
  const next = apuRange(values);
  if (
    (origin.kind === "event-clock" || origin.kind === "unobserved-dmc") &&
    next.min === counter.value.min &&
    next.max === counter.value.max
  )
    return;
  counter.value = next;
  counter.origin = origin;
};
export const apuSetFlag = (
  flag: NesApuFlag,
  values: readonly boolean[],
  origin: NesApuOrigin,
): void => {
  const next = apuJoinFlag(values);
  if (
    (origin.kind === "event-clock" || origin.kind === "unobserved-dmc") &&
    next === flag.value
  )
    return;
  flag.value = next;
  flag.origin = origin;
};
export const apuLengthTable = [
  10, 254, 20, 2, 40, 4, 80, 6, 160, 8, 60, 10, 14, 12, 26, 14, 12, 16, 24, 18,
  48, 20, 96, 22, 192, 24, 72, 26, 16, 28, 32, 30,
] as const;

/** Physical units consume qualified edges, independent of waveform/channel output gating. */
export function apuQuarterClock(
  state: NesApuState,
  origin: NesApuOrigin,
): void {
  for (const [index, address] of [0x4000, 0x4004, 0x400c].entries()) {
    const envelope = state.envelopes[index]!,
      dividers: number[] = [],
      decays: number[] = [];
    for (const start of apuFlags(envelope.start.value))
      for (const control of apuByteValues(state, address, 47))
        if (start) {
          dividers.push(control & 15);
          decays.push(15);
        } else
          for (const divider of apuValues(envelope.divider.value)) {
            dividers.push(divider === 0 ? control & 15 : divider - 1);
            for (const decay of apuValues(envelope.decay.value))
              decays.push(
                divider !== 0
                  ? decay
                  : decay !== 0
                    ? decay - 1
                    : control & 32
                      ? 15
                      : 0,
              );
          }
    apuSetCounter(envelope.divider, dividers, origin);
    apuSetCounter(envelope.decay, decays, origin);
    apuSetFlag(envelope.start, [false], origin);
  }
  const linear: number[] = [],
    reload: boolean[] = [];
  for (const flag of apuFlags(state.triangle_reload.value))
    for (const control of apuByteValues(state, 0x4008)) {
      if (flag) linear.push(control & 127);
      else
        for (const value of apuValues(state.triangle_linear.value))
          linear.push(Math.max(0, value - 1));
      reload.push(Boolean(control & 128) && flag);
    }
  apuSetCounter(state.triangle_linear, linear, origin);
  apuSetFlag(state.triangle_reload, reload, origin);
}

export function apuHalfClock(state: NesApuState, origin: NesApuOrigin): void {
  for (const [index, address] of [0x4000, 0x4004, 0x4008, 0x400c].entries()) {
    const values: number[] = [];
    for (const control of apuByteValues(state, address, index === 2 ? 128 : 32))
      for (const count of apuValues(state.lengths[index]!.value))
        values.push(
          control & (index === 2 ? 128 : 32) ? count : Math.max(0, count - 1),
        );
    apuSetCounter(state.lengths[index]!, values, origin);
  }
  for (const index of [0, 1]) clockSweep(state, index, origin);
}

function clockSweep(
  state: NesApuState,
  index: number,
  origin: NesApuOrigin,
): void {
  const sweep = state.sweeps[index]!,
    period = state.pulse_timers[index]!;
  const periods = nesByteCandidates(period.high.value)
    .filter((value) => value < 8)
    .flatMap((high) =>
      nesByteCandidates(period.low.value).map((low) => (high << 8) | low),
    );
  let first: number | null = null,
    common = 2047;
  const dividers: number[] = [];
  for (const control of apuByteValues(state, 0x4001 + index * 4))
    for (const divider of apuValues(sweep.divider.value)) {
      for (const reload of apuFlags(sweep.reload.value))
        dividers.push(
          divider === 0 || reload ? (control >> 4) & 7 : divider - 1,
        );
      if (common !== 0)
        for (const timer of periods) {
          const shift = control & 7,
            change = timer >> shift,
            target = Math.max(
              0,
              timer + (control & 8 ? -change - (index === 0 ? 1 : 0) : change),
            ),
            next =
              divider === 0 &&
              Boolean(control & 128) &&
              shift !== 0 &&
              timer >= 8 &&
              target <= 2047
                ? target
                : timer;
          if (first === null) first = next;
          else common &= ~(first ^ next);
          if (common === 0) break;
        }
    }
  const low = nesByteProof(common & 255, first! & 255),
    high = apuHigh(nesByteProof((common >> 8) & 7, first! >> 8));
  if (JSON.stringify(low) !== JSON.stringify(period.low.value))
    period.low = { value: low, origin };
  if (JSON.stringify(high) !== JSON.stringify(period.high.value))
    period.high = { value: high, origin };
  apuSetCounter(sweep.divider, dividers, origin);
  apuSetFlag(sweep.reload, [false], origin);
}
