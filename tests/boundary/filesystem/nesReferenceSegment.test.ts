import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { z } from "zod";
import type { traceNesCodeInputSchema } from "../../../src/domain/nesCodeTrace.js";
import type { NesReferenceRow } from "../../../scripts/lib/nes-reference-profile.mjs";
import {
  verifyNesReferenceSegment,
  type NesReferenceRamFact,
} from "../../../scripts/lib/nes-reference-segment.mjs";

type Origin = {
  byte_index: number;
  region: string;
  ram_address: number;
  instruction_index?: number;
  write_index?: number;
  initial_ram_index?: number;
};
type Read = {
  address: number | null;
  value: number | null;
  file_offset: number | null;
  ram_origins: Origin[];
  mapper_origins: unknown[];
  known_bits?: { mask: number; value: number };
};
type Cycle =
  | { kind: "read"; index: number; role: string; read: Read }
  | { kind: "write"; index: number; role: string; write_index: number };
type Write = {
  address: number;
  value: number | null;
  known_bits?: { mask: number; value: number };
};
const cpu = () => ({
  a: 234,
  x: 0,
  y: 0,
  sp: 253,
  c: false,
  z: false,
  i: true,
  d: false,
  v: false,
  n: true,
});
const bus = (cycle: number) => ({
  model: "nmos-6502-bus" as const,
  dma_reads: "absent" as const,
  next_cycle_index: cycle,
});
const read = (
  address: number | null,
  value: number | null,
  origins: Origin[] = [],
): Read => ({
  address,
  value,
  file_offset:
    address !== null && address >= 0x8000
      ? 16 + ((address - 0x8000) & 16383)
      : null,
  ram_origins: origins,
  mapper_origins: [],
});
const cycle = (index: number, role: string, value: Read): Cycle => ({
  kind: "read",
  index,
  role,
  read: value,
});
const origin = (): Origin => ({
  byte_index: 0,
  region: "internal-ram",
  ram_address: 256,
  instruction_index: 0,
  write_index: 0,
});
const instruction = (
  [index, address, bytes]: [number, number, string],
  [cycles, writes, data, next]: [Cycle[], Write[], Read[], number],
) => ({
  index,
  address,
  bytes_hex: bytes,
  file_offsets: Array.from(
    { length: bytes.length / 2 },
    (_, byte): number | null => 16 + ((address + byte - 0x8000) & 16383),
  ),
  ram_origins: [] as Origin[],
  mapper_origins: [] as unknown[],
  interrupt_vector: null,
  branch_assumption: null,
  cpu_after: cpu(),
  next_address: next,
  writes,
  data_reads: data,
  cpu_bus_cycles: cycles,
});
const fixture = () => {
  const rom = Buffer.alloc(16 + 16384 + 8192);
  rom.set([78, 69, 83, 26, 1, 1]);
  rom.set([0x8d, 0, 1, 0xad, 0, 1, 0x60, 0xea], 16);
  const rows: NesReferenceRow[] = [
    { address: 0xc000, bytes: "8d0001", cycle: 7, cpu: cpu() },
    { address: 0xc003, bytes: "ad0001", cycle: 11, cpu: cpu() },
    { address: 0xc006, bytes: "60", cycle: 15, cpu: cpu() },
  ];
  const input: z.input<typeof traceNesCodeInputSchema> = {
    path: "/synthetic-reference.nes",
    initial: { mapper: 0 },
    entry: 0xc000,
    cpu: cpu(),
    initial_cpu_bus: bus(7),
    initial_ram: [],
    max_instructions: 3,
  };
  const parameters: Record<string, unknown> = {
    ...structuredClone(input),
    initial: { mapper: 0, prg_ram_write_enabled: null },
    initial_prg_ram: [],
    branch_choices: [],
    initial_ppu: null,
    initial_apu: null,
    initial_controllers: null,
    initial_irq: null,
    initial_cpu_dma: null,
    initial_cpu_io: null,
    initial_interrupts: null,
  };
  const ramRead = read(256, 234, [origin()]);
  const instructions = [
    instruction(
      [0, 0xc000, "8d0001"],
      [
        [
          cycle(7, "opcode", read(0xc000, 0x8d)),
          cycle(8, "operand", read(0xc001, 0)),
          cycle(9, "operand", read(0xc002, 1)),
          { kind: "write", role: "data", index: 10, write_index: 0 },
        ],
        [{ address: 256, value: 234 }],
        [],
        0xc003,
      ],
    ),
    instruction(
      [1, 0xc003, "ad0001"],
      [
        [
          cycle(11, "opcode", read(0xc003, 0xad)),
          cycle(12, "operand", read(0xc004, 0)),
          cycle(13, "operand", read(0xc005, 1)),
          cycle(14, "data", ramRead),
        ],
        [],
        [structuredClone(ramRead)],
        0xc006,
      ],
    ),
  ];
  const stackLow = read(510, null),
    stackHigh = read(511, null);
  const stop = {
    reason: "unknown-control-target",
    address: 0xc006,
    bytes_hex: "60",
    file_offsets: [22],
    ram_origins: [] as Origin[],
    mapper_origins: [] as unknown[],
    data_reads: [structuredClone(stackLow), structuredClone(stackHigh)],
    cpu_bus_frontier: {
      cycles: [
        cycle(15, "opcode", read(0xc006, 0x60)),
        cycle(16, "dummy", read(0xc007, 0xea)),
        cycle(17, "dummy", read(509, null)),
        cycle(18, "stack", stackLow),
        cycle(19, "stack", stackHigh),
        cycle(20, "dummy", read(null, null)),
      ],
      writes: [] as Write[],
      mapper_events: [] as unknown[],
      blocked_address: null,
    },
  };
  const sha256 = createHash("sha256").update(rom).digest("hex");
  const evidence = {
    evidence_id: "ev_synthetic_first",
    subject: { digest: { sha256 }, local_path: input.path },
    parameters,
    normalized_result: {
      artifact: { sha256, path: input.path },
      code_trace: {
        status: "derived",
        resolved_entry: 0xc000,
        entry_vector: null,
        entry_interrupt: null,
        branch_choices_used: 0,
        instructions,
        stop,
        final_cpu: cpu(),
        cpu_bus: { initial: bus(7), initialized: bus(7), final: bus(15) },
        mapper_trace: {
          status: "derived",
          initial: { mapper: 0, prg_ram_write_enabled: null },
          final: { mapper: 0, prg_ram_write_enabled: null },
        },
      },
    },
  };
  return {
    evidence,
    rom,
    rows,
    startRow: 0,
    segmentIndex: 0,
    input,
    ram: new Map<number, NesReferenceRamFact>(),
  };
};
type Fixture = ReturnType<typeof fixture>;
const trace = (f: Fixture) => f.evidence.normalized_result.code_trace;
const busRead = (
  f: Fixture,
  instructionIndex: number,
  cycleIndex: number,
): Read => {
  const actual =
    trace(f).instructions[instructionIndex]!.cpu_bus_cycles[cycleIndex]!;
  if (actual.kind !== "read") throw new Error("read cycle required");
  return actual.read;
};

it("authenticates committed ROM/RAM reads and keeps hypothetical frontier writes out of the ledger", () => {
  const f = fixture(),
    before = { ...structuredClone(f), rom: Buffer.from(f.rom) };
  const result = verifyNesReferenceSegment(f);
  expect(result).toMatchObject({
    endRow: 2,
    comparedAfterStates: 2,
    verifiedDataReads: 9,
    unresolvedDataReads: 4,
    ramBackedInstructions: 0,
  });
  expect(result.ram.get(256)).toEqual({
    value: 234,
    writer: {
      evidence_id: "ev_synthetic_first",
      segment: 0,
      instruction_index: 0,
      absolute_instruction_index: 0,
      write_index: 0,
    },
  });
  expect(f).toEqual(before);
  const frontier = trace(f).stop.cpu_bus_frontier;
  frontier.writes.push({ address: 300, value: 5 });
  frontier.cycles.push({
    kind: "write",
    role: "stack",
    index: 21,
    write_index: 0,
  });
  expect(verifyNesReferenceSegment(f).ram.has(300)).toBe(false);
});

it("bridges initial_ram_index to a genuinely earlier segment writer and preserves its identity", () => {
  const f = fixture();
  const prior = verifyNesReferenceSegment(f).ram;
  f.startRow = 1;
  f.segmentIndex = 1;
  f.ram = prior;
  f.input.entry = 0xc003;
  f.input.initial_cpu_bus = bus(11);
  f.input.max_instructions = 2;
  f.input.initial_ram = [{ address: 256, value: 234 }];
  f.evidence.evidence_id = "ev_synthetic_second";
  Object.assign(f.evidence.parameters, structuredClone(f.input), {
    initial: { mapper: 0, prg_ram_write_enabled: null },
  });
  const t = trace(f);
  t.resolved_entry = 0xc003;
  t.cpu_bus.initial = bus(11);
  t.cpu_bus.initialized = bus(11);
  t.instructions = [t.instructions[1]!];
  t.instructions[0]!.index = 0;
  const source: Origin = {
    byte_index: 0,
    region: "internal-ram",
    ram_address: 256,
    initial_ram_index: 0,
  };
  busRead(f, 0, 3).ram_origins = [source];
  t.instructions[0]!.data_reads[0]!.ram_origins = [structuredClone(source)];
  const result = verifyNesReferenceSegment(f);
  expect(result.endRow).toBe(2);
  expect(result.ram.get(256)!.writer.evidence_id).toBe("ev_synthetic_first");
  const bad = structuredClone(f);
  bad.input.initial_ram = [{ address: 257, value: 234 }];
  bad.evidence.parameters.initial_ram = bad.input.initial_ram;
  expect(() => verifyNesReferenceSegment(bad)).toThrow(/initial_ram/u);
  const stale = structuredClone(f);
  stale.ram.set(256, {
    value: 234,
    writer: { ...prior.get(256)!.writer, absolute_instruction_index: 1 },
  });
  expect(() => verifyNesReferenceSegment(stale)).toThrow(
    /prior global writer/u,
  );
});

it("authenticates RAM-backed instruction fetches through the initial input-index bridge", () => {
  const f = fixture();
  f.startRow = 1;
  f.segmentIndex = 1;
  f.rows = [
    f.rows[0]!,
    { address: 256, bytes: "ea", cycle: 11, cpu: cpu() },
    { address: 257, bytes: "60", cycle: 13, cpu: cpu() },
  ];
  f.ram.set(256, {
    value: 234,
    writer: {
      evidence_id: "ev_prior",
      segment: 0,
      instruction_index: 0,
      absolute_instruction_index: 0,
      write_index: 0,
    },
  });
  f.input.entry = 256;
  f.input.initial_cpu_bus = bus(11);
  f.input.initial_ram = [{ address: 256, value: 234 }];
  f.input.max_instructions = 1;
  Object.assign(f.evidence.parameters, structuredClone(f.input), {
    initial: { mapper: 0, prg_ram_write_enabled: null },
  });
  const t = trace(f),
    source: Origin = {
      byte_index: 0,
      region: "internal-ram",
      ram_address: 256,
      initial_ram_index: 0,
    };
  t.resolved_entry = 256;
  t.cpu_bus = { initial: bus(11), initialized: bus(11), final: bus(13) };
  const next = instruction(
    [0, 256, "ea"],
    [
      [
        cycle(11, "opcode", read(256, 234, [source])),
        cycle(12, "dummy", read(257, null)),
      ],
      [],
      [],
      257,
    ],
  );
  next.file_offsets = [null];
  next.ram_origins = [structuredClone(source)];
  t.instructions = [next];
  t.stop = {
    ...t.stop,
    address: 257,
    bytes_hex: "60",
    file_offsets: [],
    data_reads: [],
    cpu_bus_frontier: { ...t.stop.cpu_bus_frontier, cycles: [], writes: [] },
  };
  Reflect.deleteProperty(t.stop, "cpu_bus_frontier");
  t.stop.reason = "instruction-budget";
  expect(verifyNesReferenceSegment(f).ramBackedInstructions).toBe(1);
  next.ram_origins[0]!.initial_ram_index = 1;
  expect(() => verifyNesReferenceSegment(f)).toThrow();
});

it("requires a same-instruction RAM read to follow its authenticating bus write", () => {
  const f = fixture(),
    t = trace(f),
    first = t.instructions[0]!;
  const sameInstruction = read(256, 234, [origin()]);
  first.cpu_bus_cycles.push(cycle(11, "dummy", sameInstruction));
  first.data_reads = [structuredClone(sameInstruction)];
  f.rows = f.rows.map((row, index) => ({
    ...row,
    cycle: row.cycle + (index === 0 ? 0 : 1),
  }));
  for (const action of t.instructions[1]!.cpu_bus_cycles) action.index++;
  for (const action of t.stop.cpu_bus_frontier.cycles) action.index++;
  t.cpu_bus.final.next_cycle_index++;
  expect(verifyNesReferenceSegment(f).endRow).toBe(2);
  first.cpu_bus_cycles[3] = cycle(10, "dummy", sameInstruction);
  first.cpu_bus_cycles[4] = {
    kind: "write",
    role: "data",
    index: 11,
    write_index: 0,
  };
  expect(() => verifyNesReferenceSegment(f)).toThrow(/committed writer/u);
});

it("admits a final frontier-only segment while refusing other zero-progress segments", () => {
  const f = fixture();
  f.ram = verifyNesReferenceSegment(f).ram;
  f.startRow = 2;
  f.segmentIndex = 1;
  f.input.entry = 0xc006;
  f.input.initial_cpu_bus = bus(15);
  f.input.max_instructions = 1;
  f.input.initial_ram = [{ address: 256, value: 234 }];
  f.evidence.evidence_id = "ev_final_frontier";
  Object.assign(f.evidence.parameters, structuredClone(f.input), {
    initial: { mapper: 0, prg_ram_write_enabled: null },
  });
  const t = trace(f);
  t.resolved_entry = 0xc006;
  t.instructions = [];
  t.cpu_bus.initial = bus(15);
  t.cpu_bus.initialized = bus(15);
  const result = verifyNesReferenceSegment(f);
  expect(result).toMatchObject({
    endRow: 2,
    comparedAfterStates: 0,
    verifiedDataReads: 2,
    unresolvedDataReads: 4,
  });
  expect(result.ram).toEqual(f.ram);
  Reflect.deleteProperty(t.stop, "cpu_bus_frontier");
  expect(() => verifyNesReferenceSegment(f)).toThrow(/progress/u);
  const empty = fixture();
  trace(empty).instructions = [];
  expect(() => verifyNesReferenceSegment(empty)).toThrow(/progress/u);
});

const negatives: [string, (f: Fixture) => void][] = [
  [
    "subject digest changed",
    (f) => {
      f.evidence.subject.digest.sha256 = "bad";
    },
  ],
  [
    "subject path changed",
    (f) => {
      f.evidence.subject.local_path = "/other.nes";
    },
  ],
  [
    "parameter CPU changed",
    (f) => {
      f.evidence.parameters.cpu = { ...cpu(), a: 0 };
    },
  ],
  [
    "parameter seed RAM changed",
    (f) => {
      f.evidence.parameters.initial_ram = [{ address: 510, value: 0 }];
    },
  ],
  [
    "parameter device selected",
    (f) => {
      f.evidence.parameters.initial_irq = { model: "mmc3" };
    },
  ],
  [
    "branch choice consumed",
    (f) => {
      trace(f).branch_choices_used = 1;
    },
  ],
  [
    "NROM mapper state changed",
    (f) => {
      Reflect.set(trace(f).mapper_trace.final, "prg_ram_write_enabled", true);
    },
  ],
  [
    "wrong CPU after",
    (f) => {
      trace(f).instructions[0]!.cpu_after.a = 0;
    },
  ],
  [
    "wrong reference next PC",
    (f) => {
      trace(f).instructions[0]!.next_address++;
    },
  ],
  [
    "nonconsecutive cycles",
    (f) => {
      trace(f).instructions[0]!.cpu_bus_cycles[1]!.index++;
    },
  ],
  [
    "ROM alias offset forged despite identical value",
    (f) => {
      busRead(f, 0, 1).file_offset = 20;
    },
  ],
  [
    "known ROM erased to unknown",
    (f) => {
      const r = busRead(f, 0, 0);
      r.value = null;
      r.file_offset = null;
    },
  ],
  [
    "known RAM erased to unknown",
    (f) => {
      const r = busRead(f, 1, 3);
      r.value = null;
      r.ram_origins = [];
    },
  ],
  [
    "known RAM source absent",
    (f) => {
      busRead(f, 1, 3).ram_origins = [];
    },
  ],
  [
    "RAM source points to future writer",
    (f) => {
      busRead(f, 1, 3).ram_origins[0]!.instruction_index = 1;
    },
  ],
  [
    "mapper origin fabricated",
    (f) => {
      busRead(f, 0, 0).mapper_origins = [{ kind: "fake" }];
    },
  ],
  [
    "write cycle missing",
    (f) => {
      trace(f).instructions[0]!.cpu_bus_cycles[3] = cycle(
        10,
        "dummy",
        read(3, null),
      );
    },
  ],
  [
    "write index out of range",
    (f) => {
      const c = trace(f).instructions[0]!.cpu_bus_cycles[3]!;
      if (c.kind === "write") c.write_index = 1;
    },
  ],
  [
    "committed write partial",
    (f) => {
      trace(f).instructions[0]!.writes[0]!.value = null;
    },
  ],
  [
    "semantic read source not on bus",
    (f) => {
      trace(f).instructions[1]!.data_reads[0]!.address = 257;
    },
  ],
  [
    "committed bus includes frontier",
    (f) => {
      trace(f).cpu_bus.final.next_cycle_index += 6;
    },
  ],
];
it.each(negatives)("rejects altered segment proof: %s", (_name, mutate) => {
  const f = fixture();
  mutate(f);
  expect(() => verifyNesReferenceSegment(f)).toThrow();
});
