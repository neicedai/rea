import { expect, it } from "vitest";
import { nesApuStateSchema, type NesApuState } from "./nesApu.js";
import {
  advanceNesApu,
  admitNesApu,
  initializeNesApu,
} from "./nesApuDerivation.js";
import { nesDmcEventSchema, previewNesDmcDelivery } from "./nesDmc.js";
import { nesDmcTimingPhase } from "./nesDmcTiming.js";
import type { NesMapperEvent } from "./nesMapperEvents.js";

const origin = { kind: "initial-state" } as const;
const initial = (timer = 3) => {
  const state = nesApuStateSchema.parse({
    model: "apu-registers",
    frame_clocks: "cpu-ordered",
    dmc_reads: "explicit",
    next_event_index: 50,
    registers: Object.fromEntries(
      [
        [0x4010, 0x8f],
        [0x4012, 0x10],
        [0x4013, 0],
        [0x4015, 16],
        [0x4017, 64],
      ].map(([address, value]) => [address, { value, origin }]),
    ),
    dmc_remaining: { value: { min: 1, max: 1 }, origin },
    dmc_irq: { value: false, origin },
    frame_sequencer: {
      region: "ntsc",
      cpu_phase: "get",
      position: { min: 0, max: 0 },
      five_step: false,
      reset_delay: { min: 0, max: 0 },
      clock_block: 0,
    },
    dmc: {
      model: "dmc-reader-output",
      region: "ntsc",
      clocks: "cpu-ordered",
      current_address: 0xc800,
      buffer: { status: "empty" },
      shift: 0x91,
      bits_remaining: 1,
      silence: true,
      level: 64,
      timer_remaining: timer,
      cpu_timing: {
        model: "2a03-dmc-dma",
        duplication: "disabled",
        request: { status: "pending", type: "load", delay: 0 },
        stop: { status: "none" },
      },
    },
  });
  if (state.frame_clocks !== "cpu-ordered")
    throw new Error("Expected a CPU-ordered producer fixture");
  return state;
};

const step = (state: NesApuState, event: NesMapperEvent) => {
  const result = advanceNesApu(state, event);
  if (!result.ok) throw new Error(result.error.reason);
  state.next_event_index++;
  return result.value;
};
const deliver = (state: NesApuState, output_boundary: boolean | null) =>
  step(state, {
    kind: "apu-dmc-cpu-read",
    address: state.dmc!.current_address!,
    value: 0xa6,
    cycle_index: 500,
    output_boundary,
  });

it("qualifies the aligned implicit stop from a delivered one-byte load and preserves its read trigger", () => {
  const state = initial(),
    before = structuredClone(state);
  expect(previewNesDmcDelivery(state, "load")).toEqual({
    kind: "implicit-stop",
    output_boundary: false,
  });
  expect(state).toEqual(before);
  step(state, { kind: "apu-cpu-cycle" });
  const delivery = deliver(state, false);
  expect(delivery!.operation.effects).toEqual([
    "dmc-read",
    "dmc-implicit-stop-queued",
  ]);
  expect(state.dmc_irq.value).toBe(true);
  expect(state.dmc_remaining.value).toEqual({ min: 1, max: 1 });
  expect(state.dmc).toMatchObject({
    current_address: 0xc400,
    shift: 0xa6,
    shift_origin: { kind: "dmc-read", index: 51 },
    buffer: {
      status: "full",
      value: 0xa6,
      origin: { kind: "dmc-read", index: 51 },
    },
    silence: true,
    level: 64,
    bits_remaining: 1,
    timer_remaining: 2,
    cpu_timing: {
      request: { status: "none" },
      stop: {
        status: "pending",
        cause: "implicit",
        delay: 3,
        origin: { kind: "dmc-read", index: 51, cycle_index: 500 },
      },
    },
  });
  step(state, { kind: "apu-cpu-cycle" });
  step(state, { kind: "apu-cpu-cycle" });
  expect(state.dmc!.cpu_timing!.request).toEqual({
    status: "pending",
    type: "reload",
    delay: 0,
  });
  expect(state.dmc!.cpu_timing!.stop).toMatchObject({ delay: 1 });
  const output = structuredClone(state.dmc);
  const stopped = step(state, { kind: "apu-dmc-stop" });
  expect(stopped!.dmc_stop).toEqual({
    cause: "implicit",
    event_index: 54,
    origin: { kind: "dmc-read", index: 51, cycle_index: 500 },
  });
  expect(state.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(state.dmc).toMatchObject({
    buffer: output!.buffer,
    shift: output!.shift,
    silence: output!.silence,
    level: output!.level,
    timer_remaining: output!.timer_remaining,
    cpu_timing: { request: { status: "none" }, stop: { status: "none" } },
  });
});

it("uses a proven same-edge boundary for duplication and reads the follow-up afresh", () => {
  const state = initial(1);
  state.dmc!.cpu_timing!.duplication = "enabled";
  state.dmc!.cpu_timing!.stop = {
    status: "pending",
    cause: "explicit",
    delay: 2,
    origin,
  };
  expect(previewNesDmcDelivery(state, "load")).toEqual({
    kind: "duplicate",
    output_boundary: true,
  });
  step(state, { kind: "apu-cpu-cycle" });
  const delivered = deliver(state, true);
  expect(delivered!.operation.effects).toEqual(["dmc-read", "dmc-duplicate"]);
  expect(state.dmc_irq.value).toBe(true);
  expect(state.dmc).toMatchObject({
    current_address: 0xc400,
    shift: 0xa6,
    silence: false,
    level: 64,
    buffer: { status: "empty" },
    cpu_timing: {
      request: {
        status: "pending",
        type: "duplicate",
        delay: 0,
        origin: { kind: "dmc-read", index: 51, cycle_index: 500 },
      },
      stop: { status: "pending", cause: "explicit", delay: 1, origin },
    },
  });
  state.dmc!.cpu_timing!.stop = { status: "none" };
  expect(previewNesDmcDelivery(state, "duplicate").kind).toBe("normal");
  for (let edge = 0; edge < 4; edge++) step(state, { kind: "apu-cpu-cycle" });
  const fresh = step(state, {
    kind: "apu-dmc-cpu-read",
    address: 0xc400,
    value: 0x3c,
    cycle_index: 504,
    output_boundary: false,
  });
  expect(fresh!.operation.effects).toEqual(["dmc-read"]);
  expect(state.dmc!.buffer).toEqual({
    status: "full",
    value: 0x3c,
    origin: { kind: "dmc-read", index: 56 },
  });
  expect(state.dmc!.shift).toBe(0xa6);
  expect(state.dmc_remaining.value).toEqual({ min: 0, max: 0 });
});

it("overrides an older explicit stop only for the implicit delivery branch", () => {
  const state = initial();
  state.dmc!.cpu_timing!.stop = {
    status: "pending",
    cause: "explicit",
    delay: 2,
    origin,
  };
  step(state, { kind: "apu-cpu-cycle" });
  deliver(state, false);
  expect(state.dmc!.cpu_timing!.stop).toEqual({
    status: "pending",
    cause: "implicit",
    delay: 3,
    origin: { kind: "dmc-read", index: 51, cycle_index: 500 },
  });
});

it("retains unknown selector and same-edge history instead of inferring it from matching output numbers", () => {
  const state = initial(1);
  delete (state.dmc!.cpu_timing as { duplication?: unknown }).duplication;
  const parsed = nesApuStateSchema.parse(state);
  expect(parsed.dmc!.cpu_timing!.duplication).toBe("unknown");
  expect(previewNesDmcDelivery(parsed, "load").kind).toBe("unknown");
  parsed.dmc!.cpu_timing!.duplication = "enabled";
  step(parsed, { kind: "apu-cpu-cycle" });
  const before = structuredClone(parsed);
  expect(
    advanceNesApu(
      parsed,
      nesDmcEventSchema.parse({
        kind: "apu-dmc-cpu-read",
        address: 0xc800,
        value: 0xa6,
        cycle_index: 500,
      }),
    ),
  ).toMatchObject({ ok: false });
  expect(parsed).toEqual(before);
  deliver(parsed, false);
  expect(parsed.dmc!.buffer.status).toBe("full");
  expect(parsed.dmc!.cpu_timing!.request).toEqual({ status: "none" });
});

it("schedules a timer-one implicit stop without delaying the following put-boundary reload", () => {
  const state = initial(2);
  expect(previewNesDmcDelivery(state, "load")).toEqual({
    kind: "implicit-stop",
    output_boundary: false,
  });
  expect(previewNesDmcDelivery(state, "reload").kind).toBe("normal");
  step(state, { kind: "apu-cpu-cycle" });
  deliver(state, false);
  expect(state.dmc!.timer_remaining).toBe(1);
  expect(admitNesApu(state)).toEqual({ ok: true, value: null });
  step(state, { kind: "apu-cpu-cycle" });
  expect(state.dmc!.cpu_timing!.request).toEqual({
    status: "pending",
    type: "reload",
    delay: 0,
  });
  expect(state.dmc!.cpu_timing!.stop).toMatchObject({
    status: "pending",
    delay: 2,
  });
  expect(nesDmcTimingPhase(state)).toBe("get");
  expect(admitNesApu(state)).toEqual({ ok: true, value: null });
});

it.each(["get", "put", null] as const)(
  "requests a ready reload immediately after a %s output boundary",
  (phase) => {
    const state = initial(1);
    state.frame_sequencer.cpu_phase = phase;
    state.dmc!.buffer = { status: "full", value: 0xa6, origin };
    state.dmc!.cpu_timing!.request = { status: "none" };
    state.dmc_remaining.value = { min: 2, max: 2 };
    step(state, { kind: "apu-cpu-cycle" });
    expect(state.dmc!.buffer.status).toBe("empty");
    expect(state.dmc!.bits_remaining).toBe(8);
    expect(state.dmc!.cpu_timing!.request).toEqual({
      status: "pending",
      type: "reload",
      delay: 0,
    });
  },
);

it.each(["get", "put", null] as const)(
  "preserves caller reload latency without deriving a phase for %s",
  (phase) => {
    const state = initial();
    state.frame_sequencer.cpu_phase = phase;
    state.dmc!.cpu_timing!.request = {
      status: "pending",
      type: "reload",
      delay: 1,
    };
    expect(nesDmcTimingPhase(state)).toBeNull();
    expect(admitNesApu(state)).toEqual({ ok: true, value: null });
    const resumed = initializeNesApu(state);
    if (resumed.frame_clocks !== "cpu-ordered")
      throw new Error("Expected CPU-ordered framing after initialization");
    expect(resumed.frame_sequencer.cpu_phase).toBe(phase);
    expect(resumed.dmc!.cpu_timing!.request).toMatchObject({ delay: 1 });
    step(resumed, { kind: "apu-cpu-cycle" });
    expect(resumed.dmc!.cpu_timing!.request).toEqual({
      status: "pending",
      type: "reload",
      delay: 0,
    });
  },
);

it.each(["get", null] as const)(
  "rejects an implicit delivery with %s post-phase instead of creating a contradictory stop",
  (phase) => {
    const state = initial(2);
    state.frame_sequencer.cpu_phase = phase;
    const before = structuredClone(state);
    expect(
      advanceNesApu(state, {
        kind: "apu-dmc-cpu-read",
        address: 0xc800,
        value: 0xa6,
        cycle_index: 500,
        output_boundary: false,
      }),
    ).toMatchObject({ ok: false });
    expect(state).toEqual(before);
  },
);

it("does not reinterpret a running two-byte reload as an initial load after live 4013 becomes zero", () => {
  const state = initial();
  state.dmc_remaining.value = { min: 2, max: 2 };
  state.dmc!.cpu_timing!.request = {
    status: "pending",
    type: "reload",
    delay: 0,
  };
  expect(previewNesDmcDelivery(state, "reload")).toEqual({
    kind: "normal",
    output_boundary: false,
  });
  step(state, { kind: "apu-cpu-cycle" });
  expect(deliver(state, false)!.operation.effects).toEqual(["dmc-read"]);
  expect(state.dmc_remaining.value).toEqual({ min: 1, max: 1 });
  expect(state.dmc!.cpu_timing!.stop).toEqual({ status: "none" });
  expect(state.dmc!.current_address).toBe(0xc801);
});

it("rejects contradictory boundary/cause/read origins without mutating qualified output", () => {
  const state = initial(1);
  state.dmc!.cpu_timing!.duplication = "disabled";
  step(state, { kind: "apu-cpu-cycle" });
  state.dmc!.timer_remaining = 53;
  const before = structuredClone(state);
  expect(
    advanceNesApu(state, {
      kind: "apu-dmc-cpu-read",
      address: 0xc800,
      value: 0xa6,
      cycle_index: 500,
      output_boundary: true,
    }),
  ).toMatchObject({ ok: false });
  expect(state).toEqual(before);
  state.dmc!.cpu_timing!.stop = {
    status: "pending",
    cause: "explicit",
    delay: 1,
    origin: { kind: "dmc-read", index: 49, cycle_index: 499 },
  };
  expect(admitNesApu(state)).toMatchObject({ ok: false });
  state.dmc!.cpu_timing!.stop = { status: "none" };
  state.dmc!.cpu_timing!.request = {
    status: "pending",
    type: "duplicate",
    delay: 0,
    origin: {
      kind: "dmc-read",
      index: state.next_event_index,
      cycle_index: 499,
    },
  };
  expect(admitNesApu(state)).toMatchObject({ ok: false });
});

it("rejects a four-edge implicit stop instead of treating it as an explicit disable", () => {
  const state = initial();
  state.dmc!.cpu_timing!.stop = {
    status: "pending",
    cause: "implicit",
    delay: 4,
    origin: { kind: "dmc-read", index: 49, cycle_index: 499 },
  };
  expect(admitNesApu(state)).toEqual({
    ok: false,
    error: {
      kind: "invalid-apu-state",
      reason: "An implicit DMC stop cannot retain more than three CPU edges.",
    },
  });
});
