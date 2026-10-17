import assert from "node:assert/strict";
import { checkRecursive } from "./verify-package-nes-discovery-recursive-checks.mjs";
import {
  addresses,
  oracle,
  PRG,
} from "./verify-package-nes-discovery-returns-fixture.mjs";
import {
  nodesAt,
  stateOf,
  edgesFrom,
  ramCell,
} from "./verify-package-nes-discovery-graph.mjs";

const resolvedReturns = (graph, continuation) =>
  graph.edges.filter(
    (edge) =>
      edge.kind === "return" &&
      edge.resolution === "resolved" &&
      edge.continuation_index === continuation.index,
  );

function matched(graph, callAddress, callerInvocation) {
  const candidates = graph.continuations.filter(
    (continuation) =>
      graph.nodes[continuation.call_node_index].address === callAddress &&
      (callerInvocation === undefined ||
        continuation.caller_invocation_index === callerInvocation),
  );
  assert.equal(
    candidates.length,
    1,
    `One call binding at ${callAddress.toString(16)}`,
  );
  const continuation = candidates[0],
    returns = resolvedReturns(graph, continuation);
  assert.ok(
    returns.length > 0,
    `Matched return at ${callAddress.toString(16)}`,
  );
  for (const edge of returns) {
    const summary = graph.return_summaries[edge.summary_index];
    assert.equal(
      summary.invocation_index,
      continuation.callee_invocation_index,
    );
    assert.equal(summary.return_node_index, edge.from);
    assert.equal(summary.return_analysis_index, edge.analysis_index);
    assert.equal(summary.context_index, edge.target_context_index);
    assert.equal(
      edge.target_invocation_index,
      continuation.caller_invocation_index,
    );
    assert.equal(edge.target_address, continuation.return_address);
    assert.ok(
      continuation.call_analysis_indices.every(
        (index) =>
          graph.analyses[index].node_index === continuation.call_node_index,
      ),
    );
    assert.notEqual(edge.to, null);
    assert.equal(
      graph.nodes[edge.to].invocation_index,
      continuation.caller_invocation_index,
    );
    assert.equal(summary.frame.intact, true);
  }
  return {
    continuation,
    returns,
    first: graph.nodes[returns[0].to],
    summary: graph.return_summaries[returns[0].summary_index],
  };
}

export function bankSwitch(graph) {
  const { first, summary } = matched(graph, addresses.bankSwitch.caller);
  assert.equal(first.address, addresses.bankSwitch.continuation);
  assert.equal(first.file_offsets[0], oracle.switched.file_offset);
  assert.equal(first.bytes_hex, oracle.switched.bytes);
  assert.equal(first.cpu_in.a, oracle.switched.a_in);
  assert.equal(summary.cpu_out.a, oracle.switched.a_in);
  assert.equal(stateOf(graph, first).banks[6], 5);
  assert.ok(
    !graph.nodes.some((node) =>
      node.file_offsets.includes(oracle.oldContinuationOffset),
    ),
  );
  assert.equal(
    graph.edges.filter((edge) => edge.kind === "after-call-candidate").length,
    0,
  );
}

export function preserved(graph) {
  const { first, summary, continuation } = matched(
    graph,
    addresses.preserved.caller,
  );
  assert.equal(first.file_offsets[0], oracle.preserved.file_offset);
  assert.equal(first.cpu_in.a, 0x33);
  assert.equal(stateOf(graph, first).banks[6], 1);
  assert.equal(summary.cpu_out.a, 0x33);
  const loaded = nodesAt(graph, 0x8046).find(
    (node) => node.invocation_index === first.invocation_index,
  );
  assert.ok(loaded);
  assert.equal(loaded.cpu_out.a, 0x33);
  const read = graph.data_references.find(
    (reference) =>
      reference.node_index === loaded.index && reference.address === 16,
  );
  assert.ok(read);
  assert.equal(read.value, 0x33);
  const origin = read.ram_origins[0];
  assert.deepEqual(
    origin.writer_nodes.map((index) => graph.nodes[index].address),
    [0x8043],
  );
  const rootRts = graph.roots.find(
    (root) => root.entry === addresses.preserved.rts,
  );
  assert.ok(rootRts);
  assert.notEqual(
    rootRts.invocation_index,
    continuation.callee_invocation_index,
  );
  assert.equal(
    graph.edges.filter(
      (edge) =>
        edge.kind === "return" &&
        edge.resolution === "resolved" &&
        graph.nodes[edge.from].invocation_index === rootRts.invocation_index,
    ).length,
    0,
  );
  assert.ok(
    graph.frontiers.some((frontier) => frontier.from === rootRts.node_index),
  );
}

export function ramPointer(graph) {
  const { first, summary } = matched(graph, addresses.ramPointer.caller);
  assert.equal(first.address, 0xe203);
  assert.equal(first.cpu_in.a, 0x44);
  const jump = edgesFrom(graph, first, "jump")[0];
  assert.equal(jump.target_address, 0x8100);
  assert.equal(graph.nodes[jump.to].file_offsets[0], PRG + 8448);
  for (const [address, expected] of [
    [2, 0],
    [3, 0x81],
  ])
    assert.equal(ramCell(graph, summary.ram_out, address).value, expected);
  const origins = graph.data_references
    .filter(
      (reference) =>
        reference.node_index === first.index && reference.kind === "pointer",
    )
    .flatMap((reference) => reference.ram_origins);
  assert.deepEqual(
    origins.map((origin) => origin.ram_address).sort((a, b) => a - b),
    [2, 3],
  );
  for (const [index, address] of [2, 3].entries()) {
    const origin = origins.find((origin) => origin.ram_address === address);
    assert.deepEqual(
      origin.writer_witness_indices.map(
        (index) => graph.nodes[graph.write_witnesses[index].node_index].address,
      ),
      [oracle.pointerWriters[index]],
    );
  }
}

export function nested(graph) {
  const outer = matched(graph, addresses.nested.caller),
    inner = matched(
      graph,
      addresses.nested.outer,
      outer.continuation.callee_invocation_index,
    );
  assert.equal(inner.first.address, addresses.nested.outerContinuation);
  assert.equal(stateOf(graph, inner.first).banks[6], 5);
  assert.equal(outer.first.address, addresses.nested.continuation);
  assert.equal(outer.first.file_offsets[0], oracle.nested.file_offset);
  assert.equal(outer.first.cpu_in.a, 0x66);
  assert.equal(stateOf(graph, outer.first).banks[6], 5);
  assert.notEqual(
    inner.continuation.callee_invocation_index,
    outer.continuation.callee_invocation_index,
  );
}

export function paired(graph) {
  const actual = [];
  for (const expected of oracle.paired) {
    const { first, summary, continuation } = matched(graph, expected.caller);
    assert.equal(first.address, expected.continuation);
    assert.equal(first.cpu_in.a, 0x77);
    const callAnalysis = graph.analyses[continuation.call_analysis_indices[0]];
    assert.equal(callAnalysis.cpu_in.a, expected.a_in);
    const jump = edgesFrom(graph, first, "jump")[0],
      target = graph.nodes[jump.to];
    actual.push({
      bank: stateOf(graph, target).banks[6] & 63,
      address: target.address,
      file_offset: target.file_offsets[0],
    });
    const high = ramCell(graph, summary.ram_out, 3);
    assert.equal(high.value, expected.a_in);
    assert.equal(high.writer_witness_indices.length, 1);
    const witness = graph.write_witnesses[high.writer_witness_indices[0]];
    assert.equal(
      graph.nodes[witness.node_index].address,
      addresses.paired.writer,
    );
    assert.equal(
      graph.nodes[witness.node_index].invocation_index,
      continuation.callee_invocation_index,
    );
    assert.equal(witness.value, expected.a_in);
    assert.ok(
      witness.analysis_indices.every(
        (index) => graph.analyses[index].cpu_in.a === expected.a_in,
      ),
    );
  }
  assert.deepEqual(
    actual,
    oracle.paired.map((item) => ({
      bank: item.bank,
      address: item.target,
      file_offset: item.file_offset,
    })),
  );
  for (const forbidden of oracle.forbiddenPairedOffsets)
    assert.ok(
      !graph.nodes.some((node) => node.file_offsets.includes(forbidden)),
    );
}

export function entryBanks(graph) {
  const actual = [];
  for (const root of graph.roots) {
    const { first } = matched(
      graph,
      addresses.entryBanks.caller,
      root.invocation_index,
    );
    assert.equal(first.cpu_in.a, 0x64);
    const jump = edgesFrom(graph, first, "jump")[0],
      target = graph.nodes[jump.to];
    assert.equal(target.address, 0x8400);
    actual.push({
      bank: stateOf(graph, target).banks[6],
      file_offset: target.file_offsets[0],
    });
  }
  assert.deepEqual(
    actual.sort((a, b) => a.bank - b.bank),
    oracle.entryBankTargets,
  );
}

export function recursive(graph) {
  checkRecursive(graph, matched(graph, addresses.recursive.caller));
}

export function noReturn(graph, items) {
  for (const item of items) {
    const continuation = graph.continuations.find(
      (continuation) =>
        graph.nodes[continuation.call_node_index].address === item.caller,
    );
    assert.ok(continuation);
    assert.deepEqual(resolvedReturns(graph, continuation), []);
    assert.equal(nodesAt(graph, item.continuation).length, 0);
  }
  assert.equal(
    graph.edges.filter((edge) => edge.kind === "after-call-candidate").length,
    0,
  );
}

export function damagedFrames(graph) {
  physicalJump(graph);
  noReturn(graph, [addresses.brokenStack, addresses.unknownStore]);
  for (const address of [
    addresses.brokenStack.rts,
    addresses.unknownStore.rts,
  ]) {
    const rts = nodesAt(graph, address)[0];
    assert.ok(rts);
    assert.ok(graph.frontiers.some((frontier) => frontier.from === rts.index));
  }
  assert.ok(
    graph.data_references.some(
      (reference) =>
        graph.nodes[reference.node_index].address ===
          addresses.unknownStore.callee &&
        reference.kind === "write" &&
        reference.address === null,
    ),
  );
}

function physicalJump(graph) {
  const jump = nodesAt(graph, addresses.physicalJump.rts)[0];
  assert.ok(jump);
  const edge = edgesFrom(graph, jump, "stack-jump")[0];
  assert.ok(edge);
  assert.equal(edge.resolution, "resolved");
  assert.equal(edge.target_address, addresses.physicalJump.target);
  assert.equal(edge.continuation_index, null);
  assert.equal(edge.summary_index, null);
  assert.equal(graph.nodes[edge.to].invocation_index, jump.invocation_index);
  assert.equal(graph.nodes[edge.to].cpu_in.sp, 0xfd);
  const reads = graph.data_references
    .filter(
      (reference) =>
        reference.node_index === jump.index &&
        [0x1fc, 0x1fd].includes(reference.address),
    )
    .sort((a, b) => a.address - b.address);
  assert.deepEqual(
    reads.map((reference) => reference.value),
    [0xff, 0xee],
  );
  assert.deepEqual(
    reads.map((reference) =>
      reference.ram_origins.flatMap((origin) =>
        origin.writer_witness_indices.map(
          (index) =>
            graph.nodes[graph.write_witnesses[index].node_index].address,
        ),
      ),
    ),
    [[addresses.physicalJump.writers[0]], [addresses.physicalJump.writers[1]]],
  );
}

export function stacks(graph) {
  for (const [name, expected, frameKind] of [
    ["knownStack", oracle.knownStack, "physical"],
    ["opaqueStack", oracle.opaqueStack, "opaque"],
    ["opaqueSimple", oracle.opaqueSimple, "opaque"],
  ]) {
    const item = addresses[name],
      { first, summary, continuation } = matched(graph, item.caller);
    assert.equal(first.address, item.continuation);
    assert.equal(first.cpu_in.sp, expected.sp);
    assert.equal(first.cpu_in.a, expected.a);
    assert.equal(
      graph.invocations[continuation.callee_invocation_index].frame.kind,
      frameKind,
    );
    assert.equal(summary.frame.kind, frameKind);
    if (frameKind === "opaque") {
      assert.equal(summary.stack_target, item.continuation);
      assert.equal(summary.return_proof, "relative-bytes");
      assert.ok(
        !graph.data_references.some(
          (reference) =>
            graph.nodes[reference.node_index].invocation_index ===
              continuation.callee_invocation_index &&
            reference.address !== null &&
            reference.address >= 256 &&
            reference.address < 512,
        ),
      );
    } else {
      assert.equal(summary.stack_target, item.continuation);
      assert.equal(summary.return_proof, "physical-bytes");
      const pulled = graph.data_references.find(
        (reference) =>
          graph.nodes[reference.node_index].address === item.pull &&
          reference.address === oracle.knownStack.pushed_address,
      );
      assert.ok(pulled);
      assert.equal(pulled.value, 0x42);
      assert.deepEqual(
        pulled.ram_origins[0].writer_witness_indices.map(
          (index) =>
            graph.nodes[graph.write_witnesses[index].node_index].address,
        ),
        [item.push],
      );
    }
  }
}

export function budget(graph, kind) {
  assert.equal(graph.termination, kind);
  if (kind === "work-item-budget") {
    assert.equal(graph.work_items_processed, 7);
    assert.equal(graph.return_summaries.length, 1);
    assert.equal(graph.pending_returns.length, 1);
    assert.equal(graph.pending_returns[0].next_summary_offset, 0);
    assert.equal(nodesAt(graph, addresses.ramPointer.continuation).length, 0);
  } else if (kind === "invocation-budget") {
    assert.equal(graph.invocations.length, 1);
    assert.equal(nodesAt(graph, addresses.ramPointer.continuation).length, 0);
  } else {
    assert.equal(graph.continuations.length, 1);
    assert.ok(
      graph.pending.length > 0 ||
        graph.frontiers.some((frontier) => /budget/u.test(frontier.reason)),
    );
  }
}
