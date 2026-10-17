import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent cycle/byte oracle for the actual public and installed consumers. */
export async function verifyPackageNesCpuIo(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 1, 0, 8]);
  bytes.set([0xad, 0x15, 0x40], 16 + 0x4355);
  bytes.writeUInt16LE(0xc345, 16 + 32768 - 2);
  for (let block = 0; block < 8; block++)
    bytes.set([0x35, 0xdb, 0xc1, 0xc1], 16 + 0x1a00 + block * 32 + 20);
  const path = join(workspace, "installed-2a03-io.nes");
  await writeFile(path, bytes);
  const base = inputFor(path),
    fullEvidence = await invoke("trace-nes-code", base),
    full = fullEvidence.normalized_result.code_trace;
  verifyDma(full, bytes);
  assert.equal(
    fullEvidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(
    (await invoke("explore-nes-code", base)).normalized_result.code_exploration
      .paths[0].trace,
    full,
  );
  assert.deepEqual(
    (
      await invoke("trace-nes-mapper-events", {
        path,
        initial: base.initial,
        initial_ppu: base.initial_ppu,
        initial_controllers: base.initial_controllers,
        initial_apu: base.initial_apu,
        events: full.mapper_trace.steps.map((step) => step.event),
      })
    ).normalized_result.trace,
    full.mapper_trace,
  );
  await verifyPrefixes(invoke, base, full);
  await verifyControllers(invoke, base);
  await verifyHeldControllers(invoke, base);
  const status = (
    await invoke("trace-nes-code", {
      ...base,
      entry: 0xc355,
      initial_cpu_dma: null,
      initial_ppu: null,
      initial_controllers: null,
      initial_apu: {
        ...base.initial_apu,
        frame_irq: { value: false, origin: { kind: "initial-state" } },
      },
      initial_cpu_bus: { ...base.initial_cpu_bus, next_cycle_index: 70000 },
    })
  ).normalized_result.code_trace;
  assert.equal(status.final_cpu.a, 0);
  assert.equal(status.cpu_bus.io.final.cpu_latch, 0);
  assert.equal(status.cpu_bus.io.final.external_latch, 0x40);
  assert.deepEqual(status.cpu_bus.io.final.latch_origins.external, [
    { mask: 255, source: { kind: "cycle", line: "external", index: 70002 } },
  ]);
  const future = (
    await invoke("trace-nes-code", {
      ...base,
      initial_cpu_io: {
        ...base.initial_cpu_io,
        latch_origins: {
          cpu: [
            { mask: 255, source: { kind: "cycle", line: "cpu", index: 50000 } },
          ],
          external: [
            { mask: 255, source: { kind: "initial-latch", line: "external" } },
          ],
        },
      },
    })
  ).normalized_result.code_trace;
  assert.equal(future.status, "unsupported");
  assert.match(future.reason, /precede/);
  const pal = (
    await invoke("trace-nes-code", {
      ...base,
      initial_cpu_dma: { ...base.initial_cpu_dma, region: "pal" },
    })
  ).normalized_result.code_trace;
  assert.equal(pal.status, "unsupported");
  assert.match(pal.reason, /2A07/);
  assert.deepEqual(await readFile(path), bytes);
  return {
    ok: true,
    workflows: 19,
    composite_reads: 24,
    io_profiles: 2,
    byte_sources: true,
    atomic_budget: true,
    original_unchanged: true,
    scope:
      "Conditional conventional 2A03 latches/controller enables/OAM conflicts; no PAL 2A07 decode, DMC arbitration, PPU scheduling, real Ghidra or physical observations",
  };
}

function inputFor(path) {
  const origin = { kind: "initial-state" };
  return {
    path,
    initial: { mapper: 0 },
    entry: 0x4010,
    max_instructions: 1,
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 50000,
    },
    initial_cpu_io: {
      model: "2a03-io",
      controller_clocking: "contiguous",
      active_controller: 0,
      cpu_latch: 0x20,
      external_latch: 0x80,
    },
    initial_cpu_dma: { model: "oam-cpu-dma", region: "ntsc", cpu_phase: "put" },
    initial_ppu: {
      model: "ppu-memory",
      register_writes_enabled: true,
      access_phase: "non-rendering",
      dma_reads: "absent",
      chr_ram_size: null,
      nametable_layout: "ciram-2k",
      mask: 0,
      control: 0,
      oam: {
        model: "oam-memory",
        address: 237,
        retention: "stable",
        reads: "supported",
        dma_pending: { status: "pending", page: 0x9a },
      },
    },
    initial_controllers: {
      model: "standard-controllers",
      dma_reads: "absent",
      strobe: false,
      oam_dma_pending: { status: "pending", page: 0x9a },
      buttons: [0x96, 0x69],
      ports: [0x96, 0x69].map((buttons, index) => ({
        serial_reports: [
          {
            position: 0,
            buttons,
            origin: { kind: "initial-report", port: index + 1 },
          },
        ],
      })),
    },
    initial_apu: {
      model: "apu-registers",
      frame_clocks: "cpu-ordered",
      dmc_reads: "absent",
      registers: { 16405: { value: 0, origin }, 16407: { value: 0, origin } },
      frame_irq: { value: true, origin },
      dmc_irq: { value: false, origin },
      frame_sequencer: {
        region: "ntsc",
        cpu_phase: "put",
        position: { min: 100, max: 100 },
        five_step: false,
        reset_delay: { min: 0, max: 0 },
        clock_block: 0,
      },
    },
  };
}

function verifyDma(trace, bytes) {
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "unsupported-opcode");
  assert.deepEqual(trace.instructions, []);
  const transfer = trace.cpu_dma.transfers[0];
  assert.equal(transfer.cpu_bus_cycles.length, 513);
  assert.equal(
    transfer.cpu_bus_cycles.filter((cycle) => cycle.dma_io).length,
    24,
  );
  const data = transfer.cpu_bus_cycles.slice(1);
  for (let index = 0; index < 256; index++) {
    const read = data[index * 2],
      put = data[index * 2 + 1],
      low = index & 31,
      block = index >> 5;
    assert.equal(read.read.address, 0x9a00 + index);
    assert.equal(read.read.file_offset, 16 + 0x1a00 + index);
    assert.equal(read.read.value, bytes[16 + 0x1a00 + index]);
    let value = read.read.value;
    if (low === 21) value = block === 0 ? 0x60 : 0x20;
    else if (low === 22) value = 0xc0 | ((0x96 >> block) & 1);
    else if (low === 23) value = 0xc0 | ((0x69 >> block) & 1);
    if (low >= 21 && low <= 23) {
      assert.equal(read.dma_io.decoded_address, 0x4000 | low);
      assert.equal(read.dma_io.cpu_value, value);
      assert.equal(
        read.dma_io.external_value,
        low === 21 ? read.read.value : value,
      );
      assert.equal(read.dma_io.internal_read.file_offset, null);
    }
    assert.equal(transfer.writes[put.write_index].value, value);
    const destination = (237 + index) & 255;
    assert.equal(
      trace.mapper_trace.ppu_trace.final.oam.cells[destination].value,
      value & (destination % 4 === 2 ? 227 : 255),
    );
  }
  assert.equal(trace.cpu_bus.final.next_cycle_index, 50513);
  assert.equal(trace.cpu_bus.io.final.cpu_latch, 2);
  assert.equal(trace.cpu_bus.io.final.external_latch, 2);
  assert.equal(trace.mapper_trace.apu_trace.final.frame_irq.value, false);
  assert.deepEqual(
    trace.mapper_trace.controller_trace.final.ports.map(
      (port) => port.serial_reports[0].position,
    ),
    [8, 8],
  );
}

async function verifyPrefixes(invoke, base, full) {
  const stopped = (
    await invoke("trace-nes-code", { ...base, max_oam_dma_source_bytes: 0 })
  ).normalized_result.code_trace;
  assert.equal(stopped.stop.reason, "oam-dma-source-budget");
  assert.deepEqual(stopped.cpu_dma.frontier.cpu_bus_cycles, []);
  assert.equal(stopped.cpu_bus.io.final.cpu_latch, 0x20);
  assert.equal(stopped.cpu_bus.io.final.external_latch, 0x80);
  assert.equal(stopped.cpu_bus.io.frontier.cpu_latch, 0x20);
  assert.equal(stopped.mapper_trace.apu_trace.final.frame_irq.value, true);
  const resumed = (
    await invoke("trace-nes-code", {
      ...base,
      entry: 0xc345,
      initial_cpu_bus: full.cpu_bus.final,
      initial_cpu_io: full.cpu_bus.io.final,
      initial_cpu_dma: full.cpu_dma.final,
      initial_ppu: full.mapper_trace.ppu_trace.final,
      initial_controllers: full.mapper_trace.controller_trace.final,
      initial_apu: full.mapper_trace.apu_trace.final,
    })
  ).normalized_result.code_trace;
  assert.deepEqual(resumed.cpu_bus.io.final, full.cpu_bus.io.final);
  assert.deepEqual(resumed.cpu_dma.transfers, []);
}

async function verifyControllers(invoke, base) {
  for (const clocking of ["contiguous", "per-cycle"]) {
    const input = {
      ...base,
      initial_cpu_dma: null,
      initial_apu: null,
      initial_ppu: null,
      initial_controllers: {
        ...base.initial_controllers,
        oam_dma_pending: { status: "none" },
      },
      initial_cpu_io: { ...base.initial_cpu_io, controller_clocking: clocking },
      initial_cpu_bus: { ...base.initial_cpu_bus, next_cycle_index: 60000 },
      cpu: { sp: 0xfd, i: false },
      entry: { accepted_interrupt: "irq", return_address: 0x4016 },
    };
    const trace = (await invoke("trace-nes-code", input)).normalized_result
      .code_trace;
    assert.equal(trace.entry_interrupt.cpu_bus_cycles.length, 7);
    assert.equal(
      trace.mapper_trace.controller_trace.final.ports[0].serial_reports[0]
        .position,
      clocking === "contiguous" ? 1 : 2,
    );
    assert.equal(
      trace.mapper_trace.steps.filter(
        (step) => step.event.kind === "controller-hold",
      ).length,
      clocking === "contiguous" ? 1 : 0,
    );
    assert.deepEqual(
      (
        await invoke("trace-nes-mapper-events", {
          path: base.path,
          initial: base.initial,
          initial_controllers: input.initial_controllers,
          events: trace.mapper_trace.steps.map((step) => step.event),
        })
      ).normalized_result.trace,
      trace.mapper_trace,
    );
  }
  const unknown = (
    await invoke("trace-nes-code", {
      ...base,
      initial_cpu_dma: null,
      initial_apu: null,
      initial_ppu: null,
      initial_controllers: {
        ...base.initial_controllers,
        oam_dma_pending: { status: "none" },
      },
      initial_cpu_io: { ...base.initial_cpu_io, active_controller: null },
      cpu: { sp: 0xfd },
      entry: { accepted_interrupt: "irq", return_address: 0x4016 },
    })
  ).normalized_result.code_trace;
  assert.equal(unknown.stop.reason, "cpu-io-controller-uncertain");
  assert.equal(unknown.entry_interrupt, null);
}

async function verifyHeldControllers(invoke, base) {
  for (const [strobe, live, mask, value] of [
    [true, 1, 225, 225],
    [null, 0, 225, 224],
    [null, 1, 224, 224],
  ]) {
    const input = {
      ...base,
      initial_cpu_dma: null,
      initial_apu: null,
      initial_ppu: null,
      cpu: { sp: 0xfd },
      entry: { accepted_interrupt: "irq", return_address: 0x4016 },
      initial_controllers: {
        ...base.initial_controllers,
        strobe,
        buttons: [live, 0x69],
        oam_dma_pending: { status: "none" },
        ports: [0xaa, 0x69].map((buttons, index) => ({
          serial_reports: [
            {
              position: 1,
              buttons,
              origin: { kind: "initial-report", port: index + 1 },
            },
          ],
        })),
      },
      initial_cpu_io: {
        ...base.initial_cpu_io,
        active_controller: 1,
        external_latch: 224,
        held_controller: {
          pin_value: strobe === true ? { mask: 1, value: 0 } : null,
          cycle_index: 49999,
          source: {
            kind: "standard-controller",
            port: 1,
            strobe: strobe === true ? false : null,
            live: { value: 1, origin: { kind: "initial-buttons", port: 1 } },
            serial_reports: [
              {
                position: 0,
                buttons: 0xaa,
                origin: { kind: "initial-report", port: 1 },
              },
            ],
            tail_bit: 1,
            dma_reads: "absent",
            reason: "unresolved-controller-bit",
          },
        },
      },
    };
    const trace = (await invoke("trace-nes-code", input)).normalized_result
      .code_trace;
    for (const cycle of trace.entry_interrupt.cpu_bus_cycles.slice(0, 2))
      assert.deepEqual(cycle.read.known_bits, { mask, value });
    const pads = trace.mapper_trace.controller_trace;
    assert.deepEqual(pads.final.ports, pads.initialized.ports);
    if (strobe === null) {
      const held = trace.mapper_trace.steps[0].event.held;
      assert.equal(held.source.live.value, live);
      assert.equal(held.source.serial_reports[0].position, 0);
      assert.equal(held.cycle_index, 49999);
    }
    assert.deepEqual(
      (
        await invoke("trace-nes-mapper-events", {
          path: base.path,
          initial: base.initial,
          initial_controllers: input.initial_controllers,
          events: trace.mapper_trace.steps.map((step) => step.event),
        })
      ).normalized_result.trace,
      trace.mapper_trace,
    );
  }
}
