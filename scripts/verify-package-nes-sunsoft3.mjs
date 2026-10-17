import assert from "node:assert/strict";
import { irqWorkflows } from "./verify-package-nes-sunsoft3-irq.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRG,
  CHR,
  selectors,
  chrBanks,
  fixture,
} from "./verify-package-nes-sunsoft3-fixture.mjs";

const write = (address, value) => ({ kind: "cpu-write", address, value });
const ppu = {
  model: "ppu-memory",
  register_writes_enabled: true,
  access_phase: "non-rendering",
  dma_reads: "absent",
  chr_ram_size: null,
  nametable_layout: "ciram-2k",
  control: 0,
  mask: 0,
};
const snapshots = (trace) =>
  trace.steps.map((step) =>
    "mapper_snapshot" in step
      ? { ...trace.mapper_snapshots[step.mapper_snapshot], ...step }
      : step,
  );
function verifyBytes(trace, bytes) {
  for (const instruction of trace.instructions)
    for (const [index, value] of Buffer.from(
      instruction.bytes_hex,
      "hex",
    ).entries()) {
      const offset = instruction.file_offsets[index];
      if (offset !== null) assert.equal(bytes[offset], value);
      else {
        const origin = instruction.ram_origins.find(
          (item) => item.byte_index === index,
        );
        assert.equal(origin.region, "prg-ram");
        assert.equal(origin.bank, 0);
        assert.equal(
          trace.instructions[origin.instruction_index].writes[
            origin.write_index
          ].value,
          value,
        );
      }
    }
}
/** Independent byte/edge oracle for the documented conventional Sunsoft 3 board. */
export async function verifyPackageNesSunsoft3(invoke, workspace) {
  const files = new Map();
  const save = async (name, bytes) => {
    const path = join(workspace, name);
    await writeFile(path, bytes);
    files.set(path, bytes);
    return path;
  };
  const bytes = fixture(),
    path = await save("sunsoft3-independent.nes", bytes);
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
  const base = {
    path,
    initial: { mapper: 67 },
    cpu: { sp: 255 },
    max_instructions: 256,
  };
  await banking({ call, base, bytes });
  await ppuAndPartial({ call, base });
  await ramQualification({ call, base, bytes, save });
  await irqWorkflows({ call, base, snapshots });
  const single = Buffer.concat([
    bytes.subarray(0, PRG),
    bytes.subarray(PRG + 15 * 16384, CHR),
    bytes.subarray(CHR),
  ]);
  single[4] = 1;
  const alias = (
    await call("trace-nes-mapper-writes", {
      path: await save("sunsoft3-single-bank.nes", single),
      initial: { mapper: 67, prg_bank: 0xff },
      writes: [],
    })
  ).trace;
  assert.deepEqual(
    alias.final_mapping.prg_windows.map((item) => [
      item.bank,
      item.file_offset,
    ]),
    [
      [0, PRG],
      [0, PRG],
    ],
  );
  const mismatch = (
    await call("trace-nes-mapper-events", {
      path,
      initial: { mapper: 67 },
      initial_irq: { model: "sunsoft3" },
      events: [{ kind: "h3001-cpu-cycle" }],
    })
  ).trace;
  assert.equal(mismatch.status, "unsupported");
  const invalid = Buffer.from(bytes);
  invalid[8] = 16;
  assert.equal(
    (
      await call("trace-nes-mapper-writes", {
        path: await save("sunsoft3-submapper.nes", invalid),
        initial: { mapper: 67 },
        writes: [],
      })
    ).trace.status,
    "unsupported",
  );
  for (const [name, original] of files)
    assert.deepEqual(await readFile(name), original);
  assert.equal(workflows, 21);
  return {
    ok: true,
    workflows,
    banking: true,
    ram_provenance: true,
    irq_continuation: true,
    original_unchanged: true,
    scope:
      "Conditional Sunsoft 3 PRG/CHR/CIRAM/RAM and internal CPU-edge IRQ derivations; external IRQ input inactive, synthetic immutable ROMs, not observed gameplay or physical timing",
  };
}
async function banking({ call, base, bytes }) {
  const trace = (await call("trace-nes-code", base)).code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0xb6);
  verifyBytes(trace, bytes);
  const cross = trace.instructions.find((item) => item.address === 0xbfff);
  assert.deepEqual(cross.file_offsets, [PRG + 6 * 16384 - 1, PRG + 15 * 16384]);
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((item) => item.bank),
    [12, 15],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.chr_windows.map((item) => item.bank),
    chrBanks,
  );
  assert.deepEqual(trace.mapper_trace.final.chr_banks, selectors);
  assert.equal(trace.mapper_trace.final.prg_bank, 0xec);
  assert.deepEqual(trace.mapper_trace.nes_prg_views, [
    { mapper: 67, prg_bank: 5 },
    { mapper: 67, prg_bank: 12 },
  ]);
  assert.equal(
    trace.instructions.find((item) => item.mnemonic === "INC").data_reads[0]
      .value,
    0x11,
  );
  const writes = trace.instructions
    .flatMap((item) => item.writes)
    .filter((item) => item.address >= 0x8000);
  const replay = (
    await call("trace-nes-mapper-writes", {
      path: base.path,
      initial: base.initial,
      writes,
    })
  ).trace;
  assert.deepEqual(replay, trace.mapper_trace);
  const events = (
    await call("trace-nes-mapper-events", {
      path: base.path,
      initial: base.initial,
      events: [
        ...writes.map((item) => ({ ...item, kind: "cpu-write" })),
        ...chrBanks.flatMap((_, index) => [
          { kind: "ppu-read", address: index * 2048 },
          { kind: "ppu-read", address: index * 2048 + 2047 },
        ]),
      ],
    })
  ).trace;
  assert.deepEqual(events.final_mapping, trace.mapper_trace.final_mapping);
  assert.deepEqual(
    events.steps.slice(-8).map((item) => item.read_source.file_offset),
    chrBanks.flatMap((bank) => [CHR + bank * 2048, CHR + bank * 2048 + 2047]),
  );
  const exploration = (await call("explore-nes-code", base)).code_exploration;
  assert.deepEqual(exploration.paths[0].trace, trace);
}
async function ppuAndPartial({ call, base }) {
  const events = [
    write(0xe800, 0),
    { kind: "ppu-write", address: 0x2000, value: 0x37 },
    { kind: "ppu-write", address: 0x2400, value: 0x69 },
    { kind: "ppu-read", address: 0x2800 },
    write(0xefff, 1),
    { kind: "ppu-read", address: 0x2400 },
    { kind: "ppu-read", address: 0x2c00 },
    write(0xe801, 2),
    { kind: "ppu-read", address: 0x2c00 },
    write(0xe900, 3),
    { kind: "ppu-read", address: 0x2000 },
  ];
  const input = {
    path: base.path,
    initial: { mapper: 67 },
    initial_ppu: ppu,
    events,
  };
  const trace = (await call("trace-nes-mapper-events", input)).trace;
  assert.equal(trace.status, "derived");
  assert.deepEqual(
    trace.steps
      .filter((item) => item.event.kind === "ppu-read")
      .map((item) => [item.read_source.value, item.read_source.bank]),
    [
      [0x37, 0],
      [0x37, 0],
      [0x69, 1],
      [0x37, 0],
      [0x69, 1],
    ],
  );
  assert.equal(trace.final_mapping.mirroring, "one-screen-b");
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: snapshots(trace)[6].state,
      initial_ppu: {
        ...trace.ppu_trace.final,
        next_event_index: trace.ppu_trace.initial.next_event_index + 7,
      },
      events: events.slice(7),
    })
  ).trace;
  assert.deepEqual(continued.final_mapping, trace.final_mapping);
  assert.equal(continued.steps.at(-1).read_source.value, 0x69);
  const partial = (
    await call("trace-nes-mapper-writes", {
      path: base.path,
      initial: {
        mapper: 67,
        prg_bank: { mask: 15, value: 5 },
        chr_banks: chrBanks.map((value) => ({ mask: 63, value })),
        mirroring: { mask: 3, value: 3 },
      },
      writes: [],
    })
  ).trace;
  assert.deepEqual(
    partial.final_mapping.prg_windows.map((item) => item.bank),
    [5, 15],
  );
  assert.deepEqual(partial.final_mapping.prg_view, { mapper: 67, prg_bank: 5 });
  assert.deepEqual(
    partial.final_mapping.chr_windows.map((item) => item.bank),
    chrBanks,
  );
  assert.equal(partial.final_mapping.mirroring, "one-screen-b");
  const unknown = (
    await call("trace-nes-mapper-writes", {
      path: base.path,
      initial: { mapper: 67, prg_bank: { mask: 7, value: 5 } },
      writes: [],
    })
  ).trace;
  assert.equal(unknown.final_mapping.prg_windows[0].bank, null);
  assert.equal(unknown.final_mapping.prg_view, null);
}
async function ramQualification({ call, base, bytes, save }) {
  const nvram = Buffer.from(bytes);
  nvram[10] = 0x70;
  const seeded = (
    await call("trace-nes-code", {
      path: await save("sunsoft3-nvram.nes", nvram),
      initial: { mapper: 67 },
      entry: 0x6000,
      initial_prg_ram: [0xa9, 0x6d, 0x60].map((value, index) => ({
        bank: 0,
        address: 0x6000 + index,
        value,
      })),
    })
  ).code_trace;
  assert.equal(seeded.final_cpu.a, 0x6d);
  assert.equal(seeded.instructions[0].ram_origins[0].initial_prg_ram_index, 0);
  const legacy = Buffer.from(bytes);
  legacy[7] = 0x40;
  legacy[8] = 1;
  legacy[10] = 0;
  const unknown = (
    await call("trace-nes-code", {
      ...base,
      path: await save("sunsoft3-legacy.nes", legacy),
    })
  ).code_trace;
  assert.equal(unknown.status, "derived");
  assert.equal(unknown.stop.address, 0x6000);
  assert.notEqual(unknown.final_cpu.a, 0xb6);
  const invalid = Buffer.from(bytes);
  invalid[10] = 8;
  assert.equal(
    (
      await call("trace-nes-code", {
        path: await save("sunsoft3-ram16k.nes", invalid),
        initial: { mapper: 67 },
        entry: 0x6000,
        initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x60 }],
      })
    ).code_trace.status,
    "unsupported",
  );
}
