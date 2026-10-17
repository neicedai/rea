import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  entries,
} from "./verify-package-nes-discovery-values-fixture.mjs";
import {
  checkDiscoveryCoverage,
  checkDiscoveryWitnesses,
} from "./verify-package-nes-discovery-graph.mjs";
import * as checks from "./verify-package-nes-discovery-values-checks.mjs";

/** Literal 6502 expectations; no production interpreter or value-owner imports. */
export async function verifyPackageNesDiscoveryValues(invoke, workspace) {
  const bytes = fixture(),
    path = join(workspace, "discovery-current-values.nes"),
    digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes);
  let workflows = 0;
  const run = async (roots, extra = {}) => {
    const evidence = await invoke("discover-nes-code", {
      path,
      initial: { mapper: 0 },
      roots,
      ...extra,
    });
    workflows++;
    assert.equal(evidence.subject.digest.sha256, digest);
    const report = evidence.normalized_result,
      graph = report.code_discovery;
    assert.equal(report.artifact.path, path);
    assert.deepEqual(report.header.header, [...bytes.subarray(0, 16)]);
    assert.equal(graph.status, "derived");
    checkDiscoveryCoverage(graph, bytes, 16, 32768);
    checkDiscoveryWitnesses(graph);
    checks.pools(graph);
    if (
      extra.max_work_items === undefined &&
      extra.max_value_state_records === undefined
    )
      assert.equal(graph.termination, "worklist-exhausted");
    return graph;
  };
  checks.recursive(
    await run([entries.recursive], {
      max_work_items: 512,
      max_invocations: 64,
    }),
  );
  checks.mirror(await run([entries.mirror]));
  checks.ramCarrier(await run([entries.ramCarrier]));
  checks.stores(await run([entries.storedSet, entries.equalConstants]));
  checks.stacks(await run([entries.relativeSet, entries.physicalSet]));
  checks.io(await run([entries.io]));
  checks.calls(await run([entries.preservedCall, entries.changedCall]));
  checks.unknownStore(await run([entries.unknownStore]));
  checks.joined(await run([entries.joined]));
  const limit = 192;
  checks.budget(
    await run([entries.mirror, entries.ramCarrier], {
      max_value_state_records: limit,
    }),
    limit,
  );
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(workflows, 10);
  return {
    ok: true,
    workflows,
    stable_ram_recursion: true,
    mirrored_current_aliases: true,
    ram_only_predicates: true,
    nonconvex_stores: true,
    independent_equal_values: true,
    relative_and_physical_stack_domains: true,
    independent_io_reads: true,
    matched_call_ram_effects: true,
    unknown_store_invalidation: true,
    joined_initial_and_writer_sources: true,
    value_state_budget: true,
    original_unchanged: true,
    scope:
      "Authored rooted static current-value/RAM copy relationships, independent actual-write and conditional proofs, exact byte domains and matched-call effects. No observed execution, whole-game, provider or hardware timing claim; cancellation remains separately checked at the producer boundary.",
  };
}
