import assert from "node:assert/strict";
import {
  CHR,
  chrByte,
  extendedInput,
  splitInput,
} from "./verify-package-nes-mmc5-ppu-memory-fixture.mjs";

/** Existing qualified fetch pipelines must survive generic PPU memory selection. */
export async function verifyMmc5BackgroundMemory(context) {
  await extended(context);
  await split(context);
}

async function extended({ eventTrace, path, busReads, exramAtom, cellValue }) {
  const input = extendedInput(path),
    full = await eventTrace(input),
    reads = busReads(full);
  assert.equal(reads[0].value, 17);
  exramAtom(reads[1], { address: 37, value: 170, cell_value: 131, shift: 6 });
  for (const [index, bank, offset] of [
    [2, 67, 0x112],
    [3, 131, 0x11a],
  ]) {
    assert.equal(reads[index].file_offset, CHR + bank * 4096 + offset);
    assert.equal(reads[index].value, chrByte(bank * 4096 + offset));
  }
  assert.equal(cellValue(full.final.exram[37]), null);
  assert.equal(full.final.ppu.extended_attribute.value, 131);
  assert.deepEqual(full.final.ppu.extended_attribute.origin, {
    kind: "initial-exram",
    address: 37,
  });
  const prefix = await eventTrace({
    ...input,
    events: input.events.slice(0, 3),
  });
  const resumed = await eventTrace({
    initial: prefix.final,
    initial_ppu: prefix.ppu_trace.final,
    events: input.events.slice(3),
  });
  assert.deepEqual(resumed.final, full.final);
  assert.deepEqual(resumed.ppu_trace.final, full.ppu_trace.final);
}

async function split({ eventTrace, path, busReads, exramAtom }) {
  const full = await eventTrace(splitInput(path)),
    reads = busReads(full);
  exramAtom(reads[0], { address: 933, value: 33 });
  exramAtom(reads[1], { address: 1017, value: 85, cell_value: 109, shift: 0 });
  for (const [index, bank, offset] of [
    [2, 7, 0x213],
    [3, 9, 0x21b],
  ]) {
    assert.equal(reads[index].file_offset, CHR + bank * 4096 + offset);
    assert.equal(reads[index].value, chrByte(bank * 4096 + offset));
  }
  assert.equal(full.final.ppu.split_y, 236);
  const continued = await eventTrace({
    initial: full.final,
    initial_ppu: full.ppu_trace.final,
    events: [{ kind: "mmc5-render-frame" }],
  });
  assert.equal(continued.final.ppu.split_y, 17);
}
