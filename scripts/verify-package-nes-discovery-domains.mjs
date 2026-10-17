import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  bankFixture,
  entries,
  mmc1Initial,
  mmc3Initial,
  rotations,
} from "./verify-package-nes-discovery-domains-fixture.mjs";
import {
  checkDiscoveryCoverage,
  checkDiscoveryWitnesses,
} from "./verify-package-nes-discovery-graph.mjs";
import * as checks from "./verify-package-nes-discovery-domains-checks.mjs";

/** Authored exact-byte-domain oracle, independent of the production abstract interpreter. */
export async function verifyPackageNesDiscoveryDomains(invoke, workspace) {
  const mmc1 = bankFixture(1),
    mmc3 = bankFixture(4);
  const definitions = [
    { name: "nrom", bytes: fixture(), initial: { mapper: 0 }, prgSize: 32768 },
    { name: "mmc1", ...mmc1, initial: mmc1Initial(), prgSize: 65536 },
    { name: "mmc3", ...mmc3, initial: mmc3Initial(), prgSize: 65536 },
  ];
  for (const definition of definitions) {
    definition.path = join(
      workspace,
      `discovery-domains-${definition.name}.nes`,
    );
    definition.digest = createHash("sha256")
      .update(definition.bytes)
      .digest("hex");
    await writeFile(definition.path, definition.bytes);
  }
  let workflows = 0;
  const run = async (index, roots, extra = {}) => {
    const definition = definitions[index];
    const evidence = await invoke("discover-nes-code", {
      path: definition.path,
      initial: definition.initial,
      roots,
      ...extra,
    });
    workflows++;
    assert.equal(evidence.subject.digest.sha256, definition.digest);
    const report = evidence.normalized_result,
      graph = report.code_discovery;
    assert.equal(report.artifact.path, definition.path);
    assert.deepEqual(report.header.header, [
      ...definition.bytes.subarray(0, 16),
    ]);
    assert.equal(graph.status, "derived");
    checkDiscoveryCoverage(graph, definition.bytes, 16, definition.prgSize);
    checkDiscoveryWitnesses(graph);
    checks.pools(graph);
    if (extra.max_work_items === undefined)
      assert.equal(graph.termination, "worklist-exhausted");
    return graph;
  };
  checks.range(await run(0, [entries.range]));
  checks.negative(await run(0, [entries.negative]));
  checks.resultNz(await run(0, [entries.zero, entries.nonzero]));
  checks.independent(await run(0, [entries.independent]));
  checks.killed(
    await run(0, [entries.increment, entries.clc, entries.unknownOperand]),
  );
  checks.copies(await run(0, [entries.copies]));
  checks.joined(await run(0, [entries.joined, entries.persisted]));
  checks.calls(await run(0, [entries.call, entries.changedCall]));
  checks.banked(await run(2, [0xe000]), 4, mmc3);
  checks.banked(await run(1, [0xe000]), 1, mmc1);
  checks.budget(await run(0, [entries.range], { max_work_items: 6 }), 6);
  checks.correlatedRotations(
    await run(
      0,
      rotations.map((spec) => spec.entry),
    ),
  );
  for (const definition of definitions)
    assert.deepEqual(await readFile(definition.path), definition.bytes);
  assert.equal(workflows, 12);
  return {
    ok: true,
    workflows,
    exact_ranges: true,
    wrapped_compare_negative: true,
    result_predicates: true,
    independent_flag_sources: true,
    semantic_copies: true,
    nonconvex_joins: true,
    call_domain_effects: true,
    banked_domain_effects: true,
    budget_frontiers: true,
    correlated_rotations: true,
    original_unchanged: true,
    scope:
      "Authored static byte-domain and C/Z/N source predicates with literal 6502 expectations, qualified MMC1/MMC3 bank writes and matched calls. No exact RAM-domain, observed execution, whole-game or hardware timing claim",
  };
}
