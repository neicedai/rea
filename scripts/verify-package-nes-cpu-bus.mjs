import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Installed source oracle with independently addressed MMC3 windows; no source models or fixtures. */
export async function verifyPackageNesCpuBus(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 131072 + 8192, 2),
    prg = 16,
    entry = 0xe345;
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 1, 64, 8]);
  bytes.set([32, 254, 159, 2], prg + 15 * 8192 + 0x345);
  bytes.set([32, 86], prg + 3 * 8192 + 0x1ffe);
  bytes.set([196, 169, 115, 96], prg + 8 * 8192);
  bytes.set([169, 70, 141, 0, 128], prg + 14 * 8192 + 0x456);
  bytes[prg + 3 * 8192 + 0x45b] = 96;
  const path = join(workspace, "installed-mmc3-bus.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    initial: { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 3, 8] },
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 30000,
    },
    entry,
    cpu: { sp: 0xfd },
  };
  const evidence = await invoke("trace-nes-code", input),
    trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.deepEqual(
    trace.instructions.map((i) => i.address),
    [0xe345, 0x9ffe, 0xc456, 0xc458, 0xc45b, 0xa001, 0xa003],
  );
  assert.deepEqual(
    trace.instructions.map((i) => i.cpu_bus_cycles.length),
    [6, 6, 2, 4, 6, 2, 6],
  );
  assert.deepEqual(trace.instructions[1].file_offsets, [
    prg + 3 * 8192 + 0x1ffe,
    prg + 3 * 8192 + 0x1fff,
    prg + 8 * 8192,
  ]);
  assert.deepEqual(
    trace.instructions[1].cpu_bus_cycles.map((cycle) => cycle.role),
    ["opcode", "operand", "dummy", "stack", "stack", "operand"],
  );
  let mode = 0,
    cycleIndex = 30000,
    verifiedReads = 0;
  const stack = new Map();
  for (const instruction of trace.instructions) {
    for (const cycle of instruction.cpu_bus_cycles) {
      assert.equal(cycle.index, cycleIndex++);
      if (cycle.kind === "write") {
        const write = instruction.writes[cycle.write_index];
        if (write.address === 0x8000) mode = 1;
        if (write.address < 8192)
          stack.set(write.address & 2047, {
            value: write.value,
            instruction_index: instruction.index,
            write_index: cycle.write_index,
          });
      } else if (cycle.read.address >= 0x8000) {
        const address = cycle.read.address,
          bank =
            address >= 0xe000
              ? 15
              : address >= 0xc000
                ? mode
                  ? 3
                  : 14
                : address >= 0xa000
                  ? 8
                  : mode
                    ? 14
                    : 3;
        const offset = prg + bank * 8192 + (address & 8191);
        assert.equal(cycle.read.file_offset, offset);
        assert.equal(cycle.read.value, bytes[offset]);
        verifiedReads++;
      } else if (stack.has(cycle.read.address & 2047)) {
        const fact = stack.get(cycle.read.address & 2047);
        assert.equal(cycle.read.value, fact.value);
        assert.deepEqual(cycle.read.ram_origins, [
          {
            byte_index: 0,
            region: "internal-ram",
            ram_address: cycle.read.address & 2047,
            instruction_index: fact.instruction_index,
            write_index: fact.write_index,
          },
        ]);
        verifiedReads++;
      }
    }
  }
  assert.equal(trace.final_cpu.a, 115);
  assert.equal(trace.final_cpu.sp, 0xfd);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 30032);
  assert.equal(trace.stop.cpu_bus_frontier.cycles[0].index, 30032);
  const explored = await invoke("explore-nes-code", input);
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  const replay = await invoke("trace-nes-mapper-writes", {
    path,
    initial: input.initial,
    writes: trace.instructions
      .flatMap((i) => i.writes)
      .filter((write) => write.address >= 0x8000),
  });
  assert.deepEqual(
    replay.normalized_result.trace.final_mapping,
    trace.mapper_trace.final_mapping,
  );
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await readFile(path), bytes);
  const self = (
    await invoke("trace-nes-code", {
      ...input,
      entry: 0x15f,
      cpu: { sp: 0x61 },
      max_instructions: 1,
      initial_ram: [
        { address: 0x15f, value: 32 },
        { address: 0x160, value: 119 },
        { address: 0x161, value: 128 },
      ],
    })
  ).normalized_result.code_trace;
  assert.equal(self.status, "derived");
  assert.equal(self.instructions[0].bytes_hex, "207701");
  assert.equal(self.instructions[0].next_address, 0x177);
  assert.deepEqual(self.instructions[0].ram_origins[2], {
    byte_index: 2,
    region: "internal-ram",
    ram_address: 0x161,
    instruction_index: 0,
    write_index: 0,
  });
  assert.deepEqual(
    self.instructions[0].cpu_bus_cycles.map((cycle) => cycle.role),
    ["opcode", "operand", "dummy", "stack", "stack", "operand"],
  );
  const apu = await verifySourceApu(invoke, workspace);
  return {
    ok: true,
    workflows: 8,
    committed_bus_cycles: 32,
    source_verified_reads: verifiedReads,
    apu,
    scope:
      "Installed CLI nominal source bus, bank windows and scheduled APU frames; no real Ghidra, DMA stalls or hardware observations",
  };
}

async function verifySourceApu(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 32768, 2),
    origin = { kind: "initial-state" },
    entry = 0xc567;
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 0, 0, 8]);
  bytes.set([44, 21, 64, 2], 16 + entry - 0x8000);
  const path = join(workspace, "installed-source-apu-bus.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    entry,
    initial: { mapper: 0 },
    initial_cpu_bus: { model: "nmos-6502-bus", dma_reads: "absent" },
    cpu: { a: 0 },
    initial_apu: {
      model: "apu-registers",
      frame_clocks: "cpu-ordered",
      dmc_reads: "absent",
      next_event_index: 1200,
      registers: { 16407: { value: 0, origin } },
      frame_irq: { value: false, origin },
      frame_sequencer: {
        region: "pal",
        position: { min: 33249, max: 33249 },
        five_step: false,
        cpu_phase: "put",
        reset_delay: { min: 0, max: 0 },
        clock_block: 0,
      },
    },
  };
  const evidence = await invoke("trace-nes-code", input),
    trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.instructions[0].cpu_after.v, true);
  assert.equal(trace.instructions[0].data_reads[0].known_bits.value & 64, 64);
  assert.equal(trace.mapper_trace.apu_trace.final.frame_irq.value, true);
  assert.deepEqual(
    trace.mapper_trace.steps.map((step) => step.event.kind),
    [
      "apu-cpu-cycle",
      "apu-cpu-cycle",
      "apu-cpu-cycle",
      "cpu-read",
      "apu-cpu-cycle",
    ],
  );
  assert.equal(trace.cpu_bus.final.next_cycle_index, 4);
  const replay = await invoke("trace-nes-mapper-events", {
    path,
    initial: input.initial,
    initial_apu: input.initial_apu,
    events: trace.mapper_trace.steps.map((step) => step.event),
  });
  assert.deepEqual(
    replay.normalized_result.trace.apu_trace.final,
    trace.mapper_trace.apu_trace.final,
  );
  assert.deepEqual(
    (await invoke("explore-nes-code", input)).normalized_result.code_exploration
      .paths[0].trace,
    trace,
  );
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await readFile(path), bytes);
  const handler = Buffer.from(bytes);
  handler[16 + entry - 0x8000] = 64;
  for (const delta of [6, 4, 2])
    handler.writeUInt16LE(entry, 16 + 32768 - delta);
  const handlerPath = join(workspace, "installed-source-entry-bus.nes");
  await writeFile(handlerPath, handler);
  const interrupt = (
    await invoke("trace-nes-code", {
      ...input,
      path: handlerPath,
      entry: { accepted_interrupt: "irq", return_address: 0xc5f0 },
      cpu: { sp: 0, i: false },
      max_instructions: 1,
      initial_apu: {
        ...input.initial_apu,
        frame_sequencer: {
          ...input.initial_apu.frame_sequencer,
          position: { min: 100, max: 100 },
        },
      },
    })
  ).normalized_result.code_trace;
  assert.equal(interrupt.status, "derived");
  assert.equal(interrupt.entry_interrupt.cpu_bus_cycles.length, 7);
  assert.deepEqual(interrupt.entry_interrupt.mapper_event_range, {
    start: 0,
    count: 7,
  });
  assert.equal(interrupt.instructions[0].cpu_bus_cycles.length, 6);
  assert.deepEqual(interrupt.instructions[0].mapper_event_range, {
    start: 7,
    count: 6,
  });
  assert.equal(interrupt.final_cpu.sp, 0);
  assert.equal(interrupt.final_cpu.i, false);
  assert.equal(interrupt.instructions[0].next_address, 0xc5f0);
  assert.equal(interrupt.cpu_bus.final.next_cycle_index, 13);
  assert.deepEqual(
    interrupt.mapper_trace.apu_trace.final.frame_sequencer.position,
    { min: 113, max: 113 },
  );
  assert.deepEqual(await readFile(handlerPath), handler);
  return {
    ok: true,
    region: "pal",
    read_before_fourth_edge: true,
    committed_edges: 4,
  };
}
