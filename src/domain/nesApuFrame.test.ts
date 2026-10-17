import { expect, it } from "vitest";
import {
  nesApuFrameSchema,
  clockNesApuFrame,
  queueNesApuFrameReset,
} from "./nesApuFrame.js";
import { nesApuStateSchema } from "./nesApu.js";
import {
  advanceNesApu,
  initializeNesApu,
  admitNesApu,
} from "./nesApuDerivation.js";

const phase = (extra: Record<string, unknown> = {}) =>
  nesApuFrameSchema.parse({
    region: "ntsc",
    position: { min: 0, max: 0 },
    five_step: false,
    cpu_phase: "get",
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
    ...extra,
  });
it("matches independent NTSC/PAL four/five-step tables over two complete sequences", () => {
  for (const region of ["ntsc", "pal"] as const)
    for (const five of [false, true]) {
      const quarters =
          region === "ntsc"
            ? [7457, 14913, 22371, five ? 37281 : 29829]
            : [8313, 16627, 24939, five ? 41565 : 33253],
        halves = [quarters[1], quarters[3]],
        end = quarters[3]! + 1,
        state = phase({ region, five_step: five });
      for (let cycle = 1; cycle <= end * 2; cycle++) {
        const relative = ((cycle - 1) % end) + 1,
          signals = clockNesApuFrame(
            state,
            { fiveStep: five, inhibit: false },
            cycle - 1,
          );
        expect(signals).toEqual({
          quarter: quarters.includes(relative),
          half: halves.includes(relative),
          irq: !five && relative >= end - 2,
          reset: false,
        });
        expect(state.position).toEqual({ min: cycle % end, max: cycle % end });
      }
    }
});

it("keeps three/four-cycle delayed writes and unknown parity separate from immediate inhibition", () => {
  for (const cpuPhase of ["get", "put", null] as const) {
    const state = phase({
      position: { min: 100, max: 100 },
      cpu_phase: cpuPhase,
    });
    queueNesApuFrameReset(state, 10);
    expect(state.reset_delay).toEqual({
      min: cpuPhase === "put" ? 4 : 3,
      max: cpuPhase === "get" ? 3 : 4,
    });
    const outputs = Array.from({ length: 4 }, (_, index) =>
      clockNesApuFrame(state, { fiveStep: true, inhibit: true }, 11 + index),
    );
    expect(outputs[0]!.reset).toBe(false);
    expect(outputs[1]!.reset).toBe(false);
    expect(outputs[2]!.reset).toBe(
      cpuPhase === null ? null : cpuPhase === "get",
    );
    expect(outputs[3]!.reset).toBe(
      cpuPhase === null ? null : cpuPhase === "put",
    );
    expect(state.five_step).toBe(true);
    expect(state.reset_delay).toEqual({ min: 0, max: 0 });
    if (cpuPhase !== null)
      expect(state.position).toEqual(
        cpuPhase === "get" ? { min: 1, max: 1 } : { min: 0, max: 0 },
      );
    else {
      expect(state.position!.min).toBe(0);
      expect(state.position!.max).toBeGreaterThanOrEqual(1);
    }
    expect(outputs.every((output) => output.irq === false)).toBe(true);
  }
});

it("blocks adjacent reset clocks and applies a scheduled quarter before a coincident mode-5 reset", () => {
  const state = phase({
    position: { min: 7456, max: 7456 },
    reset_delay: { min: 1, max: 1 },
  });
  expect(
    clockNesApuFrame(state, { fiveStep: true, inhibit: false }, 0),
  ).toEqual({ quarter: true, half: false, irq: false, reset: true });
  expect(state.clock_block).toBe(1);
  state.reset_delay = { min: 1, max: 1 };
  expect(
    clockNesApuFrame(state, { fiveStep: true, inhibit: false }, 1),
  ).toEqual({ quarter: false, half: false, irq: false, reset: true });
  expect(state.clock_block).toBe(0);
  const ambiguous = phase({
    five_step: true,
    position: { min: 35000, max: 35000 },
    reset_delay: { min: 0, max: 1 },
  });
  expect(
    clockNesApuFrame(ambiguous, { fiveStep: false, inhibit: false }, 0),
  ).toEqual({ quarter: false, half: false, irq: false, reset: true });
  expect(ambiguous.position).toEqual({ min: 0, max: 0 });
  expect(ambiguous.five_step).toBe(false);
  expect(
    nesApuFrameSchema.safeParse({
      ...state,
      region: "ntsc",
      position: { min: 40000, max: 40000 },
    }).success,
  ).toBe(false);
});

it("propagates unknown scheduled clocks without inventing counter or IRQ outcomes", () => {
  const origin = { kind: "initial-state" },
    zero = { value: { min: 0, max: 0 }, origin },
    state = initializeNesApu(
      nesApuStateSchema.parse({
        model: "apu-registers",
        frame_clocks: "cpu-ordered",
        frame_sequencer: {
          region: "ntsc",
          five_step: false,
          position: null,
          reset_delay: { min: 0, max: 0 },
          clock_block: 0,
        },
        dmc_reads: "absent",
        dmc_remaining: zero,
        frame_irq: { value: false, origin },
        dmc_irq: { value: false, origin },
        lengths: [{ value: { min: 1, max: 1 }, origin }, zero, zero, zero],
        registers: { 16384: { value: 0, origin }, 16407: { value: 0, origin } },
      }),
    );
  const advanced = advanceNesApu(state, { kind: "apu-cpu-cycle" });
  if (!advanced.ok) throw new Error(advanced.error.reason);
  expect(advanced.value!.operation.frame_clock).toEqual({
    quarter: null,
    half: null,
    irq: null,
    reset: false,
  });
  expect(state.lengths[0]!.value).toEqual({ min: 0, max: 1 });
  expect(state.frame_irq.value).toBeNull();
  state.next_event_index++;
  const read = advanceNesApu(state, { kind: "cpu-read", address: 0x4015 });
  if (!read.ok) throw new Error(read.error.reason);
  expect(read.value!.read).toMatchObject({
    known_bits: { mask: 158, value: 0 },
  });
  expect(state.frame_irq.value).toBe(false);
  state.next_event_index++;
  expect(
    advanceNesApu(state, { kind: "apu-frame-clock", clock: "quarter" }).ok,
  ).toBe(false);
  if (state.frame_clocks !== "cpu-ordered")
    throw new Error("Missing sequencer");
  state.frame_sequencer.origin = {
    kind: "cpu-cycle",
    index: state.next_event_index,
  };
  expect(admitNesApu(state)).toMatchObject({
    ok: false,
    error: { reason: expect.stringContaining("sequencer origin") },
  });
  state.frame_sequencer.origin = { kind: "initial-phase" };
  state.frame_sequencer.five_step = true;
  expect(admitNesApu(state)).toMatchObject({
    ok: false,
    error: { reason: expect.stringContaining("active mode/phase") },
  });
});
