import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed audio-control oracle, without source fixtures or APU helpers. */
export async function verifyPackageNesApu(invoke, workspace) {
  const pairs = [
    [0x4000, 7],
    [0x4001, 138],
    [0x4002, 239],
    [0x4003, 251],
    [0x4004, 50],
    [0x4005, 132],
    [0x4006, 255],
    [0x4007, 19],
    [0x4008, 147],
    [0x400a, 42],
    [0x400b, 43],
    [0x400c, 60],
    [0x400e, 130],
    [0x400f, 56],
    [0x4010, 64],
    [0x4011, 115],
    [0x4012, 49],
    [0x4013, 3],
    [0x4017, 0],
  ];
  const bytes = Buffer.alloc(16 + 32768, 2),
    prg = 16;
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 0]);
  const program = [[0x4015, 0], [0x4015, 15], ...pairs].flatMap(
    ([address, value]) => [169, value, 141, address & 255, address >> 8],
  );
  program.push(44, 21, 64, 80, 3, 169, 129, 96, 169, 66, 96);
  bytes.set(program, prg + 0x4100);
  bytes.writeUInt16LE(0xc100, prg + 32768 - 4);
  const path = join(workspace, "packaged-apu-controls.nes"),
    origin = { kind: "initial-state" },
    zero = { value: { min: 0, max: 0 }, origin };
  await writeFile(path, bytes);
  for (const irq of [false, true]) {
    const input = {
      path,
      initial: { mapper: 0 },
      initial_apu: {
        model: "apu-registers",
        frame_clocks: "explicit",
        next_event_index: 711,
        frame_irq: { value: irq, origin },
        sweeps: [{ divider: zero }, { divider: zero }],
      },
    };
    const evidence = await invoke("trace-nes-code", input),
      code = evidence.normalized_result.code_trace;
    assert.equal(code.status, "derived");
    assert.equal(code.stop.reason, "return");
    assert.equal(code.final_cpu.a, irq ? 129 : 66);
    const mapped = code.mapper_trace,
      apu = mapped.apu_trace;
    assert.equal(mapped.mapper_snapshots.length, 1);
    assert.deepEqual(
      apu.final.lengths.map((fact) => fact.value),
      [30, 20, 4, 6].map((value) => ({ min: value, max: value })),
    );
    assert.deepEqual(
      apu.final.pulse_timers.map((timer) => [
        timer.low.value,
        timer.high.value,
      ]),
      [
        [239, 3],
        [255, 3],
      ],
    );
    const read = code.instructions.find(
      (instruction) => instruction.mnemonic === "BIT",
    ).data_reads[0];
    assert.equal(read.file_offset, null);
    assert.deepEqual(read.ram_origins, []);
    assert.deepEqual(read.known_bits, { mask: 223, value: irq ? 79 : 15 });
    assert.equal(read.mapper_origins[0].kind, "apu-status");
    assert.deepEqual(read.mapper_origins[0].frame_irq, { value: irq, origin });
    assert.equal(apu.final.frame_irq.value, false);
    for (const instruction of code.instructions)
      for (const [index, offset] of instruction.file_offsets.entries())
        assert.equal(
          bytes[offset],
          parseInt(instruction.bytes_hex.slice(index * 2, index * 2 + 2), 16),
        );
    for (const [address, value] of pairs) {
      const fact = apu.final.registers[address],
        event = mapped.steps[fact.origin.index - 711].event;
      assert.equal(fact.value, value);
      assert.equal(event.kind, "cpu-write");
      assert.equal(event.address, address);
      assert.equal(event.value, value);
    }
    assert.equal(apu.final.next_event_index, 711 + mapped.steps.length);
    const replay = await invoke("trace-nes-mapper-events", {
      ...input,
      events: mapped.steps.map((step) => step.event),
    });
    assert.deepEqual(replay.normalized_result.trace, mapped);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      code,
    );
    const continuation = await invoke("trace-nes-mapper-events", {
        path,
        initial: mapped.final,
        initial_apu: apu.final,
        events: [{ kind: "apu-frame-clock", clock: "quarter-half" }],
      }),
      final = continuation.normalized_result.trace.apu_trace.final;
    assert.deepEqual(
      final.lengths.map((fact) => fact.value),
      [29, 20, 4, 6].map((value) => ({ min: value, max: value })),
    );
    assert.deepEqual(
      final.pulse_timers.map((timer) => [timer.low.value, timer.high.value]),
      [
        [755 & 255, 755 >> 8],
        [1086 & 255, 1086 >> 8],
      ],
    );
    assert.deepEqual(
      final.envelopes.map((unit) => unit.decay.value),
      [15, 15, 15].map((value) => ({ min: value, max: value })),
    );
    assert.deepEqual(
      final.envelopes.map((unit) => unit.divider.value),
      [7, 2, 12].map((value) => ({ min: value, max: value })),
    );
    assert.deepEqual(final.triangle_linear.value, { min: 19, max: 19 });
    assert.equal(final.triangle_reload.value, true);
    const reset = await invoke("trace-nes-mapper-events", {
        path,
        initial: mapped.final,
        initial_apu: final,
        events: [
          { kind: "cpu-write", address: 0x4017, value: 128 },
          { kind: "apu-frame-reset" },
          { kind: "apu-frame-clock", clock: "irq" },
        ],
      }),
      resetTrace = reset.normalized_result.trace.apu_trace;
    assert.ok(resetTrace.operations[0].effects.includes("frame-reset-queued"));
    assert.ok(!resetTrace.operations[0].effects.includes("half-clock"));
    assert.deepEqual(resetTrace.final.lengths[0].value, { min: 28, max: 28 });
    assert.equal(resetTrace.final.frame_reset_pending.value, false);
    assert.equal(resetTrace.final.frame_irq.value, false);
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(await readFile(path), bytes);
  }
  const looping = await invoke("trace-nes-mapper-events", {
    path,
    initial: { mapper: 0 },
    initial_apu: {
      model: "apu-registers",
      frame_clocks: "explicit",
      dmc_reads: "absent",
      dmc_remaining: zero,
      frame_irq: { value: true, origin },
      registers: { [0x4017]: { value: 0, origin } },
    },
    events: [
      { kind: "cpu-write", address: 0x4013, value: 0 },
      { kind: "cpu-write", address: 0x4010, value: 192 },
      { kind: "cpu-write", address: 0x4015, value: 16 },
      { kind: "cpu-read", address: 0x4015 },
    ],
  });
  const trace = looping.normalized_result.trace;
  assert.deepEqual(trace.steps.at(-1).cpu_read.known_bits, {
    mask: 159,
    value: 16,
  });
  assert.equal(trace.steps.at(-1).cpu_read.source.frame_irq.value, null);
  assert.equal(trace.steps.at(-1).cpu_read.source.dmc_irq.value, false);
  assert.deepEqual(trace.apu_trace.final.dmc_remaining.value, {
    min: 1,
    max: 1,
  });
  assert.equal(trace.apu_trace.final.frame_irq.value, false);
  return {
    workflows: 3,
    conditional_apu_registers: true,
    original_unchanged: true,
  };
}
