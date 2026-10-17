import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PRG,
  CHR,
  banks,
  fixture,
} from "./verify-package-nes-h3001-fixture.mjs";

const write = (address, value) => ({ kind: "cpu-write", address, value });
const cycle = { kind: "h3001-cpu-cycle" };
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
const irq = {
  model: "h3001",
  counter_low: 0,
  counter_high: 0,
  enabled: false,
  asserted: false,
  zero_behavior: "wrap",
};
function snapshots(trace) {
  return trace.steps.map((step) =>
    "mapper_snapshot" in step
      ? { ...trace.mapper_snapshots[step.mapper_snapshot], ...step }
      : step,
  );
}
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
/** Hardware-derived banking and separately qualified IRQ rules; no mapper implementation imports. */
export async function verifyPackageNesH3001(invoke, workspace) {
  const files = new Map();
  const save = async (name, bytes) => {
    const path = join(workspace, name);
    await writeFile(path, bytes);
    files.set(path, bytes);
    return path;
  };
  const bytes = fixture(),
    path = await save("h3001-independent.nes", bytes);
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
    initial: { mapper: 65 },
    cpu: { sp: 255 },
    max_instructions: 256,
  };
  await banking({ call, base, bytes });
  await ppuAndPartial({ call, base });
  await ramQualification({ call, base, bytes, save });
  await irqWorkflows({ call, base });
  const unsupported = Buffer.from(bytes);
  unsupported[8] = 16;
  const rejected = await call("trace-nes-mapper-writes", {
    path: await save("h3001-submapper.nes", unsupported),
    initial: { mapper: 65 },
    writes: [],
  });
  assert.equal(rejected.trace.status, "unsupported");
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
      "Conditional H3001 source/PRG/CHR/CIRAM/RAM and qualified IRQ models; synthetic immutable ROMs, not observed gameplay or physical IRQ timing",
  };
}
async function banking({ call, base, bytes }) {
  const trace = (await call("trace-nes-code", base)).code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0xb6);
  verifyBytes(trace, bytes);
  const cross = trace.instructions.filter(
    (instruction) =>
      instruction.address === 0x9fff || instruction.address === 0xbfff,
  );
  assert.deepEqual(
    cross.map((instruction) => instruction.file_offsets),
    [
      [PRG + 6 * 8192 - 1, PRG + 19 * 8192],
      [PRG + 20 * 8192 - 1, PRG + 30 * 8192],
      [PRG + 20 * 8192 - 1, PRG + 5 * 8192],
    ],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
    [30, 19, 5, 31],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.chr_windows.map((window) => window.bank),
    banks,
  );
  assert.deepEqual(trace.mapper_trace.nes_prg_views, [
    { mapper: 65, prg_mode: 0, prg_bank_0: 5, prg_bank_1: 19 },
    { mapper: 65, prg_mode: 1, prg_bank_0: 5, prg_bank_1: 19 },
  ]);
  assert.equal(
    trace.instructions.find((instruction) => instruction.mnemonic === "INC")
      .data_reads[0].value,
    0x11,
  );
  const writes = trace.instructions
    .flatMap((instruction) => instruction.writes)
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
        ...banks.map((_, index) => ({
          kind: "ppu-read",
          address: index * 1024 + 1023,
        })),
      ],
    })
  ).trace;
  assert.deepEqual(events.final_mapping, trace.mapper_trace.final_mapping);
  assert.deepEqual(
    events.steps.slice(-8).map((step) => step.read_source.file_offset),
    banks.map((bank) => CHR + bank * 1024 + 1023),
  );
  const exploration = (await call("explore-nes-code", base)).code_exploration;
  assert.deepEqual(exploration.paths[0].trace, trace);
}
async function ppuAndPartial({ call, base }) {
  const events = [
    write(0x9001, 128),
    { kind: "ppu-write", address: 0x2000, value: 0x37 },
    { kind: "ppu-read", address: 0x2400 },
    write(0x9001, 0),
    { kind: "ppu-write", address: 0x2400, value: 0x69 },
    { kind: "ppu-read", address: 0x2c00 },
    write(0x9001, 192),
    { kind: "ppu-read", address: 0x2c00 },
  ];
  const input = {
    path: base.path,
    initial: { mapper: 65 },
    initial_ppu: ppu,
    events,
  };
  const trace = (await call("trace-nes-mapper-events", input)).trace;
  assert.equal(trace.status, "derived");
  assert.deepEqual(
    trace.steps
      .filter((step) => step.event.kind === "ppu-read")
      .map((step) => [step.read_source.value, step.read_source.bank]),
    [
      [0x37, 0],
      [0x69, 1],
      [0x37, 0],
    ],
  );
  assert.equal(trace.final_mapping.mirroring, "one-screen-a");
  const semantic = snapshots(trace),
    prefix = semantic[5];
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: prefix.state,
      initial_ppu: {
        ...trace.ppu_trace.final,
        next_event_index: trace.ppu_trace.initial.next_event_index + 6,
      },
      events: events.slice(6),
    })
  ).trace;
  assert.deepEqual(continued.final_mapping, trace.final_mapping);
  assert.equal(continued.steps.at(-1).read_source.value, 0x37);
  const partial = (
    await call("trace-nes-mapper-writes", {
      path: base.path,
      initial: {
        mapper: 65,
        control: { mask: 128, value: 128 },
        mirroring: { mask: 64, value: 64 },
        prg_banks: [
          { mask: 31, value: 5 },
          { mask: 31, value: 19 },
        ],
      },
      writes: [],
    })
  ).trace;
  assert.deepEqual(
    partial.final_mapping.prg_windows.map((window) => window.bank),
    [30, 19, 5, 31],
  );
  assert.equal(partial.final_mapping.mirroring, "one-screen-a");
  assert.equal(partial.final_mapping.prg_view, null);
  const aliased = (
    await call("trace-nes-mapper-writes", {
      path: base.path,
      initial: { mapper: 65, control: 0, prg_banks: [229, 211] },
      writes: [],
    })
  ).trace;
  assert.deepEqual(aliased.final.prg_banks, [229, 211]);
  assert.deepEqual(
    aliased.final_mapping.prg_windows.map((window) => window.bank),
    [5, 19, 30, 31],
  );
  assert.deepEqual(aliased.final_mapping.prg_view, {
    mapper: 65,
    prg_mode: 0,
    prg_bank_0: 37,
    prg_bank_1: 19,
  });
}
async function ramQualification({ call, base, bytes, save }) {
  const nvram = Buffer.from(bytes);
  nvram[10] = 0x70;
  const seeded = (
    await call("trace-nes-code", {
      path: await save("h3001-nvram.nes", nvram),
      initial: { mapper: 65 },
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
      path: await save("h3001-legacy.nes", legacy),
    })
  ).code_trace;
  assert.equal(unknown.status, "derived");
  assert.notEqual(unknown.final_cpu.a, 0xb6);
  assert.equal(unknown.stop.address, 0x6000);
  const invalid = Buffer.from(bytes);
  invalid[10] = 8;
  const rejected = (
    await call("trace-nes-code", {
      path: await save("h3001-ram16k.nes", invalid),
      initial: { mapper: 65 },
      entry: 0x6000,
      initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x60 }],
    })
  ).code_trace;
  assert.equal(rejected.status, "unsupported");
}
async function irqWorkflows({ call, base }) {
  const sourceInput = {
    path: base.path,
    initial: { mapper: 65 },
    entry: 0xe380,
    initial_irq: irq,
    max_instructions: 9,
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 7000,
    },
  };
  const source = (await call("trace-nes-code", sourceInput)).code_trace;
  assert.equal(source.status, "derived");
  assert.equal(source.cpu_bus.final.next_cycle_index, 7026);
  assert.deepEqual(source.mapper_trace.final_irq, {
    ...irq,
    counter_low: 0,
    enabled: false,
    asserted: true,
  });
  assert.equal(source.mapper_trace.final.irq_control, 128);
  const clocked = source.mapper_trace.steps.filter(
    (step) => step.event.kind === "h3001-cpu-cycle",
  );
  assert.equal(clocked.length, 26);
  assert.equal(clocked[22].irq.asserted, false);
  assert.equal(clocked[23].irq.asserted, true);
  const replay = (
    await call("trace-nes-mapper-events", {
      path: base.path,
      initial: sourceInput.initial,
      initial_irq: irq,
      events: source.mapper_trace.steps.map((step) => step.event),
    })
  ).trace;
  assert.deepEqual(replay, source.mapper_trace);
  const events = [
    write(0x9005, 0),
    write(0x9006, 2),
    write(0x9004, 0),
    write(0x9003, 128),
    { kind: "ppu-read", address: 0 },
    cycle,
    cycle,
    cycle,
    write(0x9004, 0),
    cycle,
    write(0x9003, 128),
    cycle,
    cycle,
    write(0x9003, 0),
  ];
  const input = {
    path: base.path,
    initial: { mapper: 65 },
    initial_irq: irq,
    events,
  };
  const supplied = (await call("trace-nes-mapper-events", input)).trace;
  assert.equal(supplied.steps[4].irq.counter_low, 2);
  assert.deepEqual(supplied.steps[6].irq, {
    ...irq,
    counter_low: 0,
    enabled: false,
    asserted: true,
  });
  assert.equal(supplied.steps[8].irq.enabled, false);
  assert.equal(supplied.steps[8].irq.asserted, false);
  assert.equal(supplied.steps[9].irq.counter_low, 2);
  const prefix = snapshots(supplied)[5];
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: prefix.state,
      initial_irq: prefix.irq,
      events: events.slice(6),
    })
  ).trace;
  assert.deepEqual(continued.final_irq, supplied.final_irq);
  assert.deepEqual(continued.final, supplied.final);
  await irqZeroCases({ call, base });
}
async function irqZeroCases({ call, base }) {
  for (const [zero_behavior, low, high, enabled, asserted] of [
    ["wrap", 255, 255, true, false],
    ["pause", 0, 0, true, false],
    ["assert", 0, 0, false, true],
    [null, null, null, null, null],
  ]) {
    const trace = (
      await call("trace-nes-mapper-events", {
        path: base.path,
        initial: { mapper: 65, irq_control: 128 },
        initial_irq: { ...irq, enabled: true, zero_behavior },
        events: [cycle],
      })
    ).trace;
    if (zero_behavior === null) {
      assert.equal(trace.final_irq.counter_low, null);
      assert.equal(trace.final_irq.counter_high, null);
      assert.equal(trace.final_irq.enabled, null);
      assert.equal(trace.final_irq.asserted, null);
    } else
      assert.deepEqual(trace.final_irq, {
        ...irq,
        zero_behavior,
        counter_low: low,
        counter_high: high,
        enabled,
        asserted,
      });
  }
  const mismatch = (
    await call("trace-nes-mapper-events", {
      path: base.path,
      initial: { mapper: 65 },
      initial_irq: irq,
      events: [{ kind: "fme7-cpu-cycle" }],
    })
  ).trace;
  assert.equal(mismatch.status, "unsupported");
}
