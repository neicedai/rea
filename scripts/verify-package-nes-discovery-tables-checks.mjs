import assert from "node:assert/strict";
import {
  entries,
  paired,
  tableReads,
  targets,
  PRG,
} from "./verify-package-nes-discovery-tables-fixture.mjs";
import { stateOf } from "./verify-package-nes-discovery-graph.mjs";

const sorted = (items) => [...items].sort((a, b) => a - b);
const referencesAt = (graph, address) =>
  graph.data_references.filter(
    (reference) => graph.nodes[reference.node_index].address === address,
  );
const edgesAt = (graph, address, kind = "jump") =>
  graph.edges.filter(
    (edge) =>
      graph.nodes[edge.from].address === address &&
      edge.kind === kind &&
      edge.resolution === "resolved",
  );

function selection(graph, partition, site) {
  const choices = graph.partitions[partition].selections.filter(
    (item) => graph.nodes[item.node_index].address === site,
  );
  assert.equal(
    choices.length,
    1,
    `One selector binding at ${site.toString(16)}`,
  );
  return choices[0].value;
}

export function partitions(graph) {
  for (const [index, partition] of graph.partitions.entries()) {
    assert.equal(partition.index, index);
    const sites = partition.selections.map(
      (item) => `${item.node_index}:${item.register}`,
    );
    assert.equal(
      new Set(sites).size,
      sites.length,
      "A partition overwrites a site instead of growing a history chain",
    );
    for (const item of partition.selections)
      assert.ok(graph.nodes[item.node_index]);
  }
  for (const analysis of graph.analyses) {
    assert.ok(graph.partitions[analysis.partition_index]);
    if (analysis.refinement !== null) {
      const proof = analysis.refinement;
      assert.ok(proof.value >= 0 && proof.value <= 255);
      if (typeof proof.source_value === "number")
        assert.equal(proof.value, proof.source_value);
      else if (proof.source_value !== null)
        assert.equal(
          proof.value & proof.source_value.mask,
          proof.source_value.value,
        );
      assert.ok(
        graph.partitions[analysis.partition_index].selections.some(
          (item) =>
            item.node_index === analysis.node_index &&
            item.register === proof.register &&
            item.value === proof.value,
        ),
      );
    }
  }
  for (const edge of graph.edges)
    if (edge.target_partition_index !== null)
      assert.ok(graph.partitions[edge.target_partition_index]);
  for (const item of [...graph.roots, ...graph.frontiers, ...graph.pending])
    if (item.partition_index !== null)
      assert.ok(graph.partitions[item.partition_index]);
}

function targetPairs(graph, jump) {
  return edgesAt(graph, jump)
    .map((edge) => ({
      bank: stateOf(graph, graph.nodes[edge.to]).banks[6] & 63,
      address: edge.target_address,
      file_offset: graph.nodes[edge.to].file_offsets[0],
    }))
    .sort((a, b) => a.address - b.address || a.bank - b.bank);
}

function expectedPairs(items) {
  return items
    .map((item) => ({
      bank: item.bank,
      address: item.address,
      file_offset: PRG + item.bank * 8192 + item.address - 0x8000,
    }))
    .sort((a, b) => a.address - b.address || a.bank - b.bank);
}

function tableEvidence(graph, sites, bases, expected) {
  for (const [position, site] of sites.entries()) {
    const reads = referencesAt(graph, site).filter(
      (reference) => reference.kind === "read" && reference.address !== null,
    );
    let semanticReads = 0;
    for (const read of reads) {
      const partition = graph.analyses[read.analysis_index].partition_index,
        value = selection(graph, partition, sites[0]),
        item = expected.find((candidate) => candidate.selector === value);
      assert.ok(item);
      const effective = bases[position] + value;
      if (read.address === effective) {
        semanticReads++;
        assert.equal(read.value, [item.low, item.high, item.bank][position]);
      } else {
        // The shared CPU transfer also retains the original page-crossing read.
        assert.notEqual(bases[position] & 0xff00, effective & 0xff00);
        assert.equal(
          read.address,
          (bases[position] & 0xff00) | (effective & 255),
        );
        assert.equal(read.value, [2, 0x20, 0x82][position]);
      }
      assert.deepEqual(read.file_offsets, [
        PRG + 122880 + read.address - 0xe000,
      ]);
    }
    assert.equal(semanticReads, expected.length);
  }
  const dataOffsets = sites.flatMap((site) =>
    referencesAt(graph, site).flatMap((read) => read.file_offsets),
  );
  assert.ok(
    !graph.nodes.some((node) =>
      node.file_offsets.some((offset) => dataOffsets.includes(offset)),
    ),
    "Table bytes remain referenced data rather than code roots",
  );
}

function pointerWriters(graph, jump, writers) {
  for (const reference of referencesAt(graph, jump).filter(
    (item) => item.kind === "pointer",
  )) {
    assert.ok(reference.address === 2 || reference.address === 3);
    assert.equal(reference.ram_origins.length, 1);
    const origin = reference.ram_origins[0];
    assert.equal(origin.ram_address, reference.address);
    assert.ok(origin.writer_witness_indices.length > 0);
    for (const index of origin.writer_witness_indices) {
      const witness = graph.write_witnesses[index];
      assert.equal(
        graph.nodes[witness.node_index].address,
        writers[reference.address - 2],
      );
      assert.equal(witness.value, reference.value);
      assert.ok(
        witness.analysis_indices.some(
          (index) =>
            graph.analyses[index].partition_index ===
            graph.analyses[reference.analysis_index].partition_index,
        ),
      );
    }
  }
}

export function pairedDispatch(graph, returned = false) {
  assert.equal(graph.termination, "worklist-exhausted");
  const sites = returned ? tableReads.returned : tableReads.paired,
    jump = returned ? 0xe913 : 0xe015;
  assert.deepEqual(targetPairs(graph, jump), expectedPairs(paired));
  tableEvidence(graph, sites, [0xe2ff, 0xe3ff, 0xe4ff], paired);
  pointerWriters(graph, jump, returned ? [0xe906, 0xe90b] : [0xe008, 0xe00d]);
  for (const edge of edgesAt(graph, jump)) {
    const value = selection(graph, edge.target_partition_index, sites[0]);
    assert.equal(edge.target_address, paired[value].address);
    assert.equal(
      stateOf(graph, graph.nodes[edge.to]).banks[6],
      paired[value].bank,
    );
  }
  if (returned) {
    const binding = graph.continuations.find(
      (item) =>
        graph.nodes[item.call_node_index].address === entries.returnedIndex,
    );
    assert.ok(binding);
    assert.ok(
      graph.edges.some(
        (edge) =>
          edge.kind === "return" &&
          edge.continuation_index === binding.index &&
          edge.target_address === sites[0],
      ),
    );
  }
}

export function fullByte(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.deepEqual(targetPairs(graph, 0xe112), expectedPairs(targets("full")));
  tableEvidence(
    graph,
    tableReads.full,
    [0xe600, 0xe700, 0xe800],
    targets("full"),
  );
  assert.deepEqual(
    sorted(
      graph.analyses
        .filter(
          (analysis) =>
            analysis.refinement !== null &&
            graph.nodes[analysis.node_index].address === 0xe102,
        )
        .map((analysis) => analysis.refinement.value),
    ),
    Array.from({ length: 256 }, (_, index) => index),
  );
  assert.deepEqual(graph.pending_refinements, []);
}

export function copiedIndex(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.deepEqual(targetPairs(graph, 0xe056), expectedPairs(paired));
  tableEvidence(
    graph,
    [0xe046, 0xe04b, 0xe050],
    [0xe2ff, 0xe3ff, 0xe4ff],
    paired,
  );
  pointerWriters(graph, 0xe056, [0xe049, 0xe04e]);
  const refinements = graph.analyses.filter(
    (analysis) =>
      graph.nodes[analysis.node_index].address === 0xe046 &&
      analysis.refinement !== null,
  );
  assert.equal(refinements.length, 2);
  assert.ok(
    refinements.every(
      (analysis) =>
        analysis.refinement.equal_registers.includes("x") &&
        analysis.refinement.equal_registers.includes("y"),
    ),
  );
}

export function transformed(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.deepEqual(
    targetPairs(graph, 0xe195),
    expectedPairs(targets("transformed")),
  );
  const reads = referencesAt(graph, 0xe18b).filter(
    (item) => item.address === 0xe400 || item.address === 0xe401,
  );
  assert.deepEqual(sorted(reads.map((item) => item.address)), [0xe400, 0xe401]);
  for (const reference of reads) {
    const value = selection(
      graph,
      graph.analyses[reference.analysis_index].partition_index,
      0xe185,
    );
    assert.equal(reference.address, 0xe3ff + value + 1);
  }
}

export function independent(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.deepEqual(
    targetPairs(graph, 0xe1d9),
    expectedPairs(targets("independent")),
  );
  const pairs = edgesAt(graph, 0xe1d9).map((edge) => [
    selection(graph, edge.target_partition_index, 0xe1c5),
    selection(graph, edge.target_partition_index, 0xe1cf),
  ]);
  assert.deepEqual(
    pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    [
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ],
  );
}

export function wrapped(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.deepEqual(
    targetPairs(graph, 0xe539),
    expectedPairs([
      { bank: 1, address: 0x8310 },
      { bank: 1, address: 0x8320 },
    ]),
  );
  for (const value of [0, 1]) {
    const references = referencesAt(graph, 0xe531).filter(
        (item) =>
          selection(
            graph,
            graph.analyses[item.analysis_index].partition_index,
            0xe531,
          ) === value,
      ),
      pointers = references.filter((item) => item.kind === "pointer"),
      read = references.find((item) => item.kind === "read");
    assert.deepEqual(
      pointers.map((item) => item.address),
      value === 0 ? [255, 0] : [0, 1],
    );
    assert.equal(read.address, value === 0 ? 0x8100 : 0x8281);
    assert.equal(read.value, value === 0 ? 0x10 : 0x20);
    for (const pointer of pointers) {
      const expectedWriter = new Map([
        [255, 0xe522],
        [0, 0xe526],
        [1, 0xe52a],
      ]).get(pointer.address);
      assert.deepEqual(
        pointer.ram_origins.flatMap((item) =>
          item.writer_witness_indices.map(
            (index) =>
              graph.nodes[graph.write_witnesses[index].node_index].address,
          ),
        ),
        [expectedWriter],
      );
    }
  }
}

export function mixed(graph) {
  assert.deepEqual(targetPairs(graph, 0xe58e), expectedPairs([paired[0]]));
  const reads = referencesAt(graph, 0xe585).filter(
    (item) => item.kind === "read",
  );
  assert.equal(reads.find((item) => item.address === 0x7fff).value, null);
  assert.equal(reads.find((item) => item.address === 0x8000).value, 0x10);
  assert.ok(
    graph.frontiers.some(
      (item) =>
        item.from !== null &&
        graph.nodes[item.from].address === 0xe58e &&
        selection(graph, item.partition_index, 0xe585) === 0,
    ),
  );
}

export function mmc1(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  const edges = edgesAt(graph, 0xc029);
  assert.equal(edges.length, 2);
  for (const edge of edges) {
    const value = selection(graph, edge.target_partition_index, 0xc005),
      target = graph.nodes[edge.to],
      mapper = stateOf(graph, target);
    assert.equal(mapper.prg_bank, value);
    assert.deepEqual(mapper.shift_bits, []);
    assert.equal(target.address, paired[value].address);
    assert.equal(
      target.file_offsets[0],
      PRG + value * 16384 + target.address - 0x8000,
    );
    assert.ok(
      graph.contexts.some(
        (context) =>
          context.state.mapper === 1 &&
          JSON.stringify(context.state.shift_bits) === JSON.stringify([value]),
      ),
    );
  }
}

export function computed(graph, opaque = false) {
  const callAddress = opaque ? entries.opaque : entries.computedCall,
    binding = graph.continuations.find(
      (item) => graph.nodes[item.call_node_index].address === callAddress,
    );
  assert.ok(binding);
  const jumps = edgesAt(graph, 0xe853, "stack-jump");
  assert.equal(jumps.length, 2);
  for (const edge of jumps) {
    const value = selection(graph, edge.target_partition_index, 0xe845);
    assert.equal(edge.target_address, value === 0 ? 0x8111 : 0x8222);
    assert.equal(edge.target_invocation_index, binding.callee_invocation_index);
    assert.equal(edge.continuation_index, null);
    assert.equal(edge.summary_index, null);
  }
  const returns = graph.edges.filter(
    (edge) =>
      edge.kind === "return" &&
      edge.continuation_index === binding.index &&
      edge.resolution === "resolved",
  );
  assert.equal(returns.length, 2);
  for (const edge of returns) {
    const summary = graph.return_summaries[edge.summary_index],
      value = stateOf(graph, graph.nodes[edge.to]).banks[6] === 1 ? 0 : 1;
    assert.equal(edge.target_address, opaque ? 0xeb03 : entries.callerResume);
    assert.equal(summary.cpu_out.a, value === 0 ? 0x31 : 0x55);
    assert.equal(summary.cpu_out.sp, opaque ? null : 0xfd);
    assert.equal(
      summary.return_proof,
      opaque ? "relative-bytes" : "physical-bytes",
    );
    assert.equal(graph.nodes[edge.from].address, value === 0 ? 0x8113 : 0x8224);
  }
  const physicalReads = referencesAt(graph, 0xe853).filter(
    (item) => item.kind === "read",
  );
  assert.deepEqual(
    [...new Set(physicalReads.map((item) => item.address))].sort(
      (a, b) => a - b,
    ),
    opaque ? [null] : [0x1fa, 0x1fb],
  );
  if (opaque) {
    assert.ok(
      !graph.data_references.some(
        (item) =>
          item.address !== null && item.address >= 256 && item.address < 512,
      ),
    );
    for (const reference of physicalReads) {
      assert.deepEqual(reference.ram_origins, []);
      assert.equal(reference.relative_stack_origins.length, 1);
      assert.ok(
        reference.relative_stack_origins[0].writer_witness_indices.every(
          (index) =>
            [0xe84e, 0xe852].includes(
              graph.nodes[
                graph.relative_stack_write_witnesses[index].node_index
              ].address,
            ),
        ),
      );
    }
  } else
    for (const reference of physicalReads)
      assert.ok(
        reference.ram_origins
          .flatMap((item) => item.writer_witness_indices)
          .every((index) =>
            [0xe84e, 0xe852].includes(
              graph.nodes[graph.write_witnesses[index].node_index].address,
            ),
          ),
      );
}

export function recursive(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  const outer = graph.continuations.find(
    (item) => graph.nodes[item.call_node_index].address === 0xe983,
  );
  assert.ok(outer);
  assert.ok(
    graph.continuations.some(
      (item) => graph.nodes[item.call_node_index].address === 0xea04,
    ),
  );
  const returns = graph.edges.filter(
    (edge) =>
      edge.kind === "return" &&
      edge.continuation_index === outer.index &&
      edge.resolution === "resolved",
  );
  assert.ok(returns.length > 0);
  assert.ok(
    returns.every(
      (edge) => graph.return_summaries[edge.summary_index].cpu_out.a === 0x7c,
    ),
  );
  assert.deepEqual(graph.pending_returns, []);
}

export function finiteLoop(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.deepEqual(
    sorted([
      ...new Set(
        referencesAt(graph, 0xeb82).flatMap((item) => item.file_offsets),
      ),
    ]),
    [PRG + 122880 + 0x200, PRG + 122880 + 0x2ff, PRG + 122880 + 0x300],
  );
  assert.ok(graph.partitions.length <= 3);
  assert.deepEqual(graph.pending_refinements, []);
}

export function budget(graph, reason, nextValue) {
  assert.equal(graph.termination, reason);
  assert.ok(graph.pending_refinements.length + graph.pending.length > 0);
  assert.equal(graph.pending_refinements.length, 1);
  assert.equal(graph.pending_refinements[0].next_value, nextValue);
  const completed = graph.analyses.filter(
    (analysis) => analysis.refinement !== null,
  );
  assert.deepEqual(
    sorted(completed.map((analysis) => analysis.refinement.value)),
    Array.from({ length: nextValue }, (_, index) => index),
  );
  for (const pending of graph.pending_refinements) {
    assert.equal(pending.register, "x");
    assert.ok(pending.next_value >= 0 && pending.next_value <= 255);
    assert.ok(graph.partitions[pending.partition_index]);
    assert.ok(graph.nodes[pending.node_index]);
  }
}
