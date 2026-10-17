import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHR,
  ppu,
  initial,
  fixture,
  write,
} from "./verify-package-nes-vrc6-ppu-memory-fixture.mjs";
import { vrc6PpuGraphicsWorkflows } from "./verify-package-nes-vrc6-ppu-memory-graphics.mjs";
import {
  vrc6PpuMemoryMaximumInput,
  verifyVrc6PpuMemoryMaximumResult,
} from "./verify-package-nes-vrc6-ppu-memory-maximum.mjs";
export {
  vrc6PpuMemoryMaximumInput,
  verifyVrc6PpuMemoryMaximumResult,
} from "./verify-package-nes-vrc6-ppu-memory-maximum.mjs";
export { fixture as vrc6PpuMemoryFixture } from "./verify-package-nes-vrc6-ppu-memory-fixture.mjs";

const romPages = (table) =>
  table.blocks.map((block) =>
    block.sources.map((index) => table.source_pages[index].file_offset),
  );
function verifyPages(pages, bytes) {
  for (const page of pages)
    if (typeof page === "object" && page.kind === "rom")
      assert.equal(
        page.bytes_hex,
        bytes
          .subarray(page.file_offset, page.file_offset + 1024)
          .toString("hex"),
      );
}
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
const dataValues = (trace) =>
  trace.instructions
    .filter((item) => item.mnemonic === "LDA" && item.data_reads.length > 0)
    .map((item) => item.data_reads[0].value);
/** Independent captured VRC6 ROM/CIRAM byte, buffer and graphics oracles. */
export async function verifyPackageNesVrc6PpuMemory(invoke, workspace) {
  const files = new Map();
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
  for (const mapper of [24, 26]) {
    const bytes = fixture(mapper),
      path = join(workspace, `vrc6-${mapper}-ppu-memory.nes`);
    await writeFile(path, bytes);
    files.set(path, bytes);
    boards.push({ mapper, path, bytes });
  }
  for (const board of boards) await pairedPattern({ call, ...board });
  await mixedMemory({ call, ...boards[0] });
  await unknownBacking({ call, ...boards[0] });
  for (const board of boards) await sourceBuffers({ call, ...board });
  await vrc6PpuGraphicsWorkflows({
    call,
    ...boards[0],
    verifyPages,
    verifyBytes,
  });
  await capacityAndAdmission({ call, ...boards[0], verifyPages });
  for (const [path, bytes] of files)
    assert.deepEqual(await readFile(path), bytes);
  assert.equal(workflows, 22);
  return {
    ok: true,
    workflows,
    captured_memory: true,
    cpu_buffer: true,
    unknown_backing: true,
    graphics_sources: true,
    original_unchanged: true,
    scope:
      "Conditional original VRC6a/b retained CHR-ROM/CIRAM bytes, partial mux writes, CPU2007 buffers and frozen graphics; synthetic immutable ROMs, no PPU timing, electrical observation, gameplay or alternate PCB claim",
  };
}
async function pairedPattern({ call, mapper, path, bytes }) {
  const trace = (
    await call("trace-nes-mapper-events", {
      path,
      initial: initial(mapper, 1),
      initial_ppu: ppu,
      ppu_pattern_table: 0,
      events: [
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-read", address: 1024 },
        write(0xb003, 0x21),
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-read", address: 1024 },
      ],
    })
  ).trace;
  assert.equal(trace.status, "derived");
  assert.deepEqual(
    trace.steps
      .filter((item) => item.event.kind === "ppu-read")
      .map((item) => [item.read_source.value, item.read_source.file_offset]),
    [
      [5, CHR + 5 * 1024],
      [5, CHR + 5 * 1024],
      [4, CHR + 4 * 1024],
      [5, CHR + 5 * 1024],
    ],
  );
  assert.deepEqual(
    romPages(trace.ppu_trace.pattern_table),
    [4, 5, 8, 9].map((page) => [CHR + page * 1024]),
  );
  assert.deepEqual(
    trace.ppu_trace.pattern_table.tiles[0].rows[0],
    [0, 0, 0, 0, 0, 3, 0, 0],
  );
  verifyPages(trace.ppu_trace.pattern_table.source_pages, bytes);
}
async function mixedMemory({ call, mapper, path, bytes }) {
  const origin = { kind: "initial-memory", space: "nametable", address: 1024 };
  const input = {
    path,
    initial: initial(mapper, { mask: 47, value: 32 }),
    initial_ppu: { ...ppu, nametable: { 1024: { value: 0xa0, origin } } },
    ppu_nametable: 1,
    events: [
      { kind: "ppu-read", address: 0x2400 },
      { kind: "ppu-write", address: 0x2400, value: 0xa2 },
      { kind: "ppu-read", address: 0x2400 },
    ],
  };
  const trace = (await call("trace-nes-mapper-events", input)).trace;
  const first = trace.steps[0].read_source;
  assert.deepEqual(first.known_bits, { mask: 254, value: 160 });
  assert.deepEqual(first.sources.map((source) => source.kind).sort(), [
    "memory",
    "rom",
  ]);
  assert.equal(
    first.sources.find((source) => source.kind === "rom").file_offset,
    CHR + 47 * 1024,
  );
  assert.equal(
    first.sources.find((source) => source.kind === "memory").address,
    1024,
  );
  assert.equal(trace.ppu_trace.operations[1].write.status, "uncertain");
  assert.deepEqual(trace.ppu_trace.final.nametable[1024], {
    value: { mask: 253, value: 160 },
    origin,
  });
  assert.deepEqual(trace.steps[2].read_source.known_bits, {
    mask: 252,
    value: 160,
  });
  assert.deepEqual(
    trace.ppu_trace.nametable.source_pages.map((page) =>
      typeof page === "number" ? page : page.file_offset,
    ),
    [1024, CHR + 47 * 1024],
  );
  assert.deepEqual(trace.ppu_trace.nametable.cells[0].tile_index, {
    mask: 252,
    value: 160,
  });
  verifyPages(trace.ppu_trace.nametable.source_pages, bytes);
  const continued = (
    await call("trace-nes-mapper-events", {
      path,
      initial: trace.final,
      initial_ppu: trace.ppu_trace.final,
      events: [
        write(0xb003, 0x20),
        { kind: "ppu-read", address: 0x2400 },
        write(0xb003, 0x30),
        { kind: "ppu-write", address: 0x2400, value: 255 },
        { kind: "ppu-read", address: 0x2400 },
      ],
    })
  ).trace;
  assert.deepEqual(continued.steps[1].read_source.known_bits, {
    mask: 253,
    value: 160,
  });
  assert.deepEqual(continued.steps[1].read_source.sources[0].origin, origin);
  assert.equal(
    continued.ppu_trace.operations.find((operation) => operation.write !== null)
      .write.status,
    "ignored",
  );
  assert.equal(continued.steps[4].read_source.value, 0xa1);
  assert.equal(continued.steps[4].read_source.file_offset, CHR + 47 * 1024);
  assert.deepEqual(
    continued.ppu_trace.final.nametable[1024],
    trace.ppu_trace.final.nametable[1024],
  );
}
async function unknownBacking({ call, mapper, path }) {
  const input = {
    path,
    initial: initial(mapper, { mask: 47, value: 32 }),
    initial_ppu: {
      ...ppu,
      nametable_layout: null,
      v: { low: 0, high: 36 },
      read_buffer: { value: 73 },
    },
    events: [{ kind: "cpu-read", address: 0x2007 }],
  };
  const trace = (await call("trace-nes-mapper-events", input)).trace;
  assert.equal(trace.steps[0].cpu_read.value, 73);
  assert.equal(trace.ppu_trace.final.read_buffer.value, null);
  assert.deepEqual(
    trace.ppu_trace.final.read_buffer.sources
      .map((source) => source.kind)
      .sort(),
    ["rom", "unknown"],
  );
  assert.equal(
    trace.ppu_trace.final.read_buffer.sources.find(
      (source) => source.kind === "rom",
    ).file_offset,
    CHR + 47 * 1024,
  );
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: trace.final,
      initial_ppu: trace.ppu_trace.final,
    })
  ).trace;
  assert.equal(continued.steps[0].cpu_read.value, null);
  assert.equal(continued.ppu_trace.final.read_buffer.value, null);
  assert.deepEqual(
    continued.ppu_trace.final.read_buffer.sources
      .map((source) => source.kind)
      .sort(),
    ["rom", "unknown"],
  );
  assert.equal(
    continued.ppu_trace.final.read_buffer.sources.find(
      (source) => source.kind === "rom",
    ).file_offset,
    CHR + 47 * 1024 + 1,
  );
}
async function sourceBuffers({ call, mapper, path, bytes }) {
  const input = {
    path,
    initial: initial(mapper),
    initial_ppu: {
      ...ppu,
      v: { low: 0, high: 36 },
      read_buffer: { value: 73 },
      nametable: { 1026: 0xa2, 1028: 0x66 },
    },
  };
  const trace = (await call("trace-nes-code", input)).code_trace;
  verifyBytes(trace, bytes);
  assert.equal(trace.stop.reason, "return");
  assert.deepEqual(dataValues(trace), [73, 0xa1, 63, 0xa2]);
  assert.equal(trace.final_cpu.a, 0xa2);
  assert.equal(
    trace.instructions.find((item) => item.address === 0xe185).writes[0]
      .address,
    mapper === 24 ? 0xe002 : 0xe001,
  );
  const device = trace.mapper_trace.ppu_trace;
  assert.deepEqual(device.final.v, { low: 5, high: 36 });
  assert.equal(device.final.read_buffer.value, 0x66);
  assert.deepEqual(device.final.nametable[1027], {
    value: 0x44,
    origin: { kind: "event-write", index: 5 },
  });
  assert.equal(device.final.read_buffer.sources[0].address, 1028);
  assert.equal(trace.mapper_trace.final.chr_banks[6], 62);
  assert.equal(trace.mapper_trace.final.chr_banks[5], 39);
  const replay = (
    await call("trace-nes-mapper-events", {
      ...input,
      events: trace.mapper_trace.steps.map((step) => step.event),
    })
  ).trace;
  assert.deepEqual(replay, trace.mapper_trace);
  if (mapper !== 24) return;
  const prefix = (
    await call("trace-nes-code", { ...input, max_instructions: 4 })
  ).code_trace;
  assert.equal(prefix.stop.address, 0xe18b);
  assert.equal(prefix.mapper_trace.ppu_trace.final.read_buffer.value, 63);
  assert.equal(
    prefix.mapper_trace.ppu_trace.final.read_buffer.sources[0].file_offset,
    CHR + 63 * 1024 + 1,
  );
  const tailInput = {
    path,
    initial: prefix.mapper_trace.final,
    cpu: prefix.final_cpu,
    entry: prefix.stop.address,
    initial_ppu: {
      ...prefix.mapper_trace.ppu_trace.final,
      nametable: {
        ...prefix.mapper_trace.ppu_trace.final.nametable,
        1026: 0x99,
      },
    },
  };
  const tail = (await call("trace-nes-code", tailInput)).code_trace;
  verifyBytes(tail, bytes);
  assert.deepEqual(dataValues(tail), [63, 0x99]);
  assert.equal(tail.final_cpu.a, 0x99);
  assert.equal(tail.mapper_trace.ppu_trace.final.read_buffer.value, 0x66);
  assert.deepEqual(
    tail.mapper_trace.ppu_trace.final.nametable[1027],
    device.final.nametable[1027],
  );
  const tailReplay = (
    await call("trace-nes-mapper-events", {
      path,
      initial: tailInput.initial,
      initial_ppu: tailInput.initial_ppu,
      events: tail.mapper_trace.steps.map((step) => step.event),
    })
  ).trace;
  assert.deepEqual(tailReplay, tail.mapper_trace);
  assert.deepEqual(
    (await call("explore-nes-code", input)).code_exploration.paths[0].trace,
    trace,
  );
}
async function capacityAndAdmission({ call, mapper, path, bytes }) {
  const maximum = (
    await call("trace-nes-mapper-events", {
      path,
      initial: {
        ...initial(mapper, { mask: 47, value: 0 }),
        chr_banks: [5, 9, 18, 27, 36, 39, null, null],
      },
      initial_ppu: ppu,
      ppu_nametable: 1,
      events: [],
    })
  ).trace;
  const pages = maximum.ppu_trace.nametable.source_pages;
  assert.equal(pages.length, 258);
  assert.deepEqual(
    pages.filter((page) => typeof page === "number"),
    [0, 1024],
  );
  assert.deepEqual(
    pages
      .filter((page) => typeof page === "object")
      .map((page) => page.file_offset),
    Array.from({ length: 256 }, (_, page) => CHR + page * 1024),
  );
  verifyPages(pages, bytes);
  const bare = (
    await call("trace-nes-mapper-events", {
      path,
      initial: initial(mapper, 1),
      events: [
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-read", address: 1024 },
      ],
    })
  ).trace;
  assert.deepEqual(
    bare.steps.map((step) => step.read_source),
    [0, 1].map(() => ({
      status: "chr-rom",
      bank: 5,
      file_offset: CHR + 5 * 1024,
    })),
  );
  const invalid = (
    await call("trace-nes-mapper-events", {
      path,
      initial: initial(mapper),
      initial_ppu: { ...ppu, nametable_layout: "four-screen-4k" },
      events: [],
    })
  ).trace;
  assert.equal(invalid.status, "unsupported");
  for (const facet of ["pattern", "sprites", "viewport"])
    verifyVrc6PpuMemoryMaximumResult(
      await call(
        "trace-nes-mapper-events",
        vrc6PpuMemoryMaximumInput(path, facet),
      ),
      bytes,
      facet,
    );
}
