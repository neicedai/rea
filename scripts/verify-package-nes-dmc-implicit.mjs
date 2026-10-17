import assert from "node:assert/strict";
import { apu } from "./verify-package-nes-dmc-source-fixture.mjs";

const origin = { kind: "initial-state" };
function state(timer = 12, duplication = "enabled") {
  const selected = apu("put");
  selected.next_event_index = 12000;
  selected.registers[16400].value = 143;
  selected.lengths = Array.from({ length: 4 }, () => ({
    value: { min: 0, max: 0 },
    origin,
  }));
  Object.assign(selected.dmc, {
    shift: 2,
    bits_remaining: 1,
    silence: false,
    timer_remaining: timer,
  });
  selected.dmc.cpu_timing.duplication = duplication;
  return selected;
}
function gets(trace) {
  return [
    ...trace.instructions.flatMap((instruction) => instruction.cpu_bus_cycles),
    ...trace.cpu_bus.dmc.boundary_cycles,
    ...(trace.cpu_dma?.transfers.flatMap(
      (transfer) => transfer.cpu_bus_cycles,
    ) ?? []),
  ].filter((cycle) => cycle.kind === "read" && cycle.role === "dmc-get");
}
function deliveries(trace) {
  return trace.cpu_bus.dmc.transfers
    .filter((episode) => episode.outcome === "sample")
    .map((episode) => trace.mapper_trace.steps[episode.mapper_event_index]);
}
function verifyDuplicate(trace) {
  assert.equal(trace.cpu_bus.final.next_cycle_index, 7017);
  assert.deepEqual(
    trace.cpu_bus.dmc.transfers.map((episode) => [
      episode.type,
      episode.first_cycle_index,
      episode.sample_cycle_index,
    ]),
    [
      ["load", 7009, 7011],
      ["duplicate", 7012, 7015],
    ],
  );
  assert.deepEqual(trace.cpu_bus.dmc.transfers[1].request_origin, {
    kind: "dmc-read",
    index: 12013,
    cycle_index: 7011,
  });
  assert.deepEqual(
    deliveries(trace).map((step) => [
      step.event.output_boundary,
      step.dmc_read.value,
      step.dmc_read.source.index,
      step.dmc_read.source.cycle_index,
    ]),
    [
      [true, 0x5d, 12013, 7011],
      [false, 0x5d, 12018, 7015],
    ],
  );
  assert.deepEqual(
    gets(trace).map((cycle) => [
      cycle.index,
      cycle.read.address,
      cycle.read.value,
      cycle.read.file_offset,
    ]),
    [
      [7011, 0xc9c0, 0x5d, 16 + 0x49c0],
      [7015, 0xc9c0, 0x5d, 16 + 0x49c0],
    ],
  );
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc.buffer, {
    status: "full",
    value: 0x5d,
    origin: { kind: "dmc-read", index: 12018 },
  });
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.shift, 0x5d);
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.level, 62);
  assert.equal(trace.mapper_trace.apu_trace.final.dmc_irq.value, true);
}
/** Independent continuous-burst and one-cycle implicit-stop timing oracle. */
export async function verifyDmcSourceImplicit(workflow) {
  await cpuBurst(workflow);
  await implicitAbort(workflow);
  await uncertainWindows(workflow);
  await liveRestart(workflow);
  await oamBurst(workflow);
  await invalidOrigin(workflow);
}
async function cpuBurst({ base, source, replay }) {
  const input = { ...base, entry: 0xc680, initial_apu: state() };
  const full = await source(input);
  verifyDuplicate(full);
  await replay(input, full);
  const disabledInput = { ...input, initial_apu: state(12, "disabled") };
  const disabled = await source(disabledInput);
  assert.equal(disabled.cpu_bus.final.next_cycle_index, 7013);
  assert.equal(disabled.cpu_bus.dmc.transfers.length, 1);
  assert.equal(disabled.mapper_trace.apu_trace.final.dmc.shift, 1);
  assert.equal(disabled.mapper_trace.apu_trace.final.dmc.silence, true);
  await replay(disabledInput, disabled);
  assert.deepEqual(
    await source({
      ...input,
      max_dmc_dma_source_bytes: full.cpu_bus.dmc.retained_source_bytes,
    }),
    full,
  );
  const short = await source({
    ...input,
    max_dmc_dma_source_bytes: full.cpu_bus.dmc.retained_source_bytes - 1,
  });
  assert.equal(short.stop.reason, "dmc-dma-source-budget");
  assert.equal(short.instructions.length, 3);
  assert.equal(short.cpu_bus.final.next_cycle_index, 7008);
  assert.deepEqual(short.cpu_bus.dmc.transfers, []);
  assert.equal(
    short.cpu_bus.dmc.frontier.transfers[0].sample_cycle_index,
    7011,
  );
  assert.equal(short.cpu_bus.dmc.frontier.active.type, "duplicate");
  const prefix = await source({ ...input, max_instructions: 3 });
  const resumedInput = {
    ...input,
    entry: prefix.stop.address,
    cpu: prefix.final_cpu,
    initial: prefix.mapper_trace.final,
    initial_cpu_bus: prefix.cpu_bus.final,
    initial_apu: prefix.mapper_trace.apu_trace.final,
    max_instructions: 1,
  };
  const resumed = await source(resumedInput);
  assert.deepEqual(resumed.cpu_bus.final, full.cpu_bus.final);
  assert.deepEqual(
    resumed.mapper_trace.apu_trace.final,
    full.mapper_trace.apu_trace.final,
  );
  assert.deepEqual(gets(resumed), gets(full));
  await replay(resumedInput, resumed);
}
async function implicitAbort({ base, source, replay }) {
  const input = {
    ...base,
    entry: 0xc680,
    initial_apu: state(14),
    max_instructions: 5,
  };
  const trace = await source(input);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 7016);
  const aborted = trace.cpu_bus.dmc.transfers[1];
  assert.equal(aborted.outcome, "aborted");
  assert.equal(aborted.cause, "implicit-stop");
  assert.equal(aborted.first_cycle_index, 7014);
  assert.deepEqual(aborted.setup, [
    { cycle_index: 7014, phase: "halt", shared_with_oam: false },
  ]);
  assert.deepEqual(aborted.stop_origin, {
    kind: "dmc-read",
    index: 12013,
    cycle_index: 7011,
  });
  assert.equal(aborted.stop_event_index, 12016);
  assert.equal("mapper_event_index" in aborted, false);
  assert.equal("sample_cycle_index" in aborted, false);
  assert.ok(
    trace.mapper_trace.apu_trace.operations.some(
      (operation) =>
        operation.kind === "apu-dmc-stop" && operation.event_index === 12016,
    ),
  );
  assert.equal(trace.mapper_trace.apu_trace.final.registers[16405].value, 16);
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc_irq, {
    value: true,
    origin: { kind: "dmc-read", index: 12013 },
  });
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc_remaining.value, {
    min: 0,
    max: 0,
  });
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.shift, 0x5d);
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.level, 66);
  await replay(input, trace);
  const writeInput = { ...input, entry: 0xc6c0, max_instructions: 4 };
  const write = await source(writeInput);
  assert.equal(write.cpu_bus.final.next_cycle_index, 7015);
  assert.equal(write.cpu_bus.dmc.transfers.length, 1);
  assert.equal(write.instructions[3].writes[0].address, 16);
  assert.equal(write.instructions[3].writes[0].value, 16);
  assert.deepEqual(write.mapper_trace.apu_trace.final.dmc_irq, {
    value: true,
    origin: { kind: "dmc-read", index: 12013 },
  });
  assert.deepEqual(write.mapper_trace.apu_trace.final.dmc_remaining.value, {
    min: 0,
    max: 0,
  });
  await replay(writeInput, write);
}
async function uncertainWindows({ base, source }) {
  for (const [timer, duplication] of [
    [12, "unknown"],
    [13, "enabled"],
  ]) {
    const selected = state(timer, duplication);
    if (timer === 13)
      selected.registers[16400].value = { mask: 191, value: 143 };
    const trace = await source({
      ...base,
      entry: 0xc680,
      initial_apu: selected,
    });
    assert.equal(trace.stop.reason, "dmc-dma-stop-window");
    assert.equal(trace.cpu_bus.final.next_cycle_index, 7008);
    assert.equal(trace.instructions.length, 3);
    assert.deepEqual(gets(trace), []);
    assert.deepEqual(trace.cpu_bus.dmc.transfers, []);
    assert.deepEqual(
      trace.cpu_bus.dmc.frontier.active.setup.map((item) => [
        item.cycle_index,
        item.phase,
      ]),
      [
        [7009, "halt"],
        [7010, "dummy"],
      ],
    );
  }
}
async function liveRestart({ base, source, replay }) {
  const selected = state(3);
  selected.frame_sequencer.cpu_phase = "get";
  selected.registers[16402].value = 40;
  selected.registers[16405].value = 16;
  selected.dmc_remaining.value = { min: 1, max: 1 };
  selected.dmc.cpu_timing.request = {
    status: "pending",
    type: "load",
    delay: 0,
  };
  const input = {
    ...base,
    entry: 0xe120,
    initial_apu: selected,
    max_instructions: 1,
  };
  const trace = await source(input);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 7007);
  assert.deepEqual(
    gets(trace).map((cycle) => [
      cycle.index,
      cycle.read.address,
      cycle.read.value,
      cycle.read.file_offset,
    ]),
    [
      [7002, 0xc9c0, 0x5d, 16 + 0x49c0],
      [7006, 0xca00, 0x96, 16 + 0x4a00],
    ],
  );
  assert.deepEqual(
    deliveries(trace).map((step) => [
      step.dmc_read.value,
      step.dmc_read.source.index,
    ]),
    [
      [0x5d, 12003],
      [0x96, 12008],
    ],
  );
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.shift, 0x5d);
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.buffer.value, 0x96);
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.current_address, 0xca01);
  await replay(input, trace);
}
async function oamBurst({ base, source, replay }) {
  const selected = state(3);
  selected.frame_sequencer.cpu_phase = "get";
  selected.registers[16405].value = 16;
  selected.dmc_remaining.value = { min: 1, max: 1 };
  selected.dmc.cpu_timing.request = {
    status: "pending",
    type: "load",
    delay: 0,
  };
  const input = {
    ...base,
    entry: 0xe120,
    initial_apu: selected,
    max_instructions: 1,
    initial_cpu_dma: {
      model: "oam-cpu-dma",
      region: "ntsc",
      cpu_phase: "get",
      oam_dma_pending: { status: "pending", page: 0x92 },
    },
    initial_ppu: {
      model: "ppu-memory",
      register_writes_enabled: true,
      access_phase: "non-rendering",
      dma_reads: "absent",
      chr_ram_size: null,
      nametable_layout: "ciram-2k",
      control: 0,
      mask: 0,
      oam: {
        model: "oam-memory",
        address: 211,
        retention: "stable",
        reads: "supported",
        dma_pending: { status: "pending", page: 0x92 },
      },
    },
  };
  const trace = await source(input);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 7518);
  assert.deepEqual(
    trace.cpu_bus.dmc.transfers.map((episode) => [
      episode.type,
      episode.first_cycle_index,
      episode.sample_cycle_index,
    ]),
    [
      ["load", 7000, 7002],
      ["duplicate", 7003, 7006],
    ],
  );
  assert.ok(
    trace.cpu_bus.dmc.transfers[1].setup.every((item) => item.shared_with_oam),
  );
  const transfer = trace.cpu_dma.transfers[0];
  assert.equal(transfer.cpu_bus_cycles.length, 518);
  assert.equal(transfer.writes.length, 256);
  for (const [index, write] of transfer.writes.entries())
    assert.equal(write.value, (index * 17 + 0x36) & 255);
  await replay(input, trace);
}
async function invalidOrigin({ base, source }) {
  const selected = state();
  selected.registers[16405].value = 16;
  selected.dmc_remaining.value = { min: 1, max: 1 };
  selected.dmc.cpu_timing.request = {
    status: "pending",
    type: "duplicate",
    delay: 0,
    origin: { kind: "dmc-read", index: 11999, cycle_index: 7000 },
  };
  const trace = await source({
    ...base,
    entry: 0xe120,
    initial_apu: selected,
    max_instructions: 1,
  });
  assert.equal(trace.status, "unsupported");
  assert.match(trace.reason, /cycle/);
}
