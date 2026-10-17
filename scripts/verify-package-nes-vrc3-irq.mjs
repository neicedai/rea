import assert from "node:assert/strict";
import { initial, write } from "./verify-package-nes-vrc3-fixture.mjs";
const cycle = { kind: "vrc3-cpu-cycle" };
const irq = {
  model: "vrc3",
  counter_low: 0,
  counter_high: 0,
  enabled: false,
  asserted: false,
};
const latches = [0xad, 0xef, 0xc3, 0xb2];
const snapshot = (trace, index) => {
  const step = trace.steps[index];
  return "mapper_snapshot" in step
    ? { ...trace.mapper_snapshots[step.mapper_snapshot], ...step }
    : step;
};
export async function vrc3IrqWorkflows({ call, path }) {
  await source({ call, path });
  await supplied({ call, path });
  await modes({ call, path });
  const mismatch = (
    await call("trace-nes-mapper-events", {
      path,
      initial,
      initial_irq: irq,
      events: [{ kind: "vrc-cpu-cycle" }],
    })
  ).trace;
  assert.equal(mismatch.status, "unsupported");
}
async function source({ call, path }) {
  const input = {
    path,
    initial,
    entry: 0xc500,
    initial_irq: irq,
    max_instructions: 15,
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 7000,
    },
  };
  const trace = (await call("trace-nes-code", input)).code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.cpu_bus.final.next_cycle_index, 7042);
  assert.deepEqual(trace.mapper_trace.final_irq, {
    ...irq,
    counter_low: 0xfe,
    counter_high: 0x23,
    enabled: true,
    asserted: true,
  });
  assert.deepEqual(trace.mapper_trace.final.irq_latch_nibbles, latches);
  assert.equal(trace.mapper_trace.final.irq_control, 0xf7);
  const clocked = trace.mapper_trace.steps.filter(
    (item) => item.event.kind === "vrc3-cpu-cycle",
  );
  assert.equal(clocked.length, 42);
  assert.equal(clocked[30].irq.asserted, false);
  assert.equal(clocked[31].irq.asserted, true);
  assert.equal(clocked[31].irq.counter_low, 0xfd);
  assert.equal(clocked[39].irq.asserted, false);
  assert.equal(clocked[39].irq.counter_low, 255);
  const replay = (
    await call("trace-nes-mapper-events", {
      path,
      initial,
      initial_irq: irq,
      events: trace.mapper_trace.steps.map((item) => item.event),
    })
  ).trace;
  assert.deepEqual(replay, trace.mapper_trace);
  assert.deepEqual(
    (await call("explore-nes-code", input)).code_exploration.paths[0].trace,
    trace,
  );
}
async function supplied({ call, path }) {
  const events = [
    write(0xcfff, 7),
    cycle,
    cycle,
    cycle,
    write(0xafff, 9),
    write(0xdfff, 255),
    cycle,
    cycle,
    cycle,
  ];
  const input = {
    path,
    initial: { ...initial, irq_latch_nibbles: latches },
    initial_irq: irq,
    events,
  };
  const trace = (await call("trace-nes-mapper-events", input)).trace;
  assert.deepEqual(trace.steps[0].irq, {
    ...irq,
    counter_low: 0xfd,
    counter_high: 0x23,
    enabled: true,
  });
  assert.equal(trace.steps[2].irq.counter_low, 255);
  assert.equal(trace.steps[2].irq.asserted, false);
  assert.deepEqual(trace.steps[3].irq, {
    ...irq,
    counter_low: 0xfd,
    counter_high: 0x23,
    enabled: true,
    asserted: true,
  });
  assert.equal(trace.steps[4].irq.counter_high, 0x23);
  assert.equal(trace.steps[5].irq.counter_low, 0xfd);
  assert.equal(trace.steps[5].irq.asserted, false);
  assert.deepEqual(trace.final_irq, {
    ...irq,
    counter_low: 0xfd,
    counter_high: 0x23,
    enabled: true,
    asserted: true,
  });
  assert.equal(trace.final.irq_latch_nibbles[2], 9);
  const prefix = snapshot(trace, 5);
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: prefix.state,
      initial_irq: prefix.irq,
      events: events.slice(6),
    })
  ).trace;
  assert.deepEqual(continued.final_irq, trace.final_irq);
  assert.deepEqual(continued.final, trace.final);
}
async function modes({ call, path }) {
  const full = (
    await call("trace-nes-mapper-events", {
      path,
      initial: { ...initial, irq_latch_nibbles: [4, 3, 2, 1], irq_control: 3 },
      initial_irq: {
        ...irq,
        counter_low: 255,
        counter_high: 255,
        enabled: true,
      },
      events: [cycle, cycle, write(0xa000, 9), write(0xc000, 7)],
    })
  ).trace;
  assert.deepEqual(full.steps[0].irq, {
    ...irq,
    counter_low: 0x34,
    counter_high: 0x12,
    enabled: true,
    asserted: true,
  });
  assert.deepEqual(full.steps[1].irq, {
    ...irq,
    counter_low: 0x35,
    counter_high: 0x12,
    enabled: true,
    asserted: true,
  });
  assert.equal(full.steps[2].irq.counter_high, 0x12);
  assert.deepEqual(full.final_irq, {
    ...irq,
    counter_low: 0x34,
    counter_high: 0x19,
    enabled: true,
  });
  const partial = (
    await call("trace-nes-mapper-events", {
      path,
      initial: {
        ...initial,
        irq_latch_nibbles: [13, 15, 3, 2].map((value) => ({ mask: 15, value })),
      },
      initial_irq: irq,
      events: [write(0xc000, 7)],
    })
  ).trace;
  assert.deepEqual(partial.final_irq, {
    ...irq,
    counter_low: 0xfd,
    counter_high: 0x23,
    enabled: true,
  });
  assert.deepEqual(
    partial.final.irq_latch_nibbles,
    [13, 15, 3, 2].map((value) => ({ mask: 15, value })),
  );
  const unknown = (
    await call("trace-nes-mapper-events", {
      path,
      initial: {
        ...initial,
        irq_control: { mask: 3, value: 3 },
        irq_latch_nibbles: [12, 15, 2, 1],
      },
      initial_irq: { ...irq, counter_low: 255, counter_high: 0, enabled: true },
      events: [cycle],
    })
  ).trace;
  assert.deepEqual(unknown.final_irq, {
    ...irq,
    counter_low: { mask: 3, value: 0 },
    counter_high: { mask: 254, value: 0 },
    enabled: true,
    asserted: null,
  });
  await acknowledge({ call, path });
}
async function acknowledge({ call, path }) {
  const ack = (
    await call("trace-nes-mapper-events", {
      path,
      initial: { ...initial, irq_control: 5, irq_latch_nibbles: latches },
      initial_irq: {
        ...irq,
        counter_low: 254,
        counter_high: 0x12,
        asserted: true,
      },
      events: [write(0xd000, 99), cycle, cycle],
    })
  ).trace;
  assert.equal(ack.final.irq_control, 5);
  assert.deepEqual(ack.steps[0].irq, {
    ...irq,
    counter_low: 254,
    counter_high: 0x12,
    enabled: true,
  });
  assert.deepEqual(ack.final_irq, {
    ...irq,
    counter_low: 0xfd,
    counter_high: 0x12,
    enabled: true,
    asserted: true,
  });
}
