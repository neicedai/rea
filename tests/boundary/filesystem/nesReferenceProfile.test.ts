import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import {
  NESTEST_REFERENCE_PROFILE,
  assertNesReferenceCoverage,
  parseNesReferenceLog,
  qualifyNesReferenceArtifacts,
  type NesReferenceCpu,
} from "../../../scripts/lib/nes-reference-profile.mjs";

const line = (
  pc: string,
  bytes: string,
  cycle: number | string,
  status = "24",
) =>
  `${pc}  ${bytes.padEnd(8)}  NOP                             A:00 X:00 Y:00 P:${status} SP:FD PPU:  0, 21 CYC:${cycle}`;
const encoded = (...lines: string[]) =>
  Buffer.from(`${lines.join("\r\n")}\r\n`);
interface Coverage {
  compared_instructions: number;
  compared_after_states: number;
  compared_bus_cycles: number;
  reference_rows_not_applied: number;
  initial_cycle: number;
  final_committed_cycle: number;
  initial_ram_count: number;
  final_cpu: NesReferenceCpu;
  stop: {
    reason: string;
    address: number;
    bytes_hex: string;
    cpu_bus_frontier: {
      cycles: {
        kind: string;
        index: number;
        role: string;
        read: {
          address: number | null;
          value: number | null;
          known_bits?: { mask: number; value: number };
        };
      }[];
      writes: unknown[];
      mapper_events: unknown[];
      blocked_address: number | null;
    };
  };
}
// Independent acceptance constants, never copied from the production profile.
const coverage = (): Coverage => ({
  compared_instructions: 8990,
  compared_after_states: 8990,
  compared_bus_cycles: 26547,
  reference_rows_not_applied: 1,
  initial_cycle: 7,
  final_committed_cycle: 26554,
  initial_ram_count: 0,
  final_cpu: {
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
  stop: {
    reason: "unknown-control-target",
    address: 0xc66e,
    bytes_hex: "60",
    cpu_bus_frontier: {
      cycles: [
        {
          kind: "read",
          index: 26554,
          role: "opcode",
          read: { address: 0xc66e, value: 0x60 },
        },
        {
          kind: "read",
          index: 26555,
          role: "dummy",
          read: { address: 0xc66f, value: 0xa9 },
        },
        {
          kind: "read",
          index: 26556,
          role: "dummy",
          read: { address: 0x1fd, value: 0xc6 },
        },
        {
          kind: "read",
          index: 26557,
          role: "stack",
          read: { address: 0x1fe, value: null },
        },
        {
          kind: "read",
          index: 26558,
          role: "stack",
          read: { address: 0x1ff, value: null },
        },
        {
          kind: "read",
          index: 26559,
          role: "dummy",
          read: { address: null, value: null },
        },
      ],
      writes: [],
      mapper_events: [],
      blocked_address: null,
    },
  },
});

it("pins immutable artifact identities and the precise committed-prefix scope", () => {
  expect(NESTEST_REFERENCE_PROFILE.id).toBe("nestest-nintendulator");
  expect(NESTEST_REFERENCE_PROFILE.rom_sha256).toBe(
    "f67d55fd6b3cf0bad1cc85f1df0d739c65b53e79cecb7fea8f77ec0eadab0004",
  );
  expect(NESTEST_REFERENCE_PROFILE.log_sha256).toBe(
    "627c8e180b1a924dfa705c5dc6958fad7ab75a62de556173caf880ccc1337540",
  );
  expect(NESTEST_REFERENCE_PROFILE.rows).toBe(8991);
  expect(NESTEST_REFERENCE_PROFILE.initial_row).toEqual({
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
  });
  expect(NESTEST_REFERENCE_PROFILE.final_row).toEqual({
    address: 0xc66e,
    bytes: "60",
    cycle: 26554,
    cpu: coverage().final_cpu,
  });
  expect(Object.isFrozen(NESTEST_REFERENCE_PROFILE)).toBe(true);
  expect(Object.isFrozen(NESTEST_REFERENCE_PROFILE.initial_row.cpu)).toBe(true);
  expect(Object.isFrozen(NESTEST_REFERENCE_PROFILE.frontier.cycles)).toBe(true);
  expect(Object.isFrozen(NESTEST_REFERENCE_PROFILE.frontier.cycles[0])).toBe(
    true,
  );
  expect(NESTEST_REFERENCE_PROFILE.scope).toContain("unapplied");
  expect(NESTEST_REFERENCE_PROFILE.scope).toContain("No initial RAM/stack");
});

it("parses pre-instruction CPU byte/flag facts without inventing stack contents or PPU execution", () => {
  const rows = parseNesReferenceLog(
    encoded(line("C000", "4C F5 C5", 7), line("C5F5", "A2 00", 10, "CF")),
  );
  expect(rows).toEqual([
    {
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
    {
      address: 0xc5f5,
      bytes: "a200",
      cycle: 10,
      cpu: {
        a: 0,
        x: 0,
        y: 0,
        sp: 253,
        c: true,
        z: true,
        i: true,
        d: true,
        v: true,
        n: true,
      },
    },
  ]);
  expect(Object.isFrozen(rows)).toBe(true);
  expect(Object.isFrozen(rows[0]!.cpu)).toBe(true);
  const lf = Buffer.from(`${line("C000", "EA", 0)}\n${line("C001", "EA", 2)}`);
  expect(parseNesReferenceLog(lf).map((row) => row.cycle)).toEqual([0, 2]);
});

it.each([
  ["empty", Buffer.from("")],
  ["one row", encoded(line("C000", "EA", 7))],
  ["invalid PC", encoded(line("X000", "EA", 7), line("C001", "EA", 9))],
  [
    "missing cycles",
    encoded(line("C000", "EA", 7).replace("CYC:7", ""), line("C001", "EA", 9)),
  ],
  [
    "unsafe cycles",
    encoded(
      line("C000", "EA", "9007199254740992"),
      line("C001", "EA", "9007199254740993"),
    ),
  ],
  [
    "fractional cycles",
    encoded(line("C000", "EA", "7.5"), line("C001", "EA", 9)),
  ],
  ["negative cycles", encoded(line("C000", "EA", -7), line("C001", "EA", 9))],
  ["duplicate cycles", encoded(line("C000", "EA", 7), line("C001", "EA", 7))],
  ["decreasing cycles", encoded(line("C000", "EA", 9), line("C001", "EA", 7))],
  [
    "blank interior row",
    encoded(line("C000", "EA", 7), "", line("C001", "EA", 9)),
  ],
  ["invalid UTF8", Buffer.from([0xff, 0xfe, 0x61])],
])("rejects malformed reference logs: %s", (_name, bytes) => {
  expect(() => parseNesReferenceLog(bytes)).toThrow();
});

it("accepts exactly the committed prefix and keeps all hypothetical cycles unapplied", () => {
  const summary = coverage();
  const before = structuredClone(summary);
  expect(() => assertNesReferenceCoverage(summary)).not.toThrow();
  expect(() =>
    assertNesReferenceCoverage(summary, "nestest-nintendulator"),
  ).not.toThrow();
  expect(() =>
    assertNesReferenceCoverage(
      summary,
      structuredClone(NESTEST_REFERENCE_PROFILE),
    ),
  ).not.toThrow();
  expect(summary).toEqual(before);
});

const invalidCoverage: [string, (summary: Coverage) => void][] = [
  [
    "933 instruction historical prefix",
    (s) => {
      s.compared_instructions = 933;
      s.compared_after_states = 933;
      s.reference_rows_not_applied = 8058;
    },
  ],
  [
    "short instruction count",
    (s) => {
      s.compared_instructions--;
    },
  ],
  [
    "uncompared final afterstate",
    (s) => {
      s.compared_after_states--;
    },
  ],
  [
    "terminal RTS counted applied",
    (s) => {
      s.compared_instructions = 8991;
      s.reference_rows_not_applied = 0;
    },
  ],
  [
    "wrong unapplied rows",
    (s) => {
      s.reference_rows_not_applied = 2;
    },
  ],
  [
    "short cycle count",
    (s) => {
      s.compared_bus_cycles--;
    },
  ],
  [
    "hypothetical cycles counted committed",
    (s) => {
      s.compared_bus_cycles += 6;
      s.final_committed_cycle += 6;
    },
  ],
  [
    "wrong initial clock",
    (s) => {
      s.initial_cycle = 0;
    },
  ],
  [
    "wrong committed endpoint",
    (s) => {
      s.final_committed_cycle--;
    },
  ],
  [
    "seeded unknown stack",
    (s) => {
      s.initial_ram_count = 2;
    },
  ],
  [
    "wrong final register",
    (s) => {
      s.final_cpu = { ...s.final_cpu, x: 0 };
    },
  ],
  [
    "wrong final flag",
    (s) => {
      s.final_cpu = { ...s.final_cpu, c: false };
    },
  ],
  [
    "wrong final SP",
    (s) => {
      s.final_cpu = { ...s.final_cpu, sp: 255 };
    },
  ],
  [
    "successful return invented",
    (s) => {
      s.stop.reason = "return";
    },
  ],
  [
    "wrong final PC",
    (s) => {
      s.stop.address = 0xc6a2;
    },
  ],
  [
    "wrong final opcode",
    (s) => {
      s.stop.bytes_hex = "40";
    },
  ],
  [
    "frontier cycle removed",
    (s) => {
      s.stop.cpu_bus_frontier.cycles.pop();
    },
  ],
  [
    "frontier cycle added",
    (s) => {
      s.stop.cpu_bus_frontier.cycles.push({
        kind: "read",
        index: 26560,
        role: "dummy",
        read: { address: null, value: null },
      });
    },
  ],
  [
    "frontier index changed",
    (s) => {
      s.stop.cpu_bus_frontier.cycles[3]!.index++;
    },
  ],
  [
    "frontier role changed",
    (s) => {
      s.stop.cpu_bus_frontier.cycles[3]!.role = "dummy";
    },
  ],
  [
    "frontier address changed",
    (s) => {
      s.stop.cpu_bus_frontier.cycles[3]!.read.address = 0x1fd;
    },
  ],
  [
    "unobserved stack value invented",
    (s) => {
      s.stop.cpu_bus_frontier.cycles[3]!.read.value = 0;
    },
  ],
  [
    "unobserved stack partial value invented",
    (s) => {
      s.stop.cpu_bus_frontier.cycles[3]!.read.known_bits = {
        mask: 1,
        value: 0,
      };
    },
  ],
  [
    "known frontier value erased",
    (s) => {
      s.stop.cpu_bus_frontier.cycles[2]!.read.value = null;
    },
  ],
  [
    "frontier write introduced",
    (s) => {
      s.stop.cpu_bus_frontier.writes.push({ address: 0x1fe, value: 0 });
    },
  ],
  [
    "frontier event introduced",
    (s) => {
      s.stop.cpu_bus_frontier.mapper_events.push({
        kind: "cpu-read",
        address: 0,
      });
    },
  ],
  [
    "blocked frontier introduced",
    (s) => {
      s.stop.cpu_bus_frontier.blocked_address = 0x1fe;
    },
  ],
];
it.each(invalidCoverage)(
  "rejects an incomplete or altered gate summary: %s",
  (_name, mutate) => {
    const summary = coverage();
    mutate(summary);
    expect(() => assertNesReferenceCoverage(summary)).toThrow();
  },
);

it("rejects unknown profiles, threshold overrides and unknown artifact identities", () => {
  const rom = Buffer.from("unknown ROM"),
    log = encoded(line("C000", "EA", 7), line("C001", "EA", 9));
  for (const profile of [
    "generic",
    "unknown",
    { ...NESTEST_REFERENCE_PROFILE, rows: 2 },
    { ...NESTEST_REFERENCE_PROFILE, applied_instructions: 933 },
    { ...NESTEST_REFERENCE_PROFILE, rom_sha256: "0".repeat(64) },
  ]) {
    expect(() => assertNesReferenceCoverage(coverage(), profile)).toThrow(
      /profile/iu,
    );
    expect(() => qualifyNesReferenceArtifacts(rom, log, profile)).toThrow(
      /profile/iu,
    );
  }
  expect(() => qualifyNesReferenceArtifacts(rom, log)).toThrow(/ROM SHA-256/u);
  // Generic parsing alone provides no gate qualification, regardless of matching row count.
  const short = encoded(
    ...Array.from({ length: 933 }, (_, index) =>
      line("C000", "EA", 7 + index * 2),
    ),
  );
  expect(parseNesReferenceLog(short)).toHaveLength(933);
  expect(() => qualifyNesReferenceArtifacts(rom, short)).toThrow();
});

const romPath = process.env.REA_NES_REFERENCE_ROM;
const logPath = process.env.REA_NES_REFERENCE_LOG;
it.runIf(romPath !== undefined || logPath !== undefined)(
  "qualifies explicitly supplied pinned artifacts and rejects changed ROM/log bytes",
  async () => {
    if (!romPath || !logPath)
      throw new Error(
        "Both REA_NES_REFERENCE_ROM and REA_NES_REFERENCE_LOG are required",
      );
    const [rom, log] = await Promise.all([
      readFile(romPath),
      readFile(logPath),
    ]);
    const beforeRom = Buffer.from(rom),
      beforeLog = Buffer.from(log);
    const qualified = qualifyNesReferenceArtifacts(rom, log);
    expect(qualified.rows).toHaveLength(8991);
    expect(qualified.rows[0]!.cycle).toBe(7);
    expect(qualified.rows.at(-1)).toEqual({
      address: 0xc66e,
      bytes: "60",
      cycle: 26554,
      cpu: coverage().final_cpu,
    });
    const changedRom = Buffer.from(rom);
    changedRom[changedRom.length - 1] = changedRom[changedRom.length - 1]! ^ 1;
    expect(() => qualifyNesReferenceArtifacts(changedRom, log)).toThrow(
      /ROM SHA-256/u,
    );
    const changedLog = Buffer.from(log);
    changedLog[changedLog.length - 1] = changedLog[changedLog.length - 1]! ^ 1;
    expect(() => qualifyNesReferenceArtifacts(rom, changedLog)).toThrow(
      /Log SHA-256/u,
    );
    const rows = log.toString("utf8").split(/\r?\n/u);
    expect(() =>
      qualifyNesReferenceArtifacts(
        rom,
        Buffer.from(`${rows.slice(0, 933).join("\r\n")}\r\n`),
      ),
    ).toThrow(/Log SHA-256/u);
    expect(rom).toEqual(beforeRom);
    expect(log).toEqual(beforeLog);
  },
);
