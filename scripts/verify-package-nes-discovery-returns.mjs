import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  initial,
  addresses,
  PRG,
  PRG_SIZE,
} from "./verify-package-nes-discovery-returns-fixture.mjs";
import {
  checkDiscoveryCoverage,
  checkDiscoveryWitnesses,
  nodesAt,
} from "./verify-package-nes-discovery-graph.mjs";
import * as checks from "./verify-package-nes-discovery-returns-checks.mjs";

/** Independent matched-return, input-correlation and qualified-stack oracles. */
export async function verifyPackageNesDiscoveryReturns(invoke, workspace) {
  const bytes = fixture(),
    path = join(workspace, "discovery-returns.nes"),
    sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes);
  let workflows = 0;
  const run = async (roots, overrides = {}) => {
    workflows++;
    const evidence = await invoke("discover-nes-code", {
      path,
      initial: initial(),
      roots,
      ...overrides,
    });
    assert.equal(evidence.subject.digest.sha256, sha256);
    const report = evidence.normalized_result;
    assert.deepEqual(report.header.header, [...bytes.subarray(0, 16)]);
    assert.equal(report.artifact.path, path);
    const graph = report.code_discovery;
    assert.equal(graph.status, "derived");
    checkDiscoveryCoverage(graph, bytes, PRG, PRG_SIZE);
    checkDiscoveryWitnesses(graph);
    return graph;
  };
  checks.bankSwitch(await run([addresses.bankSwitch.caller]));
  checks.preserved(
    await run([addresses.preserved.caller, addresses.preserved.rts]),
  );
  checks.ramPointer(await run([addresses.ramPointer.caller]));
  checks.nested(await run([addresses.nested.caller]));
  checks.paired(await run(addresses.paired.roots));
  checks.entryBanks(
    await run([addresses.entryBanks.caller], {
      additional_roots: [
        { entry: addresses.entryBanks.caller, initial: initial(5) },
      ],
    }),
  );
  checks.recursive(await run([addresses.recursive.caller]));
  const nonReturning = await run([addresses.nonReturn.caller]);
  checks.noReturn(nonReturning, [addresses.nonReturn]);
  assert.equal(nonReturning.termination, "worklist-exhausted");
  assert.equal(
    nodesAt(nonReturning, addresses.nonReturn.unreachableRts).length,
    0,
  );
  checks.damagedFrames(
    await run([
      addresses.brokenStack.caller,
      addresses.unknownStore.caller,
      addresses.physicalJump.root,
    ]),
  );
  checks.stacks(
    await run([
      addresses.knownStack.root,
      addresses.opaqueStack.caller,
      addresses.opaqueSimple.caller,
    ]),
  );
  checks.budget(
    await run([addresses.ramPointer.caller], { max_work_items: 7 }),
    "work-item-budget",
  );
  checks.budget(
    await run([addresses.ramPointer.caller], { max_invocations: 1 }),
    "invocation-budget",
  );
  checks.budget(
    await run(addresses.paired.roots, { max_continuations: 1 }),
    "continuation-budget",
  );
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(workflows, 13);
  return {
    ok: true,
    workflows,
    matched_returns: true,
    correlated_callers: true,
    stack_qualification: true,
    recursive_fixedpoint: true,
    return_budgets: true,
    original_unchanged: true,
    scope:
      "Static qualified JSR/RTS return-state summaries with explicit mapper assumptions and exact write witnesses; no observed execution, whole-ROM, physical timing or real-provider claim",
  };
}
