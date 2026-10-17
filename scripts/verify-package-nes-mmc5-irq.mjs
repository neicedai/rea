import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const line = () => [
  { kind: "ppu-read", address: 0x2a55 },
  { kind: "ppu-read", address: 0x2a55 },
  { kind: "ppu-read", address: 0x2a55 },
  { kind: "ppu-read", address: 0x1001 },
];

/** Independent installed oracle: different NT addresses, partial control writes and mid-filter continuation. */
export async function verifyPackageMmc5Irq(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 32768 + 8192);
  bytes.set([78, 69, 83, 26, 2, 1, 80, 8]);
  bytes.set([169, 3, 141, 3, 82, 169, 0, 141, 4, 82, 96], 16 + 3 * 8192);
  bytes.writeUInt16LE(0xe000, 16 + 32768 - 4);
  const path = join(workspace, "packaged-mmc5-irq.nes");
  await writeFile(path, bytes);
  const initial = {
    mapper: 5,
    prg_mode: 3,
    prg_banks: [0, 128, 129, 130, 3],
    ram_wiring: "none",
    ppu_mask: 24,
    ppu_control: 0,
    exram_mode: 1,
    split: [0, null, null],
    chr_mode: 0,
  };
  const source = await invoke("trace-nes-code", { path, initial });
  const code = source.normalized_result.code_trace;
  assert.equal(code.status, "derived");
  assert.equal(code.stop.reason, "return");
  for (const instruction of code.instructions)
    for (const [index, offset] of instruction.file_offsets.entries())
      assert.equal(
        bytes[offset],
        Buffer.from(instruction.bytes_hex, "hex")[index],
      );
  const prefix = code.instructions
    .flatMap((i) => i.writes)
    .map((w) => ({ ...w, kind: "cpu-write" }));
  const tail = [
    { kind: "cpu-read", address: 0xfffb },
    ...line(),
    ...line(),
    ...line(),
    ...line(),
    { kind: "cpu-read", address: 0x520c },
    {
      kind: "cpu-write",
      address: 0x5204,
      value: null,
      known_bits: { mask: 128, value: 128 },
    },
    {
      kind: "cpu-write",
      address: 0x5c20,
      value: null,
      known_bits: { mask: 253, value: 164 },
    },
    { kind: "cpu-read", address: 0x5204 },
    { kind: "cpu-write", address: 0x5104, value: 3 },
    { kind: "cpu-read", address: 0x5c20 },
    { kind: "mmc5-reset" },
    { kind: "cpu-read", address: 0x5c20 },
    { kind: "cpu-write", address: 0x5104, value: 3 },
    { kind: "cpu-read", address: 0x5c20 },
    { kind: "cpu-read", address: 0xfffa },
  ];
  const evidence = await invoke("trace-nes-mapper-events", {
    path,
    initial,
    initial_irq: { model: "mmc5" },
    events: [...prefix, ...tail],
  });
  const trace = evidence.normalized_result.trace;
  assert.equal(trace.status, "derived");
  const steps = trace.steps.slice(prefix.length);
  assert.deepEqual(
    steps.slice(1, 5).map((s) => s.irq_clock),
    [false, false, false, true],
  );
  assert.equal(steps[16].irq.counter, 3);
  assert.equal(steps[16].irq.pending, true);
  assert.equal(steps[16].irq.asserted, false);
  assert.equal(steps[17].irq.pending, true);
  assert.equal(steps[18].irq.asserted, true);
  assert.equal(steps[19].write_effect, "exram-write");
  assert.deepEqual(steps[20].cpu_read.known_bits, { mask: 192, value: 192 });
  assert.equal(steps[20].irq.pending, false);
  assert.equal(steps[20].irq.counter, 3);
  assert.deepEqual(steps[22].cpu_read.known_bits, { mask: 253, value: 164 });
  assert.equal(steps[23].irq.enabled, false);
  assert.equal(steps[23].irq.counter, 3);
  assert.equal(steps[24].cpu_read.value, null);
  assert.equal(steps[24].cpu_read.source.access, "unknown");
  assert.equal(steps[24].cpu_read.source.written_since_reset, false);
  assert.deepEqual(steps[24].cpu_read.source.cell_value, {
    mask: 253,
    value: 164,
  });
  assert.deepEqual(steps[26].cpu_read.known_bits, { mask: 253, value: 164 });
  assert.equal(steps[27].irq.counter, 0);
  assert.equal(steps[27].irq.in_frame, false);
  assert.equal(steps[27].irq.pending, false);
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const snapshot = trace.steps[prefix.length + 2];
  const resumed = (
    await invoke("trace-nes-mapper-events", {
      path,
      initial: snapshot.state,
      initial_irq: snapshot.irq,
      events: tail.slice(3),
    })
  ).normalized_result.trace;
  assert.deepEqual(resumed.final, trace.final);
  assert.deepEqual(resumed.final_irq, trace.final_irq);
  assert.deepEqual(await readFile(path), bytes);
}
