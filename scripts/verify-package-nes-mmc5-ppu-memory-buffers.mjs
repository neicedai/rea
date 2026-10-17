import assert from "node:assert/strict";
import {
  SOURCE_ENTRY,
  FRONTIER_ENTRY,
  initial,
  ppu,
  write,
} from "./verify-package-nes-mmc5-ppu-memory-fixture.mjs";

async function generatedBuffers({ eventTrace }) {
  const first = await eventTrace({
    initial: {
      ...initial(),
      nametable_control: 255,
      fill_tile: 0x15,
      exram_mode: 2,
    },
    initial_ppu: {
      ...ppu,
      v: { low: 0, high: 32 },
      read_buffer: { value: 73 },
    },
    events: [
      { kind: "cpu-read", address: 0x2007 },
      write(0x5106, 0x99),
      write(0x5105, 170),
      { kind: "cpu-read", address: 0x2007 },
    ],
  });
  assert.equal(first.steps[0].cpu_read.value, 73);
  assert.equal(first.steps[3].cpu_read.value, 0x15);
  const fill = first.steps[3].cpu_read.source.alternatives
    .flatMap((alternative) => alternative.sources)
    .find((source) => source.kind === "mmc5-fill");
  assert.deepEqual(fill, {
    kind: "mmc5-fill",
    register: 0x5106,
    register_value: 0x15,
    value: 0x15,
    mask: 255,
  });
  assert.equal(first.final.fill_tile, 0x99);
  assert.deepEqual(first.ppu_trace.final.read_buffer.sources, [
    { kind: "mmc5-zero", value: 0, mask: 255 },
  ]);
  const resumed = await eventTrace({
    initial: first.final,
    initial_ppu: first.ppu_trace.final,
    events: [write(0x5104, 0), { kind: "cpu-read", address: 0x2007 }],
  });
  assert.equal(resumed.steps[1].cpu_read.value, 0);
  assert.equal(resumed.ppu_trace.final.read_buffer.value, 0xc2);
  assert.deepEqual(resumed.steps[1].cpu_read.source.alternatives[0].sources, [
    { kind: "mmc5-zero", value: 0, mask: 255 },
  ]);
}

const sourceData = (trace) =>
  trace.instructions
    .filter(
      (instruction) =>
        instruction.mnemonic === "LDA" && instruction.data_reads.length > 0,
    )
    .map((instruction) => instruction.data_reads[0]);
function verifyCode(trace, bytes) {
  for (const instruction of trace.instructions)
    for (const [index, byte] of Buffer.from(
      instruction.bytes_hex,
      "hex",
    ).entries()) {
      assert.deepEqual(instruction.ram_origins, []);
      assert.notEqual(instruction.file_offsets[index], null);
      assert.equal(bytes[instruction.file_offsets[index]], byte);
    }
}

export async function verifyMmc5MemoryBuffers(context) {
  await sourceBuffers(context);
  await rollback(context);
  await generatedBuffers(context);
}

async function sourceBuffers({ call, eventTrace, path, bytes, cellValue }) {
  const input = {
    path,
    entry: SOURCE_ENTRY,
    max_instructions: 12,
    initial: {
      ...initial(),
      nametable_control: 0xaa,
      exram: { 0: 0xa0, 1: 0xa1, 2: 0xa2 },
    },
    initial_ppu: {
      ...ppu,
      v: { low: 0, high: 32 },
      read_buffer: { value: 73 },
      nametable: { 2: 0x55, 3: 0x56 },
    },
  };
  const full = (await call("trace-nes-code", input)).code_trace;
  assert.equal(full.status, "derived");
  verifyCode(full, bytes);
  assert.deepEqual(
    sourceData(full).map((read) => read.value),
    [73, 0xa0, 0xa1, 0x55],
  );
  assert.deepEqual(cellValue(full.mapper_trace.final.exram[1]), 0xaa);
  const original = sourceData(full)[2].mapper_origins.find(
    (source) => source.kind === "ppu-register",
  );
  assert.ok(original);
  const captured = original.alternatives
    .flatMap((alternative) => alternative.sources)
    .find((source) => source.kind === "mmc5-exram");
  assert.equal(captured.address, 1);
  assert.equal(captured.value, 0xa1);
  assert.deepEqual(captured.origin, { kind: "initial-exram", address: 1 });
  assert.deepEqual(
    await eventTrace({
      initial: input.initial,
      initial_ppu: input.initial_ppu,
      events: full.mapper_trace.steps.map((step) => step.event),
    }),
    full.mapper_trace,
  );
  const prefix = (
    await call("trace-nes-code", { ...input, max_instructions: 2 })
  ).code_trace;
  assert.equal(prefix.stop.address, SOURCE_ENTRY + 6);
  assert.equal(prefix.mapper_trace.ppu_trace.final.read_buffer.value, 0xa1);
  const tailInput = {
    path,
    entry: prefix.stop.address,
    max_instructions: 10,
    cpu: prefix.final_cpu,
    initial: prefix.mapper_trace.final,
    initial_ppu: prefix.mapper_trace.ppu_trace.final,
  };
  const tail = (await call("trace-nes-code", tailInput)).code_trace;
  assert.deepEqual(
    sourceData(tail).map((read) => read.value),
    [0xa1, 0x55],
  );
  assert.deepEqual(tail.final_cpu, full.final_cpu);
  assert.deepEqual(tail.mapper_trace.final, full.mapper_trace.final);
  assert.deepEqual(
    tail.mapper_trace.ppu_trace.final,
    full.mapper_trace.ppu_trace.final,
  );
  assert.deepEqual(
    await eventTrace({
      initial: tailInput.initial,
      initial_ppu: tailInput.initial_ppu,
      events: tail.mapper_trace.steps.map((step) => step.event),
    }),
    tail.mapper_trace,
  );
  assert.deepEqual(
    (await call("explore-nes-code", input)).code_exploration.paths[0].trace,
    full,
  );
}

async function rollback({ call, path, exramAtom }) {
  const result = (
    await call("trace-nes-code", {
      path,
      entry: FRONTIER_ENTRY,
      initial: { ...initial(), nametable_control: 0xaa },
      initial_ppu: { ...ppu, v: { low: 0, high: 32 } },
    })
  ).code_trace;
  assert.equal(result.stop.reason, "unknown-control-target");
  assert.equal(result.instructions.length, 0);
  assert.deepEqual(result.mapper_trace.steps, []);
  assert.deepEqual(result.mapper_trace.ppu_trace.operations, []);
  assert.deepEqual(
    result.mapper_trace.ppu_trace.final,
    result.mapper_trace.ppu_trace.initial,
  );
  assert.ok(result.mapper_trace.ppu_trace.frontier.length > 0);
  const reads = result.mapper_trace.ppu_trace.frontier.flatMap(
    (operation) => operation.bus_reads,
  );
  exramAtom(reads[0], { address: 0, value: 0xc0 });
}
