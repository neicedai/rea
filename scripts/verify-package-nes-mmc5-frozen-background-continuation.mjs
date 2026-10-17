import assert from "node:assert/strict";
import {
  ENTRY,
  initial,
  geometry,
  nametableInput,
  viewportInput,
} from "./verify-package-nes-mmc5-frozen-background-fixture.mjs";

export async function verifyFrozenMmc5Continuation(context) {
  await retainedWrites(context);
  await sourceContinuation(context);
}

async function retainedWrites(context) {
  const {
    path,
    eventTrace,
    projection,
    projectedPalette,
    projectedBranches,
    frozenEqual,
  } = context;
  const writes = [
      { kind: "cpu-write", address: 0x5104, value: 2 },
      { kind: "cpu-write", address: 0x5c25, value: 0x83 },
      { kind: "cpu-write", address: 0x5104, value: 1 },
    ],
    input = nametableInput(path, {
      initial: { ...initial(), nametable_control: 170 },
      events: writes,
    }),
    full = await eventTrace(input),
    prefix = await eventTrace({
      ...input,
      events: writes.slice(0, 2),
      ppu_nametable: null,
      ppu_mmc5_background: null,
    }),
    tail = await eventTrace({
      path,
      initial: prefix.final,
      initial_ppu: prefix.ppu_trace.final,
      events: writes.slice(2),
      ppu_nametable: 0,
      ppu_mmc5_background: { nametable: geometry() },
    });
  assert.deepEqual(tail.final, full.final);
  assert.deepEqual(tail.ppu_trace.final, full.ppu_trace.final);
  assert.deepEqual(tail.ppu_trace.nametable, full.ppu_trace.nametable);
  const paired = projectedBranches(
    projection(full.ppu_trace.nametable),
    40,
    8,
  )[0].pair;
  assert.deepEqual(paired.tile_origin, { kind: "event-write", index: 1 });
  assert.deepEqual(paired.attribute.origin, paired.tile_origin);
  assert.equal(paired.tile, 0x83);
  assert.equal(paired.attribute.value, 0x83);
  assert.equal(
    projectedPalette(projection(full.ppu_trace.nametable), 40, 8),
    1 << 9,
  );
  const baseline = await eventTrace({
    ...input,
    ppu_nametable: null,
    ppu_mmc5_background: null,
  });
  frozenEqual(full, baseline);
}

async function sourceContinuation({
  path,
  bytes,
  call,
  eventTrace,
  viewportCode,
  codeMask,
}) {
  const { events: _events, ...selected } = viewportInput(path),
    codeInput = { ...selected, entry: ENTRY, max_instructions: 5 },
    code = (await call("trace-nes-code", codeInput)).code_trace;
  assert.equal(code.status, "derived");
  assert.equal(code.instructions.length, 5);
  assert.equal(code.stop.address, ENTRY + 11);
  assert.equal(
    viewportCode(code.mapper_trace.ppu_trace.viewport, 0, 0),
    codeMask(10),
  );
  for (const instruction of code.instructions)
    for (const [index, byte] of Buffer.from(
      instruction.bytes_hex,
      "hex",
    ).entries())
      assert.equal(bytes[instruction.file_offsets[index]], byte);
  assert.deepEqual(
    await eventTrace({
      ...selected,
      events: code.mapper_trace.steps.map((step) => step.event),
    }),
    code.mapper_trace,
  );
  const codePrefix = (
    await call("trace-nes-code", { ...codeInput, max_instructions: 2 })
  ).code_trace;
  assert.equal(codePrefix.stop.address, ENTRY + 5);
  assert.equal(
    viewportCode(codePrefix.mapper_trace.ppu_trace.viewport, 0, 0),
    codeMask(5),
  );
  const codeTail = (
    await call("trace-nes-code", {
      ...codeInput,
      entry: codePrefix.stop.address,
      max_instructions: 3,
      cpu: codePrefix.final_cpu,
      initial: codePrefix.mapper_trace.final,
      initial_ppu: codePrefix.mapper_trace.ppu_trace.final,
    })
  ).code_trace;
  assert.deepEqual(codeTail.final_cpu, code.final_cpu);
  assert.deepEqual(codeTail.mapper_trace.final, code.mapper_trace.final);
  assert.deepEqual(
    codeTail.mapper_trace.ppu_trace.final,
    code.mapper_trace.ppu_trace.final,
  );
  assert.deepEqual(
    codeTail.mapper_trace.ppu_trace.viewport,
    code.mapper_trace.ppu_trace.viewport,
  );
  assert.deepEqual(
    (await call("explore-nes-code", codeInput)).code_exploration.paths[0].trace,
    code,
  );
}
