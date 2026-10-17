import assert from "node:assert/strict";
import {
  branchKinds,
  calls,
  MMC3_PRG,
} from "./verify-package-nes-discovery-branches-fixture.mjs";
import { nodesAt, stateOf } from "./verify-package-nes-discovery-graph.mjs";

const branchEdges = (graph, address) =>
  graph.edges.filter(
    (edge) =>
      graph.nodes[edge.from].address === address &&
      edge.kind.startsWith("branch-"),
  );
const analysesAt = (graph, address) =>
  graph.analyses.filter(
    (analysis) => graph.nodes[analysis.node_index].address === address,
  );
const readAt = (graph, address) =>
  graph.data_references.find(
    (read) =>
      graph.nodes[read.node_index].address === address && read.kind === "read",
  );

/** Edge conditions qualify candidates; analysis CPU outputs never choose a path. */
export function conditions(graph) {
  for (const edge of graph.edges) {
    const node = graph.nodes[edge.from],
      spec = branchKinds.find((item) => item.mnemonic === node.mnemonic),
      analysis = graph.analyses[edge.analysis_index];
    if (spec === undefined) {
      assert.equal(edge.condition, null);
      continue;
    }
    const value = edge.kind === "branch-taken" ? spec.when : !spec.when;
    assert.deepEqual(edge.condition, { flag: spec.flag, value });
    assert.ok(
      analysis.cpu_in[spec.flag] === null ||
        analysis.cpu_in[spec.flag] === value,
    );
    assert.deepEqual(analysis.cpu_out, analysis.cpu_in);
  }
  for (const analysis of graph.analyses) {
    const node = graph.nodes[analysis.node_index],
      spec = branchKinds.find((item) => item.mnemonic === node.mnemonic);
    if (spec === undefined) continue;
    const edges = graph.edges.filter(
      (edge) => edge.analysis_index === analysis.index,
    );
    assert.equal(edges.length, analysis.cpu_in[spec.flag] === null ? 2 : 1);
  }
}

export function vectors(graph, items) {
  assert.equal(graph.termination, "worklist-exhausted");
  for (const spec of items) {
    const node = nodesAt(graph, spec.address)[0];
    assert.ok(node);
    assert.equal(node.cpu_in[spec.flag], spec.source);
    const edges = branchEdges(graph, spec.address),
      kinds =
        spec.source === null
          ? ["branch-not-taken", "branch-taken"]
          : [spec.source === spec.when ? "branch-taken" : "branch-not-taken"];
    assert.deepEqual(edges.map((edge) => edge.kind).sort(), kinds.sort());
    for (const edge of edges) {
      const taken = edge.kind === "branch-taken",
        expected = spec.address + (taken ? 5 : 2),
        target = graph.nodes[edge.to];
      assert.equal(edge.target_address, expected);
      assert.equal(target.address, expected);
      assert.equal(target.cpu_in[spec.flag], taken ? spec.when : !spec.when);
      assert.equal(target.cpu_out.a, taken ? 0x22 : 0x11);
    }
    if (spec.source !== null)
      assert.equal(
        nodesAt(graph, spec.address + (spec.source === spec.when ? 2 : 5))
          .length,
        0,
      );
  }
}

export function partialFacts(graph) {
  assert.deepEqual(nodesAt(graph, 0x9004)[0].cpu_in.register_bits?.a, {
    mask: 128,
    value: 0,
  });
  assert.equal(nodesAt(graph, 0x9004)[0].cpu_in.z, null);
  assert.equal(nodesAt(graph, 0x9044)[0].cpu_in.n, null);
  assert.equal(nodesAt(graph, 0x9084)[0].cpu_in.z, false);
  assert.equal(nodesAt(graph, 0x9105)[0].cpu_in.c, null);
  assert.equal(nodesAt(graph, 0x9204)[0].cpu_in.a, 4);
  assert.equal(nodesAt(graph, 0x9244)[0].cpu_in.x, 5);
  assert.equal(nodesAt(graph, 0x9284)[0].cpu_in.y, 6);
  assert.equal(nodesAt(graph, 0x92c4)[0].cpu_in.a, null);
}

function relativeWriter(graph, read, address) {
  assert.equal(read.address, null);
  assert.deepEqual(read.ram_origins, []);
  assert.equal(read.relative_stack_origins.length, 1);
  for (const index of read.relative_stack_origins[0].writer_witness_indices) {
    const witness = graph.relative_stack_write_witnesses[index];
    assert.equal(graph.nodes[witness.node_index].address, address);
    assert.ok(
      witness.analysis_indices.every(
        (analysis) =>
          graph.analyses[analysis].node_index === witness.node_index,
      ),
    );
  }
}

export function stacks(graph) {
  const plp = readAt(graph, 0x9403);
  assert.ok(plp);
  assert.ok(typeof plp.value === "object" && plp.value !== null);
  assert.equal(plp.value.mask & 1, 1);
  assert.equal(plp.value.value & 1, 1);
  relativeWriter(graph, plp, 0x9401);
  const pla = readAt(graph, 0x9447);
  assert.ok(pla);
  assert.deepEqual(pla.value, { mask: 128, value: 0 });
  relativeWriter(graph, pla, 0x9444);
  relativeWriter(graph, readAt(graph, 0x94c7), 0x94c1);
  for (const address of [0x9488, 0x9547]) {
    const read = readAt(graph, address);
    assert.ok(read);
    assert.equal(read.value, null);
    assert.equal(read.address, null);
    assert.deepEqual(read.relative_stack_origins, []);
  }
  assert.ok(
    graph.data_references.some(
      (read) =>
        graph.nodes[read.node_index].address === 0x9505 &&
        read.kind === "write" &&
        read.address === null,
    ),
  );
}

export function returnedFlags(graph) {
  for (const spec of calls) {
    const binding = graph.continuations.find(
      (item) => graph.nodes[item.call_node_index].address === spec.call,
    );
    assert.ok(binding);
    const returned = graph.edges.find(
      (edge) =>
        edge.kind === "return" &&
        edge.continuation_index === binding.index &&
        edge.resolution === "resolved",
    );
    assert.ok(returned);
    const summary = graph.return_summaries[returned.summary_index];
    assert.equal(
      graph.nodes[summary.return_node_index].address,
      spec.calleeRts,
    );
    assert.equal(summary.cpu_out.c, spec.source);
    const branch = branchEdges(graph, spec.branch);
    assert.equal(branch.length, 1);
    assert.equal(branch[0].kind, "branch-taken");
    assert.deepEqual(branch[0].condition, { flag: "c", value: spec.when });
    const selectedJump = graph.nodes[branch[0].to],
      jump = graph.edges.find(
        (edge) => edge.from === selectedJump.index && edge.kind === "jump",
      ),
      target = graph.nodes[jump.to];
    assert.equal(target.address, spec.target);
    assert.equal(
      target.file_offsets[0],
      MMC3_PRG + spec.bank * 8192 + spec.target - 0x8000,
    );
    assert.equal(stateOf(graph, target).banks[6], spec.bank);
    assert.equal(target.cpu_out.a, spec.a);
    assert.equal(
      returned.target_invocation_index,
      binding.caller_invocation_index,
    );
  }
  const pairs = graph.continuations.filter((binding) =>
    [0xe201, 0xe241].includes(graph.nodes[binding.call_node_index].address),
  );
  assert.equal(
    new Set(pairs.map((binding) => binding.callee_invocation_index)).size,
    2,
  );
  assert.equal(
    nodesAt(graph, 0x8100).length,
    0,
    "Pruned path cannot seed the poisoned bank handler",
  );
}

export function joined(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.equal(nodesAt(graph, 0x9610)[0].cpu_in.c, null);
  const analyses = analysesAt(graph, 0x9610);
  assert.equal(analyses[0].cpu_in.c, false);
  assert.ok(analyses.some((analysis) => analysis.cpu_in.c === null));
  assert.deepEqual(
    graph.edges
      .filter((edge) => edge.analysis_index === analyses[0].index)
      .map((edge) => edge.kind),
    ["branch-taken"],
  );
  assert.ok(
    branchEdges(graph, 0x9610).some((edge) => edge.kind === "branch-not-taken"),
  );
  assert.equal(nodesAt(graph, 0x9612)[0].cpu_in.c, true);
  const zero = branchEdges(graph, 0x9663);
  assert.equal(zero.length, 2);
  assert.deepEqual(zero.map((edge) => edge.kind).sort(), [
    "branch-not-taken",
    "branch-taken",
  ]);
  assert.ok(zero.every((edge) => edge.target_address === 0x9665));
  assert.equal(new Set(zero.map((edge) => edge.to)).size, 1);
  assert.equal(nodesAt(graph, 0x9665)[0].cpu_in.c, null);
  for (const [address, flag, value] of [
    [0x9805, "c", true],
    [0x9810, "c", false],
  ]) {
    const edges = branchEdges(graph, address);
    assert.equal(edges.length, 1);
    assert.equal(edges[0].kind, "branch-not-taken");
    assert.equal(nodesAt(graph, address)[0].cpu_in[flag], value);
  }
  assert.equal(nodesAt(graph, 0x9820).length, 0);
}

export function wrapped(graph) {
  const edges = branchEdges(graph, 0xfffe);
  assert.equal(edges.length, 2, "One qualified edge in each root invocation");
  for (const edge of edges) {
    const analysis = graph.analyses[edge.analysis_index];
    assert.deepEqual(graph.nodes[edge.from].file_offsets, [
      16 + 32766,
      16 + 32767,
    ]);
    if (analysis.cpu_in.c === false) {
      assert.equal(edge.kind, "branch-taken");
      assert.equal(edge.target_address, 0xfff8);
      assert.equal(graph.nodes[edge.to].bytes_hex, "4cf8ff");
    } else {
      assert.equal(analysis.cpu_in.c, true);
      assert.equal(edge.kind, "branch-not-taken");
      assert.equal(edge.target_address, 0);
      assert.equal(edge.to, null);
      assert.ok(
        graph.frontiers.some(
          (item) =>
            item.invocation_index === edge.target_invocation_index &&
            item.address === 0,
        ),
      );
    }
  }
}

export function crossing(graph) {
  const nodes = nodesAt(graph, 0xbfff);
  assert.equal(nodes.length, 2);
  const actual = [];
  for (const node of nodes) {
    const bank = stateOf(graph, node).banks[7],
      edge = graph.edges.find(
        (edge) => edge.from === node.index && edge.kind === "branch-taken",
      );
    assert.equal(node.bytes_hex, "90fc");
    assert.deepEqual(node.file_offsets, [
      MMC3_PRG + bank * 8192 + 8191,
      MMC3_PRG + 49152,
    ]);
    assert.equal(edge.target_address, 0xbffd);
    assert.equal(edge.target_context_index, node.context_index);
    actual.push([bank, graph.nodes[edge.to].cpu_out.a]);
  }
  assert.deepEqual(
    actual.sort((a, b) => a[0] - b[0]),
    [
      [3, 0x43],
      [5, 0x55],
    ],
  );
}

export function serial(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.equal(nodesAt(graph, 0xc040).length, 0);
  const roots = graph.roots.map((root) => graph.contexts[root.context_index]);
  assert.deepEqual(
    roots.map((item) => item.state.shift_bits),
    [[0], [1]],
  );
  assert.deepEqual(roots[0].mapping.prg_windows, roots[1].mapping.prg_windows);
  const jumps = nodesAt(graph, 0xc017),
    actual = [];
  assert.equal(jumps.length, 2);
  for (const node of jumps) {
    const edge = graph.edges.find(
        (item) => item.from === node.index && item.kind === "jump",
      ),
      target = graph.nodes[edge.to],
      bank = stateOf(graph, target).prg_bank;
    assert.equal(edge.target_address, 0x8000);
    assert.deepEqual(stateOf(graph, target).shift_bits, []);
    actual.push([bank, target.file_offsets[0], target.cpu_out.a]);
  }
  assert.deepEqual(
    actual.sort((a, b) => a[0] - b[0]),
    [
      [0, 16, 0x11],
      [1, 16400, 0x22],
    ],
  );
}

export function budget(graph, limit) {
  assert.equal(graph.termination, "work-item-budget");
  assert.equal(graph.work_items_processed, limit);
  if (limit === 4) {
    assert.ok(graph.pending.some((item) => item.address === 0x961a));
    assert.ok(
      branchEdges(graph, 0x9610).every((edge) => edge.kind === "branch-taken"),
    );
    assert.equal(nodesAt(graph, 0x9612).length, 0);
  } else {
    assert.ok(graph.pending.some((item) => item.address === 0x9612));
    assert.ok(
      branchEdges(graph, 0x9610).some(
        (edge) => edge.kind === "branch-not-taken",
      ),
    );
    assert.equal(nodesAt(graph, 0x9612).length, 0);
  }
}
