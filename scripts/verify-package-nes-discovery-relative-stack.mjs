import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fixture,
  initial,
  entries,
  PRG,
  PRG_SIZE,
} from "./verify-package-nes-discovery-relative-stack-fixture.mjs";
import {
  checkDiscoveryCoverage,
  checkDiscoveryWitnesses,
} from "./verify-package-nes-discovery-graph.mjs";
import * as checks from "./verify-package-nes-discovery-relative-stack-checks.mjs";

/** Unknown physical SP never prevents a target proven by actual relative byte writes. */
export async function verifyPackageNesDiscoveryRelativeStack(
  invoke,
  workspace,
) {
  const bytes = fixture(),
    path = join(workspace, "discovery-relative-stack.nes"),
    digest = createHash("sha256").update(bytes).digest("hex");
  await writeFile(path, bytes);
  let workflows = 0;
  const run = async (root, overrides = {}) => {
    workflows++;
    const evidence = await invoke("discover-nes-code", {
        path,
        initial: initial(),
        roots: [root],
        ...overrides,
      }),
      report = evidence.normalized_result,
      graph = report.code_discovery;
    assert.equal(evidence.subject.digest.sha256, digest);
    assert.equal(report.artifact.path, path);
    assert.deepEqual(report.header.header, [...bytes.subarray(0, 16)]);
    assert.equal(graph.status, "derived");
    checkDiscoveryCoverage(graph, bytes, PRG, PRG_SIZE);
    checkDiscoveryWitnesses(graph);
    checks.relativeWitnesses(graph);
    return graph;
  };
  checks.direct(await run(entries.direct));
  checks.caller(await run(entries.caller));
  checks.partialCopy(await run(entries.partialCopy));
  checks.nested(await run(entries.nested));
  checks.joined(await run(entries.joined));
  checks.wrap(await run(entries.wrapCaller));
  checks.unresolved(await run(entries.lost), 0xe60a);
  checks.unresolved(await run(entries.knownToLost), 0xe64d);
  checks.unresolved(await run(entries.unknownAlias), 0xe68c);
  checks.nonstack(await run(entries.nonstack));
  checks.unresolved(await run(entries.stackAlias), 0xe70b);
  checks.rebase(await run(entries.knownRebase));
  checks.physical(await run(entries.physical));
  checks.status(await run(entries.status));
  checks.partialTarget(await run(entries.partialTarget));
  checks.budget(await run(entries.wrapCaller, { max_work_items: 130 }));
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(workflows, 16);
  return {
    ok: true,
    workflows,
    relative_byte_targets: true,
    matched_relative_returns: true,
    partial_stack_bits: true,
    stack_ring_coverage: true,
    alias_frontiers: true,
    physical_regression: true,
    original_unchanged: true,
    scope:
      "Conditional static current-SP-relative byte proofs with exact writer analyses, full 256-slot capacity and explicit loss/alias frontiers; no invented physical SP, observed execution or whole-ROM claim",
  };
}
