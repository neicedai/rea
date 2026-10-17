import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed-CLI pointer/storage oracle with no external cartridge RAM. */
export async function verifyPackageNamco163Ram(invoke, workspace) {
  for (const model of ["saturate", "wrap"]) {
    const bytes = Buffer.alloc(16 + 65536 + 8192, 2);
    bytes.fill(0, 0, 16);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x30, 0x18, 0x20]);
    const program = [
      0xa9, 0xfd, 0x8d, 0xff, 0xff, 0xad, 0xf0, 0x4f, 0x85, 0x10, 0xee, 0xb0,
      0x4a, 0xad, 0xbc, 0x4a, 0x85, 0x11, 0xa2, 1, 0xbd, 0xff, 0x49, 0x85, 0x12,
      0x0c, 0xf0, 0x48, 0xa9, 0x9e, 0x8d, 0, 0xf8, 0xa0, 1, 0xa9, 0x72, 0x91,
      0x20, 0x6c, 0, 0x48,
    ];
    bytes.set(program, 16 + 7 * 8192);
    bytes.set([0xa9, 0x43, 0x8d, 0, 0xe0], 16 + 16);
    bytes.set([0x4c, 0x10, 0xa0], 16 + 3 * 8192 + 21);
    bytes.set([0xa9, 0x77, 0x60], 16 + 8192 + 16);
    bytes.writeUInt16LE(0xe000, 16 + 65536 - 4);
    const ram = Array.from({ length: 128 }, (_, n) => n);
    ram[126] = 0x12;
    ram[127] = 0x34;
    ram[32] = 0x10;
    ram[33] = 0x80;
    const path = join(workspace, `installed-chip-${model}.nes`);
    await writeFile(path, bytes);
    const input = {
      path,
      initial: {
        mapper: 19,
        variant: "namco163",
        prg_banks: [64, 1, 2],
        chip_ram: {
          address_port: 128,
          increment_model: model,
          dma_reads: "absent",
          bytes: ram,
        },
      },
      initial_ram: [
        { address: 32, value: 255 },
        { address: 33, value: 78 },
      ],
    };
    const evidence = await invoke("trace-nes-code", input),
      trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.final_cpu.a, 0x77);
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.ok("initial_irq" in trace.mapper_trace);
    assert.deepEqual(
      trace.instructions
        .flatMap((i) => i.writes)
        .filter((w) => w.address >= 16 && w.address <= 18)
        .map((w) => w.value),
      [125, model === "wrap" ? 1 : 19, model === "wrap" ? 3 : 19],
    );
    assert.equal(trace.mapper_trace.final.ram_control, 0x9e);
    assert.equal(trace.mapper_trace.final.chip_ram.address_port, 0xa2);
    assert.equal(
      trace.mapper_trace.final.chip_ram.bytes[127],
      model === "wrap" ? 18 : 19,
    );
    assert.equal(
      trace.mapper_trace.final.chip_ram.bytes[0],
      model === "wrap" ? 19 : 0,
    );
    assert.equal(trace.mapper_trace.final.chip_ram.bytes[31], 0x72);
    let end = 0;
    for (const instruction of trace.instructions) {
      assert.equal(instruction.mapper_event_range.start, end);
      end += instruction.mapper_event_range.count;
      for (const [i, offset] of instruction.file_offsets.entries()) {
        assert.notEqual(offset, null);
        assert.equal(
          bytes[offset],
          Buffer.from(instruction.bytes_hex, "hex")[i],
        );
      }
      for (const read of instruction.data_reads)
        for (const origin of read.mapper_origins) {
          assert.equal(origin.kind, "namco163-chip-ram");
          assert.equal(read.file_offset, null);
          for (const cell of origin.cells) {
            if (cell.source.kind === "initial-chip-ram")
              assert.equal(ram[cell.source.index], cell.value);
            else {
              assert.ok(cell.source.instruction_index < instruction.index);
              assert.equal(
                trace.instructions[cell.source.instruction_index].writes[
                  cell.source.write_index
                ].value,
                cell.value,
              );
            }
          }
        }
    }
    assert.equal(end, trace.mapper_trace.steps.length);
    const events = trace.mapper_trace.steps.map((s) => s.event);
    const replay = await invoke("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      events,
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths.map((p) => p.trace),
      [trace],
    );
    await verifyReadCoverage(invoke, input);
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyReadCoverage(invoke, input) {
  const unknown = await invoke("trace-nes-mapper-events", {
    path: input.path,
    initial: {
      ...input.initial,
      chip_ram: {
        ...input.initial.chip_ram,
        address_port: 128,
        dma_reads: "unobserved",
        bytes: Array(128).fill(0xa5),
      },
    },
    events: [{ kind: "cpu-read", address: 0x4800 }],
  });
  const trace = unknown.normalized_result.trace;
  assert.equal(trace.steps[0].cpu_read.value, 0xa5);
  assert.equal(trace.steps[0].cpu_read.source.cells.length, 128);
  assert.deepEqual(trace.final.chip_ram.address_port, {
    mask: 128,
    value: 128,
  });
  assert.equal(trace.coverage.unknown_cpu_reads, 0);
  const resumed = await invoke("trace-nes-mapper-events", {
    path: input.path,
    initial: trace.final,
    events: [{ kind: "cpu-read", address: 0x4fff }],
  });
  assert.equal(resumed.normalized_result.trace.steps[0].cpu_read.value, 0xa5);
  const missing = await invoke("trace-nes-mapper-events", {
    path: input.path,
    initial: {
      ...input.initial,
      chip_ram: {
        ...input.initial.chip_ram,
        address_port: 128,
        dma_reads: "absent",
      },
    },
    events: [{ kind: "cpu-read", address: null }],
  });
  assert.deepEqual(missing.normalized_result.trace.steps[0].cpu_read, {
    address: null,
    value: null,
    source: null,
  });
  assert.deepEqual(
    missing.normalized_result.trace.final.chip_ram.address_port,
    { mask: 254, value: 128 },
  );
  const phase = await invoke("trace-nes-mapper-events", {
    path: input.path,
    initial: {
      ...input.initial,
      prg_banks: [0, 1, 2],
      chip_ram: { ...input.initial.chip_ram, address_port: 121 },
    },
    events: [{ kind: "cpu-read", address: 0x4800 }],
  });
  assert.equal(phase.normalized_result.trace.steps[0].cpu_read.value, null);
  assert.equal(phase.normalized_result.trace.final.chip_ram.bytes[121], null);
  const dma = await invoke("trace-nes-mapper-events", {
    path: input.path,
    initial: input.initial,
    events: [
      { kind: "cpu-write", address: 0x4014, value: 0x4f },
      { kind: "cpu-read", address: 0x4800 },
    ],
  });
  assert.equal(
    dma.normalized_result.trace.steps[0].write_effect,
    "oam-dma-request",
  );
  assert.equal(
    dma.normalized_result.trace.steps[1].cpu_read.value,
    input.initial.chip_ram.increment_model === "wrap" ? 0 : 0x34,
  );
  const replaced = await invoke("trace-nes-mapper-events", {
    path: input.path,
    initial: input.initial,
    events: [
      { kind: "cpu-write", address: 0x4014, value: 0x48 },
      {
        kind: "cpu-write",
        address: 0x4014,
        value: 0,
        preceded_by_cpu_write: true,
      },
      { kind: "cpu-read", address: 0x4800 },
    ],
  });
  assert.equal(
    replaced.normalized_result.trace.steps[1].state.chip_ram.oam_dma_pending,
    0,
  );
  assert.equal(replaced.normalized_result.trace.steps[2].cpu_read.value, 0);
  assert.equal(
    replaced.normalized_result.trace.final.chip_ram.address_port,
    129,
  );
}
