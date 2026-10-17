import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { entries } from "./verify-package-nes-discovery-fixture.mjs";
import { addresses } from "./verify-package-nes-discovery-returns-fixture.mjs";

export const isNesDiscoveryLoopDeliveryInput = (input) =>
  Array.isArray(input.roots) &&
  input.roots.length === 1 &&
  input.roots[0] === entries.joinedLoop;

export const isNesDiscoveryReturnsRecursiveInput = (input) =>
  Array.isArray(input.roots) &&
  input.roots.length === 1 &&
  input.roots[0] === addresses.recursive.caller &&
  input.max_work_items === undefined;

const object = (value) => {
  assert.ok(
    typeof value === "object" && value !== null && !Array.isArray(value),
  );
  return value;
};

/** Verify recoverable default-stdio delivery without weakening the complete analysis. */
export async function verifyNesDiscoveryRetainedDelivery({
  response,
  evidence,
  workspace,
  invoke,
  validateBundle,
  operation = "discover_nes_code",
}) {
  object(response);
  object(evidence);
  assert.equal(response.isError, true);
  assert.equal(response.structuredContent, undefined);
  assert.ok(Array.isArray(response.content));
  assert.equal(response.content.length, 1);
  const content = object(response.content[0]);
  assert.equal(content.type, "text");
  assert.equal(typeof content.text, "string");
  const error = object(object(JSON.parse(content.text)).error),
    details = object(error.details),
    limits = object(details.reported_limits);
  assert.equal(error.code, "resource_constraint");
  assert.equal(error.category, "resource_constraint");
  assert.equal(error.retryable, false);
  assert.equal(details.operation, operation);
  assert.equal(details.resource, "transport");
  assert.equal(limits.boundary, "mcp-response");
  assert.equal(limits.constraint, "receive-buffer");
  assert.equal(limits.default_receive_buffer_bytes, 10 * 1024 * 1024);
  assert.equal(limits.result_budget_bytes, 10 * 1024 * 1024 - 1024);
  assert.ok(Number.isSafeInteger(limits.response_bytes_at_least));
  assert.ok(limits.response_bytes_at_least > limits.result_budget_bytes);
  assert.equal(limits.evidence_id, evidence.evidence_id);
  assert.deepEqual(limits.evidence_reference, {
    kind: "retained-evidence",
    evidence_id: evidence.evidence_id,
  });

  const summary = object(
    object(
      await invoke("get_evidence_bundle", {
        detail: "summary",
        filters: { evidence_id: evidence.evidence_id },
      }),
    ).result,
  );
  assert.equal(summary.kind, "evidence-bundle-summary");
  assert.deepEqual(summary.filters, { evidence_id: evidence.evidence_id });
  assert.equal(summary.matching_records, 1);
  assert.ok(summary.total_retained_records >= 1);
  assert.ok(Array.isArray(summary.records));
  assert.equal(summary.records.length, 1);
  const record = object(summary.records[0]);
  assert.equal(record.evidence_id, evidence.evidence_id);
  assert.equal(record.retention, "complete-record");
  assert.equal(record.operation, operation);
  assert.deepEqual(record.subject, evidence.subject);
  assert.deepEqual(record.provider, evidence.provider);

  const path = join(workspace, `retained-${evidence.evidence_id}.json`),
    exported = object(
      object(await invoke("export_evidence_bundle", { path })).result,
    );
  assert.equal(exported.path, path);
  assert.ok(exported.records >= 1);
  const bytes = await readFile(path);
  assert.equal(bytes.length, exported.bytes);
  const bundle = object(JSON.parse(bytes.toString("utf8")));
  await validateBundle(bundle);
  assert.ok(Array.isArray(bundle.records));
  const retained = bundle.records.filter(
    (item) => object(item).evidence_id === evidence.evidence_id,
  );
  assert.equal(retained.length, 1);
  assert.deepEqual(
    retained[0],
    evidence,
    "Exported retained Evidence must equal every CLI field, not only its ID",
  );
  return {
    evidence_id: evidence.evidence_id,
    bundle_path: path,
    bundle_bytes: bytes.length,
    complete_retention: true,
  };
}
