import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRG,
  CHR,
  initial,
  fixture,
} from "./verify-package-nes-sunsoft4-fixture.mjs";
import { sunsoft4PpuWorkflows } from "./verify-package-nes-sunsoft4-ppu.mjs";

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
/** Independent normal-board banking, RAM permission and ROM-nametable oracle. */
export async function verifyPackageNesSunsoft4(invoke, workspace) {
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
  const bytes = fixture(),
    path = await save("sunsoft4-normal.nes", bytes);
  const base = { path, initial, cpu: { sp: 255 }, max_instructions: 256 };
  await banking({ call, base, bytes });
  await ram({ call, base, bytes, save });
  await qualification({ call, base, bytes, save });
  await sunsoft4PpuWorkflows({ call, path, bytes });
  for (const [path, original] of files)
    assert.deepEqual(await readFile(path), original);
  assert.equal(workflows, 25);
  return {
    ok: true,
    workflows,
    banking: true,
    ram_provenance: true,
    rom_nametables: true,
    unknown_mux: true,
    original_unchanged: true,
    scope:
      "Conditional normal Sunsoft 4 PRG/CHR/RAM and ROM/CIRAM nametable derivations, including frozen viewport; synthetic immutable ROMs, no Dual Cartridge/license, observed gameplay or physical timing claim",
  };
}
async function banking({ call, base, bytes }) {
  const trace = (await call("trace-nes-code", base)).code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0xd4);
  verifyBytes(trace, bytes);
  assert.deepEqual(
    trace.instructions.find((item) => item.address === 0xbfff).file_offsets,
    [PRG + 6 * 16384 - 1, PRG + 15 * 16384],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((item) => item.bank),
    [12, 15],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.chr_windows.map((item) => item.bank),
    [3, 17, 42, 127],
  );
  assert.deepEqual(trace.mapper_trace.final.nametable_banks, [5, 0x86]);
  assert.deepEqual(
    trace.mapper_trace.final_mapping.nametable_windows,
    [133, 134, 133, 134].map((bank, index) => ({
      start: 0x2000 + index * 1024,
      size: 1024,
      source: "chr-rom",
      bank,
      file_offset: CHR + bank * 1024,
    })),
  );
  assert.deepEqual(trace.mapper_trace.nes_prg_views, [
    { ...initial, prg_bank: 5 },
    { ...initial, prg_bank: 12 },
  ]);
  const writes = trace.instructions
    .flatMap((item) => item.writes)
    .filter((item) => item.address >= 0x8000);
  assert.deepEqual(
    (
      await call("trace-nes-mapper-writes", {
        path: base.path,
        initial,
        writes,
      })
    ).trace,
    trace.mapper_trace,
  );
  const events = (
    await call("trace-nes-mapper-events", {
      path: base.path,
      initial,
      events: [
        ...writes.map((item) => ({ ...item, kind: "cpu-write" })),
        ...[3, 17, 42, 127].flatMap((_, index) => [
          { kind: "ppu-read", address: index * 2048 },
          { kind: "ppu-read", address: index * 2048 + 2047 },
        ]),
        { kind: "ppu-read", address: 0x2000 },
        { kind: "ppu-read", address: 0x2fff },
      ],
    })
  ).trace;
  assert.deepEqual(
    events.steps.slice(-10).map((item) => item.read_source.file_offset),
    [
      ...[3, 17, 42, 127].flatMap((bank) => [
        CHR + bank * 2048,
        CHR + bank * 2048 + 2047,
      ]),
      CHR + 133 * 1024,
      CHR + 135 * 1024 - 1,
    ],
  );
  assert.deepEqual(events.final_mapping, trace.mapper_trace.final_mapping);
  assert.deepEqual(
    (await call("explore-nes-code", base)).code_exploration.paths[0].trace,
    trace,
  );
}
async function ram({ call, base, bytes, save }) {
  const nvram = Buffer.from(bytes);
  nvram[10] = 0x70;
  const seed = (
    await call("trace-nes-code", {
      path: await save("sunsoft4-nvram.nes", nvram),
      initial: { ...initial, prg_bank: 16 },
      entry: 0x6000,
      initial_prg_ram: [0xa9, 0x6d, 0x60].map((value, index) => ({
        bank: 0,
        address: 0x6000 + index,
        value,
      })),
    })
  ).code_trace;
  assert.equal(seed.final_cpu.a, 0x6d);
  assert.equal(seed.instructions[0].ram_origins[0].initial_prg_ram_index, 0);
  for (const prg_bank of [5, { mask: 15, value: 5 }]) {
    const stopped = (
      await call("trace-nes-code", {
        path: base.path,
        initial: { ...initial, prg_bank },
        entry: 0x6000,
        initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x60 }],
      })
    ).code_trace;
    assert.equal(stopped.status, "derived");
    assert.equal(stopped.stop.address, 0x6000);
    assert.deepEqual(stopped.instructions, []);
  }
}
async function qualification({ call, base, bytes, save }) {
  const legacy = Buffer.concat([
    bytes.subarray(0, PRG),
    bytes.subarray(PRG + 131072),
  ]);
  legacy[4] = 8;
  legacy[7] = 0x40;
  legacy[8] = 0;
  legacy[10] = 0;
  const legacyPath = await save("sunsoft4-legacy-normal.nes", legacy);
  const explicit = (
    await call("trace-nes-code", { path: legacyPath, initial, entry: 0xc240 })
  ).code_trace;
  assert.equal(explicit.status, "derived");
  assert.equal(explicit.stop.reason, "return");
  assert.deepEqual(explicit.instructions[0].file_offsets, [
    PRG + 7 * 16384 + 0x240,
  ]);
  const unknownRam = (
    await call("trace-nes-code", { ...base, path: legacyPath })
  ).code_trace;
  assert.equal(unknownRam.status, "derived");
  assert.equal(unknownRam.stop.address, 0x6000);
  for (const [name, byte, value] of [
    ["dualcart", 8, 16],
    ["ram16k", 10, 8],
    ["four-screen", 6, 0x4c],
  ]) {
    const invalid = Buffer.from(bytes);
    invalid[byte] = value;
    assert.equal(
      (
        await call("trace-nes-mapper-writes", {
          path: await save(`sunsoft4-${name}.nes`, invalid),
          initial,
          writes: [],
        })
      ).trace.status,
      "unsupported",
    );
  }
  const small = Buffer.concat([
    bytes.subarray(0, PRG),
    bytes.subarray(PRG, PRG + 65536),
    bytes.subarray(CHR),
  ]);
  small[4] = 4;
  const partial = (
    await call("trace-nes-mapper-writes", {
      path: await save("sunsoft4-partial-logical.nes", small),
      initial: { ...initial, prg_bank: { mask: 3, value: 1 } },
      writes: [],
    })
  ).trace;
  assert.equal(partial.final_mapping.prg_windows[0].bank, 1);
  assert.equal(partial.final_mapping.prg_view, null);
}
