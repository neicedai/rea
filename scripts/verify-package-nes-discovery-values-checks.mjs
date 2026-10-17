import assert from "node:assert/strict";
import {
  ALL_BYTES,
  TABLE,
  entries,
  sites,
} from "./verify-package-nes-discovery-values-fixture.mjs";

const sorted = (values) => [...new Set(values)].sort((a, b) => a - b);
const cache = new WeakMap();
const analysesAt = (graph, address) =>
  graph.analyses.filter((a) => graph.nodes[a.node_index].address === address);
const readsAt = (graph, address) =>
  graph.data_references.filter(
    (r) => r.kind === "read" && graph.nodes[r.node_index].address === address,
  );
const branchAt = (graph, address, value) =>
  graph.edges.filter(
    (e) =>
      graph.nodes[e.from].address === address && e.condition?.value === value,
  );

/** The published bitmap is an unsigned integer with bit v admitting byte v. */
function domain(graph, index) {
  let known = cache.get(graph);
  if (known === undefined) cache.set(graph, (known = new Map()));
  if (known.has(index)) return known.get(index);
  const record = graph.byte_domains[index];
  assert.ok(record);
  assert.equal(record.index, index);
  assert.match(record.bitmap_hex, /^[0-9a-f]{64}$/u);
  const bitmap = BigInt(`0x${record.bitmap_hex}`);
  const values = ALL_BYTES.filter((v) => (bitmap & (1n << BigInt(v))) !== 0n);
  assert.equal(record.count, values.length);
  assert.ok(values.length > 0);
  known.set(index, values);
  return values;
}

function value(graph, snapshotIndex, variable) {
  const snapshot = graph.value_snapshots[snapshotIndex];
  assert.ok(snapshot);
  const pageIndex = snapshot.pages[variable >> 5];
  const entry =
    pageIndex === null
      ? undefined
      : graph.value_pages[pageIndex].entries.find(
          (e) => e.offset === (variable & 31),
        );
  return entry === undefined
    ? { leader: variable, values: ALL_BYTES, conditions: [] }
    : {
        leader: entry.leader,
        values: domain(graph, entry.domain_index),
        conditions: entry.condition_witness_indices,
      };
}

function proof(values) {
  let and = 255,
    or = 0;
  for (const v of values) {
    and &= v;
    or |= v;
  }
  const mask = (and ^ or ^ 255) & 255;
  return mask === 255 ? and : mask === 0 ? null : { value: and, mask };
}

function snapshot(graph, index, registers, predicates) {
  const record = graph.value_snapshots[index];
  assert.ok(record);
  assert.equal(record.pages.length, 65);
  assert.equal(record.ram_pages.length, 64);
  for (const [pageOffset, pageIndex] of record.pages.entries()) {
    if (pageIndex === null) continue;
    const page = graph.value_pages[pageIndex];
    assert.ok(page);
    for (const entry of page.entries) {
      const variable = pageOffset * 32 + entry.offset;
      assert.ok(variable <= 2051);
      assert.ok(entry.leader <= variable);
      const leader = value(graph, index, entry.leader);
      assert.equal(leader.leader, entry.leader);
      assert.deepEqual(domain(graph, entry.domain_index), leader.values);
      if (entry.leader !== variable)
        assert.deepEqual(entry.condition_witness_indices, []);
    }
  }
  if (registers !== undefined)
    for (const [variable, register] of ["a", "x", "y", "sp"].entries())
      assert.deepEqual(
        value(graph, index, variable).values,
        domain(graph, registers[register]),
      );
  if (predicates !== undefined)
    for (const predicate of Object.values(predicates)) {
      if (predicate === null) continue;
      const leader = value(graph, index, predicate.carrier_variable).leader;
      assert.equal(predicate.carrier_variable, leader);
      assert.deepEqual(
        predicate.registers,
        ["a", "x", "y", "sp"].filter(
          (_, variable) => value(graph, index, variable).leader === leader,
        ),
      );
    }
  for (const [pageOffset, pageIndex] of record.ram_pages.entries()) {
    if (pageIndex === null) continue;
    const page = graph.ram_pages[pageIndex];
    assert.ok(page);
    for (const cell of page.cells) {
      const address = pageOffset * 32 + cell.offset;
      assert.deepEqual(
        cell.value,
        proof(value(graph, index, 4 + address).values),
      );
      for (const writer of cell.writer_witness_indices)
        assert.equal(graph.write_witnesses[writer].address, address);
      assert.ok(
        cell.initial_unwritten_possible ||
          cell.unknown_write_possible ||
          cell.writer_witness_indices.length > 0,
      );
    }
  }
}

/** Cross-pool checks are independent of the producer's named runtime schema. */
export function pools(graph) {
  graph.byte_domains.forEach((_, index) => domain(graph, index));
  for (const [index, page] of graph.value_pages.entries()) {
    assert.equal(page.index, index);
    assert.equal(
      new Set(page.entries.map((e) => e.offset)).size,
      page.entries.length,
    );
    for (const entry of page.entries) {
      domain(graph, entry.domain_index);
      for (const condition of entry.condition_witness_indices)
        assert.ok(graph.condition_witnesses[condition]);
    }
  }
  for (const [index, witness] of graph.condition_witnesses.entries()) {
    assert.equal(witness.index, index);
    const source = domain(graph, witness.source_domain_index),
      result = domain(graph, witness.result_domain_index);
    assert.ok(result.every((v) => source.includes(v)));
    assert.ok(witness.analysis_indices.length > 0);
    for (const analysis of witness.analysis_indices)
      assert.equal(graph.analyses[analysis].node_index, witness.node_index);
    if (witness.kind === "index") assert.deepEqual(result, [witness.value]);
  }
  for (const writer of [
    ...graph.write_witnesses,
    ...graph.relative_stack_write_witnesses,
  ]) {
    assert.deepEqual(writer.value, proof(domain(graph, writer.domain_index)));
    for (const analysis of writer.analysis_indices)
      assert.equal(graph.analyses[analysis].node_index, writer.node_index);
  }
  for (const analysis of graph.analyses) {
    snapshot(
      graph,
      analysis.value_snapshot_in,
      analysis.register_domains_in,
      analysis.flag_predicates_in,
    );
    snapshot(
      graph,
      analysis.value_snapshot_out,
      analysis.register_domains_out,
      analysis.flag_predicates_out,
    );
  }
  for (const invocation of graph.invocations)
    snapshot(
      graph,
      invocation.value_snapshot,
      invocation.register_domains,
      invocation.flag_predicates,
    );
  for (const summary of graph.return_summaries)
    snapshot(
      graph,
      summary.value_snapshot,
      summary.register_domains,
      summary.flag_predicates,
    );
  for (const edge of graph.edges)
    if (edge.condition === null) assert.equal(edge.value_snapshot, null);
    else
      snapshot(
        graph,
        edge.value_snapshot,
        edge.register_domains,
        edge.flag_predicates,
      );
  for (const reference of graph.data_references)
    for (const origin of reference.ram_origins) {
      domain(graph, origin.domain_index);
      for (const condition of origin.condition_witness_indices)
        assert.ok(graph.condition_witnesses[condition]);
    }
}

function readValues(graph, address, expected) {
  const reads = readsAt(graph, address);
  assert.ok(reads.length > 0, `No table reads at ${address.toString(16)}`);
  assert.deepEqual(sorted(reads.map((read) => read.address - TABLE)), expected);
  for (const read of reads) {
    const v = read.address - TABLE;
    assert.equal(read.value, v);
    assert.deepEqual(read.file_offsets, [16 + TABLE - 0x8000 + v]);
    assert.equal(graph.analyses[read.analysis_index].cpu_in.x, v);
  }
}

function initialOrigin(graph, read, address, expected) {
  assert.equal(read.ram_origins.length, 1);
  const origin = read.ram_origins[0];
  assert.equal(origin.ram_address, address);
  assert.deepEqual(domain(graph, origin.domain_index), expected);
  assert.equal(origin.initial_unwritten_possible, true);
  assert.equal(origin.unknown_write_possible, false);
  assert.deepEqual(origin.writer_nodes, []);
  assert.deepEqual(origin.writer_witness_indices, []);
  assert.ok(origin.condition_witness_indices.length > 0);
  assert.ok(
    origin.condition_witness_indices.some(
      (index) => graph.condition_witnesses[index].kind === "branch",
    ),
  );
}

export function recursive(graph) {
  const invocations = graph.invocations.filter(
    (i) => i.entry_address === entries.recursiveCallee,
  );
  assert.ok(
    invocations.some((i) =>
      value(graph, i.value_snapshot, 36).values.every((v) => v !== 0),
    ),
  );
  const base = graph.return_summaries.filter(
    (s) =>
      graph.nodes[s.return_node_index].address === entries.recursiveCallee + 8,
  );
  assert.ok(base.length > 0);
  for (const summary of base)
    assert.deepEqual(value(graph, summary.value_snapshot, 36).values, [0]);
  for (const edge of branchAt(graph, entries.recursiveCallee + 2, true))
    assert.deepEqual(value(graph, edge.value_snapshot, 36).values, [0]);
  for (const edge of branchAt(graph, entries.recursiveCallee + 2, false))
    assert.deepEqual(
      value(graph, edge.value_snapshot, 36).values,
      ALL_BYTES.slice(1),
    );
  for (const invocation of invocations) {
    const incoming = value(graph, invocation.value_snapshot, 36).values;
    if (incoming.includes(0)) continue;
    assert.ok(
      !graph.edges.some(
        (e) =>
          e.kind === "branch-taken" &&
          e.condition?.value === true &&
          graph.nodes[e.from].address === entries.recursiveCallee + 2 &&
          graph.analyses[e.analysis_index].invocation_index ===
            invocation.index,
      ),
    );
    assert.ok(!base.some((s) => s.invocation_index === invocation.index));
  }
}

export function mirror(graph) {
  readValues(graph, sites.mirrorTable, ALL_BYTES.slice(0, 10));
  for (const read of readsAt(graph, sites.mirrorRead)) {
    assert.equal(read.address, 0x820);
    initialOrigin(graph, read, 0x20, ALL_BYTES.slice(0, 10));
    const out = graph.analyses[read.analysis_index].value_snapshot_out;
    assert.equal(value(graph, out, 1).leader, value(graph, out, 36).leader);
  }
}

export function ramCarrier(graph) {
  readValues(graph, sites.carrierTable, ALL_BYTES.slice(0, 10));
  const branches = analysesAt(graph, sites.carrierBranch);
  assert.ok(branches.length > 0);
  for (const analysis of branches) {
    assert.equal(analysis.cpu_in.a, 0x77);
    assert.equal(analysis.flag_predicates_in.c.carrier_variable, 36);
    assert.deepEqual(analysis.flag_predicates_in.c.registers, []);
    for (const index of analysis.flag_predicates_in.c.source_witness_indices)
      assert.equal(
        graph.nodes[graph.flag_predicate_sources[index].node_index].address,
        entries.ramCarrier + 2,
      );
  }
  for (const read of readsAt(graph, sites.carrierRead))
    initialOrigin(graph, read, 0x20, ALL_BYTES.slice(0, 10));
}

export function stores(graph) {
  readValues(graph, sites.storedTable, [1, 128]);
  const writers = graph.write_witnesses.filter(
    (w) => graph.nodes[w.node_index].address === sites.storedWrite,
  );
  assert.ok(
    writers.some(
      (w) => JSON.stringify(domain(graph, w.domain_index)) === "[1,128]",
    ),
  );
  for (const read of readsAt(graph, sites.storedRead)) {
    assert.equal(read.ram_origins[0].initial_unwritten_possible, false);
    assert.ok(read.ram_origins[0].writer_witness_indices.length > 0);
    assert.ok(
      domain(graph, read.ram_origins[0].domain_index).every(
        (v) => v === 1 || v === 128,
      ),
    );
  }
  for (const analysis of analysesAt(graph, sites.constantsFinal)) {
    assert.deepEqual(value(graph, analysis.value_snapshot_out, 36).values, [7]);
    assert.deepEqual(value(graph, analysis.value_snapshot_out, 37).values, [7]);
    assert.notEqual(
      value(graph, analysis.value_snapshot_out, 36).leader,
      value(graph, analysis.value_snapshot_out, 37).leader,
    );
  }
}

export function stacks(graph) {
  for (const [pop, table] of [
    [sites.relativePop, sites.relativeTable],
    [sites.physicalPop, sites.physicalTable],
  ]) {
    readValues(graph, table, [1, 128]);
    const reads = readsAt(graph, pop);
    assert.ok(reads.length > 0);
    for (const read of reads) {
      assert.equal(read.relative_stack_origins.length, 1);
      for (const index of read.relative_stack_origins[0]
        .writer_witness_indices) {
        const writer = graph.relative_stack_write_witnesses[index];
        assert.equal(
          graph.nodes[writer.node_index].address,
          pop === sites.relativePop ? sites.relativePush : sites.physicalPush,
        );
        assert.ok(
          domain(graph, writer.domain_index).every((v) => v === 1 || v === 128),
        );
      }
      if (pop === sites.relativePop) {
        assert.equal(read.address, null);
        assert.deepEqual(read.ram_origins, []);
      } else {
        assert.equal(read.address, 0x1fd);
        const origin = read.ram_origins[0];
        assert.equal(origin.ram_address, 0x1fd);
        assert.deepEqual(origin.writer_witness_indices, []);
        assert.ok(
          origin.condition_witness_indices.some((index) => {
            const witness = graph.condition_witnesses[index];
            return (
              witness.kind === "stack-alias" &&
              witness.variable === 4 + 0x1fd &&
              witness.relative_offset === 0
            );
          }),
        );
      }
    }
  }
}

export function io(graph) {
  readValues(graph, sites.ioTable, ALL_BYTES);
  for (const read of readsAt(graph, sites.ioSecond)) {
    assert.equal(read.address, 0x2002);
    assert.deepEqual(read.ram_origins, []);
    assert.deepEqual(read.relative_stack_origins, []);
    assert.equal(read.value, null);
  }
}

export function calls(graph) {
  readValues(graph, sites.preservedTable, ALL_BYTES.slice(0, 10));
  readValues(graph, sites.changedTable, [42]);
  for (const read of readsAt(graph, sites.preservedRead))
    initialOrigin(graph, read, 0x20, ALL_BYTES.slice(0, 10));
  for (const read of readsAt(graph, sites.changedRead)) {
    const origin = read.ram_origins[0];
    assert.deepEqual(domain(graph, origin.domain_index), [42]);
    assert.equal(origin.initial_unwritten_possible, false);
    assert.equal(origin.unknown_write_possible, false);
    assert.ok(origin.writer_witness_indices.length > 0);
    for (const index of origin.writer_witness_indices)
      assert.equal(
        graph.nodes[graph.write_witnesses[index].node_index].address,
        entries.changedCallee + 2,
      );
  }
  for (const entry of [entries.preservedCall, entries.changedCall]) {
    const bindings = graph.continuations.filter(
      (c) => graph.nodes[c.call_node_index].address === entry + 7,
    );
    assert.ok(bindings.length > 0);
    for (const binding of bindings) {
      const returns = graph.edges.filter(
        (e) => e.kind === "return" && e.continuation_index === binding.index,
      );
      assert.ok(returns.length > 0);
      for (const edge of returns) {
        const summary = graph.return_summaries[edge.summary_index];
        assert.deepEqual(
          value(graph, summary.value_snapshot, 36).values,
          entry === entries.preservedCall ? ALL_BYTES.slice(0, 10) : [42],
        );
      }
    }
  }
}

export function unknownStore(graph) {
  readValues(graph, sites.unknownTable, ALL_BYTES);
  assert.ok(
    graph.frontiers.some(
      (f) =>
        f.address === sites.unknownWrite &&
        f.reason === "unknown-write-address",
    ),
  );
  const write = graph.data_references.find(
    (r) =>
      r.kind === "write" &&
      graph.nodes[r.node_index].address === sites.unknownWrite,
  );
  assert.ok(write);
  assert.equal(write.address, null);
  assert.ok(
    !graph.write_witnesses.some(
      (w) => graph.nodes[w.node_index].address === sites.unknownWrite,
    ),
  );
  for (const read of readsAt(graph, sites.unknownRead)) {
    const origin = read.ram_origins[0];
    assert.deepEqual(domain(graph, origin.domain_index), ALL_BYTES);
    assert.equal(origin.unknown_write_possible, true);
    assert.deepEqual(origin.writer_witness_indices, []);
  }
}

export function joined(graph) {
  readValues(graph, sites.joinedTable, ALL_BYTES);
  assert.ok(
    readsAt(graph, sites.joinedRead).some((read) => {
      const origin = read.ram_origins[0];
      return (
        origin.initial_unwritten_possible &&
        origin.writer_witness_indices.some(
          (index) =>
            graph.nodes[graph.write_witnesses[index].node_index].address ===
            sites.joinedWrite,
        )
      );
    }),
  );
  const joint = analysesAt(graph, sites.joinedBranch).filter(
    (a) =>
      value(graph, a.value_snapshot_in, 36).leader !==
      value(graph, a.value_snapshot_in, 37).leader,
  );
  assert.ok(joint.length > 0);
  for (const analysis of joint)
    assert.deepEqual(
      value(graph, analysis.value_snapshot_in, 37).values,
      ALL_BYTES,
    );
}

export function budget(graph, limit) {
  assert.equal(graph.termination, "value-state-budget");
  assert.ok(graph.value_state_records <= limit);
  assert.equal(graph.roots.length, 2);
  assert.ok(
    graph.pending.length +
      graph.pending_refinements.length +
      graph.pending_returns.length >
      0,
  );
}
