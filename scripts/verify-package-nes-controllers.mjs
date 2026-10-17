import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent trainer-free, mode-1 MMC3 oracle; imports no source fixtures or controller implementation. */
export async function verifyPackageNesControllers(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 131072, 0xea);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 0, 64, 8]);
  bytes[11] = 7;
  const program = [169, 1, 141, 22, 64, 133, 55, 133, 56, 169, 0, 141, 22, 64],
    loop = program.length;
  program.push(173, 23, 64, 74, 38, 56, 173, 22, 64, 74, 38, 55);
  program.push(144, (loop - program.length - 2) & 255);
  program.push(165, 56, 133, 57, 165, 55, 41, 3, 141, 1, 128, 76, 0, 192);
  bytes.set(program, 16 + 15 * 8192 + 512);
  for (let bank = 0; bank < 4; bank++)
    bytes.set([169, 80 + bank, 96], 16 + bank * 8192);
  bytes.writeUInt16LE(0xe200, 16 + 131072 - 4);
  const path = join(workspace, "packaged-two-controllers.nes");
  await writeFile(path, bytes);
  for (const sample of [
    { buttons: 147, safe: true, bank: 1 },
    { buttons: { mask: 192, value: 128 }, safe: true, bank: 1 },
    { buttons: 147, safe: false, bank: null },
  ]) {
    const input = {
      path,
      initial: {
        mapper: 4,
        bank_select: 70,
        banks: [null, null, null, null, null, null, 0, 2],
      },
      initial_controllers: {
        model: "standard-controllers",
        buttons: [sample.buttons, 78],
        dma_reads: sample.safe ? "absent" : "unobserved",
        oam_dma_pending: { status: "none" },
        next_event_index: 6400,
      },
    };
    const evidence = await invoke("trace-nes-code", input),
      code = evidence.normalized_result.code_trace;
    assert.equal(code.status, "derived");
    assert.equal(
      code.stop.reason,
      sample.bank === null ? "unmapped-instruction" : "return",
    );
    if (sample.bank !== null) assert.equal(code.final_cpu.a, 81);
    const mapped = code.mapper_trace;
    assert.equal(mapped.status, "derived");
    assert.deepEqual(
      mapped.final_mapping.prg_windows.map((window) => window.bank),
      [14, 2, sample.bank, 15],
    );
    verifySerialReads(code, sample);
    for (const instruction of code.instructions) {
      const encoded = Buffer.from(instruction.bytes_hex, "hex");
      for (const [index, offset] of instruction.file_offsets.entries()) {
        assert.ok(Number.isInteger(offset));
        assert.equal(bytes[offset], encoded[index]);
      }
    }
    assert.equal(mapped.controller_trace.final.next_event_index, 6419);
    assert.equal(mapped.mapper_snapshots.length, 2);
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
    const continued = await invoke("trace-nes-mapper-events", {
      path,
      initial: mapped.final,
      initial_controllers: mapped.controller_trace.final,
      events: [
        { kind: "cpu-read", address: 16406 },
        { kind: "cpu-read", address: 16407 },
      ],
    });
    const next = continued.normalized_result.trace;
    assert.equal(next.controller_trace.final.next_event_index, 6421);
    for (const step of next.steps)
      assert.deepEqual(step.cpu_read.known_bits, { mask: 1, value: 1 });
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(await readFile(path), bytes);
  }
  return {
    workflows: 3,
    conditional_controller_dataflow: true,
    original_unchanged: true,
  };
}

function verifySerialReads(code, sample) {
  const reads = code.instructions
    .flatMap((instruction) => instruction.data_reads)
    .filter((read) => read.address === 16406 || read.address === 16407);
  assert.equal(reads.length, 16);
  const counts = [0, 0];
  for (const read of reads) {
    const port = read.address === 16406 ? 1 : 2,
      position = counts[port - 1]++;
    assert.equal(read.value, null);
    assert.equal(read.file_offset, null);
    assert.deepEqual(read.ram_origins, []);
    const source = read.mapper_origins[0];
    assert.equal(source.kind, "standard-controller");
    assert.equal(source.port, port);
    assert.equal(source.strobe, false);
    assert.equal(source.tail_bit, 1);
    if (sample.safe) {
      assert.deepEqual(source.serial_reports, [
        {
          position,
          buttons: port === 1 ? sample.buttons : 78,
          origin: {
            kind: "latch-write",
            port,
            index: 6401,
            buttons_origin: { kind: "initial-buttons", port },
          },
        },
      ]);
      if (port === 2 || typeof sample.buttons === "number" || position >= 6)
        assert.deepEqual(read.known_bits, {
          mask: 1,
          value:
            ((port === 2
              ? 78
              : typeof sample.buttons === "number"
                ? sample.buttons
                : sample.buttons.value) >>
              position) &
            1,
        });
      else assert.equal("known_bits" in read, false);
    }
  }
  const result = code.instructions.find(
    (instruction) => instruction.address === 0xe21c,
  ).data_reads[0];
  if (sample.safe) assert.equal(result.value, 114);
}
