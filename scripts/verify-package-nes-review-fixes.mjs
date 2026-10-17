import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { apu } from "./verify-package-nes-dmc-source-fixture.mjs";

/** Literal authored register writes and code; no production mapper imports. */
export async function verifyPackageNesReviewFixes(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 65536 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0x50, 0x40]);
  const path = join(workspace, "review-fme7-many-views.nes"),
    digest = createHash("sha256").update(bytes).digest("hex"),
    initial = {
      mapper: 69,
      variant: "fme7",
      bank_6000: 0,
      prg_banks: [0, 0, 0],
    },
    writes = [];
  let previous = [0, 0, 0];
  for (let state = 1; state <= 8192; state++) {
    const next = [state & 63, (state >> 6) & 63, state >> 12];
    for (let register = 0; register < 3; register++) {
      if (previous[register] === next[register]) continue;
      writes.push(
        { address: 0x8000, value: 9 + register },
        { address: 0xa000, value: next[register] },
      );
    }
    previous = next;
  }
  assert.equal(writes.length, 16644);
  const expectedViews = Array.from({ length: 8193 }, (_, state) => ({
    mapper: 69,
    variant: "fme7",
    lower_window: { source: "rom", bank: 0 },
    prg_bank_0: state & 63,
    prg_bank_1: (state >> 6) & 63,
    prg_bank_2: state >> 12,
  })).sort(
    (left, right) =>
      left.prg_bank_0 - right.prg_bank_0 ||
      left.prg_bank_1 - right.prg_bank_1 ||
      left.prg_bank_2 - right.prg_bank_2,
  );
  await writeFile(path, bytes);
  for (const command of [
    "trace-nes-mapper-writes",
    "trace-nes-mapper-events",
  ]) {
    const input = {
      path,
      initial,
      max_steps: writes.length,
      ...(command === "trace-nes-mapper-writes"
        ? { writes }
        : { events: writes.map((write) => ({ kind: "cpu-write", ...write })) }),
    };
    const evidence = await invoke(command, input),
      trace = evidence.normalized_result.trace;
    assert.equal(evidence.subject.digest.sha256, digest);
    assert.equal(evidence.normalized_result.artifact.path, path);
    assert.deepEqual(evidence.normalized_result.header.header, [
      ...bytes.subarray(0, 16),
    ]);
    assert.equal(trace.status, "derived");
    assert.equal(trace.steps.length, 16644);
    assert.deepEqual(trace.nes_prg_views, expectedViews);
    assert.deepEqual(trace.final.prg_banks, [0, 0, 2]);
    for (const [index, step] of trace.steps.entries()) {
      assert.equal(step.index, index);
      assert.deepEqual(
        command === "trace-nes-mapper-writes" ? step.write : step.event,
        command === "trace-nes-mapper-writes"
          ? { ...writes[index], preceded_by_cpu_write: null }
          : {
              kind: "cpu-write",
              ...writes[index],
              preceded_by_cpu_write: null,
            },
      );
    }
    assert.equal(
      command === "trace-nes-mapper-writes"
        ? trace.coverage.processed_writes
        : trace.coverage.processed_events,
      16644,
    );
  }
  assert.deepEqual(await readFile(path), bytes);
  await dmaFrontier(invoke, workspace, "oam");
  await dmaFrontier(invoke, workspace, "dmc");
  return {
    ok: true,
    workflows: 4,
    supplied_writes: 16644,
    complete_fme7_views: 8193,
    complete_event_views: true,
    oam_budget_views: true,
    dmc_budget_views: true,
    original_unchanged: true,
    scope:
      "Authored supplied-write/event replay and static MMC3 DMA-budget frontiers. No observed execution, real game, external analysis provider or hardware timing claim; cancellation is checked separately at the application boundary.",
  };
}

async function dmaFrontier(invoke, workspace, kind) {
  const bytes = Buffer.alloc(16 + 65536 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0x40, 8]);
  bytes.set(
    [
      0xa9,
      6,
      0x8d,
      0,
      0x80,
      0xa9,
      2,
      0x8d,
      1,
      0x80,
      0xa9,
      kind === "oam" ? 0x82 : 0x10,
      0x8d,
      kind === "oam" ? 0x14 : 0x15,
      0x40,
      0xea,
    ],
    16 + 7 * 8192,
  );
  const path = join(workspace, `review-mmc3-${kind}-frontier.nes`),
    digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes);
  const evidence = await invoke("explore-nes-code", {
    path,
    initial: {
      mapper: 4,
      bank_select: 6,
      banks: [null, null, null, null, null, null, 0, 1],
    },
    entry: 0xe000,
    max_instructions: 16,
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: 0,
    },
    ...(kind === "oam"
      ? {
          initial_cpu_dma: {
            model: "oam-cpu-dma",
            region: "ntsc",
            cpu_phase: "get",
          },
          initial_ppu: {
            model: "ppu-memory",
            register_writes_enabled: true,
            access_phase: "non-rendering",
            dma_reads: "absent",
            chr_ram_size: null,
            nametable_layout: "ciram-2k",
            control: 0,
            mask: 0,
            oam: {
              model: "oam-memory",
              address: 0,
              retention: "stable",
              reads: "supported",
              address_writes: "uncorrupted",
              dma_pending: { status: "none" },
            },
          },
          max_oam_dma_source_bytes: 0,
        }
      : { initial_apu: apu(), max_dmc_dma_source_bytes: 0 }),
  });
  assert.equal(evidence.subject.digest.sha256, digest);
  const exploration = evidence.normalized_result.code_exploration;
  assert.equal(exploration.status, "derived");
  assert.equal(exploration.termination, `${kind}-dma-source-budget`);
  assert.equal(exploration.paths.length, 1);
  const trace = exploration.paths[0].trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, `${kind}-dma-source-budget`);
  assert.equal(trace.mapper_trace.status, "derived");
  assert.deepEqual(exploration.nes_prg_views, [
    { mapper: 4, prg_mode: 0, r6: 0, r7: 1 },
    { mapper: 4, prg_mode: 0, r6: 2, r7: 1 },
  ]);
  assert.deepEqual(exploration.nes_prg_views, trace.mapper_trace.nes_prg_views);
  assert.deepEqual(await readFile(path), bytes);
}
