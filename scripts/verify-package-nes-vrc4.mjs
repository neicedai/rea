import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Verify installed VRC4 banking against independent cartridge byte coordinates. */
export async function verifyPackageVrc4(invoke, workspace) {
  const boards = [
    [21, 1, 1, 2],
    [21, 2, 6, 7],
    [23, 1, 0, 1],
    [23, 2, 2, 3],
    [25, 1, 1, 0],
    [25, 2, 3, 2],
  ];
  for (const [mapper, submapper, a0, a1] of boards) {
    const bytes = Buffer.alloc(528 + 131072 + 524288, 0x02);
    bytes.fill(0, 0, 16);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      8,
      64,
      ((mapper & 15) << 4) | 4,
      0x18,
      submapper << 4,
    ]);
    const port = (base, p) => base | ((p & 1) << a0) | ((p >> 1) << a1);
    const program = [
      [0x8000, 2],
      [0xa000, 5],
      [port(0x9000, 2), 2],
      [port(0x9000, 0), 2],
      [port(0xe000, 2), 15],
      [port(0xe000, 3), 31],
    ].flatMap(([address, value]) => [
      0xa9,
      value,
      0x8d,
      address & 255,
      address >> 8,
    ]);
    bytes.set([...program, 0x4c, 0x10, 0xc0], 528 + 15 * 8192);
    bytes.set([0xa9, 0x66, 0x60], 528 + 2 * 8192 + 16);
    bytes.writeUInt16LE(0xe000, 528 + 131072 - 4);
    const path = join(workspace, `packaged-vrc4-${mapper}-${submapper}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper, variant: "vrc4" } };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.final_cpu.a, 0x66);
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [
      528 + 2 * 8192 + 16,
      528 + 2 * 8192 + 17,
    ]);
    for (const instruction of trace.instructions) {
      assert.ok(
        instruction.file_offsets.every((offset) => Number.isInteger(offset)),
      );
      assert.equal(
        instruction.bytes_hex,
        Buffer.from(
          instruction.file_offsets.map((offset) => bytes[offset]),
        ).toString("hex"),
      );
    }
    assert.deepEqual(
      trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
      [14, 5, 2, 15],
    );
    assert.equal(trace.mapper_trace.final_mapping.chr_windows[7].bank, 511);
    assert.equal(trace.mapper_trace.final_mapping.mirroring, "one-screen-a");
    const writes = trace.instructions.flatMap((i) => i.writes);
    const replay = await invoke("trace-nes-mapper-writes", {
      ...input,
      writes,
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    const events = await invoke("trace-nes-mapper-events", {
      ...input,
      events: [
        ...writes.map((write) => ({ ...write, kind: "cpu-write" })),
        { kind: "ppu-read", address: 0x1fff },
      ],
    });
    assert.equal(events.normalized_result.trace.status, "derived");
    assert.deepEqual(
      events.normalized_result.trace.final_mapping,
      trace.mapper_trace.final_mapping,
    );
    assert.deepEqual(events.normalized_result.trace.steps.at(-1).read_source, {
      status: "chr-rom",
      bank: 511,
      file_offset: bytes.length - 1,
    });
    const explored = await invoke("explore-nes-code", input);
    assert.equal(explored.normalized_result.code_exploration.status, "derived");
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
  await verifyPackageVrc4Irq(invoke, workspace);
  await verifyPackageVrcWiring(invoke, workspace);
}

async function verifyPackageVrc4Irq(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 65536 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x50, 0x18, 0x20]);
  const path = join(workspace, "packaged-vrc4-irq.nes");
  await writeFile(path, bytes);
  // Mapper 21.2: chip A0/A1 come from CPU A6/A7.
  const write = (address, value) => ({ kind: "cpu-write", address, value });
  const cycle = { kind: "vrc-cpu-cycle" };
  const input = {
    path,
    initial: { mapper: 21, variant: "vrc4" },
    initial_irq: { model: "vrc4" },
    events: [
      write(0xf000, 14),
      write(0xf040, 15),
      write(0xf080, 3),
      ...Array.from({ length: 341 }, () => cycle),
    ],
  };
  const evidence = await invoke("trace-nes-mapper-events", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.trace;
  assert.equal(trace.status, "derived");
  assert.deepEqual(
    trace.steps.flatMap((s, i) => (s.irq_clock ? [i] : [])),
    [116, 230, 343],
  );
  assert.deepEqual(trace.steps[116].irq, {
    model: "vrc4",
    counter: 255,
    prescaler: [340],
    asserted: false,
  });
  assert.deepEqual(trace.steps[230].irq, {
    model: "vrc4",
    counter: 254,
    prescaler: [339],
    asserted: true,
  });
  assert.deepEqual(trace.final_irq, {
    model: "vrc4",
    counter: 255,
    prescaler: [341],
    asserted: true,
  });
  const cut = 60,
    semantic = resolvedSteps(trace),
    snapshot = semantic[cut - 1];
  const continued = await invoke("trace-nes-mapper-events", {
    path,
    initial: snapshot.state,
    initial_irq: snapshot.irq,
    events: input.events.slice(cut),
  });
  assert.equal(continued.normalized_result.trace.status, "derived");
  assert.deepEqual(
    resolvedSteps(continued.normalized_result.trace).map((s) => ({
      ...s,
      index: s.index + cut,
    })),
    semantic.slice(cut),
  );
  const partial = await invoke("trace-nes-mapper-events", {
    path,
    initial: {
      mapper: 21,
      variant: "vrc4",
      irq_control: 6,
      irq_enabled: true,
      irq_latch_low: 14,
      irq_latch_high: 15,
    },
    initial_irq: {
      model: "vrc4",
      counter: { mask: 254, value: 254 },
      asserted: false,
    },
    events: [cycle],
  });
  assert.equal(partial.normalized_result.trace.status, "derived");
  assert.deepEqual(partial.normalized_result.trace.final_irq, {
    model: "vrc4",
    counter: { mask: 254, value: 254 },
    prescaler: null,
    asserted: null,
  });
  assert.deepEqual(await readFile(path), bytes);
}

function resolvedSteps(trace) {
  return trace.steps.map((step) => {
    if (!("mapper_snapshot" in step)) return step;
    const { mapper_snapshot, ...event } = step;
    const snapshot = trace.mapper_snapshots[mapper_snapshot];
    assert.ok(snapshot);
    assert.notEqual("irq" in snapshot, "irq" in event);
    return { ...snapshot, ...event };
  });
}

/** Independent installed CLI oracle for immutable legacy-board assumptions. */
export async function verifyPackageVrcWiring(invoke, workspace) {
  const boards = [
    [22, "vrc2a", 1, 0],
    [23, "vrc2b", 0, 1],
    [25, "vrc2c", 1, 0],
    [21, "vrc4a", 1, 2],
    [25, "vrc4b", 1, 0],
    [21, "vrc4c", 6, 7],
    [25, "vrc4d", 3, 2],
    [23, "vrc4e", 2, 3],
    [23, "vrc4f", 0, 1],
  ];
  for (const [mapper, wiring, a0, a1] of boards)
    for (const nes2 of [false, true]) {
      const vrc4 = wiring.startsWith("vrc4");
      const chr = vrc4 ? 524288 : mapper === 22 ? 131072 : 262144;
      const bytes = Buffer.alloc(528 + 65536 + chr, 2);
      bytes.fill(0, 0, 16);
      bytes.set([
        0x4e,
        0x45,
        0x53,
        0x1a,
        4,
        chr / 8192,
        ((mapper & 15) << 4) | 4,
        0x10 | (nes2 ? 8 : 0),
      ]);
      const port = (base, p) => base | ((p & 1) << a0) | ((p >> 1) << a1);
      const writes = [
        [0x8000, 2],
        [0xa000, 5],
        [port(0x9000, 2), vrc4 ? 2 : 0],
        [port(0x9000, 0), 3],
        [port(0xb000, 0), 15],
        [port(0xb000, 1), vrc4 ? 31 : 15],
      ];
      const program = writes.flatMap(([address, value]) => [
        0xa9,
        value,
        0x8d,
        address & 255,
        address >> 8,
      ]);
      bytes.set([...program, 0x4c, 0x10, vrc4 ? 0xc0 : 0x80], 528 + 7 * 8192);
      bytes.set([0xa9, 0x77, 0x60], 528 + 2 * 8192 + 16);
      bytes.writeUInt16LE(0xe000, 528 + 65536 - 4);
      const path = join(
        workspace,
        `packaged-${wiring}-${nes2 ? "submapper-zero" : "legacy"}.nes`,
      );
      await writeFile(path, bytes);
      const initial = { mapper, wiring, ...(vrc4 ? { variant: "vrc4" } : {}) };
      const input = { path, initial };
      const evidence = await invoke("trace-nes-code", input);
      assert.equal(
        evidence.normalized_result.artifact.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
      assert.deepEqual(evidence.normalized_result.header.header, [
        ...bytes.subarray(0, 16),
      ]);
      assert.equal(
        evidence.normalized_result.header.headerVersion,
        nes2 ? "nes2" : "ines",
      );
      assert.equal(
        evidence.normalized_result.header.submapper,
        nes2 ? 0 : null,
      );
      const trace = evidence.normalized_result.code_trace;
      assert.equal(trace.status, "derived");
      assert.equal(trace.stop.reason, "return");
      assert.equal(trace.final_cpu.a, 0x77);
      assert.equal(trace.mapper_trace.final.wiring, wiring);
      assert.deepEqual(
        trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
        vrc4 ? [6, 5, 2, 7] : [2, 5, 6, 7],
      );
      const bank = vrc4 ? 511 : mapper === 22 ? 127 : 255;
      assert.equal(trace.mapper_trace.final_mapping.chr_windows[0].bank, bank);
      assert.equal(
        trace.mapper_trace.final_mapping.mirroring,
        vrc4 ? "one-screen-b" : "horizontal",
      );
      assert.ok(
        trace.mapper_trace.nes_prg_views.every((v) => v.wiring === wiring),
      );
      for (const instruction of trace.instructions) {
        assert.ok(
          instruction.file_offsets.every((offset) => Number.isInteger(offset)),
        );
        assert.equal(
          instruction.bytes_hex,
          Buffer.from(
            instruction.file_offsets.map((offset) => bytes[offset]),
          ).toString("hex"),
        );
      }
      const replay = await invoke("trace-nes-mapper-writes", {
        ...input,
        writes: trace.instructions.flatMap((i) => i.writes),
      });
      assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
      const events = await invoke("trace-nes-mapper-events", {
        ...input,
        events: [
          ...trace.instructions
            .flatMap((i) => i.writes)
            .map((w) => ({ ...w, kind: "cpu-write" })),
          { kind: "ppu-read", address: 0x3ff },
        ],
      });
      assert.equal(events.normalized_result.trace.status, "derived");
      assert.deepEqual(
        events.normalized_result.trace.final,
        trace.mapper_trace.final,
      );
      assert.deepEqual(
        events.normalized_result.trace.steps.at(-1).read_source,
        {
          status: "chr-rom",
          bank,
          file_offset: 528 + 65536 + bank * 1024 + 1023,
        },
      );
      const continued = await invoke("trace-nes-code", {
        path,
        initial: trace.mapper_trace.final,
        entry: vrc4 ? 0xc010 : 0x8010,
      });
      assert.equal(continued.normalized_result.code_trace.final_cpu.a, 0x77);
      if (mapper !== 22) {
        const { wiring: unused, ...unselected } = initial;
        const missing = await invoke("trace-nes-code", {
          path,
          initial: unselected,
        });
        assert.equal(
          missing.normalized_result.code_trace.status,
          "unsupported",
        );
        assert.equal(
          missing.normalized_result.artifact.sha256,
          evidence.normalized_result.artifact.sha256,
        );
      }
      assert.deepEqual(await readFile(path), bytes);
    }
}
