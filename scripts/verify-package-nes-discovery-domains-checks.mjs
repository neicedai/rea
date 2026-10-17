import assert from "node:assert/strict";
import {
  ALL_BYTES,
  TABLE,
  PAIR_TABLE,
  entries,
  sites,
  rotations,
  compareCandidates,
} from "./verify-package-nes-discovery-domains-fixture.mjs";

const REGISTERS = ["a", "x", "y", "sp"];
const sorted = (values) => [...new Set(values)].sort((a, b) => a - b);
const analysesAt = (graph, address) =>
  graph.analyses.filter((a) => graph.nodes[a.node_index].address === address);
const readsAt = (graph, address) =>
  graph.data_references.filter(
    (r) => r.kind === "read" && graph.nodes[r.node_index].address === address,
  );
const branchesAt = (graph, address, value) =>
  graph.edges.filter(
    (e) =>
      graph.nodes[e.from].address === address && e.condition?.value === value,
  );

/** Bit v of the unsigned hexadecimal integer admits byte v; no producer import. */
function domain(graph, index) {
  const record = graph.byte_domains[index];
  assert.ok(record);
  assert.equal(record.index, index);
  assert.match(record.bitmap_hex, /^[0-9a-f]{64}$/u);
  const bitmap = BigInt(`0x${record.bitmap_hex}`);
  const values = ALL_BYTES.filter((v) => (bitmap & (1n << BigInt(v))) !== 0n);
  assert.equal(record.count, values.length);
  assert.ok(values.length > 0);
  return values;
}

function snapshot(graph, refs, cpu) {
  assert.deepEqual(Object.keys(refs).sort(), [...REGISTERS].sort());
  for (const register of REGISTERS) {
    const values = domain(graph, refs[register]);
    if (cpu === undefined) continue;
    const proof = cpu[register] ?? cpu.register_bits?.[register] ?? null;
    assert.ok(
      values.every(
        (v) =>
          proof === null ||
          (typeof proof === "number"
            ? v === proof
            : (v & proof.mask) === proof.value),
      ),
    );
  }
}

function predicates(graph, facts) {
  assert.deepEqual(Object.keys(facts).sort(), ["c", "n", "z"]);
  for (const predicate of Object.values(facts)) {
    if (predicate === null) continue;
    assert.ok(["result", "compare"].includes(predicate.kind));
    assert.deepEqual(
      predicate.registers,
      REGISTERS.filter((r) => predicate.registers.includes(r)),
    );
    assert.ok(predicate.registers.length > 0);
    assert.ok(predicate.source_witness_indices.length > 0);
    assert.equal(
      new Set(predicate.source_witness_indices).size,
      predicate.source_witness_indices.length,
    );
    if (predicate.kind === "result") assert.equal(predicate.operand, null);
    else
      assert.ok(
        Number.isInteger(predicate.operand) &&
          predicate.operand >= 0 &&
          predicate.operand <= 255,
      );
    for (const index of predicate.source_witness_indices) {
      const source = graph.flag_predicate_sources[index];
      assert.ok(source);
      assert.equal(source.kind, predicate.kind);
      assert.equal(source.operand, predicate.operand);
    }
  }
}

/** Pool ownership, sources and exact-domain snapshots survive every adapter result. */
export function pools(graph) {
  const keys = graph.byte_domains.map((record, index) => {
    domain(graph, index);
    return record.bitmap_hex;
  });
  assert.equal(new Set(keys).size, keys.length);
  for (const [index, source] of graph.flag_predicate_sources.entries()) {
    assert.equal(source.index, index);
    assert.ok(REGISTERS.includes(source.register));
    assert.ok(source.analysis_indices.length > 0);
    assert.equal(
      new Set(source.analysis_indices).size,
      source.analysis_indices.length,
    );
    for (const analysis of source.analysis_indices)
      assert.equal(graph.analyses[analysis].node_index, source.node_index);
  }
  for (const analysis of graph.analyses) {
    snapshot(graph, analysis.register_domains_in, analysis.cpu_in);
    snapshot(graph, analysis.register_domains_out, analysis.cpu_out);
    predicates(graph, analysis.flag_predicates_in);
    predicates(graph, analysis.flag_predicates_out);
    if (analysis.refinement !== null) {
      const values = domain(graph, analysis.refinement.source_domain_index);
      assert.ok(values.includes(analysis.refinement.value));
      assert.deepEqual(
        domain(
          graph,
          analysis.register_domains_in[analysis.refinement.register],
        ),
        [analysis.refinement.value],
      );
    }
  }
  for (const invocation of graph.invocations) {
    snapshot(graph, invocation.register_domains, invocation.cpu_in);
    predicates(graph, invocation.flag_predicates);
  }
  for (const summary of graph.return_summaries) {
    snapshot(graph, summary.register_domains, summary.cpu_out);
    predicates(graph, summary.flag_predicates);
  }
  for (const edge of graph.edges) {
    if (edge.condition === null) {
      assert.equal(edge.register_domains, null);
      assert.equal(edge.flag_predicates, null);
    } else {
      snapshot(graph, edge.register_domains);
      predicates(graph, edge.flag_predicates);
      const analysis = graph.analyses[edge.analysis_index];
      assert.deepEqual(analysis.cpu_in, analysis.cpu_out);
    }
  }
  for (const pending of graph.pending_refinements)
    assert.ok(
      domain(graph, pending.source_domain_index).some(
        (v) => v >= pending.next_value,
      ),
    );
}

function readValues(
  graph,
  address,
  values,
  { register = "x", table = TABLE, fixedOffset = (a) => 16 + a - 0x8000 } = {},
) {
  const reads = readsAt(graph, address);
  assert.ok(reads.length > 0);
  assert.deepEqual(sorted(reads.map((read) => read.address - table)), values);
  for (const read of reads) {
    const v = read.address - table;
    assert.equal(read.value, table === PAIR_TABLE ? v ^ 0xa5 : v);
    assert.deepEqual(read.file_offsets, [fixedOffset(table) + v]);
    assert.equal(graph.analyses[read.analysis_index].cpu_in[register], v);
  }
}

function branchDomain(graph, address, { flag, value, register = "x" }, values) {
  const edges = branchesAt(graph, address, value);
  assert.ok(edges.length > 0);
  for (const edge of edges) {
    assert.equal(edge.condition.flag, flag);
    assert.deepEqual(domain(graph, edge.register_domains[register]), values);
  }
}

export function range(graph) {
  const values = compareCandidates(10, "c", false);
  assert.deepEqual(values, ALL_BYTES.slice(0, 10));
  branchDomain(graph, entries.range + 2, { flag: "c", value: false }, values);
  branchDomain(
    graph,
    entries.range + 2,
    { flag: "c", value: true },
    ALL_BYTES.slice(10),
  );
  readValues(graph, sites.range, values);
  for (const analysis of analysesAt(graph, sites.range))
    assert.deepEqual(
      domain(graph, analysis.refinement.source_domain_index),
      values,
    );
}

export function negative(graph) {
  const values = compareCandidates(5, "n", true);
  assert.deepEqual(values, [...ALL_BYTES.slice(0, 5), ...ALL_BYTES.slice(133)]);
  branchDomain(graph, entries.negative + 2, { flag: "n", value: true }, values);
  readValues(graph, sites.negative, values);
}

export function resultNz(graph) {
  branchDomain(graph, entries.zero + 1, { flag: "z", value: true }, [0]);
  branchDomain(
    graph,
    entries.nonzero + 1,
    { flag: "z", value: false },
    ALL_BYTES.slice(1),
  );
  readValues(graph, sites.zero, [0]);
  readValues(graph, sites.nonzero, ALL_BYTES.slice(1));
  for (const entry of [entries.zero, entries.nonzero]) {
    const predicate = analysesAt(graph, entry)[0].flag_predicates_out.z;
    assert.equal(predicate.kind, "result");
    assert.deepEqual(predicate.registers, ["x"]);
  }
}

export function independent(graph) {
  branchDomain(
    graph,
    entries.independent + 4,
    { flag: "c", value: false },
    ALL_BYTES.slice(0, 8),
  );
  readValues(graph, sites.independent, ALL_BYTES.slice(0, 8));
  const before = analysesAt(graph, entries.independent + 4)[0];
  assert.equal(before.cpu_in.a, 0);
  assert.equal(before.cpu_in.z, true);
  assert.equal(before.cpu_in.n, false);
  assert.equal(before.flag_predicates_in.c.kind, "compare");
  assert.equal(before.flag_predicates_in.c.operand, 8);
  assert.deepEqual(before.flag_predicates_in.c.registers, ["x"]);
  for (const flag of ["z", "n"]) {
    assert.equal(before.flag_predicates_in[flag].kind, "result");
    assert.deepEqual(before.flag_predicates_in[flag].registers, ["a"]);
  }
}

export function killed(graph) {
  for (const [address, flag] of [
    [entries.increment + 3, "c"],
    [entries.clc + 3, "c"],
    [entries.unknownOperand + 4, "c"],
  ]) {
    branchDomain(graph, address, { flag, value: false }, ALL_BYTES);
    for (const analysis of analysesAt(graph, address))
      assert.equal(analysis.flag_predicates_in.c, null);
  }
  readValues(graph, sites.increment, ALL_BYTES);
}

export function copies(graph) {
  const values = ALL_BYTES.slice(0, 10);
  for (const register of ["a", "x", "y"])
    branchDomain(
      graph,
      entries.copies + 4,
      { flag: "c", value: false, register },
      values,
    );
  readValues(graph, sites.copies, values);
  readValues(graph, sites.copiedPair, values, {
    register: "y",
    table: PAIR_TABLE,
  });
  const first = readsAt(graph, sites.copies);
  for (const read of first) {
    const analysis = graph.analyses[read.analysis_index];
    assert.deepEqual(analysis.refinement.equal_registers, ["a", "x", "y"]);
    const paired = readsAt(graph, sites.copiedPair).filter(
      (other) =>
        graph.analyses[other.analysis_index].partition_index ===
        analysis.partition_index,
    );
    assert.ok(paired.length > 0);
    assert.ok(
      paired.every(
        (other) => other.address - PAIR_TABLE === read.address - TABLE,
      ),
    );
  }
}

export function joined(graph) {
  readValues(graph, sites.joined, [0, 10]);
  assert.ok(
    analysesAt(graph, sites.joined).some(
      (analysis) =>
        analysis.refinement !== null &&
        JSON.stringify(
          domain(graph, analysis.refinement.source_domain_index),
        ) === "[0,10]",
    ),
  );
  readValues(graph, sites.persisted, ALL_BYTES.slice(1));
  for (const analysis of analysesAt(graph, sites.persisted))
    assert.deepEqual(
      domain(graph, analysis.refinement.source_domain_index),
      ALL_BYTES.slice(1),
    );
}

export function calls(graph) {
  readValues(graph, sites.callTable, ALL_BYTES.slice(0, 10));
  readValues(graph, sites.callContinuation, ALL_BYTES.slice(0, 10));
  readValues(graph, sites.changedContinuation, [20]);
  for (const entry of [entries.call, entries.changedCall]) {
    const bindings = graph.continuations.filter(
      (binding) => graph.nodes[binding.call_node_index].address === entry + 5,
    );
    assert.ok(bindings.length > 0);
    for (const binding of bindings) {
      assert.deepEqual(
        domain(
          graph,
          graph.invocations[binding.callee_invocation_index].register_domains.x,
        ),
        ALL_BYTES.slice(0, 10),
      );
      const edges = graph.edges.filter(
        (edge) =>
          edge.kind === "return" && edge.continuation_index === binding.index,
      );
      assert.ok(edges.length > 0);
      for (const edge of edges) {
        const summary = graph.return_summaries[edge.summary_index];
        const values = domain(graph, summary.register_domains.x);
        assert.ok(values.length === 1);
        assert.ok(entry === entries.call ? values[0] < 10 : values[0] === 20);
        if (entry === entries.changedCall)
          assert.equal(summary.flag_predicates.c, null);
      }
    }
  }
}

export function banked(graph, mapper, spec) {
  const fixedOffset = (address) => 16 + 65536 - 8192 + address - 0xe000;
  readValues(graph, 0xe005, [0, 1, 2], { fixedOffset });
  const width = mapper === 4 ? 8192 : 16384;
  const selected = graph.nodes.filter((node) => node.address === 0x8000);
  assert.deepEqual(
    sorted(selected.map((node) => (node.file_offsets[0] - 16) / width)),
    [0, 1, 2],
  );
  for (const node of selected) {
    const bank = (node.file_offsets[0] - 16) / width;
    assert.equal(node.cpu_out.a, 0x40 + bank);
    const state = graph.contexts[node.context_index].state;
    assert.equal(mapper === 4 ? state.banks[6] : state.prg_bank, bank);
  }
  const returns = graph.edges.filter(
    (edge) =>
      edge.kind === "return" && edge.target_address === spec.continuation,
  );
  assert.equal(returns.length, 3);
  const reads = readsAt(graph, spec.read);
  assert.deepEqual(sorted(reads.map((read) => read.value)), [0x40, 0x41, 0x42]);
  for (const read of reads) {
    assert.equal(read.address, 0x20);
    assert.equal(read.ram_origins.length, 1);
    for (const index of read.ram_origins[0].writer_witness_indices) {
      const witness = graph.write_witnesses[index];
      assert.equal(witness.address, 0x20);
      assert.equal(witness.value, read.value);
    }
  }
}

export function budget(graph, limit) {
  assert.equal(graph.termination, "work-item-budget");
  assert.equal(graph.work_items_processed, limit);
  assert.ok(
    graph.pending.length +
      graph.pending_refinements.length +
      graph.pending_returns.length >
      0,
  );
  assert.ok(
    graph.pending_refinements.some(
      (pending) =>
        JSON.stringify(domain(graph, pending.source_domain_index)) ===
        JSON.stringify(ALL_BYTES.slice(0, 10)),
    ),
  );
  const visited = readsAt(graph, sites.range).map(
    (read) => read.address - TABLE,
  );
  assert.ok(visited.length < 10 && visited.every((v) => v >= 0 && v < 10));
}

/** Incoming carry comes from this same A, rather than an independent choice. */
export function correlatedRotations(graph) {
  for (const spec of rotations) {
    const image = (values) =>
      sorted(
        values.map((a) => {
          const carry = Number(a >= 128);
          return spec.mnemonic === "ROL"
            ? ((a << 1) | carry) & 255
            : (a >> 1) | (carry << 7);
        }),
      );
    const expected = spec.mnemonic === "ROL" ? [1, 2] : [0, 192];
    assert.deepEqual(image([1, 128]), expected);
    const analyses = analysesAt(graph, spec.entry + 11);
    assert.ok(
      analyses.some(
        (analysis) =>
          JSON.stringify(domain(graph, analysis.register_domains_in.a)) ===
          "[1,128]",
      ),
    );
    for (const analysis of analyses) {
      const incoming = domain(graph, analysis.register_domains_in.a);
      assert.ok(incoming.every((value) => value === 1 || value === 128));
      assert.deepEqual(
        domain(graph, analysis.register_domains_out.a),
        image(incoming),
      );
      const carry = analysis.flag_predicates_in.c;
      assert.equal(carry.kind, "compare");
      assert.equal(carry.operand, 128);
      assert.deepEqual(carry.registers, ["a"]);
      for (const index of carry.source_witness_indices) {
        const source = graph.flag_predicate_sources[index];
        assert.equal(graph.nodes[source.node_index].address, spec.entry + 9);
        assert.equal(source.register, "a");
        assert.equal(source.kind, "compare");
        assert.equal(source.operand, 128);
      }
      for (const flag of ["z", "n"]) {
        const predicate = analysis.flag_predicates_out[flag];
        assert.equal(predicate.kind, "result");
        assert.deepEqual(predicate.registers, ["a"]);
        for (const index of predicate.source_witness_indices) {
          const source = graph.flag_predicate_sources[index];
          assert.equal(graph.nodes[source.node_index].address, spec.entry + 11);
          assert.equal(source.register, "a");
          assert.equal(source.kind, "result");
          assert.equal(source.operand, null);
          assert.ok(source.analysis_indices.includes(analysis.index));
        }
      }
    }
    readValues(graph, spec.read, expected);
  }
}
