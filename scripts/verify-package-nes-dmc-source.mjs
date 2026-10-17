import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { verifyDmcSourceStop } from "./verify-package-nes-dmc-stop.mjs";
import { verifyDmcSourceImplicit } from "./verify-package-nes-dmc-implicit.mjs";
import {
  createDmcSourceFixture,
  roles,
  assertAtomicBudget,
  assertTransfer,
  verifyRawSources,
  apu,
  reloadApu,
} from "./verify-package-nes-dmc-source-fixture.mjs";

/** Independent source-cycle/sample oracle; no domain or emulator imports. */
export async function verifyPackageNesDmcSource(invoke, workspace) {
  const { bytes, path, digest } = await createDmcSourceFixture(workspace);
  let workflows = 0;
  const call = async (command, input) => {
    workflows++;
    const evidence = await invoke(command, input);
    assert.equal(evidence.subject.digest.sha256, digest);
    return evidence.normalized_result;
  };
  const source = async (input) => {
    const trace = (await call("trace-nes-code", input)).code_trace;
    if (trace.status === "derived") verifyRawSources(trace, bytes);
    return trace;
  };
  const replay = async (input, trace) => {
    // The public event replay receives the committed steps. Source-only
    // unapplied opcode/device operations remain in the original frontier.
    const committed = structuredClone(trace.mapper_trace);
    for (const facet of ["apu_trace", "ppu_trace", "controller_trace"])
      if (committed[facet] != null) committed[facet].frontier = [];
    assert.deepEqual(
      (
        await call("trace-nes-mapper-events", {
          path,
          initial: input.initial,
          initial_apu: input.initial_apu,
          initial_ppu: input.initial_ppu ?? null,
          initial_controllers: input.initial_controllers ?? null,
          events: trace.mapper_trace.steps.map((step) => step.event),
          max_steps: trace.mapper_trace.steps.length,
        })
      ).trace,
      committed,
    );
  };
  const base = {
    path,
    initial: { mapper: 0 },
    entry: 0xc345,
    max_instructions: 4,
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 7000,
    },
    initial_apu: apu(),
  };

  const workflow = { base, source, call, replay };
  await verifyLoad(workflow);
  await verifyBoundary(workflow);
  await verifyInlineAndRetries(workflow);
  await verifyConflict(workflow);
  await verifyExploration(workflow);
  await verifyShared(workflow);
  await verifyFrontiers(workflow);
  await verifyDeviceQualifications(workflow);
  await verifyDmcSourceStop(workflow);
  await verifyDmcSourceImplicit(workflow);
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(workflows, 74);
  return {
    ok: true,
    workflows,
    inline_reload: true,
    oam_priority: true,
    contended_sample_provenance: true,
    continuation: true,
    atomic_budget: true,
    explicit_stop: true,
    aborted_and_discarded: true,
    implicit_stop: true,
    duplicate_burst: true,
    original_unchanged: true,
    scope:
      "Conditional NTSC source DMC load/reload/read retries, explicit and implicit stop/abort, caller-selected sample duplication and OAM arbitration; supplied state and synthetic immutable ROMs, not PAL, unresolved silicon windows, hardware or commercial-game compatibility",
  };
}

async function verifyLoad({ base, source, call, replay }) {
  const load = await source(base);
  assert.equal(load.stop.reason, "instruction-budget");
  assert.equal(load.cpu_bus.final.next_cycle_index, 7013);
  assert.deepEqual(roles(load.cpu_bus.dmc.boundary_cycles), [
    "dmc-halt",
    "dmc-dummy",
    "dmc-get",
  ]);
  assertTransfer(load, { type: "load", first: 7008, sample: 7010 });
  assert.equal(load.mapper_trace.apu_trace.final.dmc_irq.value, true);
  assert.deepEqual(load.mapper_trace.apu_trace.final.dmc_remaining.value, {
    min: 0,
    max: 0,
  });
  await replay(base, load);
  assert.deepEqual(
    (await call("explore-nes-code", base)).code_exploration.paths[0].trace,
    load,
  );
  const prefix = await source({ ...base, max_instructions: 3 });
  assert.equal(prefix.cpu_bus.final.next_cycle_index, 7008);
  assert.deepEqual(prefix.mapper_trace.apu_trace.final.dmc.cpu_timing.request, {
    status: "pending",
    type: "load",
    delay: 0,
  });
  const resumed = await source({
    ...base,
    entry: prefix.stop.address,
    initial: prefix.mapper_trace.final,
    cpu: prefix.final_cpu,
    initial_cpu_bus: prefix.cpu_bus.final,
    initial_apu: prefix.mapper_trace.apu_trace.final,
    max_instructions: 1,
  });
  assert.deepEqual(resumed.cpu_bus.final, load.cpu_bus.final);
  assert.deepEqual(
    resumed.cpu_bus.dmc.boundary_cycles,
    load.cpu_bus.dmc.boundary_cycles,
  );
  assert.deepEqual(
    resumed.mapper_trace.apu_trace.final,
    load.mapper_trace.apu_trace.final,
  );
}

async function verifyBoundary({ base, source, replay }) {
  const pending = {
    ...base,
    entry: 0xe120,
    initial_apu: apu("get", true),
    max_instructions: 1,
  };
  const boundary = await source(pending);
  assert.equal(boundary.stop.reason, "unsupported-opcode");
  assert.deepEqual(boundary.instructions, []);
  assert.equal(boundary.cpu_bus.final.next_cycle_index, 7003);
  assert.equal(boundary.mapper_trace.apu_trace.final.dmc.timer_remaining, 425);
  assertTransfer(boundary, { type: "load", first: 7000, sample: 7002 });
  await replay(pending, boundary);
  const boundaryBudget = await source({
    ...pending,
    max_dmc_dma_source_bytes: 0,
  });
  assertAtomicBudget(boundaryBudget, 7000);
  assert.deepEqual(boundaryBudget.mapper_trace.apu_trace.final.dmc.buffer, {
    status: "empty",
  });
}

async function verifyInlineAndRetries({ base, source, replay }) {
  const inlineInput = {
    ...base,
    entry: 0xc480,
    max_instructions: 1,
    initial_apu: reloadApu(1),
  };
  const inline = await source(inlineInput);
  assert.equal(inline.cpu_bus.final.next_cycle_index, 7006);
  assert.deepEqual(roles(inline.instructions[0].cpu_bus_cycles), [
    "opcode",
    "dmc-halt",
    "dmc-dummy",
    "dmc-alignment",
    "dmc-get",
    "dummy",
  ]);
  assert.deepEqual(inline.cpu_bus.dmc.boundary_cycles, []);
  assertTransfer(inline, { type: "reload", first: 7001, sample: 7004 });
  await replay(inlineInput, inline);
  const inlineBudget = await source({
    ...inlineInput,
    max_dmc_dma_source_bytes: 0,
  });
  assertAtomicBudget(inlineBudget, 7000);
  assert.deepEqual(inlineBudget.mapper_trace.apu_trace.final.dmc.buffer, {
    status: "full",
    value: 0x6a,
    origin: { kind: "initial-state" },
  });
  assert.equal(
    inlineBudget.mapper_trace.apu_trace.final.dmc.timer_remaining,
    1,
  );

  const rmw = await source({
    ...base,
    entry: 0xc500,
    max_instructions: 2,
    initial_apu: reloadApu(4),
    initial_ram: [{ address: 16, value: 23 }],
  });
  assert.deepEqual(
    rmw.instructions[0].writes.map((write) => write.value),
    [23, 24],
  );
  assertTransfer(rmw, { type: "reload", first: 7006, sample: 7008 });
  assert.equal(rmw.cpu_bus.dmc.transfers[0].before_instruction_index, 1);
}

async function verifyConflict({ base, source, replay }) {
  const conflictApu = apu("get", true);
  conflictApu.registers[16407].value = 0;
  conflictApu.frame_irq.value = true;
  conflictApu.dmc.current_address = 0xc9d5;
  const conflictInput = {
    ...base,
    max_instructions: 1,
    entry: 0x4010,
    initial_apu: conflictApu,
    initial_cpu_io: {
      model: "2a03-io",
      controller_clocking: "contiguous",
      active_controller: 0,
      cpu_latch: 0x20,
      external_latch: 0x80,
    },
  };
  const conflict = await source(conflictInput);
  assertTransfer(
    conflict,
    { type: "load", first: 7000, sample: 7002 },
    { address: 0xc9d5, value: 0x50 },
  );
  const sample = conflict.cpu_bus.dmc.boundary_cycles[2];
  assert.equal(sample.read.value, 0xe3);
  assert.equal(sample.read.file_offset, 16 + 0x49d5);
  assert.equal(sample.dma_io.cpu_value, 0x50);
  assert.equal(sample.dma_io.external_value, 0xe3);
  assert.equal(sample.dma_io.decoded_address, 0x4015);
  await replay(conflictInput, conflict);
  const exact = await source({
    ...conflictInput,
    max_dmc_dma_source_bytes: conflict.cpu_bus.dmc.retained_source_bytes,
  });
  assert.deepEqual(exact, conflict);
  const short = await source({
    ...conflictInput,
    max_dmc_dma_source_bytes: conflict.cpu_bus.dmc.retained_source_bytes - 1,
  });
  assertAtomicBudget(short, 7000);
  assert.equal(short.mapper_trace.apu_trace.final.frame_irq.value, true);
  assert.deepEqual(short.mapper_trace.apu_trace.final.dmc.buffer, {
    status: "empty",
  });
}

async function verifyExploration({ base, source, call }) {
  const branchInput = {
    ...base,
    entry: 0xc580,
    initial_apu: apu("get", true),
    max_instructions: 4,
  };
  const prefix = await source(branchInput);
  const branch = (
    await call("explore-nes-code", {
      ...branchInput,
      entry: 0xc580,
      max_instructions: 4,
      max_total_instructions: 20,
      max_dmc_dma_source_bytes: prefix.cpu_bus.dmc.retained_source_bytes,
    })
  ).code_exploration;
  assert.equal(branch.termination, "dmc-dma-source-budget");
  assert.equal(branch.paths.length, 2);
  assert.equal(branch.pending_paths.length, 1);
  assert.equal(branch.paths[0].trace.stop.reason, "unknown-branch");
  assert.equal(branch.paths[1].trace.stop.reason, "dmc-dma-source-budget");
}

async function verifyShared({ base, source, replay }) {
  const sharedApu = apu("put", true);
  sharedApu.registers[16403].value = 1;
  sharedApu.dmc_remaining.value = { min: 2, max: 2 };
  sharedApu.dmc.cpu_timing.request = {
    status: "pending",
    type: "reload",
    delay: 0,
  };
  const sharedInput = {
    ...base,
    entry: 0xe120,
    max_instructions: 1,
    initial_apu: sharedApu,
    initial_cpu_dma: {
      model: "oam-cpu-dma",
      region: "ntsc",
      cpu_phase: "put",
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
  const shared = await source(sharedInput);
  const transfer = shared.cpu_dma.transfers[0];
  assert.equal(transfer.cpu_bus_cycles.length, 515);
  assert.equal(shared.cpu_bus.final.next_cycle_index, 7515);
  assertTransfer(shared, { type: "reload", first: 7000, sample: 7003 });
  assert.deepEqual(shared.cpu_bus.dmc.transfers[0].setup, [
    { cycle_index: 7000, phase: "halt", shared_with_oam: true },
    { cycle_index: 7001, phase: "dummy", shared_with_oam: true },
    { cycle_index: 7002, phase: "alignment", shared_with_oam: true },
  ]);
  assert.equal(transfer.writes.length, 256);
  for (let index = 0; index < 256; index++) {
    const value = (index * 17 + 0x36) & 255;
    assert.equal(transfer.writes[index].value, value);
    const destination = (211 + index) & 255;
    assert.equal(
      shared.mapper_trace.ppu_trace.final.oam.cells[destination].value,
      value & (destination % 4 === 2 ? 227 : 255),
    );
  }
  await replay(sharedInput, shared);
}

async function verifyFrontiers({ base, source }) {
  const state = apu("put", true),
    dmc = state.dmc;
  dmc.cpu_timing.request = { status: "pending", type: "reload", delay: 0 };
  dmc.bits_remaining = null;
  dmc.timer_remaining = null;
  const trace = await source({ ...base, entry: 0xe120, initial_apu: state });
  assert.equal(trace.stop.reason, "unsupported-opcode");
  assert.equal(trace.cpu_bus.final.next_cycle_index, 7004);
  assertTransfer(trace, { type: "reload", first: 7000, sample: 7003 });
  const final = trace.mapper_trace.apu_trace.final;
  assert.equal(final.dmc.bits_remaining, null);
  assert.equal(final.dmc.timer_remaining, null);
  assert.deepEqual(final.dmc_remaining.value, { min: 0, max: 0 });
  assert.equal(final.dmc_irq.value, true);
  assert.deepEqual(final.dmc.cpu_timing.request, { status: "none" });
  const unknownApu = apu();
  unknownApu.dmc.cpu_timing.request = { status: "unknown" };
  const unknown = await source({ ...base, initial_apu: unknownApu });
  assert.equal(unknown.stop.reason, "dmc-dma-request");
  assert.equal(unknown.cpu_bus.final.next_cycle_index, 7000);
  const palApu = apu("get", true);
  palApu.dmc.region = "pal";
  palApu.dmc.timer_remaining = 398;
  palApu.frame_sequencer.region = "pal";
  const pal = await source({ ...base, initial_apu: palApu });
  assert.equal(pal.status, "unsupported");
  assert.match(pal.reason, /NTSC/);
}

async function verifyDeviceQualifications({ base, source, replay }) {
  const initial_ppu = {
    model: "ppu-memory",
    register_writes_enabled: true,
    access_phase: "non-rendering",
    dma_reads: "absent",
    chr_ram_size: null,
    nametable_layout: "ciram-2k",
    control: 0,
    mask: 0,
    v: { low: 0, high: 32 },
    read_buffer: { value: 0x73 },
    nametable: { 0: 0x26 },
  };
  const initial_controllers = {
    model: "standard-controllers",
    dma_reads: "absent",
    strobe: false,
    buttons: [0x5a, 0xc3],
    oam_dma_pending: { status: "none" },
    ports: [3, 6].map((position, index) => ({
      serial_reports: [
        {
          position,
          buttons: index === 0 ? 0x5a : 0xc3,
          origin: { kind: "initial-report", port: index + 1 },
        },
      ],
    })),
  };
  const input = { ...base, initial_ppu, initial_controllers };
  const trace = await source(input);
  assertTransfer(trace, { type: "load", first: 7008, sample: 7010 });
  const ppu = trace.mapper_trace.ppu_trace,
    controllers = trace.mapper_trace.controller_trace;
  assert.equal(ppu.final.dma_reads, "absent");
  assert.deepEqual(ppu.final.read_buffer, {
    value: 0x73,
    sources: [
      {
        kind: "register",
        field: "read-buffer",
        mask: 255,
        value: 0x73,
        origin: { kind: "initial-register", field: "read-buffer" },
      },
    ],
  });
  assert.equal(controllers.final.dma_reads, "absent");
  assert.deepEqual(controllers.final.ports, initial_controllers.ports);
  await replay(input, trace);
  await verifyDeviceReads({ input, source, replay });
}

async function verifyDeviceReads({ input, source, replay }) {
  const trace = await source({ ...input, max_instructions: 7 });
  assert.equal(trace.stop.reason, "instruction-budget");
  assert.equal(trace.instructions.length, 7);
  const buffered = trace.instructions[4].data_reads[0];
  assert.equal(buffered.address, 0x2007);
  assert.equal(buffered.value, 0x73);
  assert.equal(buffered.file_offset, null);
  assert.equal(buffered.mapper_origins[0].kind, "ppu-register");
  assert.equal(buffered.mapper_origins[0].alternatives[0].mode, "buffered");
  assert.equal(buffered.mapper_origins[0].alternatives[0].value, 0x73);
  assert.deepEqual(trace.instructions[5].data_reads[0].known_bits, {
    mask: 1,
    value: 1,
  });
  assert.equal(trace.instructions[5].data_reads[0].file_offset, null);
  assert.equal(trace.final_cpu.a, 1);
  const ppu = trace.mapper_trace.ppu_trace.final,
    controllers = trace.mapper_trace.controller_trace.final;
  assert.equal(ppu.dma_reads, "absent");
  assert.deepEqual(ppu.v, { low: 1, high: 32 });
  assert.equal(ppu.read_buffer.value, 0x26);
  assert.equal(controllers.dma_reads, "absent");
  assert.deepEqual(
    controllers.ports.map((port) => port.serial_reports[0].position),
    [4, 6],
  );
  await replay(input, trace);
}
