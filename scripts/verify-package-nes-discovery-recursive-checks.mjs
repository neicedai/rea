import assert from "node:assert/strict";
import { addresses } from "./verify-package-nes-discovery-returns-fixture.mjs";
import { nodesAt, ramCell } from "./verify-package-nes-discovery-graph.mjs";

function valueDomain(graph, snapshot, variable) {
  const page = graph.value_snapshots[snapshot].pages[variable >> 5],
    entry =
      page === null
        ? undefined
        : graph.value_pages[page].entries.find(
            (item) => item.offset === (variable & 31),
          );
  return entry === undefined
    ? (1n << 256n) - 1n
    : BigInt(`0x${graph.byte_domains[entry.domain_index].bitmap_hex}`);
}

function checkNonzeroInvocations(graph, original, nonzero) {
  for (const invocation of graph.invocations) {
    if (
      invocation.entry_address !== addresses.recursive.callee ||
      invocation.index === original.index
    )
      continue;
    assert.equal(valueDomain(graph, invocation.value_snapshot, 4), nonzero);
    assert.ok(
      nodesAt(graph, addresses.recursive.recursiveCall).some(
        (node) => node.invocation_index === invocation.index,
      ),
    );
    assert.ok(
      !graph.nodes.some(
        (node) =>
          node.invocation_index === invocation.index &&
          [
            0xe509,
            addresses.recursive.baseRts,
            addresses.recursive.recursiveRts,
          ].includes(node.address),
      ),
      "Nonzero RAM cannot fabricate a base case or a recursive caller continuation",
    );
    assert.ok(
      !graph.return_summaries.some(
        (item) => item.invocation_index === invocation.index,
      ),
    );
    const reads = graph.data_references.filter(
      (reference) =>
        graph.nodes[reference.node_index].invocation_index ===
          invocation.index &&
        reference.kind === "read" &&
        reference.address === 0,
    );
    assert.ok(reads.length > 0);
    for (const read of reads) {
      assert.equal(read.ram_origins.length, 1);
      const origin = read.ram_origins[0];
      assert.equal(
        BigInt(`0x${graph.byte_domains[origin.domain_index].bitmap_hex}`),
        nonzero,
      );
      assert.deepEqual(origin.writer_nodes, []);
      assert.deepEqual(origin.writer_witness_indices, []);
      assert.equal(origin.initial_unwritten_possible, true);
      assert.equal(origin.unknown_write_possible, false);
      assert.ok(origin.condition_witness_indices.length > 0);
    }
  }
}

export function checkRecursive(graph, matchedReturn) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.ok(graph.work_items_processed < 16384);
  assert.deepEqual(graph.pending, []);
  assert.deepEqual(graph.pending_returns, []);
  assert.deepEqual(graph.pending_refinements, []);
  assert.deepEqual(graph.frontiers, []);
  assert.deepEqual(
    [...new Set(graph.invocations.map((item) => item.entry_address))].sort(
      (a, b) => a - b,
    ),
    [addresses.recursive.callee, addresses.recursive.caller],
  );
  // Each unknown-SP call shifts a two-byte return address around 256 slots.
  // One caller, 128 mixed ring positions and the all-recursive ring are finite.
  assert.equal(graph.invocations.length, 130);
  const { first, summary, continuation } = matchedReturn;
  assert.equal(first.address, addresses.recursive.continuation);
  assert.equal(first.cpu_in.a, 0x7c);
  assert.equal(graph.return_summaries.length, 1);
  assert.ok(graph.return_summaries.every((item) => item.cpu_out.a === 0x7c));
  assert.equal(summary.return_proof, "relative-bytes");
  assert.equal(summary.stack_target, addresses.recursive.continuation);
  assert.equal(summary.frame.intact, true);
  assert.equal(valueDomain(graph, summary.value_snapshot, 4), 1n);
  assert.equal(
    graph.nodes[summary.return_node_index].address,
    addresses.recursive.baseRts,
  );
  const original = graph.invocations[continuation.callee_invocation_index],
    nonzero = ((1n << 256n) - 1n) ^ 1n;
  assert.equal(
    valueDomain(graph, original.value_snapshot, 4),
    (1n << 256n) - 1n,
  );
  checkNonzeroInvocations(graph, original, nonzero);
  assert.ok(
    graph.continuations.some(
      (item) =>
        graph.nodes[item.call_node_index].address ===
        addresses.recursive.recursiveCall,
    ),
  );
  assert.ok(
    graph.return_summaries.some(
      (item) =>
        graph.nodes[item.return_node_index].address ===
        addresses.recursive.baseRts,
    ),
  );
  assert.equal(graph.write_witnesses.length, 1);
  const writer = graph.write_witnesses[0];
  assert.equal(graph.nodes[writer.node_index].address, 0xe523);
  assert.equal(writer.address, 0x20);
  assert.equal(writer.value, 0x7c);
  assert.equal(
    BigInt(`0x${graph.byte_domains[writer.domain_index].bitmap_hex}`),
    1n << 124n,
  );
  for (const index of writer.analysis_indices) {
    const analysis = graph.analyses[index];
    assert.equal(analysis.node_index, writer.node_index);
    const cell = ramCell(
      graph,
      graph.value_snapshots[analysis.value_snapshot_out].ram_pages,
      0x20,
    );
    assert.deepEqual(cell.writer_witness_indices, [writer.index]);
    assert.equal(cell.initial_unwritten_possible, false);
    assert.equal(cell.unknown_write_possible, false);
  }
}
