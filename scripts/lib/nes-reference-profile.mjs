import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const freeze = (value) => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

/** Pinned external artifacts; callers provide bytes, and this module performs no I/O. */
export const NESTEST_REFERENCE_PROFILE = freeze({
  id: "nestest-nintendulator",
  rom_sha256:
    "f67d55fd6b3cf0bad1cc85f1df0d739c65b53e79cecb7fea8f77ec0eadab0004",
  log_sha256:
    "627c8e180b1a924dfa705c5dc6958fad7ab75a62de556173caf880ccc1337540",
  rows: 8991,
  applied_instructions: 8990,
  after_states: 8990,
  committed_cycles: 26547,
  initial_row: {
    address: 0xc000,
    bytes: "4cf5c5",
    cycle: 7,
    cpu: {
      a: 0,
      x: 0,
      y: 0,
      sp: 253,
      c: false,
      z: false,
      i: true,
      d: false,
      v: false,
      n: false,
    },
  },
  final_row: {
    address: 0xc66e,
    bytes: "60",
    cycle: 26554,
    cpu: {
      a: 0,
      x: 255,
      y: 21,
      sp: 253,
      c: true,
      z: true,
      i: true,
      d: false,
      v: false,
      n: false,
    },
  },
  frontier: {
    reason: "unknown-control-target",
    address: 0xc66e,
    bytes_hex: "60",
    cycles: [
      { index: 26554, role: "opcode", address: 0xc66e, value: 0x60 },
      { index: 26555, role: "dummy", address: 0xc66f, value: 0xa9 },
      { index: 26556, role: "dummy", address: 0x1fd, value: 0xc6 },
      { index: 26557, role: "stack", address: 0x1fe, value: null },
      { index: 26558, role: "stack", address: 0x1ff, value: null },
      { index: 26559, role: "dummy", address: null, value: null },
    ],
    writes: [],
    mapper_events: [],
    blocked_address: null,
  },
  source_urls: {
    rom: "https://www.qmtpro.com/~nes/misc/nestest.nes",
    log: "https://www.qmtpro.com/~nes/misc/nestest.log",
  },
  scope:
    "Pinned nestest conditional CPU states and nominal committed CPU bus cycles through 8990 applied instructions. The final reference RTS is an unapplied unknown-control-target frontier with six hypothetical cycles. No initial RAM/stack bytes, whole-ROM completion, per-cycle hardware observations, DMA, PPU/APU execution or game compatibility are established.",
});

const selectedProfile = (profile) => {
  if (typeof profile === "string")
    assert.equal(
      profile,
      NESTEST_REFERENCE_PROFILE.id,
      "Unknown NES reference profile",
    );
  else
    assert.deepEqual(
      profile,
      NESTEST_REFERENCE_PROFILE,
      "Unknown or modified NES reference profile",
    );
  return NESTEST_REFERENCE_PROFILE;
};

const parseRow = (line, index) => {
  const match =
    /^(?<pc>[0-9A-F]{4}) {2}(?<bytes>[0-9A-F]{2}(?: [0-9A-F]{2}){0,2}) +[^\r\n]+ A:(?<a>[0-9A-F]{2}) X:(?<x>[0-9A-F]{2}) Y:(?<y>[0-9A-F]{2}) P:(?<p>[0-9A-F]{2}) SP:(?<sp>[0-9A-F]{2}) PPU: *(?<scanline>\d{1,3}), *(?<dot>\d{1,3}) CYC:(?<cycle>\d+)$/u.exec(
      line,
    );
  assert.ok(match?.groups, `Invalid reference row ${index + 1}`);
  const fields = match.groups;
  const cycle = Number(fields.cycle);
  assert.ok(
    Number.isSafeInteger(cycle) && cycle >= 0,
    `Invalid CPU cycle on reference row ${index + 1}`,
  );
  const p = Number.parseInt(fields.p, 16);
  return {
    address: Number.parseInt(fields.pc, 16),
    bytes: fields.bytes.replaceAll(" ", "").toLowerCase(),
    cycle,
    cpu: {
      a: Number.parseInt(fields.a, 16),
      x: Number.parseInt(fields.x, 16),
      y: Number.parseInt(fields.y, 16),
      sp: Number.parseInt(fields.sp, 16),
      c: (p & 1) !== 0,
      z: (p & 2) !== 0,
      i: (p & 4) !== 0,
      d: (p & 8) !== 0,
      v: (p & 64) !== 0,
      n: (p & 128) !== 0,
    },
  };
};

/** Parse pre-instruction CPU states without executing, repairing or supplying memory. */
export const parseNesReferenceLog = (bytes) => {
  assert.ok(bytes instanceof Uint8Array, "Reference log must be bytes");
  const text = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  }).decode(bytes);
  const lines = text.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  assert.ok(
    lines.length >= 2,
    "Reference must contain at least two instruction states",
  );
  const rows = lines.map(parseRow);
  for (let index = 1; index < rows.length; index++)
    assert.ok(
      rows[index].cycle > rows[index - 1].cycle,
      `Non-increasing CPU cycle on reference row ${index + 1}`,
    );
  return freeze(rows);
};

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Identity qualification is mandatory before a comparison can become a strict gate. */
export const qualifyNesReferenceArtifacts = (
  rom,
  log,
  profile = NESTEST_REFERENCE_PROFILE,
) => {
  const selected = selectedProfile(profile);
  assert.ok(
    rom instanceof Uint8Array && log instanceof Uint8Array,
    "Reference artifacts must be bytes",
  );
  const rom_sha256 = digest(rom),
    reference_sha256 = digest(log);
  assert.equal(
    rom_sha256,
    selected.rom_sha256,
    "ROM SHA-256 does not match the pinned reference profile",
  );
  assert.equal(
    reference_sha256,
    selected.log_sha256,
    "Log SHA-256 does not match the pinned reference profile",
  );
  const rows = parseNesReferenceLog(log);
  assert.equal(
    rows.length,
    selected.rows,
    "Reference row count does not match the pinned profile",
  );
  assert.deepEqual(
    rows[0],
    selected.initial_row,
    "Initial reference state differs from the pinned profile",
  );
  assert.deepEqual(
    rows.at(-1),
    selected.final_row,
    "Final reference state differs from the pinned profile",
  );
  return freeze({ profile: selected, rom_sha256, reference_sha256, rows });
};

/** Only the complete committed prefix and its precise unapplied frontier satisfy this gate. */
export const assertNesReferenceCoverage = (
  summary,
  profile = NESTEST_REFERENCE_PROFILE,
) => {
  const selected = selectedProfile(profile);
  assert.ok(
    summary !== null && typeof summary === "object",
    "Reference coverage summary is required",
  );
  assert.equal(
    summary.compared_instructions,
    selected.applied_instructions,
    "Applied instruction coverage differs from the pinned profile",
  );
  assert.equal(
    summary.compared_after_states,
    selected.after_states,
    "After-state coverage differs from the pinned profile",
  );
  assert.equal(
    summary.compared_bus_cycles,
    selected.committed_cycles,
    "Committed cycle coverage differs from the pinned profile",
  );
  assert.equal(
    summary.reference_rows_not_applied,
    selected.rows - selected.applied_instructions,
    "Unapplied reference rows differ from the pinned profile",
  );
  assert.equal(
    summary.initial_cycle,
    selected.initial_row.cycle,
    "Initial cycle differs from the pinned profile",
  );
  assert.equal(
    summary.final_committed_cycle,
    selected.final_row.cycle,
    "Committed cycle endpoint differs from the pinned profile",
  );
  assert.equal(
    summary.initial_ram_count,
    0,
    "Strict nestest must not seed initial RAM or stack bytes",
  );
  assert.deepEqual(
    summary.final_cpu,
    selected.final_row.cpu,
    "Final committed CPU state differs from the pinned profile",
  );
  assertReferenceFrontier(summary.stop, selected.frontier);
};

const assertReferenceFrontier = (stop, expectedFrontier) => {
  assert.ok(
    stop !== null && typeof stop === "object",
    "Unapplied reference frontier is required",
  );
  assert.equal(
    stop.reason,
    expectedFrontier.reason,
    "Unexpected reference frontier reason",
  );
  assert.equal(
    stop.address,
    expectedFrontier.address,
    "Unexpected reference frontier PC",
  );
  assert.equal(
    stop.bytes_hex,
    expectedFrontier.bytes_hex,
    "Unexpected reference frontier instruction",
  );
  const frontier = stop.cpu_bus_frontier;
  assert.ok(
    frontier !== null && typeof frontier === "object",
    "Hypothetical bus frontier is required",
  );
  assert.deepEqual(
    frontier.writes,
    expectedFrontier.writes,
    "Unapplied frontier must commit no writes",
  );
  assert.deepEqual(
    frontier.mapper_events,
    expectedFrontier.mapper_events,
    "Unapplied frontier must commit no mapper events",
  );
  assert.equal(
    frontier.blocked_address,
    expectedFrontier.blocked_address,
    "Unexpected blocked reference frontier",
  );
  assert.ok(
    Array.isArray(frontier.cycles),
    "Hypothetical frontier cycles are required",
  );
  assert.equal(
    frontier.cycles.length,
    expectedFrontier.cycles.length,
    "Unexpected hypothetical frontier cycle count",
  );
  for (const [index, expected] of expectedFrontier.cycles.entries()) {
    const actual = frontier.cycles[index];
    assert.equal(
      actual?.kind,
      "read",
      `Frontier cycle ${index} must be a read`,
    );
    assert.deepEqual(
      {
        index: actual.index,
        role: actual.role,
        address: actual.read?.address,
        value: actual.read?.value,
      },
      expected,
      `Unexpected hypothetical frontier cycle ${index}`,
    );
    if (expected.value === null)
      assert.equal(
        "known_bits" in actual.read,
        false,
        `Frontier cycle ${index} must remain completely unknown`,
      );
  }
};
