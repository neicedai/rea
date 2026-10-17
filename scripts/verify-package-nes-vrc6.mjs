import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed-artifact oracle for VRC6 ROM/RAM, PPU sources and explicit IRQs. */
export async function verifyPackageVrc6(invoke, workspace) {
  for (const mapper of [24, 26])
    for (const declaration of [7, 0x70])
      await verifyBoard(invoke, workspace, mapper, declaration);
}

function cartridge(mapper, declaration) {
  const bytes = Buffer.alloc(528 + 65536 + 262144, 2);
  bytes.fill(0, 0, 16);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    4,
    32,
    ((mapper & 15) << 4) | 6,
    0x18,
    0,
    0,
    declaration,
  ]);
  const port = (base, p) =>
    base | (mapper === 24 ? p : ((p & 1) << 1) | (p >> 1));
  const routine = [
    0xa9, 2, 0x8d, 0, 0x80, 0xa9, 4, 0x8d, 0, 0xc0, 0x4c, 0xff, 0xbf,
  ];
  const writes = [
    [0x8000, 1],
    [0xc000, 5],
    [port(0x9000, 3), 7],
    [port(0xb000, 3), 0xa0],
    [0x6700, 0x44],
    ...routine.map((value, i) => [0x6000 + i, value]),
    [port(0xb000, 3), 0x20],
    [0x6700, 0x99],
    [port(0xb000, 3), 0xa0],
  ];
  bytes.set(
    [
      ...writes.flatMap(([address, value]) => [
        0xa9,
        value,
        0x8d,
        address & 255,
        address >> 8,
      ]),
      0xad,
      0,
      0x67,
      0xee,
      0,
      0x67,
      0x4c,
      0,
      0x60,
    ],
    528 + 7 * 8192 + 0x100,
  );
  bytes[528 + 6 * 8192 - 1] = 0xa9;
  bytes.set([0x5a, 0x4c, 0x10, 0x80], 528 + 4 * 8192);
  bytes.set([0xa9, 0x77, 0x60], 528 + 4 * 8192 + 16);
  bytes.writeUInt16LE(0xe100, 528 + 65536 - 4);
  return { bytes, routine, port };
}

function verifySources(trace, bytes, seeded = false) {
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0x77);
  assert.deepEqual(
    trace.instructions.find((i) => i.address === 0xbfff).file_offsets,
    [528 + 6 * 8192 - 1, 528 + 4 * 8192],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
    [4, 5, 4, 7],
  );
  for (const instruction of trace.instructions) {
    const code = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries()) {
      if (offset !== null) assert.equal(bytes[offset], code[index]);
      else {
        const origin = instruction.ram_origins.find(
            (o) => o.byte_index === index,
          ),
          address = instruction.address + index;
        assert.equal(origin.region, "prg-ram");
        assert.equal(origin.bank, 0);
        assert.equal(origin.ram_address, address);
        if (seeded)
          assert.equal(origin.initial_prg_ram_index, address - 0x6000);
        else {
          assert.equal(origin.instruction_index, 11 + 2 * (address - 0x6000));
          assert.equal(origin.write_index, 0);
          assert.equal(
            trace.instructions[origin.instruction_index].writes[0].address,
            address,
          );
          assert.equal(
            trace.instructions[origin.instruction_index].writes[0].value,
            code[index],
          );
        }
      }
    }
  }
  if (!seeded) {
    assert.equal(trace.instructions[42].data_reads[0].value, 0x44);
    assert.deepEqual(
      trace.instructions[43].writes.map((w) => w.value),
      [0x44, 0x45],
    );
    assert.equal(trace.mapper_trace.final.audio_registers[3], 7);
  }
}

async function verifyBoard(invoke, workspace, mapper, declaration) {
  const { bytes, routine, port } = cartridge(mapper, declaration),
    path = join(workspace, `packaged-vrc6-${mapper}-${declaration}.nes`);
  await writeFile(path, bytes);
  const initial = { mapper, chr_banks: [0, 2, 4, 6, 8, 10, 12, 14] },
    input = { path, initial };
  const evidence = await invoke("trace-nes-code", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(evidence.normalized_result.header.header, [
    ...bytes.subarray(0, 16),
  ]);
  const trace = evidence.normalized_result.code_trace;
  verifySources(trace, bytes);
  const replay = await invoke("trace-nes-mapper-writes", {
    ...input,
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
  const explored = await invoke("explore-nes-code", input);
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  const seeded = await invoke("trace-nes-code", {
    path,
    initial: { mapper, control: { mask: 128, value: 128 } },
    entry: 0x6000,
    initial_prg_ram: routine.map((value, i) => ({
      bank: 0,
      address: 0x6000 + i,
      value,
    })),
  });
  verifySources(seeded.normalized_result.code_trace, bytes, true);
  const ppu = await invoke("trace-nes-mapper-events", {
    path,
    initial: { ...initial, control: 0x31 },
    events: [
      { kind: "ppu-read", address: 0x2000 },
      { kind: "ppu-read", address: 0x3000 },
      { kind: "ppu-read", address: 0x3eff },
      {
        kind: "cpu-write",
        address: port(0xb000, 3),
        value: null,
        known_bits: { mask: 35, value: 33 },
      },
      { kind: "ppu-read", address: 0x2000 },
      { kind: "ppu-read", address: 0x400 },
    ],
  });
  assert.equal(ppu.normalized_result.trace.status, "derived");
  assert.deepEqual(
    ppu.normalized_result.trace.steps.map((s) => s.read_source),
    [
      { status: "chr-rom", bank: 8, file_offset: 528 + 65536 + 8 * 1024 },
      { status: "chr-rom", bank: 8, file_offset: 528 + 65536 + 8 * 1024 },
      {
        status: "chr-rom",
        bank: 14,
        file_offset: 528 + 65536 + 14 * 1024 + 767,
      },
      null,
      { status: "unknown-nametable-bank", bank: null, file_offset: null },
      { status: "chr-rom", bank: 1, file_offset: 528 + 65536 + 1024 },
    ],
  );
  assert.equal(ppu.normalized_result.trace.coverage.unknown_nametable_reads, 1);
  const irq = await invoke("trace-nes-mapper-events", {
    path,
    initial: { mapper },
    initial_irq: { model: "vrc6" },
    events: [
      { kind: "cpu-write", address: port(0xf000, 0), value: 254 },
      { kind: "cpu-write", address: port(0xf000, 1), value: 7 },
      { kind: "vrc-cpu-cycle" },
      { kind: "vrc-cpu-cycle" },
      { kind: "cpu-write", address: port(0xf000, 2), value: 0 },
    ],
  });
  assert.deepEqual(irq.normalized_result.trace.steps[3].irq, {
    model: "vrc6",
    counter: 254,
    prescaler: null,
    asserted: true,
  });
  assert.deepEqual(irq.normalized_result.trace.final_irq, {
    model: "vrc6",
    counter: 254,
    prescaler: null,
    asserted: false,
  });
  assert.deepEqual(await readFile(path), bytes);
}
