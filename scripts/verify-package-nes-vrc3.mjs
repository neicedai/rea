import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PRG,
  initial,
  fixture,
  ppu,
  write,
} from "./verify-package-nes-vrc3-fixture.mjs";
import { vrc3IrqWorkflows } from "./verify-package-nes-vrc3-irq.mjs";

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
/** Independent VRC3 banking, RAM provenance and CPU-edge IRQ oracle. */
export async function verifyPackageNesVrc3(invoke, workspace) {
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
    path = await save("vrc3-independent.nes", bytes);
  const base = { path, initial, cpu: { sp: 255 }, max_instructions: 256 };
  await banking({ call, base, bytes });
  await upload({ call, path, bytes });
  await ram({ call, base, bytes, save });
  await qualification({ call, path, bytes, save });
  await vrc3IrqWorkflows({ call, path });
  for (const [path, original] of files)
    assert.deepEqual(await readFile(path), original);
  assert.equal(workflows, 24);
  return {
    ok: true,
    workflows,
    banking: true,
    ram_provenance: true,
    chr_upload: true,
    irq_continuation: true,
    original_unchanged: true,
    scope:
      "Conditional original VRC3 PRG/RAM/CHR-RAM and qualified CPU-edge IRQ derivations; synthetic immutable ROMs, no observed gameplay or physical timing claim",
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
    [PRG + 6 * 16384 - 1, PRG + 7 * 16384],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((item) => item.bank),
    [6, 7],
  );
  assert.equal(trace.mapper_trace.final.prg_bank, 0xf6);
  assert.deepEqual(trace.mapper_trace.nes_prg_views, [
    { mapper: 73, prg_bank: 5 },
    { mapper: 73, prg_bank: 6 },
  ]);
  assert.equal(
    trace.instructions.find((item) => item.mnemonic === "INC").data_reads[0]
      .value,
    0x11,
  );
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
        { kind: "ppu-read", address: 0 },
      ],
    })
  ).trace;
  assert.deepEqual(events.final_mapping, trace.mapper_trace.final_mapping);
  assert.deepEqual(events.final, trace.mapper_trace.final);
  assert.deepEqual(events.steps.at(-1).read_source, {
    status: "chr-ram-unobserved",
    bank: 0,
    file_offset: null,
  });
  assert.equal(events.final_mapping.chr_source, "ram-unobserved");
  assert.equal(events.coverage.unknown_pattern_reads, 1);
  assert.deepEqual(events.final_mapping.chr_windows, [
    { start: 0, size: 8192, bank: 0, file_offset: null },
  ]);
  assert.deepEqual(
    (await call("explore-nes-code", base)).code_exploration.paths[0].trace,
    trace,
  );
}
async function upload({ call, path, bytes }) {
  const input = {
    path,
    initial,
    entry: 0xc380,
    initial_ppu: { ...ppu, read_buffer: { value: 73 } },
    ppu_pattern_table: 0,
  };
  const trace = (await call("trace-nes-code", input)).code_trace;
  assert.equal(trace.stop.reason, "return");
  verifyBytes(trace, bytes);
  assert.equal(trace.final_cpu.a, 0xaa);
  const device = trace.mapper_trace.ppu_trace;
  for (let address = 0; address < 16; address++) {
    const cell = device.final.chr_ram[address];
    assert.equal(cell.value, address < 8 ? 0xaa : 0xcc);
    assert.equal(cell.origin.kind, "event-write");
    const operation = device.operations.find(
      (item) => item.event_index === cell.origin.index,
    );
    assert.equal(operation.ppu_address, address);
    assert.equal(operation.write.status, "written");
  }
  assert.deepEqual(
    device.pattern_table.tiles[0].rows,
    Array.from({ length: 8 }, () => [3, 2, 1, 0, 3, 2, 1, 0]),
  );
  assert.deepEqual(
    device.pattern_table.source_pages,
    [0, 1024, 2048, 3072].map((address) => ({ kind: "chr-ram", address })),
  );
  assert.equal(
    device.final.read_buffer.sources[0].origin.index,
    device.final.chr_ram[1].origin.index,
  );
  const replay = (
    await call("trace-nes-mapper-events", {
      path,
      initial,
      initial_ppu: input.initial_ppu,
      ppu_pattern_table: 0,
      events: trace.mapper_trace.steps.map((item) => item.event),
    })
  ).trace;
  assert.deepEqual(replay, trace.mapper_trace);
  assert.deepEqual(
    (await call("explore-nes-code", input)).code_exploration.paths[0].trace,
    trace,
  );
}
async function ram({ call, base, bytes, save }) {
  const nvram = Buffer.from(bytes);
  nvram[10] = 0x70;
  const seed = (
    await call("trace-nes-code", {
      path: await save("vrc3-nvram.nes", nvram),
      initial,
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
  const legacy = Buffer.from(bytes);
  legacy[7] = 0x40;
  legacy[10] = 0;
  legacy[11] = 0;
  const unknown = (
    await call("trace-nes-code", {
      ...base,
      path: await save("vrc3-legacy.nes", legacy),
    })
  ).code_trace;
  assert.equal(unknown.status, "derived");
  assert.equal(unknown.stop.address, 0x6000);
  const invalid = Buffer.from(bytes);
  invalid[10] = 8;
  assert.equal(
    (
      await call("trace-nes-code", {
        path: await save("vrc3-ram16k.nes", invalid),
        initial,
      })
    ).code_trace.status,
    "unsupported",
  );
}
async function qualification({ call, path, bytes, save }) {
  const sub = Buffer.from(bytes);
  sub[8] = 16;
  assert.equal(
    (
      await call("trace-nes-mapper-writes", {
        path: await save("vrc3-submapper.nes", sub),
        initial,
        writes: [],
      })
    ).trace.status,
    "unsupported",
  );
  const ciram = (
    await call("trace-nes-mapper-events", {
      path,
      initial,
      initial_ppu: ppu,
      events: [
        { kind: "ppu-write", address: 0x2000, value: 0x37 },
        write(0xe000, 1),
        { kind: "ppu-read", address: 0x2400 },
      ],
    })
  ).trace;
  assert.equal(ciram.final_mapping.mirroring, "horizontal");
  assert.equal(ciram.steps[2].read_source.value, 0x37);
  const single = Buffer.concat([
    bytes.subarray(0, PRG),
    bytes.subarray(PRG + 7 * 16384),
  ]);
  single[4] = 1;
  const alias = (
    await call("trace-nes-mapper-writes", {
      path: await save("vrc3-single.nes", single),
      initial: { ...initial, prg_bank: 0xff },
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
  const small = Buffer.from(bytes.subarray(0, PRG + 65536));
  small[4] = 4;
  const partial = (
    await call("trace-nes-mapper-writes", {
      path: await save("vrc3-partial-logical.nes", small),
      initial: { ...initial, prg_bank: { mask: 3, value: 1 } },
      writes: [],
    })
  ).trace;
  assert.equal(partial.final_mapping.prg_windows[0].bank, 1);
  assert.equal(partial.final_mapping.prg_view, null);
}
