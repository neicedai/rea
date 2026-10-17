import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  integer,
  emptyOrigins,
  initialLedger,
  verifyCycles,
} from "./nes-reference-memory.mjs";

const qualifyInput = (input, trace, row) => {
  assert.equal(
    input.entry,
    row.address,
    "Segment entry must be the continuing reference PC",
  );
  assert.deepEqual(
    input.cpu,
    row.cpu,
    "Segment CPU input differs from the continuing state",
  );
  assert.equal(input.initial?.mapper, 0, "nestest requires NROM");
  assert.deepEqual(
    input.branch_choices ?? [],
    [],
    "nestest cannot supply branch choices",
  );
  assert.deepEqual(
    input.initial_prg_ram ?? [],
    [],
    "nestest cannot seed cartridge RAM",
  );
  for (const field of [
    "initial_ppu",
    "initial_apu",
    "initial_controllers",
    "initial_irq",
    "initial_cpu_dma",
    "initial_cpu_io",
    "initial_interrupts",
  ])
    assert.ok(
      input[field] === undefined || input[field] === null,
      `nestest cannot select ${field}`,
    );
  const bus = {
    model: "nmos-6502-bus",
    dma_reads: "absent",
    next_cycle_index: row.cycle,
  };
  assert.deepEqual(
    input.initial_cpu_bus,
    bus,
    "Segment requires consecutive nominal CPU bus input",
  );
  assert.deepEqual(
    trace.cpu_bus?.initial,
    bus,
    "Trace did not retain its bus input",
  );
  assert.deepEqual(
    trace.cpu_bus?.initialized,
    bus,
    "Trace changed its initial bus state",
  );
  assert.ok(
    !("io" in trace.cpu_bus) && !("dmc" in trace.cpu_bus),
    "nestest cannot select CPU device/DMC state",
  );
  assert.equal(trace.resolved_entry, row.address);
  assert.equal(trace.entry_vector, null);
  assert.equal(trace.entry_interrupt, null);
  assert.equal(
    trace.branch_choices_used,
    0,
    "nestest cannot consume branch assumptions",
  );
  assert.ok(
    !("interrupts" in trace) && !("cpu_dma" in trace),
    "nestest cannot select interrupt/DMA execution",
  );
};

const verifyFetch = (instruction, cycles) => {
  assert.deepEqual(instruction.mapper_origins, []);
  assert.equal(
    instruction.file_offsets.length,
    instruction.bytes_hex.length / 2,
  );
  for (const [byteIndex, fileOffset] of instruction.file_offsets.entries()) {
    const address = (instruction.address + byteIndex) & 65535;
    const reads = cycles.filter(
      (cycle) =>
        cycle.kind === "read" &&
        cycle.role === (byteIndex === 0 ? "opcode" : "operand") &&
        cycle.read.address === address,
    );
    assert.equal(
      reads.length,
      1,
      "Each instruction byte needs its actual opcode/operand bus read",
    );
    const read = reads[0].read;
    assert.equal(
      read.value,
      Number.parseInt(
        instruction.bytes_hex.slice(byteIndex * 2, byteIndex * 2 + 2),
        16,
      ),
    );
    assert.equal(fileOffset, read.file_offset);
    const origins = instruction.ram_origins
      .filter((origin) => origin.byte_index === byteIndex)
      .map((origin) => ({ ...origin, byte_index: 0 }));
    assert.deepEqual(
      origins,
      read.ram_origins,
      "Instruction byte source differs from its ordered bus fetch",
    );
  }
  assert.ok(
    instruction.ram_origins.every(
      (origin) => origin.byte_index < instruction.file_offsets.length,
    ),
    "RAM instruction origin exceeds its instruction bytes",
  );
};

const verifySemanticReads = (reads, cycles) => {
  assert.ok(Array.isArray(reads), "Semantic data reads are required");
  const actual = cycles
    .filter((cycle) => cycle.kind === "read")
    .map((cycle) => cycle.read);
  for (const read of reads) {
    emptyOrigins(read);
    assert.ok(
      actual.some((source) => {
        try {
          assert.deepEqual(source, read);
          return true;
        } catch {
          return false;
        }
      }),
      "Semantic read needs a matching authenticated ordered bus read",
    );
  }
};

const verifyFrontier = (stop, firstCycle, context) => {
  if (!("cpu_bus_frontier" in stop)) return;
  const frontier = stop.cpu_bus_frontier;
  const temporary = {
    ...context,
    ledger: new Map(structuredClone([...context.ledger])),
  };
  assert.deepEqual(
    frontier.mapper_events,
    [],
    "nestest frontier cannot contain mapper events",
  );
  verifyCycles(frontier.cycles, frontier.writes, firstCycle, temporary);
  verifySemanticReads(stop.data_reads, frontier.cycles);
  verifyFetch(stop, frontier.cycles);
};

const qualifyEvidence = (evidence, rom, input) => {
  assert.ok(
    rom instanceof Uint8Array && rom.length >= 16 + 16384,
    "NROM ROM bytes are required",
  );
  assert.deepEqual([...rom.subarray(0, 4)], [78, 69, 83, 26]);
  assert.equal(rom[4], 1, "Reference requires 16 KiB PRG at file offset 16");
  assert.equal(rom[6] & 0xfc, 0, "Reference requires mapper 0 and no trainer");
  assert.equal(rom[7] & 0xf0, 0, "Reference requires mapper 0");
  assert.ok(
    typeof evidence?.evidence_id === "string" &&
      evidence.evidence_id.length > 0,
    "Segment needs Evidence identity",
  );
  const sha256 = createHash("sha256").update(rom).digest("hex");
  assert.equal(
    evidence.subject?.digest?.sha256,
    sha256,
    "Subject identity differs from ROM",
  );
  assert.equal(
    evidence.normalized_result?.artifact?.sha256,
    sha256,
    "Segment artifact identity differs from ROM",
  );
  assert.equal(
    evidence.subject?.local_path,
    input.path,
    "Subject path differs from the selected input",
  );
  assert.equal(
    evidence.normalized_result?.artifact?.path,
    input.path,
    "Artifact path differs from the selected input",
  );
  const parameters = evidence.parameters;
  assert.ok(
    parameters !== null && typeof parameters === "object",
    "Evidence parameters are required",
  );
  for (const field of [
    "path",
    "entry",
    "cpu",
    "initial_cpu_bus",
    "max_instructions",
  ])
    assert.deepEqual(
      parameters[field],
      input[field],
      `Evidence changed selected ${field}`,
    );
  const initial = { prg_ram_write_enabled: null, ...input.initial };
  assert.deepEqual(
    parameters.initial,
    initial,
    "Evidence changed selected mapper input",
  );
  assert.deepEqual(
    parameters.initial_ram,
    input.initial_ram ?? [],
    "Evidence changed selected RAM handoff",
  );
  assert.deepEqual(
    parameters.initial_prg_ram,
    [],
    "nestest cannot seed cartridge RAM",
  );
  assert.deepEqual(
    parameters.branch_choices,
    [],
    "nestest cannot supply branch choices",
  );
  for (const field of [
    "initial_ppu",
    "initial_apu",
    "initial_controllers",
    "initial_irq",
    "initial_cpu_dma",
    "initial_cpu_io",
    "initial_interrupts",
  ])
    assert.equal(
      parameters[field],
      null,
      `Evidence selected unexpected ${field}`,
    );
  const trace = evidence.normalized_result?.code_trace;
  assert.equal(trace?.status, "derived");
  assert.deepEqual(
    trace.mapper_trace?.initial,
    initial,
    "Trace mapper input differs from the selected state",
  );
  return trace;
};

/** Caller qualifies the fixed artifacts and wire schema; this owns ordered byte/reference authentication. */
export const verifyNesReferenceSegment = ({
  evidence,
  rom,
  rows,
  startRow,
  segmentIndex,
  input,
  ram,
}) => {
  integer(startRow, rows.length - 1, "reference segment start");
  integer(segmentIndex, Number.MAX_SAFE_INTEGER, "segment index");
  const trace = qualifyEvidence(evidence, rom, input);
  qualifyInput(input, trace, rows[startRow]);
  assert.ok(
    (trace.instructions.length > 0 ||
      (startRow === rows.length - 1 &&
        trace.stop.reason === "unknown-control-target" &&
        "cpu_bus_frontier" in trace.stop)) &&
      trace.instructions.length <= input.max_instructions,
    "Segment must make bounded instruction progress",
  );
  const endRow = startRow + trace.instructions.length;
  assert.ok(
    endRow < rows.length,
    "Final reference frontier cannot be counted as applied",
  );
  const { carried, ledger } = initialLedger(ram, input, startRow, segmentIndex);
  const stats = {
    comparedAfterStates: 0,
    verifiedDataReads: 0,
    unresolvedDataReads: 0,
    ramBackedInstructions: 0,
  };
  const context = {
    carried,
    ledger,
    stats,
    rom,
    startRow,
    segmentIndex,
    evidenceId: evidence.evidence_id,
    instructionIndex: 0,
  };
  for (const [index, instruction] of trace.instructions.entries()) {
    const reference = rows[startRow + index],
      following = rows[startRow + index + 1];
    context.instructionIndex = index;
    assert.equal(instruction.index, index);
    assert.equal(
      instruction.address,
      reference.address,
      `PC at reference row ${startRow + index}`,
    );
    assert.equal(instruction.bytes_hex, reference.bytes);
    assert.equal(instruction.interrupt_vector, null);
    assert.equal(instruction.branch_assumption, null);
    assert.equal(
      instruction.cpu_bus_cycles?.length,
      following.cycle - reference.cycle,
    );
    verifyCycles(
      instruction.cpu_bus_cycles,
      instruction.writes,
      reference.cycle,
      context,
    );
    verifyFetch(instruction, instruction.cpu_bus_cycles);
    verifySemanticReads(instruction.data_reads, instruction.cpu_bus_cycles);
    assert.equal(instruction.next_address, following.address);
    assert.deepEqual(instruction.cpu_after, following.cpu);
    stats.comparedAfterStates++;
    if (instruction.ram_origins.length > 0) stats.ramBackedInstructions++;
  }
  const finalRow = rows[endRow];
  assert.equal(trace.stop.address, finalRow.address);
  if ("cpu_bus_frontier" in trace.stop)
    assert.equal(trace.stop.bytes_hex, finalRow.bytes);
  assert.deepEqual(trace.final_cpu, finalRow.cpu);
  assert.deepEqual(trace.cpu_bus.final, {
    model: "nmos-6502-bus",
    dma_reads: "absent",
    next_cycle_index: finalRow.cycle,
  });
  assert.equal(trace.mapper_trace.status, "derived");
  assert.deepEqual(
    trace.mapper_trace.final,
    trace.mapper_trace.initial,
    "nestest cannot change its NROM mapper state",
  );
  context.instructionIndex = trace.instructions.length;
  verifyFrontier(trace.stop, finalRow.cycle, context);
  return { trace, endRow, ram: ledger, ...stats };
};
