import assert from "node:assert/strict";

/** Independent physical partition oracle, shared by both public discovery corpora. */
export function checkDiscoveryCoverage(graph, bytes, start, size) {
  const decoded = new Set(),
    referenced = new Set();
  for (const node of graph.nodes) {
    assert.equal(node.file_offsets.length * 2, node.bytes_hex.length);
    assert.equal(
      Buffer.from(node.file_offsets.map((offset) => bytes[offset])).toString(
        "hex",
      ),
      node.bytes_hex,
    );
    for (const offset of node.file_offsets) decoded.add(offset);
  }
  for (const root of graph.roots)
    for (const byte of root.vector ?? [])
      if (byte.file_offset !== null) {
        assert.equal(bytes[byte.file_offset], byte.value);
        referenced.add(byte.file_offset);
      }
  for (const reference of graph.data_references)
    for (const offset of reference.file_offsets) referenced.add(offset);
  const overlap = [...decoded].filter((offset) => referenced.has(offset));
  for (const edge of graph.edges)
    assert.equal(graph.analyses[edge.analysis_index].node_index, edge.from);
  for (const reference of graph.data_references)
    assert.equal(
      graph.analyses[reference.analysis_index].node_index,
      reference.node_index,
    );
  assert.equal(graph.coverage.prg_bytes, size);
  assert.equal(graph.coverage.decoded_bytes, decoded.size);
  assert.equal(graph.coverage.referenced_bytes, referenced.size);
  assert.equal(graph.coverage.overlap_bytes, overlap.length);
  assert.equal(
    graph.coverage.unclassified_bytes,
    size - decoded.size - referenced.size + overlap.length,
  );
  let cursor = start;
  for (const interval of graph.coverage.intervals) {
    assert.equal(interval.file_offset, cursor);
    for (let offset = cursor; offset < cursor + interval.size; offset++) {
      const code = decoded.has(offset),
        data = referenced.has(offset);
      assert.equal(
        interval.classification,
        code
          ? data
            ? "overlap"
            : "decoded"
          : data
            ? "referenced"
            : "unclassified",
      );
    }
    cursor += interval.size;
  }
  assert.equal(cursor, start + size);
}

export function checkDiscoveryWitnesses(graph) {
  for (const node of graph.nodes)
    assert.ok(graph.invocations[node.invocation_index]);
  for (const analysis of graph.analyses)
    assert.equal(
      analysis.invocation_index,
      graph.nodes[analysis.node_index].invocation_index,
    );
  for (const witness of graph.write_witnesses)
    for (const analysis of witness.analysis_indices)
      assert.equal(graph.analyses[analysis].node_index, witness.node_index);
  for (const reference of graph.data_references)
    for (const origin of reference.ram_origins) {
      const witnesses = origin.writer_witness_indices.map(
        (index) => graph.write_witnesses[index],
      );
      assert.ok(
        witnesses.every((witness) => witness.address === origin.ram_address),
      );
      assert.deepEqual(
        [...new Set(witnesses.map((witness) => witness.node_index))].sort(
          (a, b) => a - b,
        ),
        [...origin.writer_nodes].sort((a, b) => a - b),
      );
    }
}

export const nodesAt = (graph, address) =>
  graph.nodes.filter((node) => node.address === address);
export const stateOf = (graph, node) =>
  graph.contexts[node.context_index].state;
export const edgesFrom = (graph, node, kind) =>
  graph.edges.filter((edge) => edge.from === node.index && edge.kind === kind);
export const ramCell = (graph, snapshot, address) => {
  const page = snapshot[address >> 5];
  return page === null
    ? undefined
    : graph.ram_pages[page].cells.find(
        (cell) => cell.offset === (address & 31),
      );
};
