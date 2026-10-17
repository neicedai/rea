import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CHR,
  initial,
  fixture,
  ppu,
  write,
} from "./verify-package-nes-namco163-ppu-memory-fixture.mjs";
import { namco163PpuGraphicsWorkflows } from "./verify-package-nes-namco163-ppu-memory-graphics.mjs";
import {
  namco163PpuMemoryMaximumInput,
  verifyNamco163PpuMemoryMaximumResult,
} from "./verify-package-nes-namco163-ppu-memory-maximum.mjs";
export {
  namco163PpuMemoryMaximumInput,
  verifyNamco163PpuMemoryMaximumResult,
} from "./verify-package-nes-namco163-ppu-memory-maximum.mjs";
export { fixture as namco163PpuMemoryFixture } from "./verify-package-nes-namco163-ppu-memory-fixture.mjs";

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
const dataValues = (trace) =>
  trace.instructions
    .filter((item) => item.mnemonic === "LDA" && item.data_reads.length > 0)
    .map((item) => item.data_reads[0].value);
/** Independent shared physical CIRAM, disable-bit, buffer and graphics oracles. */
export async function verifyPackageNesNamco163PpuMemory(invoke, workspace) {
  const bytes = fixture(),
    path = join(workspace, "namco163-ppu-memory.nes");
  await writeFile(path, bytes);
  let workflows = 0;
  const call = async (command, input) => {
    workflows++;
    const evidence = await invoke(command, input);
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    return evidence.normalized_result;
  };
  await sharedAlias({ call, path });
  await disableMasks({ call, path });
  await mixedAlias({ call, path });
  await unknownBacking({ call, path });
  await sourceBuffers({ call, path, bytes });
  await namco163PpuGraphicsWorkflows({
    call,
    path,
    bytes,
    verifyBytes,
    verifyPages,
  });
  for (const facet of ["nametable", "pattern", "sprites", "viewport"])
    verifyNamco163PpuMemoryMaximumResult(
      await call(
        "trace-nes-mapper-events",
        namco163PpuMemoryMaximumInput(path, facet),
      ),
      bytes,
      facet,
    );
  await bareMetadata({ call, path });
  await debugSources({ call, path });
  for (const profile of [
    { ...ppu, chr_ram_size: 8192 },
    { ...ppu, nametable_layout: "four-screen-4k" },
  ])
    assert.equal(
      (
        await call("trace-nes-mapper-events", {
          path,
          initial: initial(),
          initial_ppu: profile,
          events: [],
        })
      ).trace.status,
      "unsupported",
    );
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(workflows, 23);
  return {
    ok: true,
    workflows,
    shared_ciram: true,
    cpu_buffer: true,
    unknown_backing: true,
    graphics_sources: true,
    debug_uncertainty: true,
    original_unchanged: true,
    scope:
      "Conditional original Namco 163 CHR-ROM/CIRAM shared cells, pattern-disable controls, buffers and frozen graphics; synthetic immutable ROM, no audio-debug electrical target, PPU timing, gameplay or alternate storage claim",
  };
}
async function sharedAlias({ call, path }) {
  const trace = (
    await call("trace-nes-mapper-events", {
      path,
      initial: initial(),
      initial_ppu: ppu,
      events: [
        { kind: "ppu-write", address: 0, value: 0x44 },
        { kind: "ppu-read", address: 0x2400 },
        { kind: "ppu-write", address: 0x2000, value: 0x77 },
        { kind: "ppu-read", address: 0x800 },
        { kind: "ppu-write", address: 0x400, value: 255 },
        { kind: "ppu-write", address: 0x2800, value: 255 },
        { kind: "ppu-read", address: 0x400 },
        { kind: "ppu-read", address: 0x2800 },
      ],
    })
  ).trace;
  assert.deepEqual(
    trace.steps
      .filter((step) => step.event.kind === "ppu-read")
      .map((step) => step.read_source.value),
    [0x44, 0x77, 5, 47],
  );
  assert.deepEqual(trace.ppu_trace.final.nametable[1024], {
    value: 0x44,
    origin: { kind: "event-write", index: 0 },
  });
  assert.deepEqual(trace.ppu_trace.final.nametable[0], {
    value: 0x77,
    origin: { kind: "event-write", index: 2 },
  });
  assert.deepEqual(
    trace.ppu_trace.operations
      .filter((operation) => operation.write !== null)
      .map((operation) => operation.write.status),
    ["written", "written", "ignored", "ignored"],
  );
  assert.equal(trace.steps[1].read_source.sources[0].address, 1024);
  assert.equal(trace.steps[3].read_source.sources[0].address, 0);
}
async function disableMasks({ call, path }) {
  const events = [1, 0x41, 0x81, 0xc1].flatMap((value) => [
    write(0xe800, value),
    ...[0, 0x1000, 0x2400].map((address) => ({ kind: "ppu-read", address })),
  ]);
  const trace = (
    await call("trace-nes-mapper-events", {
      path,
      initial: initial(),
      initial_ppu: { ...ppu, nametable: { 0: 0xb0, 1024: 0xa0 } },
      events,
    })
  ).trace;
  assert.deepEqual(
    trace.steps
      .filter((step) => step.event.kind === "ppu-read")
      .map((step) => step.read_source.value),
    [0xa0, 0xb0, 0xa0, 0xa1, 0xb0, 0xa0, 0xa0, 0xb1, 0xa0, 0xa1, 0xb1, 0xa0],
  );
  assert.equal(trace.final.prg_banks[1], 0xc1);
  assert.equal(trace.final_mapping.prg_windows[1].bank, 1);
  assert.equal(trace.final_mapping.nametable_windows[1].source, "ciram");
}
async function mixedAlias({ call, path }) {
  const origin = { kind: "initial-memory", space: "nametable", address: 1024 };
  const state = initial();
  state.chr_banks[0] = { mask: 127, value: 97 };
  state.nametable_banks[0] = { mask: 127, value: 97 };
  const trace = (
    await call("trace-nes-mapper-events", {
      path,
      initial: state,
      initial_ppu: { ...ppu, nametable: { 1024: { value: 0xa0, origin } } },
      ppu_pattern_table: 0,
      events: [
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-write", address: 0, value: 0xa2 },
        { kind: "ppu-read", address: 0x2400 },
        { kind: "ppu-read", address: 0 },
      ],
    })
  ).trace;
  assert.deepEqual(trace.steps[0].read_source.known_bits, {
    mask: 254,
    value: 160,
  });
  assert.deepEqual(
    trace.steps[0].read_source.sources.map((source) => source.kind).sort(),
    ["memory", "rom"],
  );
  assert.equal(
    trace.steps[0].read_source.sources.find((source) => source.kind === "rom")
      .file_offset,
    CHR + 97 * 1024,
  );
  assert.deepEqual(trace.ppu_trace.final.nametable[1024], {
    value: { mask: 253, value: 160 },
    origin,
  });
  assert.deepEqual(trace.steps[2].read_source.known_bits, {
    mask: 253,
    value: 160,
  });
  assert.deepEqual(trace.steps[3].read_source.known_bits, {
    mask: 252,
    value: 160,
  });
  const refs = trace.ppu_trace.pattern_table.blocks[0].sources.map(
    (index) => trace.ppu_trace.pattern_table.source_pages[index],
  );
  assert.ok(
    refs.some((page) => page.kind === "ciram" && page.address === 1024),
  );
  assert.ok(
    refs.some(
      (page) => page.kind === "rom" && page.file_offset === CHR + 97 * 1024,
    ),
  );
  const continued = (
    await call("trace-nes-mapper-events", {
      path,
      initial: trace.final,
      initial_ppu: trace.ppu_trace.final,
      events: [
        { kind: "ppu-write", address: 0x2000, value: 0xa4 },
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-read", address: 0x2400 },
      ],
    })
  ).trace;
  assert.equal(continued.ppu_trace.operations[0].write.status, "uncertain");
  assert.deepEqual(continued.ppu_trace.final.nametable[1024], {
    value: { mask: 249, value: 160 },
    origin,
  });
  assert.deepEqual(continued.steps[1].read_source.known_bits, {
    mask: 248,
    value: 160,
  });
  assert.deepEqual(continued.steps[2].read_source.sources[0].origin, origin);
}
async function unknownBacking({ call, path }) {
  const state = initial();
  state.chr_banks[0] = { mask: 127, value: 97 };
  const input = {
    path,
    initial: state,
    initial_ppu: {
      ...ppu,
      nametable_layout: null,
      v: { low: 0, high: 0 },
      read_buffer: { value: 73 },
    },
    ppu_pattern_table: 0,
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
  const refs = trace.ppu_trace.pattern_table.blocks[0].sources.map(
    (index) => trace.ppu_trace.pattern_table.source_pages[index],
  );
  assert.deepEqual(refs.map((source) => source.kind).sort(), [
    "rom",
    "unknown",
  ]);
  const continued = (
    await call("trace-nes-mapper-events", {
      ...input,
      initial: trace.final,
      initial_ppu: trace.ppu_trace.final,
    })
  ).trace;
  assert.equal(continued.steps[0].cpu_read.value, null);
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
    CHR + 97 * 1024 + 1,
  );
}
async function sourceBuffers({ call, path, bytes }) {
  const input = {
    path,
    initial: initial(),
    initial_ppu: {
      ...ppu,
      v: { low: 0, high: 0 },
      read_buffer: { value: 73 },
      nametable: { 1024: 0xa0, 1026: 0xa2, 1028: 0x66 },
    },
  };
  const trace = (await call("trace-nes-code", input)).code_trace;
  verifyBytes(trace, bytes);
  assert.equal(trace.stop.reason, "return");
  assert.deepEqual(dataValues(trace), [73, 0xa0, 0xa1, 0xa2]);
  assert.equal(trace.final_cpu.a, 0xa2);
  const device = trace.mapper_trace.ppu_trace;
  assert.deepEqual(device.final.v, { low: 5, high: 0 });
  assert.equal(device.final.read_buffer.value, 0x66);
  assert.deepEqual(device.final.nametable[1027], {
    value: 0x44,
    origin: { kind: "event-write", index: 5 },
  });
  assert.deepEqual(
    (
      await call("trace-nes-mapper-events", {
        ...input,
        events: trace.mapper_trace.steps.map((step) => step.event),
      })
    ).trace,
    trace.mapper_trace,
  );
  const prefix = (
    await call("trace-nes-code", { ...input, max_instructions: 4 })
  ).code_trace;
  assert.equal(prefix.stop.address, 0xe18b);
  assert.equal(prefix.mapper_trace.ppu_trace.final.read_buffer.value, 0xa1);
  assert.equal(
    prefix.mapper_trace.ppu_trace.final.read_buffer.sources[0].file_offset,
    CHR + 225 * 1024 + 1,
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
  assert.deepEqual(dataValues(tail), [0xa1, 0x99]);
  assert.equal(tail.final_cpu.a, 0x99);
  assert.deepEqual(
    tail.mapper_trace.ppu_trace.final.nametable[1027],
    device.final.nametable[1027],
  );
  assert.deepEqual(
    (
      await call("trace-nes-mapper-events", {
        path,
        initial: tailInput.initial,
        initial_ppu: tailInput.initial_ppu,
        events: tail.mapper_trace.steps.map((step) => step.event),
      })
    ).trace,
    tail.mapper_trace,
  );
  assert.deepEqual(
    (await call("explore-nes-code", input)).code_exploration.paths[0].trace,
    trace,
  );
}
async function bareMetadata({ call, path }) {
  const state = initial(0x41);
  state.chr_banks[0] = { mask: 1, value: 1 };
  state.chr_banks[4] = { mask: 254, value: 224 };
  const bare = (
    await call("trace-nes-mapper-events", {
      path,
      initial: state,
      events: [
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-read", address: 0x1000 },
      ],
    })
  ).trace;
  assert.deepEqual(
    bare.steps.map((step) => step.read_source),
    [
      { status: "unknown-chr-bank", bank: null, file_offset: null },
      { status: "ciram-unobserved", bank: null, file_offset: null },
    ],
  );
  assert.deepEqual(
    [bare.final_mapping.chr_windows[0], bare.final_mapping.chr_windows[4]],
    [
      {
        start: 0,
        size: 1024,
        source: "chr-rom",
        bank: null,
        file_offset: null,
      },
      {
        start: 4096,
        size: 1024,
        source: "ciram",
        bank: null,
        file_offset: null,
      },
    ],
  );
}
async function debugSources({ call, path }) {
  const debugState = initial();
  debugState.prg_banks[2] = 63;
  const debug = (
    await call("trace-nes-mapper-events", {
      path,
      initial: debugState,
      initial_ppu: {
        ...ppu,
        v: { low: 0, high: 0 },
        read_buffer: { value: 73 },
      },
      ppu_pattern_table: 0,
      ppu_nametable: 0,
      events: [{ kind: "cpu-read", address: 0x2007 }],
    })
  ).trace;
  assert.equal(debug.steps[0].cpu_read.value, 73);
  assert.equal(debug.ppu_trace.final.read_buffer.value, null);
  assert.deepEqual(debug.ppu_trace.pattern_table.source_pages, [
    { kind: "unknown", reason: "namco163-audio-debug" },
  ]);
  assert.deepEqual(debug.ppu_trace.nametable.source_pages, [
    { kind: "unknown", reason: "namco163-audio-debug" },
  ]);
  const possibleState = initial();
  possibleState.prg_banks[2] = { mask: 254, value: 62 };
  const possible = (
    await call("trace-nes-mapper-events", {
      path,
      initial: possibleState,
      initial_ppu: {
        ...ppu,
        nametable: { 0: 0xb0, 1024: 0xa0 },
        v: { low: 0, high: 63 },
      },
      ppu_pattern_table: 0,
      events: [
        { kind: "cpu-write", address: 0x2007, value: 7 },
        { kind: "ppu-read", address: 0x2000 },
        { kind: "ppu-write", address: 0, value: 0x55 },
        { kind: "ppu-read", address: 0x2400 },
      ],
    })
  ).trace;
  assert.equal(possible.ppu_trace.operations[0].write.status, "written");
  assert.deepEqual(
    possible.ppu_trace.operations[0].write.invalidated_spaces,
    [],
  );
  assert.equal(
    possible.steps[1].read_source.sources.find(
      (source) => source.kind === "memory",
    ).value,
    0xb0,
  );
  assert.equal(possible.ppu_trace.operations[2].write.status, "unverified");
  assert.deepEqual(possible.ppu_trace.operations[2].write.invalidated_spaces, [
    "nametable",
  ]);
  assert.deepEqual(possible.ppu_trace.final.nametable, {});
  assert.equal(possible.ppu_trace.final.palette[0].value, 7);
  assert.ok(
    possible.ppu_trace.pattern_table.source_pages.some(
      (page) =>
        page.kind === "unknown" && page.reason === "namco163-audio-debug",
    ),
  );
  assert.ok(
    possible.ppu_trace.pattern_table.source_pages.some(
      (page) => page.kind === "ciram" && page.address === 1024,
    ),
  );
}
