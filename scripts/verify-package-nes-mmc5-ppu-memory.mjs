import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHR,
  fixture,
  initial,
  ppu,
  irq,
  write,
  read,
  chrByte,
} from "./verify-package-nes-mmc5-ppu-memory-fixture.mjs";
import { verifyMmc5MemoryBuffers } from "./verify-package-nes-mmc5-ppu-memory-buffers.mjs";
import { verifyMmc5BackgroundMemory } from "./verify-package-nes-mmc5-ppu-memory-background.mjs";
import { verifyMmc5MemoryGraphics } from "./verify-package-nes-mmc5-ppu-memory-graphics.mjs";
import {
  mmc5PpuMemoryMaximumInput,
  verifyMmc5PpuMemoryMaximumResult,
} from "./verify-package-nes-mmc5-ppu-memory-maximum.mjs";
export {
  mmc5PpuMemoryMaximumInput,
  verifyMmc5PpuMemoryMaximumResult,
} from "./verify-package-nes-mmc5-ppu-memory-maximum.mjs";
export { fixture as mmc5PpuMemoryFixture } from "./verify-package-nes-mmc5-ppu-memory-fixture.mjs";

const cellValue = (cell) =>
  cell !== null && typeof cell === "object" && "origin" in cell
    ? cell.value
    : cell;
const busReads = (trace) =>
  trace.ppu_trace.operations.flatMap((operation) => operation.bus_reads);
const atom = (read, kind) => {
  const source = read.sources.find((item) => item.kind === kind);
  assert.ok(source, `Missing ${kind} source`);
  return source;
};
const exramAtom = (
  source,
  {
    address,
    value,
    cell_value = value,
    shift = null,
    origin = { kind: "initial-exram", address },
  },
) => {
  assert.deepEqual(atom(source, "mmc5-exram"), {
    kind: "mmc5-exram",
    address,
    cell_value,
    attribute_shift: shift,
    value,
    mask: 255,
    origin,
  });
};
/** Independent original bytes and shared physical storage; invokes only public tools. */
export async function verifyPackageNesMmc5PpuMemory(invoke, workspace) {
  const bytes = fixture(),
    path = join(workspace, "mmc5-ppu-memory.nes");
  await writeFile(path, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let workflows = 0;
  const call = async (command, input) => {
    workflows++;
    const evidence = await invoke(command, input);
    assert.equal(evidence.subject.digest.sha256, sha256);
    return evidence.normalized_result;
  };
  const eventTrace = async (input) => {
    const result = await call("trace-nes-mapper-events", { path, ...input });
    assert.equal(result.trace.status, "derived", result.trace.reason);
    return result.trace;
  };
  await nametableSources(eventTrace);
  await fiveCandidates(eventTrace);
  await sharedExram(eventTrace);
  await conditionalWrites(eventTrace);
  await unqualifiedCiram(eventTrace);
  await bankRoles(eventTrace);
  await exactSnoops(eventTrace);
  await verifyMmc5MemoryBuffers({
    call,
    eventTrace,
    path,
    bytes,
    cellValue,
    exramAtom,
  });
  await verifyMmc5BackgroundMemory({
    eventTrace,
    path,
    busReads,
    exramAtom,
    cellValue,
  });
  await inFrameWrites(eventTrace);
  await verifyMmc5MemoryGraphics({ eventTrace, bytes });
  verifyMmc5PpuMemoryMaximumResult(
    await call(
      "trace-nes-mapper-events",
      mmc5PpuMemoryMaximumInput(path, "pattern"),
    ),
    bytes,
    "pattern",
  );
  const rejected = await call("trace-nes-mapper-events", {
    path,
    initial: initial(),
    initial_ppu: { ...ppu, nametable_layout: "four-screen-4k" },
    events: [],
  });
  assert.equal(rejected.trace.status, "unsupported");
  const metadata = await eventTrace({
    initial: initial(),
    events: [read(0x2800)],
  });
  assert.equal(metadata.steps[0].read_source.value, 0xc0);
  assert.ok(!("ppu_trace" in metadata));
  assert.deepEqual(await readFile(path), bytes);
  return {
    ok: true,
    workflows,
    shared_exram: true,
    nametable_sources: true,
    cpu_buffer: true,
    source_replay: true,
    graphics_sources: true,
    qualified_background: true,
    exact_snoops: true,
    rollback: true,
    original_unchanged: true,
    scope:
      "Authored synthetic MMC5 ordinary retained CIRAM/ExRAM/fill/zero bytes, CPU2007 history and existing qualified extended/split events; no automatic fetch classification, silicon timing, sound or gameplay claim",
  };
}

async function nametableSources(trace) {
  const result = await trace({
    initial: initial(),
    initial_ppu: { ...ppu, nametable: { 0: 0xa0, 1024: 0xb0 } },
    events: [
      read(0x2000),
      read(0x2400),
      read(0x2800),
      read(0x2c00),
      read(0x2fc0),
      write(0x5104, 2),
      read(0x2800),
    ],
  });
  const reads = busReads(result);
  assert.deepEqual(
    reads.map((source) => source.value),
    [0xa0, 0xb0, 0xc0, 0x15, 0x55, 0],
  );
  assert.equal(atom(reads[0], "memory").address, 0);
  assert.equal(atom(reads[1], "memory").address, 1024);
  exramAtom(reads[2], { address: 0, value: 0xc0 });
  for (const [index, register, register_value, value] of [
    [3, 0x5106, 0x15, 0x15],
    [4, 0x5107, 0xfd, 0x55],
  ])
    assert.deepEqual(atom(reads[index], "mmc5-fill"), {
      kind: "mmc5-fill",
      register,
      register_value,
      value,
      mask: 255,
    });
  assert.deepEqual(atom(reads[5], "mmc5-zero"), {
    kind: "mmc5-zero",
    value: 0,
    mask: 255,
  });
  assert.deepEqual(
    result.ppu_trace.final.nametable,
    result.ppu_trace.initial.nametable,
  );
}

async function fiveCandidates(trace) {
  const result = await trace({
    initial: { ...initial(), nametable_control: null, exram_mode: null },
    initial_ppu: { ...ppu, nametable: { 0: 0xa0, 1024: 0xb0 } },
    events: [read(0x2000)],
  });
  const sources = busReads(result)[0].sources;
  assert.equal(sources.length, 5);
  assert.deepEqual(sources.map((source) => source.kind).sort(), [
    "memory",
    "memory",
    "mmc5-exram",
    "mmc5-fill",
    "mmc5-zero",
  ]);
  assert.deepEqual(
    sources
      .filter((source) => source.kind === "memory")
      .map((source) => source.address)
      .sort((a, b) => a - b),
    [0, 1024],
  );
}

async function sharedExram(trace) {
  const result = await trace({
    initial: { ...initial(), nametable_control: 0xaa },
    initial_ppu: ppu,
    events: [
      { kind: "ppu-write", address: 0x2000, value: 0x44 },
      write(0x5104, 2),
      { kind: "cpu-read", address: 0x5c00 },
      write(0x5c00, 0x77),
      write(0x5104, 0),
      read(0x3000),
    ],
  });
  assert.equal(result.steps[2].cpu_read.value, 0x44);
  assert.deepEqual(result.final.exram[0], {
    value: 0x77,
    origin: { kind: "event-write", index: 3 },
  });
  exramAtom(busReads(result)[0], {
    address: 0,
    value: 0x77,
    origin: { kind: "event-write", index: 3 },
  });
  const continued = await trace({
    initial: result.final,
    initial_ppu: result.ppu_trace.final,
    events: [
      write(0x5104, 3),
      write(0x5c00, 0xee),
      read(0x2000),
      { kind: "cpu-read", address: 0x5c00 },
    ],
  });
  assert.equal(busReads(continued)[0].value, 0);
  assert.equal(continued.steps[3].cpu_read.value, 0x77);
  assert.deepEqual(continued.final.exram[0], result.final.exram[0]);
}

async function conditionalWrites(trace) {
  const first = { kind: "initial-exram", address: 0 };
  const result = await trace({
    initial: {
      ...initial(),
      nametable_control: { mask: 252, value: 0 },
      fill_tile: 0xa1,
      exram: { 0: { value: 0xa0, origin: first } },
    },
    initial_ppu: { ...ppu, nametable: { 0: 0xa0, 1024: 0xa0 } },
    events: [
      read(0x2000),
      { kind: "ppu-write", address: 0x2000, value: 0xa2 },
      read(0x2000),
    ],
  });
  assert.deepEqual(busReads(result)[0].known_bits, { mask: 254, value: 160 });
  assert.equal(result.ppu_trace.operations[1].write.status, "uncertain");
  assert.deepEqual(cellValue(result.final.exram[0]), { mask: 253, value: 160 });
  assert.deepEqual(result.final.exram[0].origin, first);
  for (const address of [0, 1024]) {
    assert.deepEqual(result.ppu_trace.final.nametable[address].value, {
      mask: 253,
      value: 160,
    });
    assert.deepEqual(result.ppu_trace.final.nametable[address].origin, {
      kind: "initial-memory",
      space: "nametable",
      address,
    });
  }
  assert.deepEqual(busReads(result)[1].known_bits, { mask: 252, value: 160 });
}

async function unqualifiedCiram(trace) {
  const result = await trace({
    initial: { ...initial(), nametable_control: { mask: 253, value: 0 } },
    initial_ppu: {
      ...ppu,
      nametable_layout: null,
      v: { low: 0, high: 32 },
      read_buffer: { value: 73 },
    },
    events: [{ kind: "cpu-read", address: 0x2007 }],
  });
  assert.equal(result.steps[0].cpu_read.value, 73);
  assert.equal(result.ppu_trace.final.read_buffer.value, null);
  assert.deepEqual(
    result.ppu_trace.final.read_buffer.sources
      .map((source) => source.kind)
      .sort(),
    ["mmc5-exram", "unknown"],
  );
  const continued = await trace({
    initial: result.final,
    initial_ppu: result.ppu_trace.final,
    events: [{ kind: "cpu-read", address: 0x2007 }],
  });
  assert.equal(continued.steps[0].cpu_read.value, null);
  assert.equal(atom(busReads(continued)[0], "mmc5-exram").address, 1);
}

async function bankRoles(trace) {
  const result = await trace({
    initial: { ...initial(), ppu_control: 32, ppu_mask: 24 },
    initial_ppu: ppu,
    events: [
      read(0, "sprite"),
      read(0, "background"),
      read(0),
      { kind: "ppu-read", address: 0 },
    ],
  });
  const reads = busReads(result);
  for (const [index, bank] of [
    [0, 5],
    [1, 9],
    [2, 9],
  ]) {
    assert.equal(reads[index].file_offset, CHR + bank * 1024);
    assert.equal(reads[index].value, chrByte(bank * 1024));
  }
  assert.deepEqual(
    reads[3].sources.map((source) => source.file_offset).sort((a, b) => a - b),
    [CHR + 5 * 1024, CHR + 9 * 1024],
  );
}

async function exactSnoops(trace) {
  const result = await trace({
    initial: initial(),
    initial_ppu: ppu,
    events: [
      write(0x2008, 32),
      write(0x2009, 24),
      read(0, "background"),
      write(0x2000, 32),
      write(0x2001, 24),
      read(0, "background"),
      read(0, "sprite"),
    ],
  });
  assert.deepEqual(
    busReads(result).map((source) => source.file_offset),
    [CHR + 5 * 1024, CHR + 9 * 1024, CHR + 5 * 1024],
  );
  assert.equal(result.ppu_trace.final.control, 32);
  assert.equal(result.ppu_trace.final.mask, 24);
}

async function inFrameWrites(trace) {
  for (const [mode, inFrame, expected] of [
    [0, true, 0x66],
    [1, false, null],
    [1, null, null],
  ]) {
    const result = await trace({
      initial: { ...initial(), exram_mode: mode, nametable_control: 0xaa },
      initial_irq: irq(inFrame),
      initial_ppu: ppu,
      events: [write(0x5c00, 0x66)],
    });
    assert.equal(cellValue(result.final.exram[0]), expected);
    if (inFrame === true)
      assert.deepEqual(result.final.exram[0].origin, {
        kind: "event-write",
        index: 0,
      });
  }
}
