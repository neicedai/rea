import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed frame-boundary and accepted-entry oracle; no source fixtures/models. */
export async function verifyPackageNesApuFrame(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 32768, 2),
    prg = 16,
    entry = 0xc234,
    origin = { kind: "initial-state" },
    zero = { value: { min: 0, max: 0 }, origin };
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 0, 0, 8]);
  bytes[11] = 7;
  bytes.set([173, 21, 64, 64], prg + entry - 0x8000);
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(entry, prg + 32768 - delta);
  const path = join(workspace, "packaged-apu-frame.nes");
  await writeFile(path, bytes);
  const profile = (region, position, five) => ({
    model: "apu-registers",
    frame_clocks: "cpu-ordered",
    dmc_reads: "absent",
    next_event_index: 1600,
    frame_sequencer: {
      region,
      position: { min: position, max: position },
      five_step: five,
      cpu_phase: "get",
      reset_delay: { min: 0, max: 0 },
      clock_block: 0,
    },
    registers: Object.fromEntries(
      [
        [0x4000, 0],
        [0x4001, 0],
        [0x4004, 0],
        [0x4005, 0],
        [0x4008, 0],
        [0x400c, 0],
        [0x4010, 0],
        [0x4015, 1],
        [0x4017, five ? 128 : 0],
      ].map(([address, value]) => [address, { value, origin }]),
    ),
    lengths: [{ value: { min: 1, max: 1 }, origin }, zero, zero, zero],
    dmc_remaining: zero,
    frame_irq: { value: false, origin },
    dmc_irq: { value: false, origin },
    pulse_timers: [
      { low: { value: 0, origin }, high: { value: 0, origin } },
      { low: { value: 0, origin }, high: { value: 0, origin } },
    ],
  });
  for (const [region, position, five, values] of [
    ["ntsc", 29827, false, [65, 64, 64]],
    ["pal", 41563, true, [1, 0, 0]],
  ]) {
    const input = {
        path,
        initial: { mapper: 0 },
        initial_apu: profile(region, position, five),
        events: Array.from({ length: 3 }, () => [
          { kind: "apu-cpu-cycle" },
          { kind: "cpu-read", address: 0x4015 },
        ]).flat(),
      },
      evidence = await invoke("trace-nes-mapper-events", input),
      mapped = evidence.normalized_result.trace;
    assert.equal(mapped.status, "derived");
    assert.equal(mapped.steps.length, 6);
    const reads = mapped.steps
      .filter((step) => step.cpu_read)
      .map((step) => step.cpu_read);
    assert.deepEqual(
      reads.map((read) => read.known_bits),
      values.map((value) => ({ mask: 223, value })),
    );
    assert.deepEqual(
      reads.map((read) => read.source.index),
      [1601, 1603, 1605],
    );
    assert.equal(
      mapped.apu_trace.operations.filter(
        (operation) => operation.frame_clock?.quarter,
      ).length,
      1,
    );
    assert.equal(
      mapped.apu_trace.operations.filter(
        (operation) => operation.frame_clock?.half,
      ).length,
      1,
    );
    assert.equal(
      mapped.apu_trace.operations.filter(
        (operation) => operation.frame_clock?.irq,
      ).length,
      five ? 0 : 3,
    );
    assert.deepEqual(mapped.apu_trace.final.frame_sequencer.position, {
      min: 0,
      max: 0,
    });
    assert.equal(mapped.apu_trace.final.next_event_index, 1606);
    const resumed = await invoke("trace-nes-mapper-events", {
        path,
        initial: mapped.final,
        initial_apu: mapped.apu_trace.final,
        events: [
          { kind: "cpu-write", address: 0x4017, value: 192 },
          { kind: "apu-cpu-cycle" },
          { kind: "apu-cpu-cycle" },
        ],
      }),
      pending = resumed.normalized_result.trace.apu_trace;
    assert.deepEqual(pending.final.frame_sequencer.reset_delay, {
      min: 2,
      max: 2,
    });
    assert.equal(
      pending.operations[0].effects.includes("quarter-clock"),
      false,
    );
    const complete = await invoke("trace-nes-mapper-events", {
        path,
        initial: mapped.final,
        initial_apu: pending.final,
        events: [{ kind: "apu-cpu-cycle" }, { kind: "apu-cpu-cycle" }],
      }),
      reset = complete.normalized_result.trace.apu_trace;
    assert.deepEqual(reset.final.frame_sequencer.reset_delay, {
      min: 0,
      max: 0,
    });
    assert.deepEqual(reset.final.frame_sequencer.position, { min: 0, max: 0 });
    assert.deepEqual(reset.operations.at(-1).frame_clock, {
      quarter: true,
      half: true,
      irq: false,
      reset: true,
    });
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
  for (const stopped of [false, true]) {
    const sourceBytes = Buffer.from(bytes);
    if (stopped) sourceBytes[prg + entry - 0x8000] = 2;
    const sourcePath = join(
      workspace,
      stopped ? "packaged-entry-stop.nes" : "packaged-entry-status.nes",
    );
    await writeFile(sourcePath, sourceBytes);
    const input = {
      path: sourcePath,
      initial: { mapper: 0 },
      cpu: { sp: 1 },
      entry: { accepted_interrupt: "nmi", return_address: 0x9246 },
      initial_apu: {
        model: "apu-registers",
        frame_clocks: "explicit",
        next_event_index: 613,
        dmc_remaining: { value: { min: 1, max: 1 }, origin },
        registers: { [0x4010]: { value: 128, origin } },
      },
      initial_ppu: {
        model: "ppu-memory",
        chr_ram_size: 8192,
        nametable_layout: "ciram-2k",
        next_event_index: 213,
      },
      initial_controllers: {
        model: "standard-controllers",
        next_event_index: 413,
        dma_reads: "absent",
        oam_dma_pending: { status: "none" },
      },
    };
    const evidence = await invoke("trace-nes-code", input),
      code = evidence.normalized_result.code_trace,
      mapped = code.mapper_trace;
    assert.equal(code.status, "derived");
    assert.equal(code.stop.reason, "unsupported-opcode");
    assert.deepEqual(code.entry_interrupt.mapper_event_range, {
      start: 0,
      count: 3,
    });
    assert.deepEqual(
      mapped.steps.slice(0, 3).map((step) => step.event.address),
      [257, 256, 511],
    );
    assert.equal(
      mapped.apu_trace.final.next_event_index,
      613 + mapped.steps.length,
    );
    assert.equal(
      mapped.ppu_trace.final.next_event_index,
      213 + mapped.steps.length,
    );
    assert.equal(
      mapped.controller_trace.final.next_event_index,
      413 + mapped.steps.length,
    );
    if (!stopped) {
      assert.equal(code.stop.address, 0x9246);
      assert.equal(code.final_cpu.sp, 1);
      assert.deepEqual(code.instructions[0].mapper_event_range, {
        start: 3,
        count: 1,
      });
      assert.equal(
        code.instructions[0].data_reads[0].mapper_origins[0].index,
        616,
      );
      assert.equal(mapped.steps[3].cpu_read.source.index, 616);
    }
    for (const instruction of code.instructions)
      for (const [index, offset] of instruction.file_offsets.entries())
        assert.equal(
          sourceBytes[offset],
          parseInt(instruction.bytes_hex.slice(index * 2, index * 2 + 2), 16),
        );
    const replay = await invoke("trace-nes-mapper-events", {
      path: input.path,
      initial: input.initial,
      initial_apu: input.initial_apu,
      initial_ppu: input.initial_ppu,
      initial_controllers: input.initial_controllers,
      events: mapped.steps.map((step) => step.event),
    });
    assert.deepEqual(replay.normalized_result.trace, mapped);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      code,
    );
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(sourceBytes).digest("hex"),
    );
    assert.deepEqual(await readFile(sourcePath), sourceBytes);
  }
  assert.deepEqual(await readFile(path), bytes);
  return {
    workflows: 4,
    conditional_cpu_frame_sequencer: true,
    accepted_entry_event_identity: true,
    original_unchanged: true,
  };
}
