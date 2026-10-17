import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Verify installed mapper-event state, source provenance and IRQ signal filtering. */

export async function verifyPackageNesEvents(invoke, workspace) {
  const write = (address, value) => ({
    kind: "cpu-write",
    address,
    value,
    preceded_by_cpu_write: false,
  });
  const read = (address) => ({ kind: "ppu-read", address });
  const serial = (address, value) =>
    Array.from({ length: 5 }, (_, bit) => write(address, (value >> bit) & 1));
  const scenarios = [
    ...[23, 25].map((mapper) => ({
      mapper,
      submapper: 3,
      chrSize: 262144,
      initial: { mapper },
      events: [
        ...Array.from({ length: 8 }, (_, index) => {
          const base = 0xbffc + Math.floor(index / 2) * 4096;
          const lowPort = mapper === 23 ? (index % 2) * 2 : index % 2;
          return [
            write(base + lowPort, 240 | (index * 2 + 1)),
            write(base + lowPort + (mapper === 23 ? 1 : 2), 240 | (15 - index)),
          ];
        }).flat(),
        ...Array.from({ length: 8 }, (_, index) => read(index * 1024)),
        write(0xb000, 255),
        read(1023),
        { ...write(0xb000, null), known_bits: { mask: 14, value: 6 } },
        read(0),
        write(0xb000, 7),
        read(0),
      ],
      offsets: [241, 227, 213, 199, 185, 171, 157, 143]
        .map((bank) => bank * 1024)
        .concat([262143, null, 247 * 1024]),
    })),
    {
      mapper: 22,
      chrSize: 131072,
      initial: { mapper: 22 },
      events: [
        ...Array.from({ length: 8 }, (_, index) => {
          const base = 0xbffc + Math.floor(index / 2) * 4096 + (index % 2);
          return [
            write(base, 240 | (index * 2 + 1)),
            write(base + 2, 240 | (15 - index)),
          ];
        }).flat(),
        ...Array.from({ length: 8 }, (_, index) => read(index * 1024)),
        write(0xb000, 255),
        read(1023),
        { ...write(0xb000, null), known_bits: { mask: 14, value: 6 } },
        read(0),
        { ...write(0xb000, null), known_bits: { mask: 12, value: 4 } },
        read(0),
        write(0xb000, 6),
        read(0),
      ],
      offsets: [120, 113, 106, 99, 92, 85, 78, 71]
        .map((bank) => bank * 1024)
        .concat([131071, 123 * 1024, null, 123 * 1024]),
    },
    {
      mapper: 75,
      chrSize: 131072,
      initial: { mapper: 75 },
      events: [
        write(0x9fff, 7),
        write(0xefff, 0xf3),
        write(0xffff, 0xe4),
        read(0),
        read(8191),
        write(0x9000, 2),
        read(0),
        read(8191),
        write(0xf000, 9),
        read(4096),
        { ...write(0x9000, null), known_bits: { mask: 2, value: 2 } },
        read(0),
        read(4096),
        write(0x9000, 6),
        read(4096),
      ],
      offsets: [
        19 * 4096,
        21 * 4096 - 1,
        19 * 4096,
        5 * 4096 - 1,
        9 * 4096,
        19 * 4096,
        null,
        25 * 4096,
      ],
    },
    {
      mapper: 33,
      chrSize: 524288,
      initial: { mapper: 33 },
      events: [
        write(0x9ffe, 255),
        write(0x9fff, 3),
        write(0xbffc, 255),
        write(0xbffd, 128),
        write(0xbffe, 2),
        write(0xbfff, 9),
        ...Array.from({ length: 8 }, (_, window) => read(window * 1024)),
        read(2047),
        { ...write(0x8002, null), known_bits: { mask: 254, value: 2 } },
        read(0),
        read(1024),
        write(0x8002, 3),
        read(0),
        read(1024),
      ],
      offsets: [
        510 * 1024,
        511 * 1024,
        6 * 1024,
        7 * 1024,
        255 * 1024,
        128 * 1024,
        2 * 1024,
        9 * 1024,
        524287,
        null,
        null,
        6 * 1024,
        7 * 1024,
      ],
    },
    {
      mapper: 1,
      initial: {
        mapper: 1,
        prg_mode: 3,
        prg_bank: 0,
        chr_mode: 1,
        chr_bank_0: 3,
        chr_bank_1: 6,
        shift_bits: [],
      },
      events: [
        read(0),
        write(0x8000, 128),
        ...serial(0x8000, 0),
        read(0),
        read(4096),
        ...serial(0xa000, 7),
        read(8191),
      ],
      offsets: [12288, 8192, 12288, 32767],
    },
    {
      mapper: 4,
      initial: { mapper: 4, bank_select: 0, banks: [3, 5, 6, 7, 8, 9, 0, 1] },
      events: [
        read(1023),
        write(0x8000, 128),
        read(1023),
        write(0x8000, 129),
        write(0x8001, 15),
        read(6144),
        read(8191),
        write(0x8000, null),
        read(0),
      ],
      offsets: [3071, 7167, 14336, 16383, null],
    },
  ];
  for (const submapper of [0, 1]) {
    scenarios.push({
      mapper: 206,
      submapper,
      initial: { mapper: 206 },
      events: [
        ...[255, 27, 194, 63, 170, 21].flatMap((bank, register) => [
          write(0x9ffe, 0xc0 | register),
          write(0x9fff, bank),
        ]),
        write(0xa000, 0),
        ...Array.from({ length: 8 }, (_, window) => read(window * 1024)),
        write(0x8000, 0),
        { ...write(0x8001, null), known_bits: { mask: 62, value: 2 } },
        read(0),
        read(1024),
        write(0x8000, 2),
        { ...write(0x8001, null), known_bits: { mask: 62, value: 2 } },
        read(4096),
        write(0x8001, 2),
        read(4096),
      ],
      offsets: [30, 31, 26, 27, 2, 31, 10, 21, 2, 3, null, 2].map((bank) =>
        bank === null ? null : bank * 1024,
      ),
    });
  }
  for (const scenario of scenarios) {
    // Synthetic NES 2.0 with trainer and independently patterned CHR pages.
    const prgSize = scenario.submapper === 1 ? 32768 : 65536;
    const chrSize = scenario.chrSize ?? 32768;
    const bytes = Buffer.alloc(16 + 512 + prgSize + chrSize);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      prgSize / 16384,
      chrSize / 8192,
      ((scenario.mapper & 15) << 4) | 4,
      (scenario.mapper & 240) | 8,
      (scenario.submapper ?? 0) << 4,
    ]);
    const chrOffset = 16 + 512 + prgSize;
    for (let offset = 0; offset < chrSize; offset++)
      bytes[chrOffset + offset] = (offset * 13 + (offset >> 10)) & 255;
    const path = join(
      workspace,
      `packaged-mapper-events-${scenario.mapper}-${scenario.submapper ?? 0}.nes`,
    );
    await writeFile(path, bytes);
    const input = { path, initial: scenario.initial, events: scenario.events };
    const evidence = await invoke("trace-nes-mapper-events", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.coverage.processed_events, scenario.events.length);
    assert.equal(
      trace.coverage.unknown_pattern_reads,
      scenario.offsets.filter((offset) => offset === null).length,
    );
    const reads = trace.steps.filter((step) => step.event.kind === "ppu-read");
    assert.deepEqual(
      reads.map((step) => step.read_source.file_offset),
      scenario.offsets.map((offset) =>
        offset === null ? null : chrOffset + offset,
      ),
    );
    for (const [index, offset] of scenario.offsets.entries()) {
      if (offset === null)
        assert.equal(reads[index].read_source.status, "unknown-chr-bank");
      else {
        assert.equal(reads[index].read_source.status, "chr-rom");
        assert.equal(
          bytes[reads[index].read_source.file_offset],
          (offset * 13 + (offset >> 10)) & 255,
        );
      }
    }
    // Resuming an event stream must preserve serial alignment and past snapshots.
    const split = 4;
    const resumed = await invoke("trace-nes-mapper-events", {
      path,
      initial: trace.steps[split - 1].state,
      events: scenario.events.slice(split),
    });
    assert.equal(resumed.normalized_result.trace.status, "derived");
    assert.deepEqual(resumed.normalized_result.trace.final, trace.final);
    assert.deepEqual(
      resumed.normalized_result.trace.steps.map(
        ({ index: _index, ...step }) => step,
      ),
      trace.steps.slice(split).map(({ index: _index, ...step }) => step),
    );
    const replay = await invoke("trace-nes-mapper-writes", {
      path,
      initial: scenario.initial,
      writes: scenario.events
        .filter((event) => event.kind === "cpu-write")
        .map(({ kind: _kind, ...event }) => event),
    });
    assert.deepEqual(replay.normalized_result.trace.final, trace.final);
    assert.deepEqual(
      replay.normalized_result.trace.final_mapping,
      trace.final_mapping,
    );
    assert.deepEqual(
      replay.normalized_result.trace.nes_prg_views,
      trace.nes_prg_views,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
  await verifyIrqSignals(invoke, workspace);
}

async function verifyIrqSignals(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 32768 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0x40]);
  const path = join(workspace, "packaged-mmc3-irq-signals.nes");
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const write = (address) => ({ kind: "cpu-write", address, value: null });
  const high = { kind: "ppu-a12", high: true };
  const m2 = { kind: "cpu-m2-fall" };
  const pulse = (falls) => [
    { kind: "ppu-a12", high: false },
    ...Array.from({ length: falls }, () => m2),
    high,
  ];
  const events = [
    high,
    write(0xe000),
    write(0xc001),
    write(0xe001),
    ...pulse(2),
    ...pulse(3),
    write(0xe000),
    write(0xe001),
    ...pulse(3),
  ];
  for (const model of ["sharp", "nec"]) {
    const input = {
      path,
      initial: { mapper: 4, irq_latch: 0 },
      initial_irq: {
        model,
        counter: 1,
        reload_pending: false,
        enabled: true,
        asserted: false,
      },
      events,
    };
    const evidence = await invoke("trace-nes-mapper-events", input);
    assert.equal(evidence.normalized_result.artifact.sha256, sha256);
    const trace = evidence.normalized_result.trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.initial_irq.a12_filter, null);
    assert.deepEqual(
      trace.steps.map((step) => step.irq_clock),
      events.map((_, index) =>
        index === 0 ? null : index === 12 || index === 19,
      ),
    );
    assert.equal(trace.steps[0].irq.counter, null);
    assert.equal(trace.steps[0].irq.asserted, null);
    assert.equal(trace.steps[1].irq.asserted, false);
    assert.equal(trace.steps[7].irq.reload_pending, true);
    assert.equal(trace.steps[12].irq.asserted, true);
    assert.equal(trace.steps[13].irq.asserted, false);
    assert.deepEqual(trace.final_irq, {
      model,
      counter: 0,
      reload_pending: false,
      enabled: true,
      asserted: model === "sharp",
      a12_filter: ["high"],
      mcacc_prescaler: null,
    });
    const resumed = await invoke("trace-nes-mapper-events", {
      path,
      initial: trace.steps[10].state,
      initial_irq: trace.steps[10].irq,
      events: events.slice(11),
    });
    assert.deepEqual(trace.steps[10].irq.a12_filter, ["low-2"]);
    assert.deepEqual(
      resumed.normalized_result.trace.final_irq,
      trace.final_irq,
    );
    assert.deepEqual(
      resumed.normalized_result.trace.steps.map(
        ({ index: _index, ...step }) => step,
      ),
      trace.steps.slice(11).map(({ index: _index, ...step }) => step),
    );
    const clock = { kind: "mmc3-irq-clock" };
    const qualified = await invoke("trace-nes-mapper-events", {
      ...input,
      events: [
        write(0xe000),
        write(0xc001),
        write(0xe001),
        clock,
        write(0xe000),
        write(0xe001),
        clock,
      ],
    });
    assert.deepEqual(
      qualified.normalized_result.trace.final_irq,
      trace.final_irq,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
  const unspecified = await invoke("trace-nes-mapper-events", {
    path,
    initial: { mapper: 4 },
    events: [m2, high],
  });
  assert.equal(unspecified.normalized_result.trace.status, "unsupported");
  assert.match(unspecified.normalized_result.trace.reason, /initial_irq/);
  assert.equal(unspecified.normalized_result.artifact.sha256, sha256);
}
