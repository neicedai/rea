import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed oracle uses trainer-free 128 KiB PRG and different source banks/data. */
export async function verifyPackageFme7(invoke, workspace) {
  for (const variant of ["fme7", "5a", "5b"])
    for (const storage of [7, 0x70])
      await board(invoke, workspace, variant, storage);
  await mixed(invoke, workspace);
}
function cartridge(storage) {
  const bytes = Buffer.alloc(16 + 131072 + 16384, 2);
  bytes.fill(0, 0, 16);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    8,
    2,
    0x50 | (storage & 0xf0 ? 2 : 0),
    0x48,
    0,
    0,
    storage,
  ]);
  const register = (n, value) => [
    { address: 0x8001, value: 0xe0 | n },
    { address: 0xb123, value },
  ];
  const routine = [0xa9, 0x88, 0x60];
  const writes = [
    ...register(9, 3),
    ...register(10, 10),
    ...register(11, 5),
    ...Array.from({ length: 8 }, (_, i) => register(i, 0xf0 + i)).flat(),
    ...register(8, 0xc0),
    ...routine.map((value, i) => ({ address: 0x6000 + i, value })),
    { address: 0x6500, value: 0x11 },
  ];
  const store = (items) =>
    items.flatMap(({ address, value }) => [
      0xa9,
      value,
      0x8d,
      address & 255,
      address >> 8,
    ]);
  bytes.set(
    [
      ...store(writes),
      0x20,
      0,
      0x60,
      ...store(register(8, 0x40)),
      0xa9,
      0xaa,
      0x8d,
      0,
      0x65,
      ...store(register(8, 0xc0)),
      0xad,
      0,
      0x65,
      0xee,
      0,
      0x65,
      ...store(register(8, 12)),
      0x20,
      0,
      0x60,
      0x4c,
      0xff,
      0x7f,
    ],
    16 + 15 * 8192 + 0x180,
  );
  bytes.set([0xa9, 0x5e, 0x60], 16 + 12 * 8192);
  bytes[16 + 13 * 8192 - 1] = 0xa9;
  bytes.set([0xc9, 0x4c, 0xff, 0xbf], 16 + 3 * 8192);
  bytes[16 + 11 * 8192 - 1] = 0xa9;
  bytes.set([0x42, 0x4c, 0x10, 0x80], 16 + 5 * 8192);
  bytes.set([0xa9, 0x77, 0x60], 16 + 3 * 8192 + 16);
  bytes.writeUInt16LE(0xe180, 16 + 131072 - 4);
  return { bytes, routine, register };
}
async function board(invoke, workspace, variant, storage) {
  const { bytes, routine, register } = cartridge(storage),
    path = join(workspace, `packaged-fme7-${variant}-${storage}.nes`),
    initial = { mapper: 69, variant, prg_ram_enable: "register-bit7" },
    input = { path, initial, cpu: { sp: 255 } };
  await writeFile(path, bytes);
  const evidence = await invoke("trace-nes-code", input),
    trace = evidence.normalized_result.code_trace;
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(evidence.normalized_result.header.header, [
    ...bytes.subarray(0, 16),
  ]);
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0x77);
  assert.deepEqual(
    trace.instructions.find((i) => i.address === 0x7fff).file_offsets,
    [16 + 13 * 8192 - 1, 16 + 3 * 8192],
  );
  assert.deepEqual(
    trace.instructions.find((i) => i.address === 0xbfff).file_offsets,
    [16 + 11 * 8192 - 1, 16 + 5 * 8192],
  );
  for (const instruction of trace.instructions)
    for (const [i, offset] of instruction.file_offsets.entries()) {
      const value = Buffer.from(instruction.bytes_hex, "hex")[i];
      if (offset !== null) assert.equal(bytes[offset], value);
      else {
        const origin = instruction.ram_origins.find((o) => o.byte_index === i);
        assert.equal(origin.region, "prg-ram");
        assert.equal(origin.bank, 0);
        assert.equal(
          trace.instructions[origin.instruction_index].writes[
            origin.write_index
          ].value,
          value,
        );
      }
    }
  assert.deepEqual(
    trace.instructions
      .flatMap((i) => i.data_reads)
      .filter((r) => r.address === 0x6500)
      .map((r) => r.value),
    [0x11, 0x11],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
    [12, 3, 10, 5, 15],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.chr_windows.map((w) => w.bank),
    [0, 1, 2, 3, 4, 5, 6, 7],
  );
  const replay = await invoke("trace-nes-mapper-writes", {
    path,
    initial,
    writes: trace.instructions.flatMap((i) => i.writes),
  });
  assert.deepEqual(
    replay.normalized_result.trace.final,
    trace.mapper_trace.final,
  );
  assert.deepEqual(
    replay.normalized_result.trace.final_mapping,
    trace.mapper_trace.final_mapping,
  );
  const exploration = await invoke("explore-nes-code", input);
  assert.deepEqual(
    exploration.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  const seeded = await invoke("trace-nes-code", {
    path,
    initial: {
      mapper: 69,
      variant,
      prg_ram_enable: "register-bit7",
      bank_6000: 0xc0,
    },
    entry: 0x6000,
    initial_prg_ram: routine.map((value, i) => ({
      bank: 0,
      address: 0x6000 + i,
      value,
    })),
  });
  assert.equal(seeded.normalized_result.code_trace.final_cpu.a, 0x88);
  const events = [
    ...register(14, 1),
    ...register(15, 0),
    ...register(13, 0x81),
  ].map((w) => ({ ...w, kind: "cpu-write" }));
  const irq = await invoke("trace-nes-mapper-events", {
    path,
    initial,
    initial_irq: { model: "fme7" },
    events: [
      ...events,
      { kind: "ppu-read", address: 0 },
      { kind: "fme7-cpu-cycle" },
      { kind: "fme7-cpu-cycle" },
      ...register(13, 0x80).map((w) => ({ ...w, kind: "cpu-write" })),
      { kind: "fme7-cpu-cycle" },
    ],
  });
  assert.equal(irq.normalized_result.trace.steps[6].irq.counter_low, 1);
  assert.deepEqual(irq.normalized_result.trace.final_irq, {
    model: "fme7",
    counter_low: 254,
    counter_high: 255,
    asserted: false,
  });
  assert.deepEqual(await readFile(path), bytes);
}
async function mixed(invoke, workspace) {
  const { bytes } = cartridge(13),
    path = join(workspace, "packaged-fme7-mixed.nes"),
    code = [0xa9, 0x59, 0x60];
  bytes.set(code, 16);
  await writeFile(path, bytes);
  const initial = {
    mapper: 69,
    variant: "fme7",
    prg_ram_enable: "ungated",
    bank_6000: { mask: 191, value: 128 },
  };
  const trace = await invoke("trace-nes-code", {
    path,
    entry: 0x6000,
    initial,
    initial_prg_ram: code.map((value, i) => ({
      bank: 0,
      address: 0x6000 + i,
      value,
    })),
  });
  assert.equal(trace.normalized_result.code_trace.final_cpu.a, 0x59);
  const origin =
    trace.normalized_result.code_trace.instructions[0].mapper_origins[0];
  assert.equal(origin.kind, "fme7-window");
  assert.equal(origin.source_candidates[0].file_offset, 16);
  assert.equal(origin.source_candidates[1].source.index, 0);
  const ram = await invoke("trace-nes-code", {
    path,
    entry: 0x6000,
    initial: { ...initial, bank_6000: { mask: 64, value: 64 } },
    initial_prg_ram: Array.from({ length: 64 }, (_, bank) => ({
      bank,
      address: 0x6000,
      value: 0x60,
    })),
  });
  assert.equal(ram.normalized_result.code_trace.stop.ram_origins.length, 64);
  assert.deepEqual(
    ram.normalized_result.code_trace.stop.ram_origins.map(
      (o) => o.initial_prg_ram_index,
    ),
    Array.from({ length: 64 }, (_, i) => i),
  );
  assert.deepEqual(await readFile(path), bytes);
}
