import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRG,
  CHR76,
  CHR87,
  fixture76,
  fixture87,
  write,
  ppu,
} from "./verify-package-nes-early-mappers-fixture.mjs";

const state76 = (r6 = null, r7 = null) => ({
  mapper: 76,
  banks: [null, null, null, null, null, null, r6, r7],
});
const snapshots = (trace) =>
  trace.steps.map((step) =>
    "mapper_snapshot" in step
      ? { ...trace.mapper_snapshots[step.mapper_snapshot], ...step }
      : step,
  );
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
/** Byte-authored board oracles, independent of production mapper formulas. */
export async function verifyPackageNesEarlyMappers(invoke, workspace) {
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
  const bytes87 = fixture87(),
    bytes76 = fixture76();
  const path87 = await save("j87-independent.nes", bytes87),
    path76 = await save("namco76-independent.nes", bytes76);
  await banking87({ call, path: path87, bytes: bytes87 });
  await banking76({ call, path: path76, bytes: bytes76 });
  await partialPatterns({ call, path87, path76, bytes87, bytes76 });
  await viewUncertainty({ call, bytes76, save });
  await fixedMirroring({ call, path87, path76 });
  await qualification({ call, path87, path76, bytes87, bytes76, save });
  for (const [path, bytes] of files)
    assert.deepEqual(await readFile(path), bytes);
  assert.equal(workflows, 24);
  return {
    ok: true,
    workflows,
    mappers: [76, 87],
    banking: true,
    selector_uncertainty: true,
    no_cartridge_ram: true,
    original_unchanged: true,
    scope:
      "Conditional original Namco109/J87 PRG/CHR/CIRAM source derivations and Namco108 logical-view qualification; synthetic immutable ROMs, no IRQ, observed gameplay or physical timing claim",
  };
}
async function banking87({ call, path, bytes }) {
  const input = { path, initial: { mapper: 87 }, max_instructions: 32 };
  const trace = (await call("trace-nes-code", input)).code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  verifyBytes(trace, bytes);
  assert.equal(trace.mapper_trace.final.chr_bank, 2);
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((item) => item.bank),
    [0, 1],
  );
  assert.equal(trace.mapper_trace.final_mapping.chr_windows.length, 1);
  assert.equal(trace.mapper_trace.final_mapping.chr_windows[0].bank, 1);
  assert.deepEqual(trace.mapper_trace.nes_prg_views, []);
  const writes = trace.instructions.flatMap((item) => item.writes);
  assert.deepEqual(
    writes.map((item) => item.address),
    [0x6000, 0x7fff, 0x8000],
  );
  const replay = (
    await call("trace-nes-mapper-writes", {
      path,
      initial: input.initial,
      writes,
    })
  ).trace;
  assert.deepEqual(replay, trace.mapper_trace);
  const events = (
    await call("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      events: [
        write(0x6000, 1),
        { kind: "ppu-read", address: 0x1fff },
        write(0x7fff, 2),
        { kind: "ppu-read", address: 0 },
        write(0x8000, 3),
        { kind: "ppu-read", address: 0x1fff },
      ],
    })
  ).trace;
  assert.deepEqual(
    events.steps
      .filter((item) => item.event.kind === "ppu-read")
      .map((item) => item.read_source.file_offset),
    [CHR87 + 3 * 8192 - 1, CHR87 + 8192, CHR87 + 2 * 8192 - 1],
  );
  assert.deepEqual(events.final_mapping, trace.mapper_trace.final_mapping);
  assert.deepEqual(
    (await call("explore-nes-code", input)).code_exploration.paths[0].trace,
    trace,
  );
}
async function banking76({ call, path, bytes }) {
  const input = {
    path,
    initial: { mapper: 76 },
    cpu: { sp: 255 },
    max_instructions: 256,
  };
  const trace = (await call("trace-nes-code", input)).code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0xb6);
  verifyBytes(trace, bytes);
  assert.deepEqual(
    trace.instructions
      .filter((item) => item.address === 0x9fff || item.address === 0xbfff)
      .map((item) => item.file_offsets),
    [
      [PRG + 6 * 8192 - 1, PRG + 12 * 8192],
      [PRG + 13 * 8192 - 1, PRG + 14 * 8192],
    ],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((item) => item.bank),
    [13, 12, 14, 15],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.chr_windows.map((item) => item.bank),
    [3, 17, 42, 63],
  );
  assert.deepEqual(
    trace.mapper_trace.final.banks,
    [0xc9, 0xc7, 0xc3, 0xd1, 0xea, 0xff, 0xfd, 0xec],
  );
  assert.deepEqual(trace.mapper_trace.nes_prg_views, [
    { mapper: 76, r6: 5, r7: 12 },
    { mapper: 76, r6: 13, r7: 12 },
  ]);
  const writes = trace.instructions
    .flatMap((item) => item.writes)
    .filter((item) => item.address >= 0x8000);
  assert.deepEqual(
    (
      await call("trace-nes-mapper-writes", {
        path,
        initial: input.initial,
        writes,
      })
    ).trace,
    trace.mapper_trace,
  );
  const events = (
    await call("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      events: [
        ...writes.map((item) => ({ ...item, kind: "cpu-write" })),
        ...[3, 17, 42, 63].flatMap((_, index) => [
          { kind: "ppu-read", address: index * 2048 },
          { kind: "ppu-read", address: index * 2048 + 2047 },
        ]),
      ],
    })
  ).trace;
  assert.deepEqual(
    events.steps.slice(-8).map((item) => item.read_source.file_offset),
    [3, 17, 42, 63].flatMap((bank) => [
      CHR76 + bank * 2048,
      CHR76 + bank * 2048 + 2047,
    ]),
  );
  assert.deepEqual(events.final_mapping, trace.mapper_trace.final_mapping);
  assert.deepEqual(
    (await call("explore-nes-code", input)).code_exploration.paths[0].trace,
    trace,
  );
}
async function partialPatterns({ call, path87, path76, bytes87, bytes76 }) {
  for (const item of [
    {
      path: path87,
      bytes: bytes87,
      initial: { mapper: 87, chr_bank: { mask: 1, value: 1 } },
      offsets: [CHR87 + 16384, CHR87 + 24576],
      unresolved: 4,
    },
    {
      path: path76,
      bytes: bytes76,
      initial: {
        mapper: 76,
        banks: [null, null, { mask: 62, value: 2 }, 5, 9, 10, null, null],
      },
      offsets: [CHR76 + 4096, CHR76 + 6144],
      unresolved: 2,
    },
  ]) {
    const trace = (
      await call("trace-nes-mapper-events", {
        path: item.path,
        initial: item.initial,
        initial_ppu: ppu,
        ppu_pattern_table: 0,
        events: [],
      })
    ).trace;
    const table = trace.ppu_trace.pattern_table;
    assert.equal(table.coverage.examined_tiles, 256);
    assert.equal(table.coverage.unresolved_source_blocks, item.unresolved);
    assert.deepEqual(
      table.blocks[0].sources.map(
        (index) => table.source_pages[index].file_offset,
      ),
      item.offsets,
    );
    assert.deepEqual(table.tiles[0].rows[0], [
      0,
      0,
      0,
      0,
      0,
      0,
      3,
      { choices: [0, 3] },
    ]);
    for (const page of table.source_pages)
      assert.equal(
        page.bytes_hex,
        item.bytes
          .subarray(page.file_offset, page.file_offset + 1024)
          .toString("hex"),
      );
    assert.equal(trace.steps.length, 0);
    assert.equal(trace.final_mapping.chr_windows[0].bank, null);
  }
}
async function viewUncertainty({ call, bytes76, save }) {
  const bytes = Buffer.concat([
    bytes76.subarray(0, PRG),
    bytes76.subarray(PRG, PRG + 65536),
    bytes76.subarray(CHR76),
  ]);
  bytes[4] = 4;
  const path = await save("namco76-small-physical.nes", bytes);
  const physical = (
    await call("trace-nes-mapper-writes", {
      path,
      initial: state76({ mask: 7, value: 5 }, { mask: 7, value: 4 }),
      writes: [],
    })
  ).trace;
  assert.deepEqual(
    physical.final_mapping.prg_windows.map((item) => item.bank),
    [5, 4, 6, 7],
  );
  assert.equal(physical.final_mapping.prg_view, null);
  assert.deepEqual(physical.nes_prg_views, []);
  const previous = Buffer.from(bytes.subarray(0, PRG + 65536 + 65536));
  previous[5] = 8;
  previous[6] = 0xe4;
  previous[7] = 0xc8;
  const compatible = (
    await call("trace-nes-mapper-writes", {
      path: await save("namco206-small-physical.nes", previous),
      initial: {
        ...state76({ mask: 7, value: 5 }, { mask: 7, value: 4 }),
        mapper: 206,
      },
      writes: [],
    })
  ).trace;
  assert.deepEqual(
    compatible.final_mapping.prg_windows.map((item) => item.bank),
    [5, 4, 6, 7],
  );
  assert.equal(compatible.final_mapping.prg_view, null);
  assert.deepEqual(compatible.nes_prg_views, []);
  const aliases = (
    await call("trace-nes-mapper-writes", {
      path,
      initial: state76(5, 12),
      writes: [
        { address: 0x8000, value: 6 },
        { address: 0x8001, value: 13 },
      ],
    })
  ).trace;
  assert.deepEqual(
    aliases.final_mapping.prg_windows.map((item) => item.bank),
    [5, 4, 6, 7],
  );
  assert.deepEqual(aliases.nes_prg_views, [
    { mapper: 76, r6: 5, r7: 12 },
    { mapper: 76, r6: 13, r7: 12 },
  ]);
  const joined = (
    await call("trace-nes-mapper-writes", {
      path,
      initial: {
        mapper: 76,
        bank_select: { mask: 6, value: 2 },
        banks: [0, 0, 1, 2, 4, 5, 6, 7],
      },
      writes: [{ address: 0x8001, value: 7 }],
    })
  ).trace;
  assert.deepEqual(joined.final.banks.slice(2, 4), [
    { mask: 249, value: 1 },
    { mask: 250, value: 2 },
  ]);
  assert.deepEqual(joined.final.banks.slice(4), [4, 5, 6, 7]);
  assert.equal(joined.final_mapping.chr_windows[0].bank, null);
}
async function fixedMirroring({ call, path87, path76 }) {
  const events = [
    { kind: "ppu-write", address: 0x2000, value: 0x37 },
    { kind: "ppu-write", address: 0x2400, value: 0x69 },
    write(0xa000, 255),
    { kind: "ppu-read", address: 0x2800 },
    { kind: "ppu-read", address: 0x2c00 },
  ];
  const input = {
    path: path87,
    initial: { mapper: 87 },
    initial_ppu: ppu,
    events,
  };
  const trace = (await call("trace-nes-mapper-events", input)).trace;
  assert.deepEqual(
    trace.steps.slice(-2).map((item) => item.read_source.value),
    [0x37, 0x69],
  );
  assert.equal(trace.final_mapping.mirroring, "vertical");
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: snapshots(trace)[2].state,
      initial_ppu: {
        ...trace.ppu_trace.final,
        next_event_index: trace.ppu_trace.initial.next_event_index + 3,
      },
      events: events.slice(3),
    })
  ).trace;
  assert.deepEqual(continued.final_mapping, trace.final_mapping);
  assert.deepEqual(
    continued.steps.map((item) => item.read_source.value),
    [0x37, 0x69],
  );
  const horizontal = (
    await call("trace-nes-mapper-events", {
      path: path76,
      initial: { mapper: 76 },
      initial_ppu: ppu,
      events: [
        { kind: "ppu-write", address: 0x2000, value: 0x58 },
        write(0xa000, 1),
        { kind: "ppu-read", address: 0x2400 },
      ],
    })
  ).trace;
  assert.equal(horizontal.final_mapping.mirroring, "horizontal");
  assert.equal(horizontal.steps.at(-1).read_source.value, 0x58);
  assert.equal(horizontal.final.bank_select, null);
}
async function qualification({ call, path87, path76, bytes87, bytes76, save }) {
  const single = Buffer.concat([
    bytes87.subarray(0, PRG),
    bytes87.subarray(PRG + 16384, CHR87),
    bytes87.subarray(CHR87, CHR87 + 16384),
  ]);
  single[4] = 1;
  single[5] = 2;
  const alias = (
    await call("trace-nes-code", {
      path: await save("j87-single-prg.nes", single),
      initial: { mapper: 87, chr_bank: { mask: 2, value: 2 } },
      entry: 0x8180,
    })
  ).code_trace;
  assert.equal(alias.stop.reason, "return");
  assert.deepEqual(alias.instructions[0].file_offsets, [
    PRG + 0x180,
    PRG + 0x181,
  ]);
  assert.deepEqual(
    alias.mapper_trace.final_mapping.prg_windows.map((item) => item.bank),
    [0, 0],
  );
  assert.equal(alias.mapper_trace.final.chr_bank, 2);
  assert.equal(alias.mapper_trace.initial_mapping.chr_windows[0].bank, 1);
  verifyBytes(alias, single);
  for (const [mapper, path, bytes] of [
    [87, path87, bytes87],
    [76, path76, bytes76],
  ]) {
    const ram = (
      await call("trace-nes-code", {
        path,
        initial: { mapper },
        entry: 0x6000,
        initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x60 }],
      })
    ).code_trace;
    assert.equal(ram.status, "unsupported");
    if (mapper === 87) {
      const irq = (
        await call("trace-nes-mapper-events", {
          path,
          initial: { mapper },
          initial_irq: { model: "sunsoft3" },
          events: [],
        })
      ).trace;
      assert.equal(irq.status, "unsupported");
    }
    const submapper = Buffer.from(bytes);
    submapper[8] = 16;
    assert.equal(
      (
        await call("trace-nes-mapper-writes", {
          path: await save(`mapper${mapper}-submapper.nes`, submapper),
          initial: { mapper },
          writes: [],
        })
      ).trace.status,
      "unsupported",
    );
  }
  const four = Buffer.from(bytes87);
  four[6] |= 8;
  assert.equal(
    (
      await call("trace-nes-mapper-writes", {
        path: await save("j87-four-screen.nes", four),
        initial: { mapper: 87 },
        writes: [],
      })
    ).trace.status,
    "unsupported",
  );
}
