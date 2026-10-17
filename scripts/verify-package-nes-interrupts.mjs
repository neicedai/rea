import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed CLI oracle: IRQ handler switches the window containing its own RTI. */
export async function verifyPackageNesInterrupts(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 131072 + 8192, 2),
    prg = 16;
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 1, 64, 8]);
  bytes.set([0x58, 0xea, 0xea], prg + 15 * 8192 + 0x345);
  bytes.set([0xa9, 0x46, 0x8d, 0, 0x80], prg + 14 * 8192 + 0x456);
  bytes[prg + 3 * 8192 + 0x45b] = 0x40;
  bytes.writeUInt16LE(0xc456, prg + 131072 - 2);
  const path = join(workspace, "installed-irq-bank-switch.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    entry: 0xe345,
    initial: { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 3, 8] },
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 50000,
    },
    initial_interrupts: {
      model: "nmos-6502-interrupts",
      external_irq: true,
      nmi_edges: "absent",
      pending_irq: false,
      pending_nmi: false,
    },
    cpu: { sp: 0xfd, i: true },
    max_instructions: 5,
  };
  const evidence = await invoke("trace-nes-code", input),
    trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.deepEqual(
    trace.instructions.map((i) => i.address),
    [0xe345, 0xe346, 0xc456, 0xc458, 0xc45b],
  );
  assert.deepEqual(
    trace.instructions.map((i) => i.cpu_bus_cycles.length),
    [2, 2, 2, 4, 6],
  );
  assert.equal(trace.instructions[2].file_offsets[0], prg + 14 * 8192 + 0x456);
  assert.equal(trace.instructions[4].file_offsets[0], prg + 3 * 8192 + 0x45b);
  assert.deepEqual(
    trace.interrupts.polls.map((p) => p.pending_irq),
    [false, true, false, false, true],
  );
  const entry = trace.interrupts.entries[0];
  assert.equal(entry.return_address, 0xe347);
  assert.equal(entry.target_address, 0xc456);
  assert.equal(entry.before_instruction_index, 2);
  assert.deepEqual(
    entry.writes.map((w) => w.address),
    [0x1fd, 0x1fc, 0x1fb],
  );
  assert.deepEqual(
    entry.writes.slice(0, 2).map((w) => w.value),
    [0xe3, 0x47],
  );
  assert.deepEqual(entry.writes[2].known_bits, { mask: 0x34, value: 0x20 });
  assert.deepEqual(
    entry.cpu_bus_cycles.map((c) => c.role),
    ["dummy", "dummy", "stack", "stack", "stack", "vector", "vector"],
  );
  assert.deepEqual(
    entry.interrupt_vector.map((r) => r.file_offset),
    [prg + 131072 - 2, prg + 131072 - 1],
  );
  assert.equal(trace.cpu_bus.final.next_cycle_index, 50023);
  assert.equal(trace.final_cpu.sp, 0xfd);
  assert.equal(trace.stop.address, 0xe347);
  assert.deepEqual(
    trace.instructions[4].data_reads.map(
      (r) => r.ram_origins[0].interrupt_write_index,
    ),
    [2, 1, 0],
  );
  assert.deepEqual(
    (await invoke("explore-nes-code", input)).normalized_result.code_exploration
      .paths[0].trace,
    trace,
  );
  assert.deepEqual(
    (
      await invoke("trace-nes-mapper-events", {
        path,
        initial: input.initial,
        events: trace.mapper_trace.steps.map((s) => s.event),
      })
    ).normalized_result.trace,
    trace.mapper_trace,
  );
  const prefix = (
    await invoke("trace-nes-code", { ...input, max_instructions: 2 })
  ).normalized_result.code_trace;
  const continued = (
    await invoke("trace-nes-code", {
      ...input,
      entry: prefix.stop.address,
      cpu: prefix.final_cpu,
      initial_cpu_bus: prefix.cpu_bus.final,
      initial_interrupts: prefix.interrupts.final,
      max_instructions: 3,
    })
  ).normalized_result.code_trace;
  assert.deepEqual(
    continued.interrupts.entries[0].cpu_bus_cycles,
    entry.cpu_bus_cycles,
  );
  assert.deepEqual(continued.final_cpu, trace.final_cpu);
  const uncertain = (
    await invoke("trace-nes-code", {
      ...input,
      initial_interrupts: { ...input.initial_interrupts, pending_nmi: null },
    })
  ).normalized_result.code_trace;
  assert.equal(uncertain.stop.reason, "interrupt-uncertain");
  assert.equal(uncertain.instructions.length, 0);
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await readFile(path), bytes);
  return {
    ok: true,
    workflows: 7,
    irq_bank_switch: true,
    pending_continuation: true,
    original_unchanged: true,
    scope:
      "Installed conditional nominal IRQ polling and entry; no PPU NMI edges, DMA stalls, hardware or real Ghidra verification",
  };
}
