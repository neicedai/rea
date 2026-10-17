import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  matrix,
  partial,
  stack,
  entries,
  calls,
  mmc3Fixture,
  mmc3Initial,
  MMC3_PRG,
  mmc1Fixture,
  mmc1Initial,
} from "./verify-package-nes-discovery-branches-fixture.mjs";
import {
  checkDiscoveryCoverage,
  checkDiscoveryWitnesses,
} from "./verify-package-nes-discovery-graph.mjs";
import * as checks from "./verify-package-nes-discovery-branches-checks.mjs";

async function writeFixtures(workspace) {
  const definitions = [
    {
      name: "flags",
      bytes: fixture(),
      initial: { mapper: 0 },
      prg: 16,
      size: 32768,
    },
    {
      name: "mmc3",
      bytes: mmc3Fixture(),
      initial: mmc3Initial(),
      prg: MMC3_PRG,
      size: 65536,
    },
    {
      name: "mmc1",
      bytes: mmc1Fixture(),
      initial: mmc1Initial(0),
      prg: 16,
      size: 65536,
    },
  ];
  for (const definition of definitions) {
    definition.path = join(
      workspace,
      `discovery-branches-${definition.name}.nes`,
    );
    definition.digest = createHash("sha256")
      .update(definition.bytes)
      .digest("hex");
    await writeFile(definition.path, definition.bytes);
  }
  return definitions;
}

/** Static flag predicates prune only incompatible edges and retain unknown cases. */
export async function verifyPackageNesDiscoveryBranches(invoke, workspace) {
  const definitions = await writeFixtures(workspace);
  let workflows = 0;
  const run = async (index, roots, extra = {}) => {
    const definition = definitions[index],
      evidence = await invoke("discover-nes-code", {
        path: definition.path,
        initial: definition.initial,
        roots,
        ...extra,
      }),
      report = evidence.normalized_result,
      graph = report.code_discovery;
    workflows++;
    assert.equal(evidence.subject.digest.sha256, definition.digest);
    assert.equal(report.artifact.path, definition.path);
    assert.deepEqual(report.header.header, [
      ...definition.bytes.subarray(0, 16),
    ]);
    assert.equal(graph.status, "derived");
    checkDiscoveryCoverage(
      graph,
      definition.bytes,
      definition.prg,
      definition.size,
    );
    checkDiscoveryWitnesses(graph);
    checks.conditions(graph);
    return graph;
  };
  checks.vectors(
    await run(
      0,
      matrix.map((item) => item.entry),
    ),
    matrix,
  );
  const partialGraph = await run(
    0,
    partial.map((item) => item.entry),
  );
  checks.vectors(partialGraph, partial);
  checks.partialFacts(partialGraph);
  const stackGraph = await run(
    0,
    stack.map((item) => item.entry),
  );
  checks.vectors(stackGraph, stack);
  checks.stacks(stackGraph);
  checks.returnedFlags(
    await run(
      1,
      calls.map((item) => item.entry),
    ),
  );
  checks.joined(await run(0, [entries.join, entries.zero, entries.repeated]));
  checks.wrapped(await run(0, [entries.wrapTaken, entries.wrapFall]));
  checks.crossing(
    await run(1, [0xe300], {
      additional_roots: [{ entry: 0xe300, initial: mmc3Initial(5) }],
    }),
  );
  checks.serial(
    await run(2, [0xc000], {
      additional_roots: [{ entry: 0xc000, initial: mmc1Initial(1) }],
    }),
  );
  for (const max_work_items of [4, 7])
    checks.budget(
      await run(0, [entries.join], { max_work_items }),
      max_work_items,
    );
  for (const definition of definitions)
    assert.deepEqual(await readFile(definition.path), definition.bytes);
  assert.equal(workflows, 10);
  return {
    ok: true,
    workflows,
    known_flag_pruning: true,
    conditioned_candidates: true,
    join_reanalysis: true,
    stack_call_flags: true,
    banked_branches: true,
    wrapped_targets: true,
    budget_frontiers: true,
    original_unchanged: true,
    scope:
      "Literal static 6502 flag candidates and edge predicates with caller-qualified MMC1/MMC3 bank identity. Unknown flags retain both conditioned alternatives; no observed execution, exact unknown-byte branch-range or whole-game claim",
  };
}
