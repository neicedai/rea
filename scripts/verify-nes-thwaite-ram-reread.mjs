import assert from "node:assert/strict";
import {
  checkDiscoveryCoverage,
  checkDiscoveryWitnesses,
} from "./verify-package-nes-discovery-graph.mjs";

const domainValues = (graph, index) => {
  const domain = graph.byte_domains[index];
  assert.ok(domain);
  const bits = BigInt(`0x${domain.bitmap_hex}`),
    values = Array.from({ length: 256 }, (_, value) => value).filter(
      (value) => (bits & (1n << BigInt(value))) !== 0n,
    );
  assert.equal(values.length, domain.count);
  return values;
};
const valueEntry = (graph, snapshotIndex, variable) => {
  const snapshot = graph.value_snapshots[snapshotIndex];
  assert.ok(snapshot);
  const pageIndex = snapshot.pages[Math.floor(variable / 32)];
  assert.notEqual(pageIndex, null);
  const entry = graph.value_pages[pageIndex].entries.find(
    (item) => item.offset === (variable & 31),
  );
  assert.ok(entry);
  return entry;
};

function checkInitialRamRead(graph, allBytes) {
  const initialRead = graph.data_references.find(
    (read) =>
      graph.nodes[read.node_index].address === 0xddeb &&
      read.kind === "read" &&
      read.address === 0,
  );
  assert.ok(initialRead);
  assert.equal(initialRead.value, null);
  assert.deepEqual(initialRead.file_offsets, []);
  assert.equal(initialRead.ram_origins.length, 1);
  const initialOrigin = initialRead.ram_origins[0];
  assert.deepEqual(domainValues(graph, initialOrigin.domain_index), allBytes);
  assert.deepEqual(initialOrigin.writer_nodes, []);
  assert.deepEqual(initialOrigin.writer_witness_indices, []);
  assert.deepEqual(initialOrigin.condition_witness_indices, []);
  assert.equal(initialOrigin.initial_unwritten_possible, true);
  assert.equal(initialOrigin.unknown_write_possible, false);
}

function checkConditionedRamRead(graph, reload, admitted, allBytes) {
  const node = graph.nodes[reload.node_index];
  assert.equal(node.bytes_hex, "a500");
  assert.deepEqual(node.file_offsets, [7687, 7688]);
  assert.equal(
    reload.cpu_out.a,
    null,
    "The common-bit envelope stays unknown while the exact domain excludes 0 and 1",
  );
  const reread = graph.data_references.find(
    (read) => read.analysis_index === reload.index && read.kind === "read",
  );
  assert.ok(reread);
  assert.equal(reread.address, 0);
  assert.equal(reread.value, null);
  assert.deepEqual(reread.file_offsets, []);
  assert.equal(reread.ram_origins.length, 1);
  const origin = reread.ram_origins[0];
  assert.equal(origin.ram_address, 0);
  assert.deepEqual(domainValues(graph, origin.domain_index), admitted);
  assert.deepEqual(origin.writer_nodes, []);
  assert.deepEqual(origin.writer_witness_indices, []);
  assert.equal(origin.initial_unwritten_possible, true);
  assert.equal(origin.unknown_write_possible, false);
  assert.ok(origin.condition_witness_indices.length > 0);
  for (const index of origin.condition_witness_indices) {
    const condition = graph.condition_witnesses[index];
    assert.equal(condition.kind, "branch");
    assert.equal(graph.nodes[condition.node_index].address, 0xddef);
    assert.equal(condition.flag, "c");
    assert.equal(condition.value, true);
    assert.deepEqual(
      domainValues(graph, condition.source_domain_index),
      allBytes,
    );
    assert.deepEqual(
      domainValues(graph, condition.result_domain_index),
      admitted,
    );
    for (const analysisIndex of condition.analysis_indices) {
      const branch = graph.analyses[analysisIndex];
      assert.equal(branch.node_index, condition.node_index);
      assert.ok(
        graph.edges.some(
          (edge) =>
            edge.analysis_index === analysisIndex &&
            edge.kind === "branch-not-taken" &&
            edge.target_address === 0xddf1 &&
            edge.condition?.flag === "c" &&
            edge.condition.value === true,
        ),
      );
    }
  }
  return origin;
}

function checkIndependentAttributeWrite(
  graph,
  reload,
  { admitted, attrBytes, origin },
) {
  const accumulator = valueEntry(graph, reload.value_snapshot_out, 0),
    row = valueEntry(graph, reload.value_snapshot_out, 4),
    attr = valueEntry(graph, reload.value_snapshot_out, 6);
  assert.equal(accumulator.leader, 0);
  assert.equal(row.leader, 0);
  assert.deepEqual(domainValues(graph, accumulator.domain_index), admitted);
  assert.equal(row.domain_index, accumulator.domain_index);
  assert.deepEqual(
    accumulator.condition_witness_indices,
    origin.condition_witness_indices,
  );
  assert.deepEqual(row.condition_witness_indices, []);
  assert.notEqual(attr.leader, accumulator.leader);
  assert.deepEqual(domainValues(graph, attr.domain_index), attrBytes);
  const snapshot = graph.value_snapshots[reload.value_snapshot_out],
    ramPage = graph.ram_pages[snapshot.ram_pages[0]],
    attrCell = ramPage.cells.find((cell) => cell.offset === 2);
  assert.ok(attrCell);
  assert.deepEqual(attrCell.value, { mask: 128, value: 128 });
  assert.equal(attrCell.initial_unwritten_possible, false);
  assert.equal(attrCell.unknown_write_possible, false);
  assert.ok(attrCell.writer_witness_indices.length > 0);
  for (const index of attrCell.writer_witness_indices) {
    const writer = graph.write_witnesses[index];
    assert.equal(writer.address, 2);
    assert.equal(graph.nodes[writer.node_index].address, 0xddf5);
    assert.deepEqual(writer.value, { mask: 128, value: 128 });
    assert.deepEqual(domainValues(graph, writer.domain_index), attrBytes);
  }
}

export async function verifyThwaiteRamReread(
  invoke,
  romPath,
  bytes,
  romSha256,
) {
  const evidence = await invoke("discover-nes-code", {
      path: romPath,
      initial: { mapper: 0 },
      roots: [0xddeb],
      max_work_items: 32,
    }),
    report = evidence.normalized_result,
    graph = report.code_discovery,
    admitted = Array.from({ length: 254 }, (_, index) => index + 2),
    allBytes = Array.from({ length: 256 }, (_, index) => index),
    attrBytes = Array.from({ length: 128 }, (_, index) => index + 128);
  assert.equal(evidence.subject.digest.sha256, romSha256);
  assert.equal(report.artifact.path, romPath);
  assert.deepEqual(report.header.header, [...bytes.subarray(0, 16)]);
  assert.equal(graph.status, "derived");
  checkDiscoveryCoverage(graph, bytes, 16, 16384);
  checkDiscoveryWitnesses(graph);
  checkInitialRamRead(graph, allBytes);
  const reload = graph.analyses.find(
    (analysis) =>
      graph.nodes[analysis.node_index].address === 0xddf7 &&
      JSON.stringify(domainValues(graph, analysis.register_domains_out.a)) ===
        JSON.stringify(admitted),
  );
  assert.ok(reload, "The original RAM reread preserves exactly rowNum >= 2");
  const origin = checkConditionedRamRead(graph, reload, admitted, allBytes);
  checkIndependentAttributeWrite(graph, reload, {
    admitted,
    attrBytes,
    origin,
  });
  return {
    evidence_id: evidence.evidence_id,
    entry: 0xddeb,
    branch_address: 0xddef,
    reread_address: 0xddf7,
    ram_address: 0,
    admitted_values: admitted.length,
    independent_write_address: 2,
    initial_unwritten_possible: true,
    fabricated_initial_writers: false,
    source:
      "Pinned author explosion.s rowNum >= 2 and matching original-ROM bytes",
    termination: graph.termination,
    work_items_processed: graph.work_items_processed,
  };
}
