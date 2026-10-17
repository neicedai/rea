import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRG,
  CHR,
  variants,
  initial,
  fixture,
  ppu,
  write,
} from "./verify-package-nes-irem78-fixture.mjs";

const snapshot = (trace, index) => {
  const step = trace.steps[index];
  return "mapper_snapshot" in step
    ? { ...trace.mapper_snapshots[step.mapper_snapshot], ...step }
    : step;
};
function verifyBytes(trace, bytes) {
  for (const instruction of trace.instructions) {
    assert.deepEqual(instruction.ram_origins, []);
    for (const [index, value] of Buffer.from(
      instruction.bytes_hex,
      "hex",
    ).entries())
      assert.equal(bytes[instruction.file_offsets[index]], value);
  }
}
/** Independent old-bank AND, variant routing and immutable-source oracles. */
export async function verifyPackageNesIrem78(invoke, workspace) {
  const files = new Map();
  const save = async (name, bytes) => {
    const path = join(workspace, name);
    await writeFile(path, bytes);
    files.set(path, bytes);
    return path;
  };
  let workflows = 0;
  const call = async (command, input) => {
    workflows++;
    const evidence = await invoke(command, input);
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(files.get(input.path)).digest("hex"),
    );
    return evidence.normalized_result;
  };
  const boards = [];
  for (const variant of variants) {
    const bytes = fixture(variant);
    const path = await save(`irem78-${variant}.nes`, bytes);
    boards.push({ variant, bytes, path });
  }
  const traces = [];
  for (const board of boards) traces.push(await banking({ call, ...board }));
  await sourceContinuation({ call, ...boards[0], trace: traces[0] });
  await nametables({ call, boards });
  await uncertainSources({ call, ...boards[0] });
  await logicalAliases({ call, save, ...boards[0] });
  await qualification({ call, save, ...boards[0] });
  await bufferedCpuRead({ call, ...boards[1] });
  await sourceConflictProof({ call, ...boards[0] });
  for (const [path, bytes] of files)
    assert.deepEqual(await readFile(path), bytes);
  assert.equal(workflows, 27);
  return {
    ok: true,
    workflows,
    bus_conflicts: true,
    variant_mirroring: true,
    selector_uncertainty: true,
    source_continuation: true,
    original_unchanged: true,
    scope:
      "Conditional original Cosmo Carrier/Holy Diver PRG/CHR/CIRAM derivations with pre-write AND bus conflicts; synthetic immutable ROMs, no IRQ, physical electrical observation or commercial-game compatibility claim",
  };
}
async function banking({ call, variant, path, bytes }) {
  const base = {
    path,
    initial: initial(variant),
    cpu: { sp: 255 },
    max_instructions: 64,
  };
  const trace = (await call("trace-nes-code", base)).code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0xd4);
  verifyBytes(trace, bytes);
  assert.deepEqual(
    trace.instructions.find((item) => item.address === 0xbfff).file_offsets,
    [PRG + 6 * 16384 - 1, PRG + 7 * 16384],
  );
  assert.deepEqual(
    trace.mapper_trace.steps.map((step) => step.state.latch),
    [0xad, 0x76],
  );
  assert.deepEqual(
    trace.mapper_trace.steps.map((step) => step.mapping.prg_windows[0].bank),
    [5, 6],
  );
  assert.deepEqual(
    trace.mapper_trace.steps.map((step) => step.mapping.chr_windows[0].bank),
    [10, 7],
  );
  assert.deepEqual(
    trace.mapper_trace.steps.map((step) => step.mapping.mirroring),
    variant === "cosmo-carrier"
      ? ["one-screen-b", "one-screen-a"]
      : ["vertical", "horizontal"],
  );
  assert.deepEqual(
    trace.mapper_trace.nes_prg_views,
    [2, 5, 6].map((prg_bank) => ({ mapper: 78, variant, prg_bank })),
  );
  const writes = trace.instructions
    .flatMap((item) => item.writes)
    .filter((item) => item.address >= 0x8000);
  assert.deepEqual(
    writes.map((item) => item.value),
    [255, 247],
  );
  assert.deepEqual(
    (
      await call("trace-nes-mapper-writes", {
        path,
        initial: base.initial,
        writes,
      })
    ).trace,
    trace.mapper_trace,
  );
  const events = (
    await call("trace-nes-mapper-events", {
      path,
      initial: base.initial,
      events: writes.flatMap((item) => [
        { ...item, kind: "cpu-write" },
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-read", address: 0x1fff },
      ]),
    })
  ).trace;
  assert.deepEqual(
    events.steps
      .filter((item) => item.event.kind === "ppu-read")
      .map((item) => item.read_source.file_offset),
    [CHR + 10 * 8192, CHR + 11 * 8192 - 1, CHR + 7 * 8192, CHR + 8 * 8192 - 1],
  );
  assert.deepEqual(events.final_mapping, trace.mapper_trace.final_mapping);
  if (variant === "cosmo-carrier")
    assert.deepEqual(
      (await call("explore-nes-code", base)).code_exploration.paths[0].trace,
      trace,
    );
  return trace;
}
async function sourceContinuation({ call, variant, path, bytes, trace }) {
  const prefix = (
    await call("trace-nes-code", {
      path,
      initial: initial(variant),
      cpu: { sp: 255 },
      max_instructions: 2,
    })
  ).code_trace;
  assert.equal(prefix.stop.reason, "instruction-budget");
  assert.equal(prefix.stop.address, 0xc185);
  const continued = (
    await call("trace-nes-code", {
      path,
      initial: prefix.mapper_trace.final,
      cpu: prefix.final_cpu,
      entry: prefix.stop.address,
    })
  ).code_trace;
  verifyBytes(continued, bytes);
  assert.deepEqual(continued.final_cpu, trace.final_cpu);
  assert.deepEqual(
    continued.mapper_trace.final_mapping,
    trace.mapper_trace.final_mapping,
  );
  assert.deepEqual(
    [...prefix.instructions, ...continued.instructions].map((item) => [
      item.address,
      item.file_offsets,
      item.bytes_hex,
    ]),
    trace.instructions.map((item) => [
      item.address,
      item.file_offsets,
      item.bytes_hex,
    ]),
  );
}
async function nametables({ call, boards }) {
  const events = [
    { kind: "ppu-write", address: 0x2000, value: 0x37 },
    { kind: "ppu-write", address: 0x2400, value: 0x69 },
    { kind: "ppu-read", address: 0x2800 },
    write(0xc300, 0xa5),
    { kind: "ppu-write", address: 0x2000, value: 0x58 },
    ...[0x2400, 0x2800, 0x2c00].map((address) => ({
      kind: "ppu-read",
      address,
    })),
  ];
  for (const { path, variant } of boards) {
    const input = {
      path,
      initial: initial(variant, 0xad),
      initial_ppu: ppu,
      events,
    };
    const trace = (await call("trace-nes-mapper-events", input)).trace;
    const expected =
      variant === "cosmo-carrier"
        ? [0x69, 0x58, 0x58, 0x58]
        : [0x37, 0x58, 0x69, 0x69];
    assert.deepEqual(
      trace.steps
        .filter((item) => item.event.kind === "ppu-read")
        .map((item) => item.read_source.value),
      expected,
    );
    assert.equal(trace.final.latch, 0xa5);
    if (variant === "holy-diver") {
      const prefix = (
        await call("trace-nes-mapper-events", {
          ...input,
          events: events.slice(0, 3),
        })
      ).trace;
      const continued = (
        await call("trace-nes-mapper-events", {
          ...input,
          initial: snapshot(prefix, 2).state,
          initial_ppu: {
            ...prefix.ppu_trace.final,
            next_event_index: prefix.ppu_trace.initial.next_event_index + 3,
          },
          events: events.slice(3),
        })
      ).trace;
      assert.deepEqual(continued.final_mapping, trace.final_mapping);
      assert.deepEqual(continued.ppu_trace.final, trace.ppu_trace.final);
      assert.deepEqual(
        continued.steps
          .filter((item) => item.event.kind === "ppu-read")
          .map((item) => item.read_source.value),
        expected.slice(1),
      );
    }
  }
}
async function uncertainSources({ call, variant, path, bytes }) {
  for (const [latch, address] of [
    [{ mask: 248, value: 0x10 }, 0x8200],
    [{ mask: 254, value: 0x10 }, 0x8201],
  ]) {
    const trace = (
      await call("trace-nes-mapper-writes", {
        path,
        initial: initial(variant, latch),
        writes: [{ address, value: 255 }],
      })
    ).trace;
    assert.deepEqual(trace.final.latch, { mask: 247, value: 0xa5 });
    assert.equal(trace.final_mapping.prg_windows[0].bank, 5);
    assert.equal(trace.final_mapping.chr_windows[0].bank, 10);
    assert.equal(trace.final_mapping.mirroring, "unknown");
  }
  const partial = (
    await call("trace-nes-mapper-writes", {
      path,
      initial: initial(variant),
      writes: [
        { address: 0xc320, value: null, known_bits: { mask: 240, value: 160 } },
      ],
    })
  ).trace;
  assert.deepEqual(partial.final.latch, { mask: 242, value: 0 });
  assert.equal(partial.final_mapping.prg_windows[0].bank, null);
  assert.equal(partial.final_mapping.chr_windows[0].bank, 0);
  const patterns = (
    await call("trace-nes-mapper-events", {
      path,
      initial: initial(variant, { mask: 239, value: 0xa5 }),
      initial_ppu: ppu,
      ppu_pattern_table: 0,
      events: [],
    })
  ).trace;
  const table = patterns.ppu_trace.pattern_table;
  assert.equal(table.coverage.unresolved_source_blocks, 4);
  assert.deepEqual(
    table.blocks[0].sources.map(
      (index) => table.source_pages[index].file_offset,
    ),
    [CHR + 10 * 8192, CHR + 11 * 8192],
  );
  assert.deepEqual(table.tiles[0].rows[0], [
    0,
    0,
    0,
    0,
    3,
    0,
    3,
    { choices: [0, 3] },
  ]);
  for (const page of table.source_pages)
    assert.equal(
      page.bytes_hex,
      bytes.subarray(page.file_offset, page.file_offset + 1024).toString("hex"),
    );
}
async function logicalAliases({ call, save, variant, bytes }) {
  const small = Buffer.concat([
    bytes.subarray(0, PRG),
    bytes.subarray(PRG, PRG + 32768),
    bytes.subarray(CHR, CHR + 8192),
  ]);
  small[4] = 2;
  small[5] = 1;
  const path = await save("irem78-small.nes", small);
  const partial = (
    await call("trace-nes-mapper-writes", {
      path,
      initial: initial(variant, { mask: 1, value: 1 }),
      writes: [],
    })
  ).trace;
  assert.deepEqual(
    partial.final_mapping.prg_windows.map((item) => item.bank),
    [1, 1],
  );
  assert.equal(partial.final_mapping.prg_view, null);
  const aliases = (
    await call("trace-nes-mapper-writes", {
      path,
      initial: initial(variant, 5),
      writes: [],
    })
  ).trace;
  assert.deepEqual(
    aliases.final_mapping.prg_windows.map((item) => [
      item.bank,
      item.file_offset,
    ]),
    [
      [1, PRG + 16384],
      [1, PRG + 16384],
    ],
  );
  assert.deepEqual(aliases.nes_prg_views, [
    { mapper: 78, variant, prg_bank: 5 },
  ]);
}
async function qualification({ call, save, variant, path, bytes }) {
  const legacy = Buffer.from(bytes);
  legacy[7] = 0x40;
  legacy[8] = 0;
  legacy[6] |= 8;
  const retained = (
    await call("trace-nes-mapper-events", {
      path: await save("irem78-legacy-alt.nes", legacy),
      initial: initial(variant, 5),
      initial_ppu: ppu,
      events: [
        { kind: "ppu-write", address: 0x2000, value: 0x6d },
        { kind: "ppu-read", address: 0x2c00 },
      ],
    })
  ).trace;
  assert.equal(retained.status, "derived");
  assert.equal(retained.final_mapping.mirroring, "one-screen-a");
  assert.equal(retained.steps[1].read_source.value, 0x6d);
  for (const [name, changes] of [
    ["deprecated", [[8, 0x20]]],
    ["conflicting", [[8, 0x30]]],
    ["four-screen", [[6, bytes[6] | 8]]],
  ]) {
    const changed = Buffer.from(bytes);
    for (const [index, value] of changes) changed[index] = value;
    assert.equal(
      (
        await call("trace-nes-mapper-writes", {
          path: await save(`irem78-${name}.nes`, changed),
          initial: initial(variant),
          writes: [],
        })
      ).trace.status,
      "unsupported",
    );
  }
  assert.equal(
    (
      await call("trace-nes-code", {
        path,
        initial: initial(variant),
        entry: 0x6000,
        initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x60 }],
      })
    ).code_trace.status,
    "unsupported",
  );
}
async function bufferedCpuRead({ call, variant, path, bytes }) {
  const input = {
    path,
    initial: initial(variant, 0xad),
    entry: 0xc380,
    initial_ppu: { ...ppu, v: { low: 0, high: 0 }, read_buffer: { value: 73 } },
  };
  const trace = (await call("trace-nes-code", input)).code_trace;
  verifyBytes(trace, bytes);
  assert.deepEqual(
    trace.instructions
      .filter((item) => item.mnemonic === "LDA")
      .map((item) => item.data_reads[0].value),
    [73, 10],
  );
  assert.equal(trace.mapper_trace.ppu_trace.final.read_buffer.value, 10);
  assert.equal(
    trace.mapper_trace.ppu_trace.final.read_buffer.sources[0].file_offset,
    CHR + 10 * 8192 + 1,
  );
  const replay = (
    await call("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      initial_ppu: input.initial_ppu,
      events: trace.mapper_trace.steps.map((item) => item.event),
    })
  ).trace;
  assert.deepEqual(replay, trace.mapper_trace);
}
async function sourceConflictProof({ call, variant, path, bytes }) {
  const trace = (
    await call("trace-nes-code", {
      path,
      initial: initial(variant, { mask: 1, value: 1 }),
      entry: 0xc3c0,
    })
  ).code_trace;
  assert.equal(trace.stop.reason, "return");
  verifyBytes(trace, bytes);
  assert.equal(trace.final_cpu.a, 0x66);
  assert.equal(trace.stop.address, 0x8102);
  assert.deepEqual(
    trace.instructions.find((item) => item.address === 0x8100).file_offsets,
    [PRG + 16384 + 0x100, PRG + 16384 + 0x101],
  );
  const supplied = trace.mapper_trace;
  assert.equal(supplied.final.latch, 0xa9);
  assert.equal(supplied.final_mapping.prg_windows[0].bank, 1);
  assert.equal(supplied.final_mapping.chr_windows[0].bank, 10);
  assert.equal(supplied.final_mapping.mirroring, "one-screen-b");
}
