import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Installed CLI oracle with independent ETROM bytes, aliases and a RAM/ROM boundary. */
export async function verifyPackageMmc5(invoke, workspace) {
  const prgOffset = 16,
    prgSize = 131072;
  const bytes = Buffer.alloc(prgOffset + prgSize + 8192, 0x02);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 1, 0x50, 8]);
  bytes[10] = 0x77;
  const code = [0xa9, 0x8b, 0x8d, 0x15, 0x51, 0x4c, 0xff, 0x9f];
  bytes.set([0x66, 0x4c, 0x10, 0xa0], prgOffset + 11 * 8192);
  bytes.set([0xa9, 0x55, 0x60], prgOffset + 11 * 8192 + 16);
  const path = join(workspace, "installed-mmc5-etrom.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    entry: 0x8200,
    initial: {
      mapper: 5,
      prg_mode: 3,
      prg_banks: [0, 4, 0x89, 0x82, 15],
      ram_wiring: "etrom",
    },
    initial_prg_ram: [
      ...code.map((value, index) => ({
        bank: 1,
        address: 0x6200 + index,
        value,
      })),
      { bank: 1, address: 0x7fff, value: 0xa9 },
    ],
  };
  const evidence = await invoke("trace-nes-code", input);
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0x55);
  const boundary = trace.instructions.find((i) => i.address === 0x9fff);
  assert.equal(boundary.bytes_hex, "a966");
  assert.deepEqual(boundary.file_offsets, [null, prgOffset + 11 * 8192]);
  for (const instruction of trace.instructions) {
    const data = Buffer.from(instruction.bytes_hex, "hex");
    for (const [index, offset] of instruction.file_offsets.entries())
      if (offset !== null) assert.equal(bytes[offset], data[index]);
    for (const origin of instruction.ram_origins) {
      assert.equal(origin.region, "prg-ram");
      assert.equal(origin.bank, 1);
      const item = input.initial_prg_ram[origin.initial_prg_ram_index];
      assert.equal(item.bank, origin.bank);
      assert.equal(item.address, origin.ram_address);
      assert.equal(item.value, data[origin.byte_index]);
      assert.equal(
        origin.ram_address,
        0x6000 + ((instruction.address + origin.byte_index) & 8191),
      );
    }
  }
  const replay = await invoke("trace-nes-mapper-writes", {
    path,
    initial: input.initial,
    writes: trace.instructions.flatMap((i) => i.writes),
  });
  assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
  const events = await invoke("trace-nes-mapper-events", {
    path,
    initial: input.initial,
    events: trace.instructions
      .flatMap((i) => i.writes)
      .map((write) => ({ kind: "cpu-write", ...write })),
  });
  assert.deepEqual(
    events.normalized_result.trace.final_mapping,
    trace.mapper_trace.final_mapping,
  );
  const explored = await invoke("explore-nes-code", input);
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  const continued = await invoke("trace-nes-code", {
    ...input,
    initial: trace.mapper_trace.final,
    entry: 0xa010,
  });
  assert.equal(continued.normalized_result.code_trace.final_cpu.a, 0x55);
  assert.equal(continued.normalized_result.code_trace.stop.reason, "return");
  assert.deepEqual(await readFile(path), bytes);
  await verifyMmc5AllSources(invoke, workspace);
}

async function verifyMmc5AllSources(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 1048576 + 8192, 0x02);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 64, 1, 0x50, 8]);
  bytes[10] = 11;
  for (let bank = 0; bank < 128; bank++)
    bytes.set([0xea, 0x60], 16 + bank * 8192 + 0x120);
  const path = join(workspace, "installed-mmc5-all-sources.nes");
  await writeFile(path, bytes);
  const initial_prg_ram = Array.from({ length: 16 }, (_, bank) => [
    { bank, address: 0x6120, value: 0xea },
    { bank, address: 0x6121, value: 0x60 },
  ]).flat();
  const input = {
    path,
    entry: 0x8120,
    initial: { mapper: 5, prg_mode: 3, ram_wiring: "linear-128k" },
    initial_prg_ram,
  };
  const result = await invoke("trace-nes-code", input);
  const trace = result.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  const instruction = trace.instructions[0],
    origin = instruction.mapper_origins[0];
  assert.equal(instruction.bytes_hex, "ea");
  assert.deepEqual(instruction.file_offsets, [null]);
  assert.equal(origin.kind, "mmc5-window");
  assert.equal(origin.source_candidates.length, 144);
  assert.equal(
    origin.source_candidates.filter((s) => s.kind === "rom").length,
    128,
  );
  assert.equal(
    origin.source_candidates.filter((s) => s.kind === "ram").length,
    16,
  );
  for (const source of origin.source_candidates) {
    assert.equal(source.value, 0xea);
    if (source.kind === "rom") assert.equal(bytes[source.file_offset], 0xea);
    else
      assert.deepEqual(initial_prg_ram[source.source.index], {
        bank: source.bank,
        address: source.ram_address,
        value: source.value,
      });
  }
  const missing = await invoke("trace-nes-code", {
    ...input,
    initial_prg_ram: initial_prg_ram.slice(2),
  });
  assert.equal(
    missing.normalized_result.code_trace.stop.reason,
    "unmapped-instruction",
  );
  assert.deepEqual(await readFile(path), bytes);
}
