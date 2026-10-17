import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkDiscoveryCoverage as checkCoverage } from "./verify-package-nes-discovery-graph.mjs";
import {
  PRG,
  PRG_SIZE,
  contexts,
  entries,
  oracle,
  fixture,
  aliasFixture,
  mmc1Initial,
  mmc1SerialFixture,
} from "./verify-package-nes-discovery-fixture.mjs";

const sorted = (values) => [...new Set(values)].sort((a, b) => a - b);
const state = (graph, node) => graph.contexts[node.context_index].state;
const nodesAt = (graph, address) =>
  graph.nodes.filter((node) => node.address === address);
const edgesFrom = (graph, node, kind) =>
  graph.edges.filter((edge) => edge.from === node.index && edge.kind === kind);

function checkCrossWindows(graph) {
  for (const [bankSelect, expected] of [
    [6, oracle.crossingA],
    [0x46, oracle.crossingB],
  ]) {
    const crossing = nodesAt(graph, entries.crossing).find(
      (node) => state(graph, node).bank_select === bankSelect,
    );
    assert.ok(crossing);
    assert.equal(crossing.bytes_hex, expected.bytes);
    assert.deepEqual(crossing.file_offsets, expected.offsets);
    const call = edgesFrom(graph, crossing, "call");
    assert.equal(call.length, 1);
    assert.equal(call[0].target_address, expected.target);
    assert.equal(call[0].resolution, "resolved");
    assert.equal(call[0].target_context_index, crossing.context_index);
    assert.notEqual(call[0].to, null);
    assert.deepEqual(edgesFrom(graph, crossing, "after-call-candidate"), []);
    const continuation = graph.continuations.find(
      (item) => item.call_node_index === crossing.index,
    );
    assert.ok(continuation);
    assert.equal(
      continuation.caller_invocation_index,
      crossing.invocation_index,
    );
    assert.equal(
      continuation.callee_invocation_index,
      call[0].target_invocation_index,
    );
    assert.equal(continuation.return_address, 0xc002);
    const returned = graph.edges.filter(
      (edge) =>
        edge.kind === "return" &&
        edge.continuation_index === continuation.index &&
        edge.resolution === "resolved",
    );
    assert.equal(returned.length, 1);
    assert.equal(returned[0].target_address, 0xc002);
    assert.equal(returned[0].target_context_index, crossing.context_index);
    assert.equal(
      returned[0].target_invocation_index,
      crossing.invocation_index,
    );
    assert.notEqual(returned[0].to, null);
  }
  for (const node of nodesAt(graph, 0xc010)) {
    const jump = edgesFrom(graph, node, "jump");
    assert.equal(jump.length, 1);
    assert.equal(jump[0].to, node.index);
  }
  assert.equal(graph.termination, "worklist-exhausted");
  assert.deepEqual(graph.pending, []);
}

function checkHiddenSelect(graph) {
  const writes = nodesAt(graph, 0xe302);
  assert.equal(writes.length, 2);
  assert.deepEqual(
    sorted(writes.map((node) => state(graph, node).bank_select)),
    [6, 7],
  );
  for (const expected of oracle.hiddenSelectTargets) {
    const node = nodesAt(graph, 0xe305).find(
      (node) => state(graph, node).bank_select === expected.selected_register,
    );
    assert.ok(node);
    const edge = edgesFrom(graph, node, "jump")[0];
    assert.equal(edge.target_address, expected.address);
    assert.notEqual(edge.to, null);
    assert.equal(graph.nodes[edge.to].file_offsets[0], expected.file_offset);
    const before = writes.find(
      (candidate) =>
        state(graph, candidate).bank_select === expected.selected_register,
    );
    assert.deepEqual(state(graph, before).banks.slice(6), [1, 3]);
    assert.equal(
      state(graph, graph.nodes[edge.to]).banks[expected.selected_register],
      5,
    );
  }
}

function checkDispatch(graph) {
  const condition = nodesAt(graph, 0xe123)[0];
  assert.ok(condition);
  assert.equal(
    edgesFrom(graph, condition, "branch-taken")[0].target_address,
    0xe132,
  );
  assert.equal(
    edgesFrom(graph, condition, "branch-not-taken")[0].target_address,
    0xe125,
  );
  const actual = [0xe12f, 0xe13c].map((address) => {
    const node = nodesAt(graph, address)[0],
      edge = edgesFrom(graph, node, "jump")[0];
    assert.notEqual(edge.to, null);
    const target = graph.nodes[edge.to];
    return {
      bank: state(graph, target).banks[6],
      address: target.address,
      file_offset: target.file_offsets[0],
    };
  });
  assert.deepEqual(actual, oracle.dispatchPairs);
  for (const forbidden of oracle.forbiddenDispatchPairs)
    assert.ok(
      !graph.nodes.some((node) =>
        node.file_offsets.includes(forbidden.file_offset),
      ),
    );
  const pointerOffsets = graph.data_references
    .filter((reference) => reference.kind === "pointer")
    .flatMap((reference) => reference.file_offsets);
  assert.deepEqual(
    sorted(pointerOffsets),
    oracle.dispatchPointerOffsets.flat(),
  );
}

function checkRamPointer(graph) {
  const jump = nodesAt(graph, 0xe40a)[0],
    edge = edgesFrom(graph, jump, "jump")[0];
  assert.equal(edge.target_address, 0x8100);
  assert.notEqual(edge.to, null);
  assert.equal(graph.nodes[edge.to].file_offsets[0], PRG + 8448);
  const origins = graph.data_references
    .filter(
      (reference) =>
        reference.node_index === jump.index && reference.kind === "pointer",
    )
    .flatMap((reference) => reference.ram_origins)
    .map((origin) => ({
      address: origin.ram_address,
      writers: sorted(
        origin.writer_nodes.map((index) => graph.nodes[index].address),
      ),
    }))
    .sort((a, b) => a.address - b.address);
  assert.deepEqual(origins, [
    { address: 2, writers: [0xe403] },
    { address: 3, writers: [0xe408] },
  ]);
  const loaded = graph.data_references
    .filter((reference) =>
      [0xe400, 0xe405].includes(graph.nodes[reference.node_index].address),
    )
    .flatMap((reference) => reference.file_offsets);
  assert.deepEqual(sorted(loaded), oracle.dispatchPointerOffsets[0]);
}

function checkVectors(graph) {
  assert.deepEqual(
    graph.roots.map((root) => root.entry),
    ["reset", "nmi", "irq"],
  );
  for (const [root, sourceIndex] of graph.roots.map((root, index) => [
    root,
    [1, 0, 2][index],
  ])) {
    assert.equal(root.target_address, oracle.vectorTargets[sourceIndex]);
    assert.deepEqual(
      root.vector.map((byte) => byte.file_offset),
      [
        oracle.vectorOffsets[sourceIndex],
        oracle.vectorOffsets[sourceIndex] + 1,
      ],
    );
  }
  const frontier = graph.frontiers.find(
    (item) =>
      item.from !== null &&
      graph.nodes[item.from].address === entries.unknownPointer,
  );
  assert.ok(frontier);
  assert.equal(frontier.address, null);
  assert.equal(frontier.reason, "unknown-control-target");
  const unresolved = edgesFrom(graph, graph.nodes[frontier.from], "jump")[0];
  assert.equal(unresolved.target_address, null);
  assert.equal(unresolved.resolution, "unresolved");
  const data = graph.data_references.find(
    (reference) =>
      graph.nodes[reference.node_index].address === 0xe040 &&
      reference.address === 0x9000,
  );
  assert.ok(data);
  assert.deepEqual(data.file_offsets, [oracle.dataA.file_offset]);
  assert.ok(
    !graph.nodes.some((node) =>
      node.file_offsets.includes(oracle.dataA.file_offset),
    ),
  );
}

/** Independent rooted CFG, physical-byte partition and correlated bank-transfer oracles. */
export async function verifyPackageNesDiscovery(invoke, workspace) {
  const bytes = fixture(),
    alias = aliasFixture(),
    serial = mmc1SerialFixture(),
    path = join(workspace, "discovery-mmc3.nes"),
    aliasPath = join(workspace, "discovery-nrom-alias.nes"),
    serialPath = join(workspace, "discovery-mmc1-serial.nes");
  await writeFile(path, bytes);
  await writeFile(aliasPath, alias);
  await writeFile(serialPath, serial);
  const files = new Map([
    [path, bytes],
    [aliasPath, alias],
    [serialPath, serial],
  ]);
  let workflows = 0;
  const call = async (input) => {
    workflows++;
    const evidence = await invoke("discover-nes-code", input),
      original = files.get(input.path);
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(original).digest("hex"),
    );
    const report = evidence.normalized_result;
    assert.deepEqual(report.header.header, [...original.subarray(0, 16)]);
    assert.equal(report.artifact.path, input.path);
    const graph = report.code_discovery;
    if (graph.status === "derived")
      checkCoverage(
        graph,
        original,
        input.path === path ? PRG : 16,
        input.path === aliasPath ? 16384 : PRG_SIZE,
      );
    return graph;
  };
  const run = (overrides) =>
    call({ path, initial: contexts.a(), ...overrides });
  checkVectors(await run({}));
  const empty = await run({ roots: [] });
  assert.deepEqual(empty.roots, []);
  assert.deepEqual(empty.nodes, []);
  assert.deepEqual(empty.edges, []);
  assert.equal(empty.termination, "worklist-exhausted");
  assert.equal(empty.coverage.unclassified_bytes, PRG_SIZE);
  checkCrossWindows(
    await run({
      roots: [entries.crossing, 0xc010],
      additional_roots: [entries.crossing, 0xc010].map((entry) => ({
        entry,
        initial: contexts.b(),
      })),
    }),
  );
  checkHiddenSelect(
    await run({
      roots: [entries.hiddenSelect],
      additional_roots: [
        { entry: entries.hiddenSelect, initial: contexts.selectR7() },
      ],
    }),
  );
  checkDispatch(await run({ roots: [entries.dispatch] }));
  checkRamPointer(await run({ roots: [entries.ramPointer] }));
  checkLoopWitness(await run({ roots: [entries.joinedLoop] }));
  await knownPointers(run);
  await boundaries(run);
  checkAliases(
    await call({
      path: aliasPath,
      initial: { mapper: 0 },
      roots: [0x8000, 0xc000],
    }),
  );
  checkMmc1Serial(
    await call({
      path: serialPath,
      initial: mmc1Initial(0),
      roots: [0xc000],
      additional_roots: [{ entry: 0xc000, initial: mmc1Initial(1) }],
    }),
  );
  const unsupported = await run({
    initial: { mapper: 1 },
    roots: [entries.fixedLoop],
  });
  assert.equal(unsupported.status, "unsupported");
  assert.match(unsupported.reason, /mapper/iu);
  for (const [file, original] of files)
    assert.deepEqual(await readFile(file), original);
  assert.equal(workflows, 16);
  return {
    ok: true,
    workflows,
    rooted_cfg: true,
    raw_context_identity: true,
    mmc1_serial_context: true,
    correlated_dispatch: true,
    physical_coverage: true,
    original_unchanged: true,
    scope:
      "Synthetic static rooted MMC1/MMC3 discovery with explicit serial/register assumptions, unknown frontiers and physical-source coverage; no gameplay, whole-ROM, hardware timing or real-provider claim",
  };
}

function checkAliases(aliases) {
  assert.equal(aliases.nodes.length, 3);
  assert.deepEqual(
    aliases.nodes.map((node) => node.file_offsets),
    Array.from({ length: 3 }, () => [16, 17, 18]),
  );
  for (const root of aliases.roots) {
    const node = aliases.nodes[root.node_index],
      jump = edgesFrom(aliases, node, "jump")[0];
    assert.equal(node.invocation_index, root.invocation_index);
    assert.equal(jump.target_address, 0x8000);
    assert.equal(
      aliases.nodes[jump.to].invocation_index,
      root.invocation_index,
    );
    if (root.entry === 0x8000) assert.equal(jump.to, node.index);
  }
  assert.equal(aliases.coverage.decoded_bytes, 3);
  assert.deepEqual(aliases.nes_prg_views, []);
}

function checkMmc1Serial(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  assert.equal(graph.roots.length, 2);
  const roots = graph.roots.map((root) => graph.contexts[root.context_index]);
  assert.notEqual(roots[0].index, roots[1].index);
  assert.deepEqual(
    roots.map((context) => context.state.shift_bits),
    [[0], [1]],
  );
  assert.deepEqual(roots[0].mapping.prg_windows, roots[1].mapping.prg_windows);
  const jumps = nodesAt(graph, 0xc014);
  assert.equal(jumps.length, 2);
  const targets = jumps
    .map((node) => {
      const mapper = state(graph, node),
        jump = edgesFrom(graph, node, "jump")[0];
      assert.deepEqual(mapper.shift_bits, []);
      assert.equal(jump.target_address, 0x8000);
      assert.equal(jump.resolution, "resolved");
      assert.notEqual(jump.to, null);
      const target = graph.nodes[jump.to];
      return {
        bank: mapper.prg_bank,
        file_offset: target.file_offsets[0],
        bytes: target.bytes_hex,
      };
    })
    .sort((a, b) => a.bank - b.bank);
  assert.deepEqual(targets, [
    { bank: 0, file_offset: 16, bytes: "a911" },
    { bank: 1, file_offset: 16400, bytes: "a922" },
  ]);
  assert.deepEqual(
    sorted(
      graph.data_references
        .filter(
          (reference) =>
            reference.kind === "mapper-write" && reference.address === 0xe000,
        )
        .map((reference) => graph.nodes[reference.node_index].address),
    ),
    [0xc002, 0xc007, 0xc00c, 0xc011],
  );
}

function checkLoopWitness(graph) {
  assert.equal(graph.termination, "worklist-exhausted");
  const node = nodesAt(graph, 0xe502)[0];
  assert.ok(node);
  assert.equal(node.cpu_in.x, null);
  const read = graph.data_references.find(
    (reference) =>
      reference.node_index === node.index &&
      reference.kind === "read" &&
      reference.address === 0xe280,
  );
  assert.ok(read);
  assert.equal(read.value, 0x24);
  assert.deepEqual(read.file_offsets, [PRG + 57984]);
  const witness = graph.analyses[read.analysis_index];
  assert.equal(witness.node_index, node.index);
  assert.equal(witness.cpu_in.x, 0);
  assert.equal(witness.cpu_out.a, 0x24);
  assert.ok(
    graph.analyses.filter((analysis) => analysis.node_index === node.index)
      .length > 1,
  );
}

async function knownPointers(run) {
  const graph = await run({
    roots: [entries.knownPointer, entries.wrappedPointer],
  });
  const wrapped = nodesAt(graph, entries.wrappedPointer)[0];
  assert.equal(
    edgesFrom(graph, wrapped, "jump")[0].target_address,
    oracle.wrappedPointerTarget,
  );
  assert.deepEqual(
    sorted(
      graph.data_references
        .filter(
          (reference) =>
            reference.node_index === wrapped.index &&
            reference.kind === "pointer",
        )
        .flatMap((reference) => reference.file_offsets),
    ),
    [...oracle.wrappedPointerOffsets].sort((a, b) => a - b),
  );
  const known = nodesAt(graph, entries.knownPointer)[0];
  assert.equal(edgesFrom(graph, known, "jump")[0].target_address, 0x8100);
}

async function boundaries(run) {
  const unknown = await run({ roots: [entries.unknownStore] });
  assert.ok(unknown.frontiers.some((frontier) => frontier.address === 0x8000));
  assert.equal(nodesAt(unknown, 0x8000).length, 0);
  for (const [field, termination] of [
    ["max_nodes", "node-budget"],
    ["max_work_items", "work-item-budget"],
    ["max_contexts", "context-budget"],
  ]) {
    const graph = await run({
      roots: [
        field === "max_contexts" ? entries.hiddenSelect : entries.ramPointer,
      ],
      [field]: 1,
    });
    assert.equal(graph.termination, termination);
    assert.ok(
      graph.pending.length > 0 ||
        graph.frontiers.some((frontier) => /budget/u.test(frontier.reason)),
    );
    if (field === "max_nodes") assert.equal(graph.nodes.length, 1);
    if (field === "max_work_items") assert.equal(graph.work_items_processed, 1);
    if (field === "max_contexts") assert.equal(graph.contexts.length, 1);
  }
  const initial = contexts.a();
  initial.banks[6] = { mask: 7, value: 1 };
  const partial = await run({ initial, roots: [entries.knownPointer] });
  const target = nodesAt(partial, 0x8100)[0];
  assert.ok(target);
  assert.equal(target.file_offsets[0], PRG + 8448);
  assert.deepEqual(partial.nes_prg_views, []);
}
