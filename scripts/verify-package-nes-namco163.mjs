import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed-CLI oracle, with different banks/bytes from source fixtures. */
export async function verifyPackageNamco163(invoke, workspace) {
  for (const storage of [7, 0x70]) {
    const prgOffset = 16,
      prgSize = 524288,
      chrOffset = prgOffset + prgSize;
    const bytes = Buffer.alloc(chrOffset + 262144, 2);
    bytes.fill(0, 0, 16);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      32,
      32,
      0x30 | (storage === 0x70 ? 2 : 0),
      0x18,
      0x30,
      0,
      storage,
    ]);
    const program = [];
    const store = (address, value) =>
      program.push(0xa9, value, 0x8d, address & 255, address >> 8);
    store(0xe7ff, 0xe5);
    store(0xefff, 0x75);
    store(0xf7ff, 0xbd);
    store(0xffff, 0x40);
    [0xa9, 0x88, 0x60].forEach((value, i) => store(0x6100 + i, value));
    const addresses = [0x6000, 0x6800, 0x7000, 0x7800];
    addresses.forEach((address, i) => store(address, 0xa0 + i));
    store(0xf800, 0x4a);
    addresses.forEach((address, i) => store(address, 0xb0 + i));
    store(0x4fff, 0x12);
    for (let i = 0; i < 8; i++) store(0x8000 + i * 2048, 0xe0 + i);
    [224, 225, 1, 3].forEach((value, i) => store(0xc000 + i * 2048, value));
    store(0xf800, 0x4f);
    program.push(0xee, 1, 0x61, 0x20, 0, 0x61);
    addresses.forEach((address, i) =>
      program.push(0xad, address & 255, address >> 8, 0x85, 0x10 + i),
    );
    program.push(0x4c, 0xff, 0x9f);
    bytes.set(program, prgOffset + 63 * 8192 + 0x100);
    bytes[prgOffset + 38 * 8192 - 1] = 0xa9;
    bytes.set([0x5a, 0x4c, 0xff, 0xbf], prgOffset + 53 * 8192);
    bytes[prgOffset + 54 * 8192 - 1] = 0xa9;
    bytes.set([0x66, 0x4c, 0x10, 0x80], prgOffset + 61 * 8192);
    bytes.set(
      [0xa9, 0x74, 0x8d, 0xff, 0xef, 0x4c, 0x10, 0xa0],
      prgOffset + 37 * 8192 + 16,
    );
    bytes.set([0xa9, 0x77, 0x60], prgOffset + 52 * 8192 + 16);
    bytes.writeUInt16LE(0xe100, prgOffset + prgSize - 4);
    const path = join(workspace, `installed-namco163-${storage}.nes`);
    await writeFile(path, bytes);
    const input = {
      path,
      initial: { mapper: 19, variant: "namco163" },
      cpu: { sp: 255 },
    };
    const evidence = await invoke("trace-nes-code", input),
      trace = evidence.normalized_result.code_trace;
    assert.ok(
      evidence.normalized_result.limitations.some((v) =>
        v.includes("Namco 129/163"),
      ),
    );
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(trace.status, "derived");
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.final_cpu.a, 0x77);
    assert.deepEqual(
      trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
      [37, 52, 61, 63],
    );
    assert.deepEqual(
      trace.instructions.find((i) => i.address === 0x9fff).file_offsets,
      [prgOffset + 38 * 8192 - 1, prgOffset + 53 * 8192],
    );
    assert.deepEqual(
      trace.instructions.find((i) => i.address === 0xbfff).file_offsets,
      [prgOffset + 54 * 8192 - 1, prgOffset + 61 * 8192],
    );
    assert.deepEqual(
      trace.instructions
        .flatMap((i) => i.data_reads)
        .filter((r) => addresses.includes(r.address))
        .map((r) => r.value),
      [0xb0, 0xa1, 0xb2, 0xa3],
    );
    verifySources(trace, bytes, addresses);
    const replay = await invoke("trace-nes-mapper-writes", {
      path,
      initial: input.initial,
      writes: trace.instructions
        .flatMap((i) => i.writes)
        .filter(
          (w) =>
            w.address >= 0x8000 || (w.address >= 0x4800 && w.address < 0x6000),
        ),
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths.map((p) => p.trace),
      [trace],
    );
    const mapping = trace.mapper_trace.final_mapping;
    assert.deepEqual(
      mapping.chr_windows.map((w) => w.source),
      [
        "chr-rom",
        "chr-rom",
        "chr-rom",
        "chr-rom",
        "ciram",
        "ciram",
        "ciram",
        "ciram",
      ],
    );
    assert.equal(mapping.chr_windows[0].file_offset, chrOffset + 224 * 1024);
    assert.equal(mapping.nametable_windows[2].file_offset, chrOffset + 1024);
    assert.equal(trace.mapper_trace.final.audio_data_port, 0x12);
    assert.deepEqual(await readFile(path), bytes);
    if (storage === 7) await verifyIrq(invoke, path);
  }
}

function verifySources(trace, bytes, addresses) {
  for (const instruction of trace.instructions) {
    const code = Buffer.from(instruction.bytes_hex, "hex");
    for (const [i, offset] of instruction.file_offsets.entries()) {
      if (offset !== null) assert.equal(bytes[offset], code[i]);
      else {
        const origin = instruction.ram_origins.find((o) => o.byte_index === i);
        assert.equal(origin.region, "prg-ram");
        assert.equal(origin.bank, 0);
        assert.equal(origin.ram_address, instruction.address + i);
        assert.ok(
          origin.instruction_index < trace.instructions.indexOf(instruction),
        );
        const write =
          trace.instructions[origin.instruction_index].writes[
            origin.write_index
          ];
        assert.equal(write.address, origin.ram_address);
        assert.equal(write.value, code[i]);
      }
    }
    for (const read of instruction.data_reads.filter((r) =>
      addresses.includes(r.address),
    )) {
      const origin = read.ram_origins[0];
      assert.equal(origin.bank, 0);
      assert.equal(origin.ram_address, read.address);
      assert.equal(
        trace.instructions[origin.instruction_index].writes[origin.write_index]
          .value,
        read.value,
      );
    }
  }
}
async function verifyIrq(invoke, path) {
  const input = {
    path,
    initial: { mapper: 19, variant: "namco163", irq_high: 128 },
    initial_irq: {
      model: "namco163",
      counter_low: 254,
      counter_high: 127,
      asserted: false,
    },
    events: [
      { kind: "namco163-cpu-cycle" },
      { kind: "cpu-read", address: 0x5000 },
      { kind: "namco163-cpu-cycle" },
      { kind: "cpu-write", address: 0x57ff, value: 255 },
      { kind: "namco163-cpu-cycle" },
      { kind: "cpu-write", address: 0x57ff, value: 254 },
      { kind: "namco163-cpu-cycle" },
    ],
  };
  const result = await invoke("trace-nes-mapper-events", input),
    trace = result.normalized_result.trace;
  assert.equal(trace.status, "derived");
  assert.deepEqual(
    trace.steps.map((s) => s.irq.asserted),
    [true, true, true, false, false, false, true],
  );
  assert.deepEqual(
    trace.steps
      .filter((s) => s.event.kind === "namco163-cpu-cycle")
      .map((s) => s.irq_clock),
    [true, false, false, true],
  );
  assert.equal(trace.coverage.unknown_cpu_reads, 0);
  assert.deepEqual(trace.steps[1].cpu_read, {
    address: 0x5000,
    value: 255,
    source: {
      kind: "namco163-irq-counter",
      counter_low: 255,
      counter_high: 127,
      irq_high: 128,
    },
  });
  const resumed = await invoke("trace-nes-mapper-events", {
    path,
    initial:
      trace.steps[3].state ??
      trace.mapper_snapshots[trace.steps[3].mapper_snapshot].state,
    initial_irq: trace.steps[3].irq,
    events: input.events.slice(4),
  });
  assert.deepEqual(resumed.normalized_result.trace.final_irq, trace.final_irq);
}
