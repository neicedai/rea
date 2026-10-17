import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed oracle: different trainer-free bytes, pointers and data from source fixtures. */
export async function verifyPackageEeprom(invoke, workspace) {
  for (const [mapper, model, page_size, size] of [
    [159, "x24c01", 4, 128],
    [16, "x24c02", 4, 256],
    [16, "x24c02", 16, 256],
  ]) {
    const bytes = Buffer.alloc(16 + 65536 + 8192, 2);
    bytes.fill(0, 0, 16);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      4,
      1,
      ((mapper & 15) << 4) | 2,
      (mapper & 0xf0) | 8,
      mapper === 16 ? 0x50 : 0,
      0,
      mapper === 16 ? 0x20 : 0x10,
    ]);
    const bus = stimulus(model, size - 1);
    // The first data bit of 0xD3 is one. It is sufficient to select a bank through D4.
    const firstData = bus.events.findIndex(
      (e) => e.kind === "cpu-read" && e.address === 0x7fff,
    );
    const program = bus.events
      .slice(0, firstData + 1)
      .flatMap((e) =>
        e.kind === "cpu-write"
          ? [0xa9, e.value, 0x8d, 13, 0x80]
          : [0xa9, 16, 0x2d, e.address & 255, e.address >> 8],
      );
    bytes.set(
      [
        ...program,
        0xf0,
        8,
        0xa9,
        1,
        0x8d,
        8,
        0x80,
        0x4c,
        0xff,
        0xbf,
        0xa9,
        0xee,
        0x60,
      ],
      16 + 3 * 16384 + 0x100,
    );
    bytes[16 + 2 * 16384 - 1] = 0xa9;
    bytes.set([0x5a, 0x4c, 0x10, 0x80], 16 + 3 * 16384);
    bytes.set([0xa9, 0x77, 0x60], 16 + 16384 + 16);
    bytes.writeUInt16LE(0xc100, 16 + 65536 - 4);
    const path = join(workspace, `packaged-eeprom-${model}-${page_size}.nes`),
      initial = {
        mapper,
        ...(mapper === 16 ? { variant: "lz93d50" } : {}),
        eeprom_control: 0x60,
        eeprom: {
          model,
          page_size,
          phase: "idle",
          busy: false,
          bytes: [
            { address: size - 1, value: 0xd3 },
            { address: 0, value: 0xb7 },
          ],
        },
      };
    await writeFile(path, bytes);
    const code = await invoke("trace-nes-code", { path, initial }),
      trace = code.normalized_result.code_trace;
    assert.equal(
      code.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.equal(trace.status, "derived");
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.final_cpu.a, 0x77);
    assert.deepEqual(
      trace.instructions.find((i) => i.address === 0xbfff).file_offsets,
      [16 + 2 * 16384 - 1, 16 + 3 * 16384],
    );
    const read = trace.instructions
      .flatMap((i) => i.data_reads)
      .find((r) => r.address === 0x7fff);
    assert.equal(read.value, null);
    assert.deepEqual(read.known_bits, { mask: 16, value: 16 });
    assert.equal(read.mapper_origins[0].kind, "bandai-eeprom");
    const events = await invoke("trace-nes-mapper-events", {
      path,
      initial,
      events: bus.events,
    });
    const bits = events.normalized_result.trace.steps.flatMap((s) =>
      s.cpu_read?.address === 0x7fff ? [s.cpu_read.known_bits?.value] : [],
    );
    assert.deepEqual(
      bits,
      [16, 16, 0, 16, 0, 0, 16, 16, 16, 0, 16, 16, 0, 16, 16, 16],
    );
    const write = stimulus(model, page_size - 1, [0x12, 0x34]);
    const pending = await invoke("trace-nes-mapper-events", {
      path,
      initial,
      events: write.events,
    });
    assert.equal(pending.normalized_result.trace.final.eeprom.busy, true);
    assert.deepEqual(
      pending.normalized_result.trace.final.eeprom.bytes,
      initial.eeprom.bytes,
    );
    const poll = await invoke("trace-nes-mapper-events", {
      path,
      initial: pending.normalized_result.trace.final,
      events: write.events,
    });
    assert.ok(
      poll.normalized_result.trace.steps
        .filter((s) => s.cpu_read)
        .every((s) => s.cpu_read.known_bits?.value === 16),
    );
    assert.deepEqual(
      poll.normalized_result.trace.final.eeprom.pending,
      pending.normalized_result.trace.final.eeprom.pending,
    );
    const done = await invoke("trace-nes-mapper-events", {
      path,
      initial: poll.normalized_result.trace.final,
      events: [{ kind: "eeprom-write-complete" }],
    });
    assert.equal(done.normalized_result.trace.final.eeprom.busy, false);
    assert.equal(
      done.normalized_result.trace.final.eeprom.bytes.find(
        (b) => b.address === page_size - 1,
      ).value,
      0x12,
    );
    assert.equal(
      done.normalized_result.trace.final.eeprom.bytes.find(
        (b) => b.address === 0,
      ).value,
      0x34,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
}

function stimulus(model, address, data) {
  const events = [],
    control = (value) =>
      events.push({ kind: "cpu-write", address: 0x800d, value }),
    start = () => {
      control(0x40);
      control(0x60);
      control(0x20);
    },
    stop = () => {
      control(0);
      control(0x20);
      control(0x60);
    },
    send = (value) => {
      for (let bit = 7; bit >= 0; bit--) {
        const b = ((value >> bit) & 1) << 6;
        control(b);
        control(b | 32);
        control(b);
      }
      control(0x80);
      control(0xa0);
      events.push({ kind: "cpu-read", address: 0x6001 });
      control(0x80);
    };
  start();
  if (model === "x24c01") send((address << 1) | Number(data === undefined));
  else {
    send(0xa0);
    send(address);
    if (data === undefined) {
      start();
      send(0xa1);
    }
  }
  if (data === undefined)
    for (let byte = 0; byte < 2; byte++) {
      for (let bit = 0; bit < 8; bit++) {
        control(0xa0);
        events.push({ kind: "cpu-read", address: 0x7fff });
        control(0x80);
      }
      control(byte === 0 ? 0 : 0x80);
      control(byte === 0 ? 0x20 : 0xa0);
      control(byte === 0 ? 0 : 0x80);
    }
  else for (const byte of data) send(byte);
  stop();
  return { events };
}
