import { expect, it } from "vitest";
import { nesApuStateSchema, type NesApuState } from "./nesApu.js";
import {
  admitNesApu,
  initializeNesApu,
  advanceNesApu,
} from "./nesApuDerivation.js";
import { apuHalfClock, apuQuarterClock } from "./nesApuUnits.js";
import type { NesMapperEvent } from "./nesMapperEvents.js";
import type { NesByteValue } from "./nesByteValue.js";
import { parseNesHeader } from "./nes.js";
import { nesPpuFixture } from "./nesPpu.fixture.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { nesCodeTraceSchema, traceNesCodeInputSchema } from "./nesCodeTrace.js";

const origin = { kind: "initial-state" as const };
const exact = (value: number) => ({
  value: { min: value, max: value },
  origin,
});
const period = (value: number) => ({
  low: { value: value & 255, origin },
  high: { value: value >> 8, origin },
});
const flag = (value: boolean | null) => ({ value, origin });
const initial = () =>
  nesApuStateSchema.parse({
    model: "apu-registers",
    frame_clocks: "explicit",
    dmc_reads: "absent",
    registers: Object.fromEntries(
      [
        0x4000, 0x4001, 0x4004, 0x4005, 0x4008, 0x400c, 0x4010, 0x4015, 0x4017,
      ].map((address) => [address, { value: 0, origin }]),
    ),
    lengths: [exact(0), exact(0), exact(0), exact(0)],
    envelopes: Array.from({ length: 3 }, () => ({
      start: flag(false),
      divider: exact(0),
      decay: exact(0),
    })),
    pulse_timers: [period(0), period(0)],
    sweeps: [0, 1].map(() => ({ reload: flag(false), divider: exact(0) })),
    triangle_linear: exact(0),
    triangle_reload: flag(false),
    dmc_remaining: exact(0),
    frame_irq: flag(false),
    dmc_irq: flag(false),
    frame_reset_pending: flag(false),
  });
const step = (state: NesApuState, event: NesMapperEvent) => {
  const result = advanceNesApu(state, event);
  if (!result.ok) throw new Error(result.error.reason);
  state.next_event_index++;
  return result.value;
};
const write = (state: NesApuState, address: number, value: number) =>
  step(state, {
    kind: "cpu-write",
    address,
    value,
    preceded_by_cpu_write: null,
  });

it("matches independent envelope and linear-counter transitions, including partial correlations", () => {
  const state = initial();
  for (const loop of [false, true])
    for (const start of [false, true])
      for (let volume = 0; volume < 16; volume++)
        for (let divider = 0; divider < 16; divider++)
          for (let decay = 0; decay < 16; decay++) {
            state.registers[0x4000] = {
              value: volume + (loop ? 32 : 0),
              origin,
            };
            state.envelopes[0] = {
              start: flag(start),
              divider: exact(divider),
              decay: exact(decay),
            };
            apuQuarterClock(state, origin);
            const underflow = divider === 0;
            expect(state.envelopes[0]!.divider.value).toEqual({
              min: start || underflow ? volume : divider - 1,
              max: start || underflow ? volume : divider - 1,
            });
            const wanted = start
              ? 15
              : !underflow
                ? decay
                : decay > 0
                  ? decay - 1
                  : loop
                    ? 15
                    : 0;
            expect(state.envelopes[0]!.decay.value).toEqual({
              min: wanted,
              max: wanted,
            });
          }
  state.registers[0x4008] = { value: { mask: 127, value: 5 }, origin };
  state.triangle_linear = exact(3);
  state.triangle_reload = flag(true);
  apuQuarterClock(state, origin);
  expect(state.triangle_linear.value).toEqual({ min: 5, max: 5 });
  expect(state.triangle_reload.value).toBeNull();
  state.registers[0x4008] = { value: 5, origin };
  apuQuarterClock(state, origin);
  expect(state.triangle_linear.value).toEqual({ min: 4, max: 5 });
  expect(state.triangle_reload.value).toBe(false);
});

it("checks every pulse timer and nonzero sweep shift against an independent signed-period oracle", () => {
  const state = initial();
  for (let shift = 1; shift < 8; shift++)
    for (const subtract of [false, true])
      for (let timer = 0; timer < 2048; timer++) {
        for (const index of [0, 1]) {
          state.pulse_timers[index] = period(timer);
          state.sweeps[index] = { reload: flag(true), divider: exact(0) };
          state.registers[0x4001 + index * 4] = {
            value: 128 + (subtract ? 8 : 0) + shift,
            origin,
          };
        }
        apuHalfClock(state, origin);
        for (const index of [0, 1]) {
          const delta = Math.floor(timer / 2 ** shift),
            target = Math.max(
              0,
              timer + (subtract ? -delta - (index === 0 ? 1 : 0) : delta),
            ),
            wanted = timer < 8 || target > 2047 ? timer : target;
          expect(state.pulse_timers[index]).toMatchObject(period(wanted));
          expect(state.sweeps[index]!.reload.value).toBe(false);
        }
      }
  state.pulse_timers[0] = period(1500);
  state.sweeps[0] = { reload: flag(true), divider: exact(3) };
  state.registers[0x4001] = { value: 129, origin };
  apuHalfClock(state, origin);
  expect(state.pulse_timers[0]).toMatchObject(period(1500));
});

it("keeps delayed reset, IRQ pre-read facts and DMC depletion separate from CPU writes", () => {
  const state = initial();
  write(state, 0x4015, 15);
  write(state, 0x4003, 24); // Length index 3 => two half clocks.
  write(state, 0x4017, 128);
  expect(state.lengths[0]!.value).toEqual({ min: 2, max: 2 });
  expect(state.envelopes[0]!.start.value).toBe(true);
  step(state, { kind: "apu-frame-reset" });
  expect(state.lengths[0]!.value).toEqual({ min: 1, max: 1 });
  expect(state.envelopes[0]!.decay.value).toEqual({ min: 15, max: 15 });
  expect(advanceNesApu(state, { kind: "apu-frame-reset" }).ok).toBe(false);
  write(state, 0x4017, 0);
  step(state, { kind: "apu-frame-clock", clock: "irq" });
  const read = step(state, { kind: "cpu-read", address: 0x4015 })!.read!;
  expect(read).toMatchObject({
    known_bits: { mask: 223, value: 65 },
    source: {
      frame_irq: { value: true },
      lengths: [{ value: { min: 1, max: 1 } }, {}, {}, {}],
    },
  });
  expect(state.frame_irq.value).toBe(false);
  write(state, 0x4013, 0);
  write(state, 0x4010, 128);
  write(state, 0x4015, 16);
  expect(state.dmc_remaining.value).toEqual({ min: 1, max: 1 });
  expect(state.dmc_reads).toBe("unobserved");
  const uncertain = step(state, { kind: "cpu-read", address: 0x4015 })!.read!;
  expect(state.dmc_remaining.value).toEqual({ min: 0, max: 1 });
  expect(uncertain).toMatchObject({ known_bits: { mask: 79, value: 0 } });
  write(state, 0x4015, 0);
  expect(state.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(state.dmc_irq.value).toBe(false);
});

it("rejects contradictory/history-losing snapshots and retains caller input", () => {
  const state = initial(),
    saved = structuredClone(state);
  state.lengths[0] = exact(3);
  expect(admitNesApu(state).ok).toBe(false);
  state.lengths[0] = exact(0);
  state.frame_irq.origin = { kind: "status-read", index: 0 };
  expect(admitNesApu(state).ok).toBe(false);
  expect(
    nesApuStateSchema.safeParse({
      ...state,
      triangle_linear: { value: { min: 5, max: 2 }, origin },
    }).success,
  ).toBe(false);
  expect(initializeNesApu(saved)).toEqual(saved);
  expect(saved).toEqual(initial());
});

it("retains partial pulse timer/sweep proofs across every compatible physical completion", () => {
  const expand = (value: NesByteValue, max: number) =>
    Array.from({ length: max + 1 }, (_, candidate) => candidate).filter(
      (candidate) =>
        value === null ||
        (typeof value === "number"
          ? candidate === value
          : (candidate & value.mask) === value.value),
    );
  const proof = (values: number[], max: number): NesByteValue => {
    const first = values[0]!;
    let mask = max;
    for (const value of values) mask &= ~(value ^ first);
    return mask === max
      ? first
      : mask === 0
        ? null
        : { mask, value: first & mask };
  };
  const cases: {
    low: NesByteValue;
    high: NesByteValue;
    control: NesByteValue;
    divider: { min: number; max: number };
  }[] = [
    {
      low: { mask: 254, value: 34 },
      high: 0,
      control: 137,
      divider: { min: 0, max: 0 },
    },
    {
      low: 255,
      high: { mask: 6, value: 2 },
      control: { mask: 127, value: 9 },
      divider: { min: 0, max: 0 },
    },
    {
      low: null,
      high: 0,
      control: { mask: 248, value: 136 },
      divider: { min: 0, max: 1 },
    },
    {
      low: { mask: 15, value: 3 },
      high: { mask: 5, value: 1 },
      control: 129,
      divider: { min: 0, max: 0 },
    },
  ];
  for (const sample of cases) {
    const state = initial();
    for (const index of [0, 1]) {
      state.pulse_timers[index] = {
        low: { value: sample.low, origin },
        high: { value: sample.high, origin },
      };
      state.sweeps[index] = {
        reload: flag(true),
        divider: { value: sample.divider, origin },
      };
      state.registers[0x4001 + index * 4] = { value: sample.control, origin };
    }
    apuHalfClock(state, origin);
    for (const index of [0, 1]) {
      const outputs: number[] = [];
      for (const low of expand(sample.low, 255))
        for (const high of expand(sample.high, 7))
          for (const control of expand(sample.control, 255))
            for (
              let divider = sample.divider.min;
              divider <= sample.divider.max;
              divider++
            ) {
              const timer = low + high * 256,
                shift = control & 7,
                change = Math.floor(timer / 2 ** shift),
                target = Math.max(
                  0,
                  timer +
                    (control & 8 ? -change - (index === 0 ? 1 : 0) : change),
                );
              outputs.push(
                divider === 0 &&
                  control >= 128 &&
                  shift > 0 &&
                  timer >= 8 &&
                  target <= 2047
                  ? target
                  : timer,
              );
            }
      expect(state.pulse_timers[index]).toMatchObject({
        low: {
          value: proof(
            outputs.map((value) => value & 255),
            255,
          ),
        },
        high: {
          value: proof(
            outputs.map((value) => value >> 8),
            7,
          ),
        },
      });
    }
  }
});

it("keeps possible DMC-repeated status acknowledgements and looping finish IRQs distinct", () => {
  for (const loop of [false, true]) {
    const state = initial();
    state.registers[0x4010] = { value: loop ? 192 : 128, origin };
    state.registers[0x4015] = { value: 16, origin };
    state.dmc_remaining = exact(1);
    state.frame_irq = flag(true);
    state.dmc_reads = "unobserved";
    const read = step(state, { kind: "cpu-read", address: 0x4015 })!.read!;
    expect(read.source.frame_irq.value).toBeNull();
    expect(read.source.frame_irq.origin).toEqual({
      kind: "unobserved-dmc",
      index: 0,
    });
    expect(read.source.dmc_irq.value).toBe(loop ? false : null);
    expect(read).toMatchObject({
      known_bits: { mask: loop ? 159 : 15, value: loop ? 16 : 0 },
    });
    expect(state.frame_irq.value).toBe(false);
  }
});

it("retains uncommitted indirect-jump read/acknowledgement effects only in the source frontier", async () => {
  const fixture = nesPpuFixture([108, 21, 64]),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const apu = initial();
  apu.frame_irq = flag(true);
  const input = traceNesCodeInputSchema.parse({
    path: "/apu.nes",
    initial: { mapper: 0 },
    initial_apu: {
      ...apu,
      registers: { ...apu.registers, [0x4017]: { value: 0, origin } },
    },
  });
  const result = nesCodeTraceSchema.parse(
    await deriveNesCode(
      header.value,
      fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
      input,
    ),
  );
  if (
    result.status !== "derived" ||
    result.mapper_trace.status !== "derived" ||
    !("apu_trace" in result.mapper_trace)
  )
    throw new Error(JSON.stringify(result));
  expect(result.stop.reason).toBe("unknown-control-target");
  expect(result.mapper_trace.apu_trace.final.frame_irq.value).toBe(true);
  expect(result.mapper_trace.apu_trace.operations).toEqual([]);
  expect(result.mapper_trace.apu_trace.frontier).toMatchObject([
    { effects: ["status-read"] },
  ]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    deriveNesCode(
      header.value,
      fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
      input,
      { signal: controller.signal },
    ),
  ).rejects.toBeDefined();
  expect(input.initial_apu!.frame_irq.value).toBe(true);
});
