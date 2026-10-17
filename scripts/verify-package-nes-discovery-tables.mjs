import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  mmc1Fixture,
  initial,
  mmc1Initial,
  entries,
  PRG,
  PRG_SIZE,
} from "./verify-package-nes-discovery-tables-fixture.mjs";
import {
  checkDiscoveryCoverage,
  checkDiscoveryWitnesses,
} from "./verify-package-nes-discovery-graph.mjs";
import * as checks from "./verify-package-nes-discovery-tables-checks.mjs";

/** Conditional lookup candidates are linked by CPU semantics, never table heuristics. */
export async function verifyPackageNesDiscoveryTables(invoke, workspace) {
  const artifacts = new Map();
  let workflows = 0;
  const run = async (kind, root, overrides = {}) => {
    if (!artifacts.has(kind)) {
      const bytes = kind === "mmc1" ? mmc1Fixture() : fixture(kind),
        path = join(workspace, `discovery-tables-${kind}.nes`),
        digest = createHash("sha256").update(bytes).digest("hex");
      await writeFile(path, bytes);
      artifacts.set(kind, { bytes, path, digest });
    }
    const artifact = artifacts.get(kind);
    workflows++;
    const evidence = await invoke("discover-nes-code", {
      path: artifact.path,
      initial: kind === "mmc1" ? mmc1Initial() : initial(),
      roots: [root],
      ...overrides,
    });
    assert.equal(evidence.subject.digest.sha256, artifact.digest);
    const report = evidence.normalized_result,
      graph = report.code_discovery;
    assert.equal(report.artifact.path, artifact.path);
    assert.deepEqual(report.header.header, [...artifact.bytes.subarray(0, 16)]);
    assert.equal(graph.status, "derived");
    checkDiscoveryCoverage(
      graph,
      artifact.bytes,
      PRG,
      kind === "mmc1" ? 65536 : PRG_SIZE,
    );
    checkDiscoveryWitnesses(graph);
    checks.partitions(graph);
    return graph;
  };
  checks.pairedDispatch(await run("paired", entries.paired));
  checks.copiedIndex(await run("paired", entries.copiedIndex));
  checks.mmc1(await run("mmc1", 0xc000));
  checks.fullByte(await run("full", entries.full));
  checks.budget(
    await run("full", entries.full, { max_partitions: 9 }),
    "partition-budget",
    8,
  );
  checks.budget(
    await run("full", entries.full, { max_partition_selections: 7 }),
    "partition-selection-budget",
    7,
  );
  checks.budget(
    await run("full", entries.full, { max_work_items: 20 }),
    "work-item-budget",
    18,
  );
  checks.budget(
    await run("paired", entries.paired, { max_partitions: 1 }),
    "partition-budget",
    0,
  );
  checks.wrapped(await run("wrapped", entries.wrapped));
  checks.mixed(await run("mixed", entries.mixed));
  checks.transformed(await run("transformed", entries.transformed));
  checks.independent(await run("independent", entries.independent));
  checks.pairedDispatch(await run("paired", entries.returnedIndex), true);
  checks.computed(await run("rts", entries.computed));
  checks.computed(await run("rts", entries.opaque), true);
  checks.recursive(await run("paired", entries.recursive));
  checks.finiteLoop(await run("paired", entries.finiteLoop));
  for (const artifact of artifacts.values())
    assert.deepEqual(await readFile(artifact.path), artifact.bytes);
  assert.equal(workflows, 17);
  return {
    ok: true,
    workflows,
    correlated_tables: true,
    complete_byte_domain: true,
    serial_contexts: true,
    wrapped_pointers: true,
    computed_returns: true,
    partition_budgets: true,
    original_unchanged: true,
    scope:
      "Conditional static indexed-read dispatch, byte-domain partitions and actual-stack computed RTS with preserved table, mapper and writer witnesses; no observed execution, real-game or whole-ROM claim",
  };
}
