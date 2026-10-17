import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent byte/cycle oracle, shared by installed CLI and public CLI/MCP consumers. */
export async function verifyPackageNesDma(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 32768, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 0, 0, 8]);
  bytes[11] = 7;
  bytes.set([0xa9, 0x85, 0x8d, 0x14, 0x40, 2], 16 + 0x250);
  for (let index = 0; index < 256; index++)
    bytes[16 + 0x500 + index] = ((index * 7) ^ 0xa3) & 255;
  const path = join(workspace, "installed-cycle-dma.nes");
  await writeFile(path, bytes);
  for (const phase of ["get", "put"]) {
    const input = dmaInput(path, phase);
    const evidence = await invoke("trace-nes-code", input),
      trace = evidence.normalized_result.code_trace;
    verifyTrace(trace, bytes, phase);
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(
      (await invoke("explore-nes-code", input)).normalized_result
        .code_exploration.paths[0].trace,
      trace,
    );
    assert.deepEqual(
      (
        await invoke("trace-nes-mapper-events", {
          path,
          initial: input.initial,
          initial_ppu: input.initial_ppu,
          initial_apu: input.initial_apu,
          events: trace.mapper_trace.steps.map((step) => step.event),
        })
      ).normalized_result.trace,
      trace.mapper_trace,
    );
    if (phase === "get") await verifyContinuation(invoke, input, trace);
  }
  await verifyNamcoDma(invoke, workspace);
  assert.deepEqual(await readFile(path), bytes);
  return {
    ok: true,
    workflows: 11,
    phases: 2,
    dma_cycles: [514, 513],
    raw_reads: 256,
    puts: 256,
    source_replay: true,
    partial_budget: true,
    original_unchanged: true,
    scope:
      "Conditional nominal OAM stalls and APU clocks; excludes internal-register DMA conflicts, DMC arbitration, PPU clock scheduling and hardware observations",
  };
}

async function verifyNamcoDma(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 65536 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0x30, 0x18, 0x20]);
  bytes[16 + 7 * 8192] = 0xea;
  const path = join(workspace, "installed-namco-cycle-dma.nes");
  await writeFile(path, bytes);
  const initial = {
    mapper: 19,
    variant: "namco163",
    prg_banks: [64, 1, 2],
    irq_high: 0,
    chip_ram: {
      bytes: Array.from({ length: 128 }, (_, index) => (index * 3 + 7) & 255),
      address_port: 0x85,
      increment_model: "saturate",
      dma_reads: "absent",
      oam_dma_pending: 0x4f,
    },
  };
  const base = dmaInput(path, "put");
  const input = {
    ...base,
    initial,
    entry: 0xe000,
    max_instructions: 1,
    initial_apu: null,
    initial_irq: {
      model: "namco163",
      counter_low: 0,
      counter_high: 0,
      asserted: false,
    },
    initial_ppu: {
      ...base.initial_ppu,
      chr_ram_size: null,
      nametable_layout: null,
      oam: {
        ...base.initial_ppu.oam,
        dma_pending: { status: "pending", page: 0x4f },
      },
    },
  };
  const evidence = await invoke("trace-nes-code", input),
    trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  const transfer = trace.cpu_dma.transfers[0];
  assert.equal(transfer.cpu_bus_cycles.length, 513);
  assert.deepEqual(
    transfer.writes.map((write) => write.value),
    Array.from(
      { length: 256 },
      (_, index) => (Math.min(5 + index, 127) * 3 + 7) & 255,
    ),
  );
  assert.equal(trace.mapper_trace.final.chip_ram.address_port, 255);
  assert.equal(trace.mapper_trace.final.chip_ram.oam_dma_pending, "none");
  assert.equal(
    trace.mapper_trace.steps.filter(
      (step) => step.event.kind === "namco163-cpu-cycle",
    ).length,
    515,
  );
  assert.deepEqual(
    (
      await invoke("trace-nes-mapper-events", {
        path,
        initial,
        initial_irq: input.initial_irq,
        initial_ppu: input.initial_ppu,
        events: trace.mapper_trace.steps.map((step) => step.event),
        max_steps: trace.mapper_trace.steps.length,
      })
    ).normalized_result.trace,
    trace.mapper_trace,
  );
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await readFile(path), bytes);
}

function dmaInput(path, phase) {
  const origin = { kind: "initial-state" };
  return {
    path,
    initial: { mapper: 0 },
    entry: 0x8250,
    max_instructions: 3,
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 23457,
    },
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: phase },
    initial_ppu: {
      model: "ppu-memory",
      access_phase: "non-rendering",
      dma_reads: "absent",
      chr_ram_size: 8192,
      nametable_layout: "ciram-2k",
      register_writes_enabled: true,
      control: 0,
      mask: 0,
      oam: {
        model: "oam-memory",
        address: 249,
        retention: "stable",
        reads: "supported",
        dma_pending: { status: "none" },
      },
    },
    initial_apu: {
      model: "apu-registers",
      frame_clocks: "cpu-ordered",
      dmc_reads: "absent",
      registers: { 16407: { value: 0, origin } },
      frame_irq: { value: false, origin },
      dmc_irq: { value: false, origin },
      frame_sequencer: {
        region: "ntsc",
        cpu_phase: phase,
        position: { min: 7400, max: 7400 },
        five_step: false,
        reset_delay: { min: 0, max: 0 },
        clock_block: 0,
      },
    },
  };
}

function verifyTrace(trace, bytes, phase) {
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "unsupported-opcode");
  assert.equal(trace.instructions.length, 2);
  assert.equal(trace.cpu_dma.transfers.length, 1);
  const transfer = trace.cpu_dma.transfers[0],
    count = phase === "get" ? 514 : 513;
  assert.equal(transfer.before_instruction_index, 2);
  assert.equal(transfer.halted_address, 0x8255);
  assert.equal(transfer.start_phase, phase);
  assert.equal(transfer.cpu_bus_cycles.length, count);
  assert.equal(transfer.writes.length, 256);
  assert.deepEqual(
    transfer.cpu_bus_cycles
      .slice(0, count - 512)
      .map((cycle) => cycle.read.address),
    Array(count - 512).fill(0x8255),
  );
  const data = transfer.cpu_bus_cycles.slice(count - 512);
  for (let index = 0; index < 256; index++) {
    const get = data[index * 2],
      put = data[index * 2 + 1],
      offset = 16 + 0x500 + index;
    assert.equal(get.kind, "read");
    assert.equal(get.read.address, 0x8500 + index);
    assert.equal(get.read.file_offset, offset);
    assert.equal(get.read.value, bytes[offset]);
    assert.equal(put.kind, "write");
    assert.equal(put.write_index, index);
    assert.equal(transfer.writes[index].address, 0x2004);
    assert.equal(transfer.writes[index].value, bytes[offset]);
    const destination = (249 + index) & 255,
      expected = bytes[offset] & (destination % 4 === 2 ? 227 : 255);
    assert.equal(
      trace.mapper_trace.ppu_trace.final.oam.cells[destination].value,
      expected,
    );
  }
  assert.equal(trace.cpu_bus.final.next_cycle_index, 23457 + 6 + count);
  assert.equal(trace.cpu_dma.final.cpu_phase, "get");
  assert.deepEqual(trace.cpu_dma.final.oam_dma_pending, { status: "none" });
  assert.equal(trace.mapper_trace.ppu_trace.final.oam.address, 249);
  assert.deepEqual(
    trace.mapper_trace.apu_trace.final.frame_sequencer.position,
    { min: 7406 + count, max: 7406 + count },
  );
  assert.equal(
    trace.mapper_trace.steps.filter(
      (step) => step.event.kind === "apu-cpu-cycle",
    ).length,
    6 + count,
  );
}

async function verifyContinuation(invoke, input, full) {
  const prefix = (
    await invoke("trace-nes-code", { ...input, max_oam_dma_source_bytes: 0 })
  ).normalized_result.code_trace;
  assert.equal(prefix.stop.reason, "oam-dma-source-budget");
  assert.deepEqual(prefix.cpu_dma.frontier.cpu_bus_cycles, []);
  assert.deepEqual(prefix.cpu_dma.frontier.mapper_events, [
    { kind: "oam-dma-start", page: 0x85 },
  ]);
  assert.deepEqual(prefix.cpu_dma.final.oam_dma_pending, {
    status: "pending",
    page: 0x85,
  });
  assert.equal(prefix.cpu_bus.final.next_cycle_index, 23463);
  assert.deepEqual(prefix.mapper_trace.ppu_trace.final.oam.cells, {});
  const continued = (
    await invoke("trace-nes-code", {
      ...input,
      entry: prefix.stop.address,
      initial: prefix.mapper_trace.final,
      cpu: prefix.final_cpu,
      initial_cpu_bus: prefix.cpu_bus.final,
      initial_cpu_dma: prefix.cpu_dma.final,
      initial_ppu: prefix.mapper_trace.ppu_trace.final,
      initial_apu: prefix.mapper_trace.apu_trace.final,
    })
  ).normalized_result.code_trace;
  assert.deepEqual(
    continued.cpu_dma.transfers[0].cpu_bus_cycles,
    full.cpu_dma.transfers[0].cpu_bus_cycles,
  );
  assert.deepEqual(continued.cpu_bus.final, full.cpu_bus.final);
  assert.deepEqual(
    continued.mapper_trace.ppu_trace.final.oam,
    full.mapper_trace.ppu_trace.final.oam,
  );
  const unknown = (
    await invoke("trace-nes-code", {
      ...input,
      initial_apu: null,
      initial_cpu_dma: { ...input.initial_cpu_dma, cpu_phase: null },
    })
  ).normalized_result.code_trace;
  assert.equal(unknown.stop.reason, "cpu-dma-phase");
  assert.deepEqual(unknown.cpu_dma.transfers, []);
}
