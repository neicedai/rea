import assert from "node:assert/strict";
import { verifyThwaiteRamReread } from "./verify-nes-thwaite-ram-reread.mjs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  checkDiscoveryCoverage,
  checkDiscoveryWitnesses,
} from "./verify-package-nes-discovery-graph.mjs";

/** Author release bytes, independently located against the pinned source text. */
export const THWAITE_SEMANTIC_PROFILE = Object.freeze({
  version: "0.04",
  source_commit: "ccd27ccbe3e201755b86c1b5f932b2e11ba74110",
  source_url:
    "https://github.com/pinobatch/thwaite-nes/releases/download/v0.04/thwaite.nes",
  source_binary_bit_identical_build: "unknown",
  rom_sha256:
    "a2df24d9c9f72e56c2fdc4c703becc47a5700ad0158da8208247635ebeb3779c",
  rom_size: 24592,
  dispatch_address: 0xcda5,
  dispatch_offset: 3509,
  dispatch_hex: "a53c0aaabd86ea48bd85ea4860",
  table_address: 0xea85,
  table_offset: 10901,
  table_hex: "b1cdb2cd0ece71cec0ceffce7fcfc9cf",
  levels_address: 0xeaa6,
  levels_offset: 10934,
  levels_size: 280,
  levels_sha256:
    "f60226a9b67eba6a4d70314e0bb1b15e5eccf01c2cbe2d1d975d2ce7ab1f1ae2",
  known_branch_entry: 0xe729,
  known_branch_offset: 10041,
  known_branch_hex: "1890032c07206901",
  ram_reread_entry: 0xddeb,
  ram_reread_offset: 7675,
  ram_reread_hex: "a500c9029008a50209808502a500c50c909c",
});

const handlers = [
  ["doStateInactive", 0xcdb2, "60addb03c907d005a900853c"],
  ["doStateNewLevel", 0xcdb3, "addb03c907d005a900853c60"],
  ["doStateActive", 0xce0f, "adce030dd503d008a907853c"],
  ["doStateLevelReward", 0xce72, "a902cde203f0262003c6201e"],
  ["doStateRebuildSilo", 0xcec1, "addc03c904f005add803d02e"],
  ["doStateCutscene", 0xcf00, "eedc03addc03c9059071ace7"],
  ["doStateRebuildHouse", 0xcf80, "a904cde203f039a9008ddc03"],
  ["doStateGameOver", 0xcfca, "a901cde203f0118de203a932"],
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileOffset = (address) => 16 + (address & 16383);
const sorted = (values) => [...new Set(values)].sort((a, b) => a - b);

function qualifyOriginal(bytes) {
  const profile = THWAITE_SEMANTIC_PROFILE;
  assert.equal(bytes.length, profile.rom_size);
  assert.equal(sha256(bytes), profile.rom_sha256);
  assert.equal(
    bytes.subarray(0, 16).toString("hex"),
    "4e45531a010101000000000000000000",
  );
  for (const [offset, hex] of [
    [profile.dispatch_offset, profile.dispatch_hex],
    [profile.table_offset, profile.table_hex],
    [profile.ram_reread_offset, profile.ram_reread_hex],
  ])
    assert.equal(
      bytes.subarray(offset, offset + hex.length / 2).toString("hex"),
      hex,
    );
  assert.equal(
    sha256(
      bytes.subarray(
        profile.levels_offset,
        profile.levels_offset + profile.levels_size,
      ),
    ),
    profile.levels_sha256,
  );
  assert.equal(
    bytes.subarray(10041, 10049).toString("hex"),
    profile.known_branch_hex,
  );
  assert.deepEqual(
    [...bytes.subarray(10934, 10942)],
    [16, 10, 50, 0, 1, 1, 2, 2],
  );
  assert.deepEqual(
    [...bytes.subarray(10998, 11006)],
    [64, 15, 30, 0, 1, 1, 2, 2],
  );
  assert.deepEqual(
    [...bytes.subarray(11206, 11214)],
    [40, 35, 20, 0, 9, 4, 5, 8],
  );
  for (const [state, [, target, hex]] of handlers.entries()) {
    assert.equal(
      bytes.readUInt16LE(profile.table_offset + state * 2) + 1,
      target,
    );
    assert.equal(
      bytes
        .subarray(fileOffset(target), fileOffset(target) + hex.length / 2)
        .toString("hex"),
      hex,
    );
  }
}

function selector(graph, partitionIndex) {
  const choices = graph.partitions[partitionIndex].selections.filter(
    (choice) =>
      graph.nodes[choice.node_index].address === 0xcda9 &&
      choice.register === "x",
  );
  assert.equal(choices.length, 1);
  return choices[0].value;
}

function checkDispatch(graph, bytes) {
  const refined = graph.analyses.filter(
    (analysis) =>
      graph.nodes[analysis.node_index].address === 0xcda9 &&
      analysis.refinement !== null,
  );
  assert.deepEqual(
    sorted(refined.map((analysis) => analysis.refinement.value)),
    Array.from({ length: 128 }, (_, index) => index * 2),
    "The original ASL establishes all 128 even indices; source table length does not constrain discovery",
  );
  for (const analysis of refined) {
    assert.equal(analysis.refinement.register, "x");
    assert.deepEqual(analysis.refinement.source_value, { mask: 1, value: 0 });
  }
  const dispatchEdges = graph.edges.filter(
    (edge) =>
      graph.nodes[edge.from].address === 0xcdb1 &&
      edge.kind === "stack-jump" &&
      edge.resolution === "resolved",
  );
  for (const [state, [label, target]] of handlers.entries()) {
    const edge = dispatchEdges.find(
      (item) => selector(graph, item.target_partition_index) === state * 2,
    );
    assert.ok(edge, `Original ${label} edge`);
    assert.equal(edge.target_address, target);
    assert.equal(edge.continuation_index, null);
    assert.equal(edge.summary_index, null);
    assert.equal(
      edge.target_invocation_index,
      graph.nodes[edge.from].invocation_index,
    );
    assert.notEqual(edge.to, null);
    assert.equal(graph.nodes[edge.to].file_offsets[0], fileOffset(target));
    assert.equal(graph.analyses[edge.analysis_index].cpu_in.sp, null);
    for (const [site, base] of [
      [0xcda9, 0xea86],
      [0xcdad, 0xea85],
    ]) {
      const reads = graph.data_references.filter(
        (read) =>
          graph.nodes[read.node_index].address === site &&
          read.kind === "read" &&
          selector(
            graph,
            graph.analyses[read.analysis_index].partition_index,
          ) ===
            state * 2,
      );
      assert.ok(reads.length > 0);
      for (const read of reads) {
        assert.equal(read.address, base + state * 2);
        assert.deepEqual(read.file_offsets, [fileOffset(base + state * 2)]);
        assert.equal(read.value, bytes[fileOffset(base + state * 2)]);
      }
    }
    const reads = graph.data_references.filter(
      (read) =>
        read.analysis_index === edge.analysis_index && read.kind === "read",
    );
    assert.deepEqual(
      reads.map((read) => read.value),
      [bytes[10901 + state * 2], bytes[10902 + state * 2]],
    );
    for (const [index, read] of reads.entries()) {
      assert.equal(read.address, null);
      assert.deepEqual(read.ram_origins, []);
      assert.deepEqual(read.file_offsets, []);
      assert.equal(read.relative_stack_origins.length, 1);
      const origin = read.relative_stack_origins[0];
      assert.equal(origin.offset, 0);
      assert.ok(origin.writer_witness_indices.length > 0);
      for (const witnessIndex of origin.writer_witness_indices) {
        const witness = graph.relative_stack_write_witnesses[witnessIndex];
        assert.equal(
          graph.nodes[witness.node_index].address,
          index === 0 ? 0xcdb0 : 0xcdac,
        );
        assert.equal(witness.value, read.value);
        assert.ok(
          witness.analysis_indices.some(
            (analysisIndex) =>
              selector(graph, graph.analyses[analysisIndex].partition_index) ===
              state * 2,
          ),
        );
      }
    }
  }
}

async function verifyKnownBranch(invoke, romPath, bytes) {
  const evidence = await invoke("discover-nes-code", {
      path: romPath,
      initial: { mapper: 0 },
      roots: [0xe729],
      max_work_items: 2,
    }),
    report = evidence.normalized_result,
    graph = report.code_discovery;
  assert.equal(
    evidence.subject.digest.sha256,
    THWAITE_SEMANTIC_PROFILE.rom_sha256,
  );
  assert.equal(report.artifact.path, romPath);
  assert.deepEqual(report.header.header, [...bytes.subarray(0, 16)]);
  assert.equal(graph.status, "derived");
  checkDiscoveryCoverage(graph, bytes, 16, 16384);
  checkDiscoveryWitnesses(graph);
  assert.equal(graph.termination, "work-item-budget");
  assert.equal(graph.work_items_processed, 2);
  assert.equal(graph.coverage.decoded_bytes, 3);
  const clc = graph.nodes.find((node) => node.address === 0xe729),
    bcc = graph.nodes.find((node) => node.address === 0xe72a);
  assert.ok(clc && bcc);
  assert.equal(clc.bytes_hex, "18");
  assert.deepEqual(clc.file_offsets, [10041]);
  assert.equal(clc.cpu_out.c, false);
  assert.equal(bcc.bytes_hex, "9003");
  assert.deepEqual(bcc.file_offsets, [10042, 10043]);
  assert.equal(bcc.cpu_in.c, false);
  const edges = graph.edges.filter((edge) => edge.from === bcc.index);
  assert.equal(edges.length, 1);
  assert.equal(edges[0].kind, "branch-taken");
  assert.deepEqual(edges[0].condition, { flag: "c", value: false });
  assert.equal(edges[0].target_address, 0xe72f);
  assert.equal(
    edges[0].to,
    null,
    "Two examined instructions retain the target as pending",
  );
  assert.ok(graph.pending.some((item) => item.address === 0xe72f));
  assert.equal(
    graph.nodes.some((node) => node.address === 0xe72c),
    false,
  );
  return {
    evidence_id: evidence.evidence_id,
    entry: 0xe729,
    branch_address: 0xe72a,
    target: 0xe72f,
    condition: { flag: "c", value: false },
    source:
      "Pinned author cutscene.s CLC/BCC afterwrite and matching original-ROM bytes",
    termination: graph.termination,
    pending_target: 0xe72f,
  };
}

/** Explicit opt-in original-ROM semantic golden; never downloads, patches or executes a ROM. */
export async function verifyNesThwaiteSemantics(invoke, romPath) {
  const bytes = await readFile(romPath);
  qualifyOriginal(bytes);
  const input = {
      path: romPath,
      initial: { mapper: 0 },
      roots: [0xcda5],
      max_work_items: 4000,
    },
    evidence = await invoke("discover-nes-code", input),
    report = evidence.normalized_result,
    graph = report.code_discovery;
  assert.equal(
    evidence.subject.digest.sha256,
    THWAITE_SEMANTIC_PROFILE.rom_sha256,
  );
  assert.equal(report.artifact.path, romPath);
  assert.deepEqual(report.header.header, [...bytes.subarray(0, 16)]);
  assert.equal(graph.status, "derived");
  checkDiscoveryCoverage(graph, bytes, 16, 16384);
  checkDiscoveryWitnesses(graph);
  checkDispatch(graph, bytes);
  const knownBranch = await verifyKnownBranch(invoke, romPath, bytes);
  const ramReread = await verifyThwaiteRamReread(
    invoke,
    romPath,
    bytes,
    THWAITE_SEMANTIC_PROFILE.rom_sha256,
  );
  assert.deepEqual(await readFile(romPath), bytes);
  return {
    ok: true,
    workflows: 3,
    profile: THWAITE_SEMANTIC_PROFILE,
    evidence_id: evidence.evidence_id,
    selector_domain: 128,
    verified_source_handlers: handlers.map(([source_label, target], state) => ({
      state,
      selector: state * 2,
      source_label,
      target,
      file_offset: fileOffset(target),
    })),
    level_records: 35,
    known_branch: knownBranch,
    ram_reread: ramReread,
    termination: graph.termination,
    work_items_processed: graph.work_items_processed,
    pending_items:
      graph.pending.length +
      graph.pending_refinements.length +
      graph.pending_returns.length,
    original_unchanged: true,
    scope:
      "Original author ROM and independently verified source/byte correspondences for doStateAction, eight state labels, level data, a known branch and explosion rowNum RAM conditioning across an independent attribute write; all 128 dispatch CPU-compatible indices remain analyzed. No bit-identical build, path feasibility, gameplay execution or whole-game completeness claim",
  };
}
