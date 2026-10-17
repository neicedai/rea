import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent source ROM/state fixtures and byte/cycle assertions. */
export async function createDmcSourceFixture(workspace) {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 1, 0, 8]);
  bytes.set([0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0xea], 16 + 0x4345);
  bytes.set([0xad, 7, 0x20, 0xad, 0x16, 0x40, 0x29, 1], 16 + 0x434c);
  bytes[16 + 0x4480] = 0xea;
  bytes.set([0xee, 0x10, 0, 0xea], 16 + 0x4500);
  bytes.set([0xd0, 2, 0xea, 0xea, 0xea], 16 + 0x4580);
  bytes.set([0x8d, 0x15, 0x40, 0xea, 0xea, 0xea], 16 + 0x4600);
  bytes.set([0x0e, 0x15, 0x40, 0xea], 16 + 0x4640);
  bytes.set([0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0xea, 0xea, 2], 16 + 0x4680);
  bytes.set(
    [0xa9, 16, 0x8d, 0x15, 0x40, 0xea, 0x8d, 0x10, 0, 0xea],
    16 + 0x46c0,
  );
  bytes[16 + 0x49c0] = 0x5d;
  bytes[16 + 0x49d5] = 0xe3;
  bytes[16 + 0x4a00] = 0x96;
  for (let index = 0; index < 256; index++)
    bytes[16 + 0x1200 + index] = (index * 17 + 0x36) & 255;
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0xc345, 16 + 32768 - delta);
  const path = join(workspace, "dmc-source-timing.nes");
  await writeFile(path, bytes);
  const digest = createHash("sha256").update(bytes).digest("hex");
  return { bytes, path, digest };
}

export function roles(cycles) {
  return cycles.map(({ kind, role }) => (kind === "read" ? role : kind));
}
export function assertAtomicBudget(trace, index) {
  assert.equal(trace.stop.reason, "dmc-dma-source-budget");
  assert.deepEqual(trace.instructions, []);
  assert.equal(trace.cpu_bus.final.next_cycle_index, index);
  assert.deepEqual(trace.cpu_bus.dmc.transfers, []);
}
export function assertTransfer(
  trace,
  { type, first, sample },
  { address = 0xc9c0, value = 0x5d } = {},
) {
  const transfer = trace.cpu_bus.dmc.transfers[0];
  assert.equal(transfer.type, type);
  assert.equal(transfer.first_cycle_index, first);
  assert.equal(transfer.sample_cycle_index, sample);
  const step = trace.mapper_trace.steps[transfer.mapper_event_index];
  assert.equal(step.event.kind, "apu-dmc-cpu-read");
  assert.equal(step.event.address, address);
  assert.equal(step.event.cycle_index, sample);
  assert.equal(step.dmc_read.value, value);
  assert.equal(step.dmc_read.source.kind, "cpu-dma");
  assert.equal(step.dmc_read.source.cycle_index, sample);
  assert.equal("file_offset" in step.dmc_read, false);
  assert.equal(trace.mapper_trace.apu_trace.final.dmc.buffer.value, value);
  assert.deepEqual(trace.mapper_trace.apu_trace.final.dmc.buffer.origin, {
    kind: "dmc-read",
    index: step.dmc_read.source.index,
  });
  const cycle = committedCycles(trace).find((cycle) => cycle.index === sample);
  assert.equal(cycle.role, "dmc-get");
  assert.equal(cycle.read.address, address);
}
export function verifyRawSources(trace, bytes) {
  for (const instruction of trace.instructions)
    for (const [index, value] of Buffer.from(
      instruction.bytes_hex,
      "hex",
    ).entries())
      assert.equal(bytes[instruction.file_offsets[index]], value);
  const cycles = committedCycles(trace).sort((a, b) => a.index - b.index);
  assert.equal(
    cycles.length,
    trace.cpu_bus.final.next_cycle_index -
      trace.cpu_bus.initial.next_cycle_index,
  );
  assert.equal(new Set(cycles.map((cycle) => cycle.index)).size, cycles.length);
  for (const [index, cycle] of cycles.entries())
    assert.equal(cycle.index, trace.cpu_bus.initial.next_cycle_index + index);
  assert.equal(
    trace.mapper_trace.steps.filter(
      (step) => step.event.kind === "apu-cpu-cycle",
    ).length,
    cycles.length,
  );
  for (const cycle of cycles)
    if (
      cycle.kind === "read" &&
      cycle.read.file_offset !== null &&
      cycle.read.file_offset !== undefined
    ) {
      assert.equal(cycle.read.file_offset, 16 + cycle.read.address - 0x8000);
      assert.equal(cycle.read.value, bytes[cycle.read.file_offset]);
    }
}
function committedCycles(trace) {
  return [
    ...trace.instructions.flatMap(
      (instruction) => instruction.cpu_bus_cycles ?? [],
    ),
    ...(trace.cpu_bus?.dmc?.boundary_cycles ?? []),
    ...(trace.cpu_dma?.transfers.flatMap(
      (transfer) => transfer.cpu_bus_cycles,
    ) ?? []),
  ];
}
export function apu(phase = "get", pending = false) {
  const origin = { kind: "initial-state" };
  return {
    model: "apu-registers",
    frame_clocks: "cpu-ordered",
    dmc_reads: "explicit",
    registers: Object.fromEntries(
      [
        [0x4010, 128],
        [0x4012, 39],
        [0x4013, 0],
        [0x4015, pending ? 16 : 0],
        [0x4017, 64],
      ].map(([address, value]) => [address, { value, origin }]),
    ),
    dmc_remaining: {
      value: { min: pending ? 1 : 0, max: pending ? 1 : 0 },
      origin,
    },
    dmc_irq: { value: false, origin },
    frame_irq: { value: false, origin },
    frame_sequencer: {
      region: "ntsc",
      cpu_phase: phase,
      position: { min: 0, max: 0 },
      five_step: false,
      reset_delay: { min: 0, max: 0 },
      clock_block: 0,
    },
    dmc: {
      model: "dmc-reader-output",
      region: "ntsc",
      clocks: "cpu-ordered",
      current_address: 0xc9c0,
      buffer: { status: "empty" },
      shift: 0,
      bits_remaining: 8,
      silence: true,
      level: 64,
      timer_remaining: 428,
      cpu_timing: {
        model: "2a03-dmc-dma",
        stop: { status: "none" },
        request: pending
          ? { status: "pending", type: "load", delay: 0 }
          : { status: "none" },
      },
    },
  };
}
export function reloadApu(timer) {
  const state = apu();
  state.registers[16405].value = 16;
  state.registers[16403].value = 1;
  state.dmc_remaining.value = { min: 2, max: 2 };
  Object.assign(state.dmc, {
    bits_remaining: 1,
    timer_remaining: timer,
    buffer: { status: "full", value: 0x6a, origin: { kind: "initial-state" } },
  });
  return state;
}
