import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent trainer-free installed oracle: 2 KiB CHR latches and PPU ExRAM/fill. */
export async function verifyPackageMmc5Ppu(invoke, workspace) {
  const prgSize = 32768,
    chrSize = 262144,
    chrOffset = 16 + prgSize;
  const bytes = Buffer.alloc(chrOffset + chrSize);
  bytes.set([78, 69, 83, 26, 2, 32, 80, 8]);
  for (let i = 0; i < chrSize; i++)
    bytes[chrOffset + i] = ((i >> 10) * 7 + i) & 255;
  const registers = [
    [0x5101, 2],
    [0x5130, 0],
    [0x5121, 7],
    [0x5129, 9],
    [0x2000, 32],
    [0x2001, 24],
    [0x5104, 0],
    [0x5105, 228],
    [0x5106, 55],
    [0x5107, 2],
  ];
  bytes.set(
    [
      ...registers.flatMap(([address, value]) => [
        169,
        value,
        141,
        address & 255,
        address >> 8,
      ]),
      96,
    ],
    16 + 3 * 8192,
  );
  bytes.writeUInt16LE(0xe000, 16 + prgSize - 4);
  const path = join(workspace, "packaged-mmc5-ppu.nes");
  await writeFile(path, bytes);
  const initial = {
    mapper: 5,
    prg_mode: 3,
    prg_banks: [0, 128, 129, 130, 3],
    ram_wiring: "none",
    split: [0, null, null],
    exram: { 1023: 165 },
  };
  const source = await invoke("trace-nes-code", { path, initial });
  const code = source.normalized_result.code_trace;
  assert.equal(code.status, "derived");
  assert.equal(code.stop.reason, "return");
  assert.equal(code.mapper_trace.final.chr_bank_modes[1], 2);
  assert.equal(code.mapper_trace.final.chr_bank_modes[9], 2);
  const events = [
    { kind: "ppu-read", address: 0x07ff, mmc5_fetch: "sprite" },
    { kind: "ppu-read", address: 0x03fe, mmc5_fetch: "background" },
    { kind: "ppu-read", address: 0x13fe, mmc5_fetch: "ppudata" },
    { kind: "ppu-read", address: 0x2bff, mmc5_fetch: "ppudata" },
    { kind: "ppu-write", address: 0x3bff, value: 167 },
    { kind: "ppu-read", address: 0x2bff, mmc5_fetch: "ppudata" },
    { kind: "ppu-read", address: 0x2fc0, mmc5_fetch: "ppudata" },
    {
      kind: "cpu-write",
      address: 0x5104,
      value: null,
      known_bits: { mask: 1, value: 0 },
    },
    { kind: "ppu-write", address: 0x2bff, value: 163 },
    { kind: "cpu-write", address: 0x5104, value: 3 },
    { kind: "ppu-read", address: 0x2bff, mmc5_fetch: "ppudata" },
    { kind: "cpu-read", address: 0x5fff },
  ];
  const initialWrites = code.instructions
    .flatMap((i) => i.writes)
    .map((w) => ({ ...w, kind: "cpu-write" }));
  const evidence = await invoke("trace-nes-mapper-events", {
    path,
    initial,
    events: [...initialWrites, ...events],
  });
  const trace = evidence.normalized_result.trace;
  assert.equal(trace.status, "derived");
  const steps = trace.steps.slice(initialWrites.length);
  for (const [index, bank, offset] of [
    [0, 15, 1023],
    [1, 18, 1022],
    [2, 18, 1022],
  ]) {
    assert.equal(steps[index].read_source.bank, bank);
    assert.equal(
      steps[index].read_source.file_offset,
      chrOffset + bank * 1024 + offset,
    );
    assert.equal(
      bytes[steps[index].read_source.file_offset],
      (bank * 7 + offset) & 255,
    );
    assert.equal(steps[index].read_source.value, (bank * 7 + offset) & 255);
    assert.deepEqual(steps[index].read_source.mmc5.rom_sources, {
      status: "examined",
      file_offsets: [chrOffset + bank * 1024 + offset],
    });
  }
  assert.equal(steps[3].read_source.value, 165);
  assert.equal(steps[5].read_source.value, 167);
  assert.equal(steps[6].read_source.value, 170);
  assert.equal(steps[8].write_effect, "uncertain-exram-write");
  assert.deepEqual(trace.final.exram["1023"], { mask: 251, value: 163 });
  assert.equal(steps[10].read_source.value, 0);
  assert.deepEqual(steps[11].cpu_read.known_bits, { mask: 251, value: 163 });
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const resumed = (
    await invoke("trace-nes-mapper-events", {
      path,
      initial: code.mapper_trace.final,
      events,
    })
  ).normalized_result.trace;
  assert.deepEqual(resumed.final, trace.final);
  assert.deepEqual(resumed.final_mapping, trace.final_mapping);
  assert.deepEqual(await readFile(path), bytes);
}
