import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyPackageEeprom } from "./verify-package-nes-eeprom.mjs";

/** Independent installed-artifact oracle; does not import source-domain fixtures or planners. */
export async function verifyPackageBandai(invoke, workspace) {
  await verifyPackageEeprom(invoke, workspace);
  for (const [mapper, variant, submapper, nvram] of [
    [16, "fcg", 4, 0],
    [16, "lz93d50", 5, 0x20],
    [159, "lz93d50", 0, 0x10],
  ])
    for (const version of ["nes2", "ines", "nes2-zero"]) {
      const bytes = Buffer.alloc(528 + 65536 + 262144, 2);
      bytes.fill(0, 0, 16);
      bytes.set([
        0x4e,
        0x45,
        0x53,
        0x1a,
        4,
        32,
        ((mapper & 15) << 4) | 4 | (nvram ? 2 : 0),
        (mapper & 0xf0) | (version === "ines" ? 0 : 8),
        version === "nes2" ? submapper << 4 : 0,
        0,
        version === "ines" ? 0 : nvram,
      ]);
      const base = variant === "fcg" ? 0x6000 : 0x8000,
        other = variant === "fcg" ? 0x8000 : 0x6000,
        chr = [128, 145, 162, 179, 196, 213, 230, 255];
      const writes = [
        [other + 8, 3],
        [base + 8, 0xf1],
        ...chr.map((b, i) => [base + i, b]),
        [base + 9, 3],
        [base + 13, 0x60],
      ];
      bytes.set(
        [
          ...writes.flatMap(([a, v]) => [0xa9, v, 0x8d, a & 255, a >> 8]),
          0x4c,
          0xff,
          0xbf,
        ],
        528 + 3 * 16384 + 0x100,
      );
      bytes[528 + 2 * 16384 - 1] = 0xa9;
      bytes.set([0x5a, 0x4c, 0x10, 0x80], 528 + 3 * 16384);
      bytes.set([0xa9, 0x77, 0x60], 528 + 16384 + 16);
      bytes.writeUInt16LE(0xc100, 528 + 65536 - 4);
      const path = join(
          workspace,
          `packaged-bandai-${mapper}-${variant}-${version}.nes`,
        ),
        initial = { mapper, ...(mapper === 16 ? { variant } : {}) },
        input = { path, initial };
      await writeFile(path, bytes);
      const evidence = await invoke("trace-nes-code", input),
        trace = evidence.normalized_result.code_trace;
      assert.equal(
        evidence.normalized_result.artifact.sha256,
        createHash("sha256").update(bytes).digest("hex"),
      );
      assert.deepEqual(evidence.normalized_result.header.header, [
        ...bytes.subarray(0, 16),
      ]);
      assert.equal(trace.status, "derived");
      assert.equal(trace.stop.reason, "return");
      assert.equal(trace.final_cpu.a, 0x77);
      assert.deepEqual(
        trace.instructions.find((i) => i.address === 0xbfff).file_offsets,
        [528 + 2 * 16384 - 1, 528 + 3 * 16384],
      );
      for (const instruction of trace.instructions)
        for (const [i, offset] of instruction.file_offsets.entries()) {
          assert.notEqual(offset, null);
          assert.equal(
            bytes[offset],
            Buffer.from(instruction.bytes_hex, "hex")[i],
          );
        }
      assert.deepEqual(
        trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
        [1, 3],
      );
      assert.deepEqual(
        trace.mapper_trace.final_mapping.chr_windows.map((w) => w.bank),
        chr,
      );
      assert.equal(
        trace.mapper_trace.final.eeprom_control,
        variant === "fcg" ? null : 0x60,
      );
      if (mapper === 16)
        assert.ok(
          trace.mapper_trace.nes_prg_views.every((v) => v.variant === variant),
        );
      const replay = await invoke("trace-nes-mapper-writes", {
        ...input,
        writes: trace.instructions.flatMap((i) => i.writes),
      });
      assert.deepEqual(
        replay.normalized_result.trace.final,
        trace.mapper_trace.final,
      );
      assert.deepEqual(
        replay.normalized_result.trace.final_mapping,
        trace.mapper_trace.final_mapping,
      );
      const explored = await invoke("explore-nes-code", input);
      assert.deepEqual(
        explored.normalized_result.code_exploration.paths[0].trace,
        trace,
      );
      const resumed = await invoke("trace-nes-code", {
        path,
        initial: trace.mapper_trace.final,
        entry: 0x8010,
      });
      assert.equal(resumed.normalized_result.code_trace.final_cpu.a, 0x77);
      assert.equal(resumed.normalized_result.code_trace.stop.reason, "return");
      const irq = await invoke("trace-nes-mapper-events", {
        ...input,
        initial_irq: {
          model: variant === "fcg" ? "bandai-fcg" : "bandai-lz93d50",
        },
        events: [
          { kind: "cpu-write", address: base + 11, value: 1 },
          { kind: "cpu-write", address: base + 12, value: 0 },
          { kind: "cpu-write", address: base + 10, value: 1 },
          { kind: "ppu-read", address: 0 },
          { kind: "bandai-cpu-cycle" },
          { kind: "bandai-cpu-cycle" },
        ],
      });
      assert.equal(irq.normalized_result.trace.steps[3].irq.counter_low, 1);
      assert.deepEqual(irq.normalized_result.trace.final_irq, {
        model: variant === "fcg" ? "bandai-fcg" : "bandai-lz93d50",
        counter_low: 255,
        counter_high: 255,
        asserted: true,
      });
      const seeded = await invoke("trace-nes-code", {
        ...input,
        initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x60 }],
      });
      assert.equal(seeded.normalized_result.code_trace.status, "unsupported");
      assert.deepEqual(await readFile(path), bytes);
    }
}
