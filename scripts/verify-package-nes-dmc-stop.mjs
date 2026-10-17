import assert from "node:assert/strict";
import {
  apu,
  assertTransfer,
} from "./verify-package-nes-dmc-source-fixture.mjs";

const origin = { kind: "initial-state" };
function stopState(phase, timer) {
  const state = apu(phase);
  state.registers[16405].value = 16;
  state.registers[16403].value = 1;
  state.dmc_remaining.value = { min: 3, max: 3 };
  state.lengths = Array.from({ length: 4 }, () => ({
    value: { min: 0, max: 0 },
    origin,
  }));
  Object.assign(state.dmc, {
    buffer: { status: "full", value: 0x3b, origin },
    shift: 0x54,
    bits_remaining: 1,
    silence: false,
    timer_remaining: timer,
  });
  return state;
}
function stopped(trace, outcome) {
  assert.equal(trace.status, "derived");
  const [episode] = trace.cpu_bus.dmc.transfers;
  assert.equal(trace.cpu_bus.dmc.transfers.length, 1);
  assert.equal(episode.outcome, outcome);
  assert.equal(episode.cause, "explicit-stop");
  assert.equal("sample_cycle_index" in episode, false);
  assert.equal("mapper_event_index" in episode, false);
  assert.ok(
    trace.mapper_trace.apu_trace.operations.some(
      (operation) =>
        operation.kind === "apu-dmc-stop" &&
        operation.event_index === episode.stop_event_index,
    ),
  );
  assert.equal(
    trace.mapper_trace.steps.some(
      (step) => step.event.kind === "apu-dmc-cpu-read",
    ),
    false,
  );
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc_remaining.value, {
    min: 0,
    max: 0,
  });
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc.buffer, {
    status: "empty",
  });
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.current_address, 0xc9c0);
  return episode;
}
function cycles(trace) {
  return [
    ...trace.instructions.flatMap((instruction) => instruction.cpu_bus_cycles),
    ...trace.cpu_bus.dmc.boundary_cycles,
  ];
}

/** Hand-authored adjacent-edge oracles; never imports domain/emulator producers. */
export async function verifyDmcSourceStop(workflow) {
  await adjacentStops(workflow);
  await stoppedStatusProof(workflow);
  await rmwStop(workflow);
  await sameEdgeEnable(workflow);
}
async function adjacentStops({ base, source, replay }) {
  const selected = { ...base, entry: 0xc600, cpu: { a: 0 } };
  for (const [phase, timer] of [
    ["put", 8],
    ["get", 7],
  ]) {
    const input = { ...selected, initial_apu: stopState(phase, timer) };
    const trace = await source(input);
    assert.equal(trace.cpu_bus.final.next_cycle_index, 7010);
    assert.deepEqual(trace.cpu_bus.dmc.transfers, []);
    assert.equal(trace.cpu_bus.dmc.retained_source_bytes, 0);
    assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc_remaining.value, {
      min: 0,
      max: 0,
    });
    assert.equal(trace.mapper_trace.apu_trace.final.dmc.shift, 0x3b);
    assert.equal(trace.mapper_trace.apu_trace.final.dmc.level, 62);
    await replay(input, trace);
  }
  for (const [phase, timer, halt, instruction] of [
    ["put", 6, 7006, 2],
    ["get", 5, 7005, 1],
  ]) {
    const input = { ...selected, initial_apu: stopState(phase, timer) };
    const trace = await source(input);
    const episode = stopped(trace, "aborted");
    assert.equal(trace.cpu_bus.final.next_cycle_index, 7011);
    assert.equal(episode.before_instruction_index, instruction);
    assert.equal(episode.first_cycle_index, halt);
    assert.deepEqual(episode.stop_origin, { kind: "event-write", index: 3 });
    assert.deepEqual(episode.setup, [
      { cycle_index: halt, phase: "halt", shared_with_oam: false },
    ]);
    assert.ok(trace.cpu_bus.dmc.retained_source_bytes > 0);
    await replay(input, trace);
  }
  for (const [phase, timer, get, setup, next] of [
    ["put", 4, 7007, ["halt", "dummy", "alignment"], 7010],
    ["get", 3, 7006, ["halt", "dummy"], 7009],
  ]) {
    const input = {
      ...selected,
      initial_apu: stopState(phase, timer),
      max_instructions: 2,
    };
    const trace = await source(input);
    const episode = stopped(trace, "discarded");
    assert.equal(trace.cpu_bus.final.next_cycle_index, next);
    assert.equal(episode.first_cycle_index, 7004);
    assert.equal(episode.get_cycle_index, get);
    assert.deepEqual(episode.stop_origin, { kind: "event-write", index: 3 });
    assert.deepEqual(
      episode.setup.map((item) => item.phase),
      setup,
    );
    const raw = cycles(trace).find((cycle) => cycle.index === get);
    assert.equal(raw.role, "dmc-get");
    assert.equal(raw.read.address, 0xc9c0);
    assert.equal(raw.read.value, 0x5d);
    assert.equal(raw.read.file_offset, 16 + 0x49c0);
    assert.equal(trace.mapper_trace.apu_trace.final.dmc_irq.value, false);
    await replay(input, trace);
  }
  const budget = await source({
    ...selected,
    initial_apu: stopState("put", 4),
    max_instructions: 2,
    max_dmc_dma_source_bytes: 0,
  });
  assert.equal(budget.stop.reason, "dmc-dma-source-budget");
  assert.equal(budget.instructions.length, 1);
  assert.equal(budget.cpu_bus.final.next_cycle_index, 7004);
  assert.deepEqual(budget.cpu_bus.dmc.transfers, []);
  assert.equal(budget.cpu_bus.dmc.retained_source_bytes, 0);
  assert.deepEqual(budget.mapper_trace.apu_trace.final.dmc_remaining.value, {
    min: 3,
    max: 3,
  });
  assert.deepEqual(budget.mapper_trace.apu_trace.final.dmc.cpu_timing.stop, {
    status: "pending",
    cause: "explicit",
    delay: 3,
    origin: { kind: "event-write", index: 3 },
  });
}
async function stoppedStatusProof({ base, source, replay }) {
  const state = stopState("put", 428);
  state.frame_irq.value = true;
  state.registers[16407].value = 0;
  state.dmc.buffer = { status: "empty" };
  state.dmc.cpu_timing.request = {
    status: "pending",
    type: "reload",
    delay: 0,
  };
  state.dmc.cpu_timing.stop = { status: "pending", delay: 1, origin };
  const input = {
    ...base,
    entry: 0x4015,
    initial_apu: state,
    max_instructions: 1,
    initial_cpu_io: {
      model: "2a03-io",
      controller_clocking: "contiguous",
      active_controller: 0,
      cpu_latch: 32,
      external_latch: 0,
    },
  };
  const trace = await source(input);
  const episode = stopped(trace, "aborted");
  assert.deepEqual(episode.stop_origin, origin);
  assert.equal(episode.stop_event_index, 0);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 7001);
  const halted = trace.cpu_bus.dmc.boundary_cycles[0];
  assert.equal(halted.role, "dmc-halt");
  assert.equal(halted.read.address, 0x4015);
  assert.equal(halted.read.value, 0x60);
  assert.equal(halted.read.file_offset, null);
  assert.equal(trace.mapper_trace.apu_trace.final.frame_irq.value, false);
  const bytes = Buffer.byteLength(JSON.stringify(halted.read), "utf8");
  assert.equal(trace.cpu_bus.dmc.retained_source_bytes, bytes);
  await replay(input, trace);
  assert.deepEqual(
    await source({ ...input, max_dmc_dma_source_bytes: bytes }),
    trace,
  );
  const short = await source({ ...input, max_dmc_dma_source_bytes: bytes - 1 });
  assert.equal(short.stop.reason, "dmc-dma-source-budget");
  assert.equal(short.cpu_bus.final.next_cycle_index, 7000);
  assert.equal(short.cpu_bus.dmc.retained_source_bytes, 0);
  assert.deepEqual(short.cpu_bus.dmc.transfers, []);
  assert.equal(short.mapper_trace.apu_trace.final.frame_irq.value, true);
  assert.deepEqual(short.mapper_trace.apu_trace.final.dmc_remaining.value, {
    min: 3,
    max: 3,
  });
}
async function rmwStop({ base, source, replay }) {
  for (const [phase, stopDelay, loadDelay] of [
    ["get", 2, 2],
    ["put", 1, 3],
  ]) {
    const state = stopState(phase, 428);
    state.registers[16405].value = 8;
    state.lengths[3].value = { min: 2, max: 2 };
    state.dmc_remaining.value = { min: 0, max: 0 };
    state.dmc.buffer = { status: "empty" };
    state.dmc.bits_remaining = 8;
    const input = {
      ...base,
      entry: 0xc640,
      initial_apu: state,
      max_instructions: 2,
      initial_cpu_io: {
        model: "2a03-io",
        controller_clocking: "contiguous",
        active_controller: 0,
        cpu_latch: 0,
        external_latch: 0,
      },
    };
    const prefix = await source({ ...input, max_instructions: 1 });
    assert.equal(prefix.instructions[0].data_reads[0].value, 8);
    assert.deepEqual(
      prefix.instructions[0].writes.map((write) => write.value),
      [8, 16],
    );
    assert.deepEqual(prefix.mapper_trace.apu_trace.final.dmc.cpu_timing, {
      model: "2a03-dmc-dma",
      duplication: "unknown",
      request: { status: "pending", type: "load", delay: loadDelay },
      stop: {
        status: "pending",
        cause: "explicit",
        delay: stopDelay,
        origin: { kind: "event-write", index: 5 },
      },
    });
    const full = await source(input);
    assert.equal(full.cpu_bus.final.next_cycle_index, 7008);
    assert.deepEqual(full.cpu_bus.dmc.transfers, []);
    assert.equal(full.mapper_trace.apu_trace.final.registers[16405].value, 16);
    assert.deepEqual(full.mapper_trace.apu_trace.final.dmc_remaining.value, {
      min: 0,
      max: 0,
    });
    const continuation = await source({
      ...input,
      entry: prefix.stop.address,
      cpu: prefix.final_cpu,
      initial: prefix.mapper_trace.final,
      initial_cpu_bus: prefix.cpu_bus.final,
      initial_cpu_io: prefix.cpu_bus.io.final,
      initial_apu: prefix.mapper_trace.apu_trace.final,
      max_instructions: 1,
    });
    assert.deepEqual(continuation.cpu_bus.final, full.cpu_bus.final);
    assert.deepEqual(
      continuation.mapper_trace.apu_trace.final,
      full.mapper_trace.apu_trace.final,
    );
    await replay(input, full);
  }
}
async function sameEdgeEnable({ base, source, replay }) {
  const state = stopState("get", 428);
  state.registers[16405].value = 0;
  Object.assign(state.dmc, { buffer: { status: "empty" }, bits_remaining: 8 });
  state.dmc.cpu_timing.request = { status: "pending", type: "load", delay: 4 };
  state.dmc.cpu_timing.stop = { status: "pending", delay: 4, origin };
  const input = {
    ...base,
    entry: 0xc600,
    cpu: { a: 16 },
    initial_apu: state,
    max_instructions: 3,
  };
  const trace = await source(input);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 7011);
  assert.equal(trace.cpu_bus.dmc.transfers[0].outcome, "sample");
  assertTransfer(trace, { type: "load", first: 7006, sample: 7008 });
  assert.equal(trace.cpu_bus.dmc.transfers[0].mapper_event_index, 11);
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc_remaining.value, {
    min: 16,
    max: 16,
  });
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc.cpu_timing.stop, {
    status: "none",
  });
  await replay(input, trace);
}
