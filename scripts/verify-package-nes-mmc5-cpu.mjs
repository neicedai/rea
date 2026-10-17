import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const state = {
  mapper: 5,
  prg_mode: 3,
  prg_banks: [0, 128, 129, 130, 15],
  ram_wiring: "none",
};
const cartridge = () => {
  const bytes = Buffer.alloc(16 + 131072 + 8192, 0x02);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 1, 0x50, 8]);
  return bytes;
};
function verifySources(trace, bytes) {
  for (const instruction of trace.instructions) {
    const code = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries())
      if (offset !== null) assert.equal(bytes[offset], code[index]);
    for (const item of [
      { origins: instruction.mapper_origins, code },
      ...instruction.data_reads.map((r) => ({
        origins: r.mapper_origins,
        code: null,
      })),
    ])
      for (const origin of item.origins) {
        if (origin.kind === "mmc5-multiply") {
          for (const [index, source] of origin.factor_sources.entries()) {
            assert.equal(source.kind, "cpu-write");
            assert.ok(source.instruction_index < instruction.index);
            const write =
              trace.instructions[source.instruction_index].writes[
                source.write_index
              ];
            assert.equal(write.address, 0x5205 + index);
            assert.equal(
              write.value,
              index === 0 ? origin.multiplicand : origin.multiplier,
            );
          }
        } else {
          assert.equal(origin.kind, "mmc5-exram");
          assert.equal(origin.access, "readable");
          const source = origin.byte_source;
          assert.equal(source.kind, "cpu-write");
          assert.ok(source.instruction_index < instruction.index);
          const write =
            trace.instructions[source.instruction_index].writes[
              source.write_index
            ];
          assert.equal(write.address, 0x5c00 + origin.cell_address);
          assert.equal(write.value, origin.cell_value);
          if (item.code !== null)
            assert.equal(write.value, item.code[origin.byte_index]);
        }
      }
  }
}

/** Independent installed source oracle: RMW high product, ExRAM code and an immutable readonly routine. */
export async function verifyPackageMmc5Cpu(invoke, workspace) {
  const bytes = cartridge(),
    base = 16 + 15 * 8192;
  bytes.set(
    [
      0xa9, 7, 0x8d, 5, 0x52, 0xa9, 9, 0x8d, 6, 0x52, 0xee, 6, 0x52, 0xad, 5,
      0x52, 0x09, 0x80, 0x8d, 0x14, 0x51, 0x4c, 0, 0x80,
    ],
    base,
  );
  const ram = [
    0xa9, 3, 0x8d, 4, 0x51, 0xee, 0xa0, 0x5c, 0xa9, 0x86, 0x8d, 0x15, 0x51,
    0x4c, 0x30, 0xa0,
  ];
  bytes.set(
    [
      0xa9,
      2,
      0x8d,
      4,
      0x51,
      ...ram.flatMap((v, i) => [0xa9, v, 0x8d, 0xa0 + i, 0x5c]),
      0x4c,
      0xa0,
      0x5c,
    ],
    16 + 7 * 8192,
  );
  bytes.set(
    [0xad, 5, 0x52, 0xc9, 7, 0xf0, 1, 0x02, 0xa9, 0x6d, 0x60],
    16 + 6 * 8192 + 0x30,
  );
  const path = join(workspace, "installed-mmc5-cpu.nes");
  await writeFile(path, bytes);
  const input = { path, entry: 0xe000, initial: state };
  const evidence = await invoke("trace-nes-code", input),
    trace = evidence.normalized_result.code_trace;
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0x6d);
  assert.deepEqual(trace.mapper_trace.final.multiplier, [7, 1]);
  assert.equal(trace.mapper_trace.final.exram["160"], 0xa9);
  assert.deepEqual(
    trace.instructions
      .find((i) => i.address === 0xe00a)
      .writes.map((w) => w.value),
    [0, 1],
  );
  assert.deepEqual(
    trace.instructions
      .find((i) => i.address === 0x5ca5)
      .writes.map((w) => w.value),
    [0xa9, 0xaa],
  );
  verifySources(trace, bytes);
  const replay = await invoke("trace-nes-mapper-writes", {
    path,
    initial: state,
    writes: trace.instructions.flatMap((i) => i.writes),
  });
  assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
  const events = trace.instructions.flatMap((i) => [
    ...i.data_reads.map((r) => ({ kind: "cpu-read", address: r.address })),
    ...i.writes.map((w) => ({ kind: "cpu-write", ...w })),
  ]);
  const event = await invoke("trace-nes-mapper-events", {
    path,
    initial: state,
    events,
  });
  assert.deepEqual(
    event.normalized_result.trace.final,
    trace.mapper_trace.final,
  );
  const explored = await invoke("explore-nes-code", input);
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  const continued = await invoke("trace-nes-code", {
    path,
    initial: trace.mapper_trace.final,
    entry: 0x5ca0,
  });
  assert.equal(continued.normalized_result.code_trace.final_cpu.a, 0x6d);
  assert.deepEqual(await readFile(path), bytes);
  await verifyRegisterSnapshot(invoke, workspace);
  await verifyExramCapacity(invoke, workspace);
}

async function verifyRegisterSnapshot(invoke, workspace) {
  const bytes = cartridge();
  bytes.set(
    [
      0xad, 6, 0x52, 0xaa, 0x86, 0x11, 0xa9, 0xfe, 0x25, 0x11, 0xf0, 1, 0x02,
      0x4c, 0, 0x80,
    ],
    16 + 15 * 8192,
  );
  bytes.set([0xa9, 0x48, 0x60], 16);
  const path = join(workspace, "installed-mmc5-register-proof.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    entry: 0xe000,
    initial: { ...state, multiplier: [2, null] },
  };
  const result = await invoke("trace-nes-code", input),
    trace = result.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0x48);
  assert.deepEqual(trace.final_cpu.register_bits, {
    x: { mask: 254, value: 0 },
  });
  assert.deepEqual(trace.instructions[2].writes, [
    {
      address: 0x11,
      value: null,
      known_bits: { mask: 254, value: 0 },
      preceded_by_cpu_write: false,
    },
  ]);
  assert.deepEqual(trace.instructions[4].data_reads[0].ram_origins, [
    {
      byte_index: 0,
      region: "internal-ram",
      ram_address: 0x11,
      instruction_index: 2,
      write_index: 0,
    },
  ]);
  const prefix = await invoke("trace-nes-code", {
    ...input,
    max_instructions: 2,
  });
  const saved = prefix.normalized_result.code_trace;
  const continued = await invoke("trace-nes-code", {
    path,
    initial: saved.mapper_trace.final,
    cpu: saved.final_cpu,
    entry: saved.stop.address,
  });
  assert.equal(continued.normalized_result.code_trace.stop.reason, "return");
  assert.equal(continued.normalized_result.code_trace.final_cpu.a, 0x48);
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyExramCapacity(invoke, workspace) {
  const bytes = cartridge(),
    path = join(workspace, "installed-mmc5-exram-capacity.nes");
  await writeFile(path, bytes);
  const exram = Object.fromEntries(
    Array.from({ length: 1024 }, (_, a) => [String(a), (a * 73 + 19) & 255]),
  );
  Object.assign(exram, { 1008: 0xa9, 1009: 0x33, 1010: 0x60 });
  const result = await invoke("trace-nes-code", {
      path,
      entry: 0x5ff0,
      initial: { ...state, exram_mode: 3, exram_written: true, exram },
    }),
    trace = result.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0x33);
  assert.equal(Object.keys(trace.mapper_trace.final.exram).length, 1024);
  for (const origin of trace.instructions[0].mapper_origins) {
    assert.equal(origin.kind, "mmc5-exram");
    assert.equal(origin.byte_source.kind, "initial-state");
    assert.equal(origin.cell_value, exram[String(origin.cell_address)]);
  }
  const events = await invoke("trace-nes-mapper-events", {
    path,
    initial: { ...state, exram_mode: 0, exram: { 0: 0xa5 } },
    events: [
      { kind: "cpu-write", address: 0x5c00, value: 0xa7 },
      { kind: "cpu-read", address: 0x5c00 },
      { kind: "cpu-write", address: 0x5104, value: 2 },
      { kind: "cpu-read", address: 0x5c00 },
    ],
  });
  const event = events.normalized_result.trace;
  assert.equal(event.status, "derived");
  assert.equal(event.final.exram["0"], null);
  assert.equal(event.steps[1].cpu_read.source.access, "open-bus");
  assert.equal(event.steps[3].cpu_read.source.access, "readable");
  assert.equal(event.coverage.unknown_cpu_reads, 2);
  assert.deepEqual(await readFile(path), bytes);
}
