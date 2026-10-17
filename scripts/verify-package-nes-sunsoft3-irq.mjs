import assert from "node:assert/strict";
const write = (address, value) => ({ kind: "cpu-write", address, value });
const cycle = { kind: "sunsoft3-cpu-cycle" };
const irq = {
  model: "sunsoft3",
  counter_low: 0,
  counter_high: 0,
  enabled: false,
  asserted: false,
  next_write: "high",
};

export async function irqWorkflows({ call, base, snapshots }) {
  const sourceInput = {
    path: base.path,
    initial: { mapper: 67 },
    entry: 0xc380,
    initial_irq: irq,
    max_instructions: 10,
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 7000,
    },
  };
  const source = (await call("trace-nes-code", sourceInput)).code_trace;
  assert.equal(source.status, "derived");
  assert.equal(source.cpu_bus.final.next_cycle_index, 7028);
  assert.deepEqual(source.mapper_trace.final_irq, {
    ...irq,
    counter_low: 255,
    counter_high: 255,
    enabled: false,
    asserted: true,
  });
  assert.equal(source.mapper_trace.final.irq_control, 16);
  const clocked = source.mapper_trace.steps.filter(
    (item) => item.event.kind === "sunsoft3-cpu-cycle",
  );
  assert.equal(clocked.length, 28);
  assert.equal(clocked[24].irq.counter_low, 0);
  assert.equal(clocked[24].irq.asserted, false);
  assert.equal(clocked[25].irq.asserted, true);
  const replay = (
    await call("trace-nes-mapper-events", {
      path: base.path,
      initial: sourceInput.initial,
      initial_irq: irq,
      events: source.mapper_trace.steps.map((item) => item.event),
    })
  ).trace;
  assert.deepEqual(replay, source.mapper_trace);
  const events = [
    write(0xc800, 0),
    write(0xcfff, 1),
    write(0xdfff, 16),
    { kind: "ppu-read", address: 0 },
    { kind: "cpu-read", address: 0x8000 },
    cycle,
    cycle,
    cycle,
    write(0xd800, 16),
    cycle,
    write(0x8000, 99),
  ];
  const input = {
    path: base.path,
    initial: { mapper: 67 },
    initial_irq: irq,
    events,
  };
  const supplied = (await call("trace-nes-mapper-events", input)).trace;
  assert.equal(supplied.steps[4].irq.counter_low, 1);
  assert.deepEqual(supplied.steps[5].irq, {
    ...irq,
    counter_low: 0,
    enabled: true,
  });
  assert.deepEqual(supplied.steps[6].irq, {
    ...irq,
    counter_low: 255,
    counter_high: 255,
    asserted: true,
  });
  assert.equal(supplied.steps[8].irq.asserted, true);
  assert.equal(supplied.steps[9].irq.counter_low, 254);
  assert.equal(supplied.final_irq.asserted, false);
  const prefix = snapshots(supplied)[5];
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: prefix.state,
      initial_irq: prefix.irq,
      events: events.slice(6),
    })
  ).trace;
  assert.deepEqual(continued.final_irq, supplied.final_irq);
  assert.deepEqual(continued.final, supplied.final);
  await unknownWritePhase({ call, base });
  await writePhaseAndAck({ call, base });
}
async function unknownWritePhase({ call, base }) {
  const joined = (
    await call("trace-nes-mapper-events", {
      path: base.path,
      initial: { mapper: 67 },
      initial_irq: {
        ...irq,
        counter_low: 0x12,
        counter_high: 0x34,
        next_write: null,
      },
      events: [
        write(0xc800, 0x56),
        write(0xd800, 0),
        write(0xc800, 0xab),
        write(0xc800, 0xcd),
      ],
    })
  ).trace;
  assert.equal(joined.steps[0].irq.next_write, null);
  assert.deepEqual(joined.steps[0].irq.counter_low, {
    mask: 0xbb,
    value: 0x12,
  });
  assert.deepEqual(joined.steps[0].irq.counter_high, {
    mask: 0x9d,
    value: 0x14,
  });
  assert.equal(joined.steps[1].irq.next_write, "high");
  assert.deepEqual(joined.final_irq, {
    ...irq,
    counter_low: 0xcd,
    counter_high: 0xab,
  });
}
async function writePhaseAndAck({ call, base }) {
  const aliases = [
    0x8000, 0x97ff, 0xa000, 0xb7ff, 0xc000, 0xd7ff, 0xe000, 0xf7ff,
  ];
  const acknowledged = (
    await call("trace-nes-mapper-events", {
      path: base.path,
      initial: { mapper: 67, irq_control: 16, irq_data: 0x77 },
      initial_irq: {
        ...irq,
        counter_low: 0x12,
        counter_high: 0x34,
        asserted: true,
        next_write: "low",
      },
      events: aliases.flatMap((address) => [
        write(0xd800, 0),
        write(0xc800, 0),
        write(0xc800, 0),
        write(0xd800, 16),
        cycle,
        write(0xc800, 0x77),
        write(address, 0x99),
      ]),
    })
  ).trace;
  assert.equal(acknowledged.steps[0].irq.asserted, true);
  for (let index = 0; index < aliases.length; index++) {
    const before = acknowledged.steps[index * 7 + 5].irq;
    const after = acknowledged.steps[index * 7 + 6].irq;
    assert.deepEqual(before, {
      ...irq,
      counter_low: 255,
      counter_high: 0x77,
      asserted: true,
      next_write: "low",
    });
    assert.deepEqual(after, { ...before, asserted: false });
  }
  assert.equal(acknowledged.final.irq_data, 0x77);
  assert.equal(acknowledged.final.irq_control, 16);
  const live = (
    await call("trace-nes-mapper-events", {
      path: base.path,
      initial: { mapper: 67 },
      initial_irq: {
        ...irq,
        counter_low: 0,
        counter_high: 1,
        enabled: true,
        asserted: true,
      },
      events: [write(0xc800, 2), cycle, write(0xc800, 0x80)],
    })
  ).trace;
  assert.deepEqual(live.steps[1].irq, {
    ...irq,
    counter_low: 255,
    counter_high: 1,
    enabled: true,
    asserted: true,
    next_write: "low",
  });
  assert.deepEqual(live.final_irq, {
    ...irq,
    counter_low: 0x80,
    counter_high: 1,
    enabled: true,
    asserted: true,
  });
  assert.equal(live.final.irq_data, 0x80);
}
