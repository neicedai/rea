import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  qualifyNesReferenceArtifacts,
  assertNesReferenceCoverage,
} from "./nes-reference-profile.mjs";
import { verifyNesReferenceSegment } from "./nes-reference-segment.mjs";

/** Only the actual MCP response boundary may request a smaller, uncommitted attempt. */
export class NesReferenceResponseBudgetError extends Error {
  constructor({ evidenceId, details }) {
    super("Reference trace exceeds the default MCP response budget");
    assert.ok(
      details !== null && typeof details === "object",
      "Response constraint details are required",
    );
    assert.equal(details.boundary, "mcp-response");
    assert.equal(details.evidence_id, evidenceId);
    assert.deepEqual(details.evidence_reference, {
      kind: "retained-evidence",
      evidence_id: evidenceId,
    });
    this.name = "NesReferenceResponseBudgetError";
    this.evidenceId = evidenceId;
    this.details = details;
  }
}

/** Verify every reference transition through contiguous, actual-state continuations. */
export async function verifyNesReferenceTrace({
  romPath,
  logPath,
  invoke,
  segmentInstructions,
}) {
  const path = resolve(romPath),
    referencePath = resolve(logPath);
  const [rom, log] = await Promise.all([
    readFile(path),
    readFile(referencePath),
  ]);
  const qualified = qualifyNesReferenceArtifacts(rom, log);
  const { rows, profile } = qualified;
  let limit = segmentInstructions ?? rows.length;
  assert.ok(
    Number.isSafeInteger(limit) && limit >= 1 && limit <= rows.length,
    "Segment instruction limit must fit the pinned reference row count",
  );
  let ram = new Map(),
    startRow = 0;
  let state = {
    entry: rows[0].address,
    cpu: structuredClone(rows[0].cpu),
    initial: { mapper: 0 },
    initial_cpu_bus: {
      model: "nmos-6502-bus",
      dma_reads: "absent",
      next_cycle_index: rows[0].cycle,
    },
  };
  let comparedAfterStates = 0,
    verifiedDataReads = 0,
    unresolvedDataReads = 0,
    ramBackedInstructions = 0;
  const segments = [],
    budgetAttempts = [];
  let finalTrace;
  while (true) {
    const orderedRam = [...ram.entries()].sort(([a], [b]) => a - b);
    const ramHandoff = orderedRam.map(([address, fact], initial_ram_index) => ({
      initial_ram_index,
      address,
      value: fact.value,
      writer: structuredClone(fact.writer),
    }));
    const input = {
      path,
      ...structuredClone(state),
      initial_ram: orderedRam.map(([address, fact]) => ({
        address,
        value: fact.value,
      })),
      max_instructions: Math.min(limit, rows.length - startRow),
    };
    let evidence;
    try {
      evidence = await invoke(structuredClone(input));
    } catch (cause) {
      if (!(cause instanceof NesReferenceResponseBudgetError)) throw cause;
      assert.ok(
        typeof cause.evidenceId === "string" && cause.evidenceId.length > 0,
        "A response constraint must retain its complete Evidence identity",
      );
      budgetAttempts.push({
        start_row: startRow,
        max_instructions: input.max_instructions,
        evidence_id: cause.evidenceId,
        details: cause.details,
      });
      assert.ok(
        input.max_instructions > 1,
        "A single reference instruction exceeds the default response budget",
      );
      limit = Math.ceil(input.max_instructions / 2);
      continue;
    }
    const checked = verifyNesReferenceSegment({
      evidence,
      rom,
      rows,
      startRow,
      segmentIndex: segments.length,
      input,
      ram,
    });
    const { trace, endRow } = checked;
    assert.equal(trace.instructions.length, endRow - startRow);
    if (trace.stop.reason === "instruction-budget") {
      assert.equal(
        trace.instructions.length,
        input.max_instructions,
        "A budget segment must commit its whole requested prefix",
      );
      assert.ok(
        endRow < rows.length,
        "Instruction budget cannot silently exhaust the reference",
      );
      assert.equal(
        trace.stop.address,
        rows[endRow].address,
        "Continuation entry must be the actual next reference PC",
      );
    } else {
      assert.equal(
        trace.stop.reason,
        profile.frontier.reason,
        "Unexpected early reference frontier",
      );
      assert.equal(
        endRow,
        profile.applied_instructions,
        "A matching short prefix does not satisfy complete reference coverage",
      );
    }
    segments.push({
      index: segments.length,
      start_row: startRow,
      end_row: endRow,
      evidence_id: evidence.evidence_id,
      previous_evidence_id: segments.at(-1)?.evidence_id ?? null,
      input,
      ram_handoff: ramHandoff,
      final_cpu: structuredClone(trace.final_cpu),
      final_mapper: structuredClone(trace.mapper_trace.final),
      final_cpu_bus: structuredClone(trace.cpu_bus.final),
      stop: structuredClone(trace.stop),
    });
    ram = checked.ram;
    comparedAfterStates += checked.comparedAfterStates;
    verifiedDataReads += checked.verifiedDataReads;
    unresolvedDataReads += checked.unresolvedDataReads;
    ramBackedInstructions += checked.ramBackedInstructions;
    startRow = endRow;
    if (trace.stop.reason !== "instruction-budget") {
      finalTrace = trace;
      break;
    }
    assert.ok(
      trace.instructions.length > 0,
      "A continuation must advance the committed prefix",
    );
    state = {
      entry: trace.stop.address,
      cpu: structuredClone(trace.final_cpu),
      initial: structuredClone(trace.mapper_trace.final),
      initial_cpu_bus: structuredClone(trace.cpu_bus.final),
    };
  }
  const summary = {
    ok: true,
    profile: profile.id,
    rom: { path, requested_path: romPath, sha256: qualified.rom_sha256 },
    reference: {
      path: referencePath,
      requested_path: logPath,
      sha256: qualified.reference_sha256,
      rows: rows.length,
    },
    initial_state_source: "pinned-reference-first-row-only",
    continuation_state_source:
      "preceding-committed-CPU-mapper-bus-and-RAM-writers",
    initial_ram_count: 0,
    initial_cycle: rows[0].cycle,
    final_committed_cycle: finalTrace.cpu_bus.final.next_cycle_index,
    final_cpu: structuredClone(finalTrace.final_cpu),
    compared_instructions: startRow,
    compared_after_states: comparedAfterStates,
    compared_bus_cycles:
      finalTrace.cpu_bus.final.next_cycle_index - rows[0].cycle,
    source_verified_bus_reads: verifiedDataReads,
    unresolved_bus_reads: unresolvedDataReads,
    ram_backed_instructions: ramBackedInstructions,
    reference_rows_not_applied: rows.length - startRow,
    reference_coverage: "complete-with-declared-unapplied-frontier",
    full_rom_pass: false,
    stop: structuredClone(finalTrace.stop),
    stop_segment: segments.length - 1,
    segments,
    budget_attempts: budgetAttempts,
    scope: profile.scope,
  };
  assertNesReferenceCoverage(summary, profile);
  const [finalRom, finalLog] = await Promise.all([
    readFile(path),
    readFile(referencePath),
  ]);
  assert.deepEqual(finalRom, rom, "ROM changed during reference verification");
  assert.deepEqual(finalLog, log, "Reference log changed during verification");
  return summary;
}
