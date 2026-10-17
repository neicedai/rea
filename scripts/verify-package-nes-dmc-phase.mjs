import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyRawSources } from "./verify-package-nes-dmc-source-fixture.mjs";

const origin = { kind: "initial-state" };
function apu(long = false) {
  return {
    model: "apu-registers",
    frame_clocks: "cpu-ordered",
    dmc_reads: "explicit",
    next_event_index: 22000,
    registers: Object.fromEntries(
      [
        [0x4010, 143],
        [0x4012, 41],
        [0x4013, long ? 1 : 0],
        [0x4015, 0],
        [0x4017, 64],
      ].map(([address, value]) => [address, { value, origin }]),
    ),
    lengths: Array.from({ length: 4 }, () => ({
      value: { min: 0, max: 0 },
      origin,
    })),
    dmc_remaining: { value: { min: 0, max: 0 }, origin },
    dmc_irq: { value: false, origin },
    frame_irq: { value: false, origin },
    frame_sequencer: {
      region: "ntsc",
      cpu_phase: "put",
      position: { min: 0, max: 0 },
      five_step: false,
      reset_delay: { min: 0, max: 0 },
      clock_block: 0,
    },
    dmc: {
      model: "dmc-reader-output",
      region: "ntsc",
      clocks: "cpu-ordered",
      current_address: 0xca40,
      buffer: { status: "empty" },
      shift: 2,
      bits_remaining: 1,
      silence: false,
      level: 64,
      timer_remaining: 13,
      cpu_timing: {
        model: "2a03-dmc-dma",
        duplication: "disabled",
        request: { status: "none" },
        stop: { status: "none" },
      },
    },
  };
}
const oam = {
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
function rawGets(trace) {
  return [
    ...trace.instructions.flatMap((instruction) => instruction.cpu_bus_cycles),
    ...trace.cpu_bus.dmc.boundary_cycles,
    ...(trace.cpu_dma?.transfers.flatMap(
      (transfer) => transfer.cpu_bus_cycles,
    ) ?? []),
  ].filter((cycle) => cycle.kind === "read" && cycle.role === "dmc-get");
}
/** Separate bounded public oracle for put-boundary reload and late implicit stop. */
export async function verifyPackageNesDmcPhase(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 1, 0, 8]);
  bytes.set([0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0xea, 0xea, 2], 16 + 0x47c0);
  bytes.set(
    [0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0x85, 0x10, 0xea, 2],
    16 + 0x4800,
  );
  bytes[16 + 0x4a40] = 0x81;
  bytes[16 + 0x4a41] = 0x96;
  for (let index = 0; index < 256; index++)
    bytes[16 + 0x1200 + index] = (index * 19 + 0x2b) & 255;
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0xc7c0, 16 + 32768 - delta);
  const path = join(workspace, "dmc-put-phase.nes");
  await writeFile(path, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  let workflows = 0;
  const call = async (command, input) => {
    workflows++;
    const evidence = await invoke(command, input);
    assert.equal(evidence.subject.digest.sha256, digest);
    return evidence.normalized_result;
  };
  const source = async (input) => {
    const trace = (await call("trace-nes-code", input)).code_trace;
    assert.equal(trace.status, "derived");
    verifyRawSources(trace, bytes);
    return trace;
  };
  const replay = async (input, trace) => {
    const expected = structuredClone(trace.mapper_trace);
    for (const facet of ["apu_trace", "ppu_trace"])
      if (expected[facet] != null) expected[facet].frontier = [];
    assert.deepEqual(
      (
        await call("trace-nes-mapper-events", {
          path,
          initial: input.initial,
          initial_apu: input.initial_apu,
          initial_ppu: input.initial_ppu ?? null,
          events: trace.mapper_trace.steps.map((step) => step.event),
          max_steps: trace.mapper_trace.steps.length,
        })
      ).trace,
      expected,
    );
  };
  const base = {
    path,
    initial: { mapper: 0 },
    entry: 0xc7c0,
    max_instructions: 5,
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 9000,
    },
    initial_apu: apu(),
  };
  const workflow = { base, source, replay };
  await normalReload(workflow);
  await lateStop(workflow);
  await writeBlocking(workflow);
  await oamReloads(workflow);
  await retainedLatency(workflow);
  assert.equal(workflows, 19);
  assert.deepEqual(await readFile(path), bytes);
  return {
    ok: true,
    workflows,
    put_reload: true,
    late_discard: true,
    oam_tail: true,
    original_unchanged: true,
    scope:
      "Conditional NTSC source timing and immutable synthetic ROMs; no observed hardware, PAL or commercial-game compatibility claim",
  };
}
async function normalReload({ base, source, replay }) {
  const input = { ...base, initial_apu: apu(true) };
  const trace = await source(input);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 9018);
  assert.deepEqual(
    trace.cpu_bus.dmc.transfers.map((episode) => [
      episode.type,
      episode.outcome,
      episode.first_cycle_index,
      episode.sample_cycle_index,
    ]),
    [
      ["load", "sample", 9009, 9011],
      ["reload", "sample", 9013, 9015],
    ],
  );
  assert.deepEqual(
    rawGets(trace).map((cycle) => [
      cycle.index,
      cycle.read.address,
      cycle.read.value,
      cycle.read.file_offset,
    ]),
    [
      [9011, 0xca40, 0x81, 16 + 0x4a40],
      [9015, 0xca41, 0x96, 16 + 0x4a41],
    ],
  );
  assert.deepEqual(
    trace.cpu_bus.dmc.transfers[1].setup.map((item) => [
      item.cycle_index,
      item.phase,
    ]),
    [
      [9013, "halt"],
      [9014, "dummy"],
    ],
  );
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc_remaining.value, {
    min: 15,
    max: 15,
  });
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.level, 62);
  await replay(input, trace);
}
function assertLate(trace) {
  assert.equal(trace.cpu_bus.final.next_cycle_index, 9018);
  const episode = trace.cpu_bus.dmc.transfers[1];
  assert.equal(episode.outcome, "discarded");
  assert.equal(episode.cause, "implicit-stop");
  assert.equal(episode.first_cycle_index, 9013);
  assert.equal(episode.get_cycle_index, 9015);
  assert.deepEqual(episode.stop_origin, {
    kind: "dmc-read",
    index: 22013,
    cycle_index: 9011,
  });
  assert.equal(episode.stop_event_index, 22016);
  assert.equal("mapper_event_index" in episode, false);
  assert.equal("sample_cycle_index" in episode, false);
  assert.deepEqual(
    rawGets(trace).map((cycle) => [
      cycle.index,
      cycle.read.address,
      cycle.read.value,
    ]),
    [
      [9011, 0xca40, 0x81],
      [9015, 0xca40, 0x81],
    ],
  );
  assert.equal(
    trace.mapper_trace.steps.filter(
      (step) => step.event.kind === "apu-dmc-cpu-read",
    ).length,
    1,
  );
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc_irq, {
    value: true,
    origin: { kind: "dmc-read", index: 22013 },
  });
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc_remaining.value, {
    min: 0,
    max: 0,
  });
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.current_address, 0xca40);
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.level, 66);
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc.buffer, {
    status: "empty",
  });
}
async function lateStop({ base, source, replay }) {
  const trace = await source(base);
  assertLate(trace);
  await replay(base, trace);
  assert.deepEqual(
    await source({
      ...base,
      max_dmc_dma_source_bytes: trace.cpu_bus.dmc.retained_source_bytes,
    }),
    trace,
  );
  const short = await source({
    ...base,
    max_dmc_dma_source_bytes: trace.cpu_bus.dmc.retained_source_bytes - 1,
  });
  assert.equal(short.stop.reason, "dmc-dma-source-budget");
  assert.equal(short.instructions.length, 4);
  assert.equal(short.cpu_bus.final.next_cycle_index, 9013);
  assert.equal(short.cpu_bus.dmc.transfers.length, 1);
  assert.equal(short.cpu_bus.dmc.frontier.active.type, "reload");
  const prefix = await source({ ...base, max_instructions: 4 });
  const resumed = await source({
    ...base,
    entry: prefix.stop.address,
    cpu: prefix.final_cpu,
    initial: prefix.mapper_trace.final,
    initial_cpu_bus: prefix.cpu_bus.final,
    initial_apu: prefix.mapper_trace.apu_trace.final,
    max_instructions: 1,
  });
  assert.deepEqual(resumed.cpu_bus.final, trace.cpu_bus.final);
  assert.deepEqual(
    resumed.mapper_trace.apu_trace.final,
    trace.mapper_trace.apu_trace.final,
  );
}
async function writeBlocking({ base, source, replay }) {
  for (const long of [true, false]) {
    const input = { ...base, entry: 0xc800, initial_apu: apu(long) };
    const trace = await source(input);
    assert.equal(trace.instructions[3].writes[0].address, 16);
    assert.equal(trace.instructions[3].writes[0].value, 16);
    const episode = trace.cpu_bus.dmc.transfers[1];
    assert.equal(episode.first_cycle_index, 9014);
    if (long) {
      assert.equal(trace.cpu_bus.final.next_cycle_index, 9020);
      assert.equal(episode.outcome, "sample");
      assert.equal(episode.sample_cycle_index, 9017);
      assert.deepEqual(
        episode.setup.map((item) => item.phase),
        ["halt", "dummy", "alignment"],
      );
    } else {
      assert.equal(trace.cpu_bus.final.next_cycle_index, 9017);
      assert.equal(episode.outcome, "aborted");
      assert.equal(episode.cause, "implicit-stop");
      assert.equal(episode.setup.length, 1);
      assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc_irq, {
        value: true,
        origin: { kind: "dmc-read", index: 22013 },
      });
    }
    await replay(input, trace);
  }
}
async function oamReloads({ base, source, replay }) {
  const early = apu();
  early.frame_sequencer.cpu_phase = "get";
  early.registers[16405].value = 16;
  early.dmc_remaining.value = { min: 1, max: 1 };
  early.dmc.timer_remaining = 4;
  early.dmc.cpu_timing.request = { status: "pending", type: "load", delay: 0 };
  const earlyInput = {
    ...base,
    ...oam,
    entry: 0xe120,
    initial_apu: early,
    max_instructions: 1,
  };
  const shared = await source(earlyInput);
  assert.equal(shared.cpu_bus.final.next_cycle_index, 9518);
  assert.equal(shared.cpu_bus.dmc.transfers[1].outcome, "discarded");
  assert.equal(shared.cpu_bus.dmc.transfers[1].get_cycle_index, 9006);
  assert.deepEqual(shared.cpu_bus.dmc.transfers[1].setup, [
    { cycle_index: 9004, phase: "halt", shared_with_oam: true },
    { cycle_index: 9005, phase: "dummy", shared_with_oam: true },
  ]);
  await replay(earlyInput, shared);
  const tail = apu(true);
  tail.frame_sequencer.cpu_phase = "get";
  tail.registers[16400].value = 128;
  tail.registers[16405].value = 16;
  tail.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(tail.dmc, {
    buffer: { status: "full", value: 0x59, origin },
    bits_remaining: 2,
    timer_remaining: 86,
  });
  const input = { ...earlyInput, initial_apu: tail };
  const trace = await source(input);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 9517);
  assert.equal(trace.cpu_dma.transfers[0].cpu_bus_cycles.length, 517);
  assert.equal(trace.cpu_dma.transfers[0].writes.length, 256);
  assert.deepEqual(trace.cpu_bus.dmc.boundary_cycles, []);
  const episode = trace.cpu_bus.dmc.transfers[0];
  assert.equal(episode.first_cycle_index, 9514);
  assert.equal(episode.sample_cycle_index, 9516);
  assert.deepEqual(episode.setup, [
    { cycle_index: 9514, phase: "halt", shared_with_oam: false },
    { cycle_index: 9515, phase: "dummy", shared_with_oam: false },
  ]);
  for (const [index, write] of trace.cpu_dma.transfers[0].writes.entries())
    assert.equal(write.value, (index * 19 + 0x2b) & 255);
  await replay(input, trace);
  const short = await source({
    ...input,
    max_dmc_dma_source_bytes: trace.cpu_bus.dmc.retained_source_bytes - 1,
  });
  assert.equal(short.stop.reason, "dmc-dma-source-budget");
  assert.equal(short.cpu_bus.final.next_cycle_index, 9000);
  assert.deepEqual(short.cpu_dma.transfers, []);
  assert.equal(short.cpu_dma.frontier.writes.length, 256);
  assert.equal(short.cpu_bus.dmc.frontier.active.type, "reload");
}
async function retainedLatency({ base, source }) {
  const selected = apu(true);
  selected.registers[16405].value = 16;
  selected.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(selected.dmc, { bits_remaining: 8, timer_remaining: 54 });
  selected.dmc.cpu_timing.request = {
    status: "pending",
    type: "reload",
    delay: 1,
  };
  const input = {
    ...base,
    entry: 0xc7c5,
    initial_apu: selected,
    max_instructions: 1,
  };
  const known = await source(input);
  assert.equal(known.cpu_bus.final.next_cycle_index, 9005);
  assert.equal(known.cpu_bus.dmc.transfers[0].first_cycle_index, 9001);
  assert.equal(known.cpu_bus.dmc.transfers[0].sample_cycle_index, 9003);
  selected.frame_sequencer.cpu_phase = null;
  const unknown = await source(input);
  assert.equal(unknown.stop.reason, "dmc-dma-phase");
  assert.equal(unknown.cpu_bus.final.next_cycle_index, 9000);
}
