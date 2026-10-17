import assert from "node:assert/strict";
import {
  nodesAt,
  edgesFrom,
  stateOf,
} from "./verify-package-nes-discovery-graph.mjs";

const readsAt = (graph, address) =>
  graph.data_references.filter(
    (reference) =>
      graph.nodes[reference.node_index].address === address &&
      reference.kind === "read",
  );
const analysesAt = (graph, address) =>
  graph.analyses.filter(
    (analysis) => graph.nodes[analysis.node_index].address === address,
  );
const relativeCell = (graph, snapshot, offset) => {
  const page = snapshot[offset >> 5];
  return page === null
    ? undefined
    : graph.relative_stack_pages[page].cells.find(
        (cell) => cell.offset === (offset & 31),
      );
};
const writerAddresses = (graph, origin) =>
  origin.writer_witness_indices
    .map(
      (index) =>
        graph.nodes[graph.relative_stack_write_witnesses[index].node_index]
          .address,
    )
    .sort((a, b) => a - b);

export function relativeWitnesses(graph) {
  for (const analysis of graph.analyses) {
    assert.equal(analysis.relative_stack_in.length, 8);
    assert.equal(analysis.relative_stack_out.length, 8);
  }
  for (const reference of graph.data_references)
    for (const origin of reference.relative_stack_origins) {
      assert.deepEqual(reference.file_offsets, []);
      const witnesses = origin.writer_witness_indices.map(
        (index) => graph.relative_stack_write_witnesses[index],
      );
      assert.deepEqual(
        [...new Set(witnesses.map((item) => item.node_index))].sort(
          (a, b) => a - b,
        ),
        origin.writer_nodes,
      );
      for (const witness of witnesses)
        assert.ok(
          witness.analysis_indices.every(
            (index) => graph.analyses[index].node_index === witness.node_index,
          ),
        );
    }
  for (const reference of graph.data_references) {
    const node = graph.nodes[reference.node_index],
      analysis = graph.analyses[reference.analysis_index];
    if (
      ["PHA", "PHP", "PLA", "PLP", "RTS", "JSR"].includes(node.mnemonic) &&
      analysis.cpu_in.sp === null &&
      (reference.kind === "read" || reference.kind === "write")
    ) {
      assert.equal(
        reference.address,
        null,
        "Unknown-SP bytes have relative locations, not invented physical RAM addresses",
      );
      assert.deepEqual(reference.ram_origins, []);
      assert.deepEqual(reference.file_offsets, []);
    }
  }
}

function jump(graph, from, target, kind = "stack-jump") {
  const node = nodesAt(graph, from)[0];
  assert.ok(node);
  const edge = edgesFrom(graph, node, kind).find(
    (edge) => edge.resolution === "resolved",
  );
  assert.ok(edge, `Resolved ${kind} at ${from.toString(16)}`);
  assert.equal(edge.target_address, target);
  assert.equal(edge.target_invocation_index, node.invocation_index);
  assert.equal(edge.continuation_index, null);
  assert.equal(edge.summary_index, null);
  assert.notEqual(edge.to, null);
  return { node, edge, target: graph.nodes[edge.to] };
}

function matched(graph, callAddress, target) {
  const binding = graph.continuations.find(
    (item) => graph.nodes[item.call_node_index].address === callAddress,
  );
  assert.ok(binding);
  const edge = graph.edges.find(
    (edge) =>
      edge.kind === "return" &&
      edge.resolution === "resolved" &&
      edge.continuation_index === binding.index,
  );
  assert.ok(edge);
  const summary = graph.return_summaries[edge.summary_index];
  assert.equal(edge.target_address, target);
  assert.equal(edge.target_invocation_index, binding.caller_invocation_index);
  assert.equal(summary.invocation_index, binding.callee_invocation_index);
  assert.equal(summary.stack_target, target);
  assert.equal(summary.return_proof, "relative-bytes");
  assert.equal(summary.cpu_out.sp, null);
  return { summary, binding, edge };
}

function stackReadValues(graph, address, values, writers) {
  const reads = readsAt(graph, address);
  assert.deepEqual(
    reads.map((item) => item.value),
    values,
  );
  for (const [index, read] of reads.entries()) {
    assert.equal(read.relative_stack_origins.length, 1);
    assert.equal(read.relative_stack_origins[0].offset, 0);
    assert.deepEqual(writerAddresses(graph, read.relative_stack_origins[0]), [
      writers[index],
    ]);
  }
}

export function direct(graph) {
  const transfer = jump(graph, 0xe006, 0xe200);
  assert.equal(transfer.target.file_offsets[0], 528 + 57344 + 0x200);
  assert.equal(transfer.target.cpu_in.sp, null);
  stackReadValues(graph, 0xe006, [0xff, 0xe1], [0xe005, 0xe002]);
  assert.equal(nodesAt(graph, 0xe200)[0].cpu_out.a, 0x53);
  assert.ok(
    graph.frontiers.some(
      (item) => item.from !== null && graph.nodes[item.from].address === 0xe202,
    ),
  );
  assert.deepEqual(graph.return_summaries, []);
}

export function caller(graph) {
  jump(graph, 0xe086, 0xe200);
  stackReadValues(graph, 0xe086, [0xff, 0xe1], [0xe085, 0xe082]);
  const { summary, binding } = matched(graph, 0xe040, 0xe043);
  assert.equal(graph.nodes[summary.return_node_index].address, 0xe202);
  assert.equal(summary.cpu_out.a, 0x53);
  stackReadValues(graph, 0xe202, [0x42, 0xe0], [0xe040, 0xe040]);
  assert.equal(
    graph.invocations[binding.callee_invocation_index].frame.kind,
    "opaque",
  );
  assert.ok(analysesAt(graph, 0xe043).some((item) => item.cpu_in.a === 0x53));
  assert.ok(
    !graph.write_witnesses.some(
      (item) => item.address >= 256 && item.address < 512,
    ),
  );
}

export function partialCopy(graph) {
  const read = readsAt(graph, 0xe109)[0];
  assert.ok(read);
  assert.deepEqual(read.value, { mask: 254, value: 128 });
  assert.deepEqual(
    writerAddresses(graph, read.relative_stack_origins[0]),
    [0xe106],
  );
  const copied = analysesAt(graph, 0xe10b)[0];
  assert.deepEqual(copied.cpu_out.register_bits.a, { mask: 254, value: 128 });
  assert.equal(analysesAt(graph, 0xe10c)[0].cpu_out.a, 128);
  const mapped = jump(graph, 0xe111, 0x8000, "jump");
  assert.equal(stateOf(graph, mapped.target).banks[6], 128);
  assert.equal(mapped.target.file_offsets[0], 528);
  const pushed = analysesAt(graph, 0xe106)[0];
  assert.deepEqual(relativeCell(graph, pushed.relative_stack_out, 1).value, {
    mask: 254,
    value: 128,
  });
}

export function nested(graph) {
  const inner = matched(graph, 0xe283, 0xe286),
    outer = matched(graph, 0xe240, 0xe243);
  assert.equal(inner.summary.cpu_out.a, 0x99);
  assert.equal(outer.summary.cpu_out.a, 0x42);
  stackReadValues(graph, 0xe2c5, [0x99], [0xe2c2]);
  stackReadValues(graph, 0xe286, [0x42], [0xe282]);
  assert.notEqual(
    inner.binding.callee_invocation_index,
    outer.binding.callee_invocation_index,
  );
}

export function joined(graph) {
  const reads = readsAt(graph, 0xe34d),
    joined = reads.find(
      (item) => typeof item.value === "object" && item.value !== null,
    );
  assert.ok(joined);
  assert.deepEqual(joined.value, { mask: 254, value: 66 });
  assert.deepEqual(
    writerAddresses(graph, joined.relative_stack_origins[0]),
    [0xe346, 0xe34c],
  );
  assert.ok(analysesAt(graph, 0xe34e).some((item) => item.cpu_out.a === 0x42));
}

export function wrap(graph) {
  const transfer = jump(graph, 0xe502, 0xaaab),
    analysis = analysesAt(graph, 0xe502)[0];
  assert.equal(analysis.cpu_in.sp, null);
  assert.equal(transfer.target.file_offsets[0], 528 + 24576 + 0xaab);
  stackReadValues(graph, 0xe502, [0xaa, 0xaa], [0xe501, 0xe500]);
  for (let offset = 0; offset < 256; offset++) {
    const cell = relativeCell(graph, analysis.relative_stack_in, offset);
    assert.ok(cell, `Complete stack ring slot ${offset}`);
    assert.equal(cell.value, 0xaa);
    assert.deepEqual(
      cell.writer_witness_indices.map(
        (index) =>
          graph.nodes[graph.relative_stack_write_witnesses[index].node_index]
            .address,
      ),
      [0xe402 + ((256 - offset) & 255)],
    );
  }
  const binding = graph.continuations.find(
    (item) => graph.nodes[item.call_node_index].address === 0xe540,
  );
  assert.ok(binding);
  assert.ok(
    !graph.edges.some(
      (item) =>
        item.kind === "return" && item.continuation_index === binding.index,
    ),
  );
  assert.equal(nodesAt(graph, 0xe543).length, 0);
}

export function unresolved(graph, rts) {
  const node = nodesAt(graph, rts)[0];
  assert.ok(node);
  assert.ok(graph.frontiers.some((item) => item.from === node.index));
  assert.ok(
    !graph.edges.some(
      (item) => item.from === node.index && item.resolution === "resolved",
    ),
  );
  assert.equal(nodesAt(graph, 0xe200).length, 0);
}

export function nonstack(graph) {
  jump(graph, 0xe6ca, 0xe200);
  stackReadValues(graph, 0xe6ca, [0xff, 0xe1], [0xe6c5, 0xe6c2]);
  const store = graph.data_references.find(
    (item) =>
      graph.nodes[item.node_index].address === 0xe6c8 && item.kind === "write",
  );
  assert.ok(store);
  assert.equal(store.address, 0x20);
  assert.equal(store.value, null);
}

export function rebase(graph) {
  const read = readsAt(graph, 0xe74b)[0];
  assert.equal(read.address, 0x1fd);
  assert.equal(read.value, 0x53);
  assert.deepEqual(
    writerAddresses(graph, read.relative_stack_origins[0]),
    [0xe745],
  );
  assert.deepEqual(
    read.ram_origins[0].writer_nodes.map((index) => graph.nodes[index].address),
    [0xe745],
  );
  const analysis = analysesAt(graph, 0xe74b)[0];
  assert.equal(analysis.cpu_out.sp, 0xfd);
  assert.equal(analysis.cpu_out.a, 0x53);
}

export function physical(graph) {
  jump(graph, 0xe086, 0xe200);
  const reads = readsAt(graph, 0xe202);
  assert.deepEqual(
    reads.map((item) => [item.address, item.value]),
    [
      [0x1ff, 0x85],
      [0x100, 0xe5],
    ],
  );
  assert.deepEqual(
    reads.map((item) =>
      item.ram_origins[0].writer_nodes.map(
        (index) => graph.nodes[index].address,
      ),
    ),
    [[0xe583], [0xe583]],
  );
  assert.equal(analysesAt(graph, 0xe202)[0].cpu_out.sp, 0);
  const summary = graph.return_summaries.find(
    (item) => item.stack_target === 0xe586,
  );
  assert.ok(summary);
  assert.equal(summary.return_proof, "physical-bytes");
  assert.equal(summary.cpu_out.a, 0x53);
}

export function status(graph) {
  const read = readsAt(graph, 0xe783)[0];
  assert.ok(typeof read.value === "object" && read.value !== null);
  assert.equal(read.value.mask & 0x31, 0x31);
  assert.equal(read.value.value & 0x31, 0x31);
  assert.deepEqual(
    writerAddresses(graph, read.relative_stack_origins[0]),
    [0xe781],
  );
  assert.equal(analysesAt(graph, 0xe783)[0].cpu_out.c, true);
  const branch = graph.edges.filter(
    (item) => graph.nodes[item.from].address === 0xe784,
  );
  assert.deepEqual(
    branch.map((item) => [item.kind, item.target_address]),
    [["branch-taken", 0xe788]],
    "The restored carry byte excludes the incompatible BCS successor",
  );
  assert.deepEqual(branch[0].condition, { flag: "c", value: true });
  assert.equal(nodesAt(graph, 0xe788)[0].cpu_out.a, 0x77);
  assert.equal(nodesAt(graph, 0xe786).length, 0);
}

export function partialTarget(graph) {
  unresolved(graph, 0xe7c8);
  stackReadValues(
    graph,
    0xe7c8,
    [{ mask: 254, value: 254 }, 0xea],
    [0xe7c7, 0xe7c2],
  );
}

export function budget(graph) {
  assert.equal(graph.termination, "work-item-budget");
  assert.equal(graph.work_items_processed, 130);
  assert.ok(graph.pending.some((item) => item.address === 0xe482));
  assert.equal(nodesAt(graph, 0xe502).length, 0);
  assert.equal(nodesAt(graph, 0xaaab).length, 0);
  const last = graph.analyses.at(-1);
  let cells = 0;
  for (let offset = 0; offset < 256; offset++)
    if (relativeCell(graph, last.relative_stack_out, offset) !== undefined)
      cells++;
  assert.equal(
    cells,
    130,
    "Committed pushes retain the two earlier actual JSR bytes and 128 authored pushes",
  );
}
