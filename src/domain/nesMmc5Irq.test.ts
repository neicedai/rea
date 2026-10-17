import { nesMapperEventSnapshot } from "./nesMapperEvents.js";
import { expect, it } from "vitest";
import {
  advanceMmc5Irq,
  initializeMmc5Irq,
  nesMmc5IrqStateSchema,
  type NesMmc5IrqState,
} from "./nesMmc5Irq.js";
import { nesMmc5StateSchema } from "./nesMmc5.js";
import {
  nesMapperEventSchema,
  traceNesMapperEventsInputSchema,
} from "./nesMapperEvents.js";
import type { NesMapperEvent } from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { parseNesHeader } from "./nes.js";
import { mmc5Fixture } from "./nesMmc5.fixture.js";

const mapper = () =>
  nesMmc5StateSchema.parse({
    mapper: 5,
    irq_target: 2,
    ppu_mask: 24,
    exram_mode: 0,
  });
const irq = (extra: Partial<NesMmc5IrqState> = {}) =>
  nesMmc5IrqStateSchema.parse({
    model: "mmc5",
    counter: 0,
    in_frame: false,
    pending: false,
    enabled: false,
    asserted: false,
    matching_reads: [0],
    idle_cycles: [0],
    ppu_read_since_cycle: false,
    ...extra,
  });
const read = (address: number) => ({ kind: "ppu-read", address }) as const;
const clock = read(0x23c0);
const line = (state: NesMmc5IrqState, m = mapper()) =>
  [read(0x2000), read(0x2000), read(0x2000), clock].reduce(
    (s, e) => advanceMmc5Irq(s, m, e).state,
    state,
  );
const byteProof = (values: number[]) => {
  const and = values.reduce((a, b) => a & b),
    or = values.reduce((a, b) => a | b),
    mask = 255 & ~(and ^ or);
  return mask === 0 ? null : mask === 255 ? and : { mask, value: and };
};

it("clocks on the read after three identical 2xxx reads and keeps pending independent of enable", () => {
  let s = irq();
  const m = mapper();
  for (let i = 0; i < 3; i++) {
    const next = advanceMmc5Irq(s, m, read(0x2000));
    expect(next.clock).toBe(false);
    s = next.state;
    expect(s.in_frame).toBe(false);
  }
  expect(s.matching_reads).toEqual([3]);
  const first = advanceMmc5Irq(s, m, clock);
  expect(first.clock).toBe(true);
  s = first.state;
  expect(s).toMatchObject({
    counter: 0,
    in_frame: true,
    pending: false,
    asserted: false,
  });
  s = line(s, m);
  expect(s.counter).toBe(1);
  s = line(s, m);
  expect(s).toMatchObject({
    counter: 2,
    pending: true,
    enabled: false,
    asserted: false,
  });
  s = advanceMmc5Irq(s, m, {
    kind: "cpu-write",
    address: 0x5204,
    value: 128,
    preceded_by_cpu_write: null,
  }).state;
  expect(s.asserted).toBe(true);
  const status = advanceMmc5Irq(s, m, { kind: "cpu-read", address: 0x5204 });
  expect(status.read).toMatchObject({
    value: null,
    known_bits: { mask: 192, value: 192 },
    source: {
      kind: "mmc5-scanline-status",
      pending: true,
      in_frame: true,
      enabled: true,
      counter: 2,
    },
  });
  expect(status.state).toMatchObject({
    pending: false,
    asserted: false,
    in_frame: true,
    counter: 2,
  });
  expect(
    advanceMmc5Irq(status.state, m, { kind: "cpu-read", address: 0x5204 }).read,
  ).toMatchObject({ known_bits: { mask: 192, value: 64 } });
});

it("does not clock on writes, nonmatching/mirrored nametable reads or CPU accesses", () => {
  const m = mapper();
  let s = irq({ in_frame: true, counter: 7 });
  for (const event of [
    read(0x2000),
    read(0x2001),
    read(0x3001),
    read(0x3001),
    read(0x3001),
    { kind: "cpu-read", address: 0x5000 },
    {
      kind: "cpu-write",
      address: 0x5203,
      value: 8,
      preceded_by_cpu_write: null,
    },
  ] as NesMapperEvent[]) {
    const next = advanceMmc5Irq(s, m, event);
    expect(next.clock).toBe(false);
    s = next.state;
  }
  expect(s.counter).toBe(7);
  expect(s.idle_cycles).toEqual([0]);
  expect(s.in_frame).toBe(true);
  s = irq({
    matching_reads: [3],
    last_ppu_address: 0x2000,
    in_frame: true,
    counter: 7,
  });
  expect(advanceMmc5Irq(s, m, read(0x3f00))).toMatchObject({
    clock: true,
    state: { counter: 8, matching_reads: [0] },
  });
});

it("requires explicit M2 rises and restarts the idle count after a PPU read", () => {
  const m = mapper();
  let s = irq({
    in_frame: true,
    counter: 9,
    pending: true,
    enabled: true,
    asserted: true,
    matching_reads: [3],
    last_ppu_address: 0x2000,
  });
  const cycle = { kind: "mmc5-cpu-cycle" } as const;
  s = advanceMmc5Irq(s, m, cycle).state;
  expect(s).toMatchObject({ in_frame: true, idle_cycles: [1] });
  s = advanceMmc5Irq(s, m, cycle).state;
  expect(s.in_frame).toBe(true);
  s = advanceMmc5Irq(s, m, read(0x1000)).state;
  s = advanceMmc5Irq(s, m, cycle).state;
  expect(s.idle_cycles).toEqual([0]);
  for (let i = 0; i < 2; i++) s = advanceMmc5Irq(s, m, cycle).state;
  expect(s.in_frame).toBe(true);
  s = advanceMmc5Irq(s, m, cycle).state;
  expect(s).toMatchObject({
    in_frame: false,
    idle_cycles: [3],
    matching_reads: [0],
    last_ppu_address: null,
    pending: true,
    asserted: true,
  });
  s = line(s, m);
  expect(s).toMatchObject({
    counter: 0,
    in_frame: true,
    pending: false,
    asserted: false,
  });
});

it("uses exact vector/status snoops and joins unconfirmed DMA, unknown values and addresses", () => {
  const m = mapper(),
    s = irq({
      in_frame: true,
      counter: 9,
      pending: true,
      enabled: true,
      asserted: true,
      matching_reads: [3],
      last_ppu_address: 0x2000,
    });
  for (const address of [0xfffa, 0xfffb])
    expect(
      advanceMmc5Irq(s, m, { kind: "cpu-read", address }).state,
    ).toMatchObject({
      counter: 0,
      in_frame: false,
      pending: false,
      asserted: false,
      matching_reads: [0],
    });
  for (const address of [0xfffc, 0x520c, 0x200a])
    expect(advanceMmc5Irq(s, m, { kind: "cpu-read", address }).state).toEqual(
      s,
    );
  expect(
    advanceMmc5Irq(s, m, {
      kind: "cpu-read",
      address: 0x2002,
      ppu_status: { mask: 128, value: 0 },
    }).state,
  ).toEqual(s);
  expect(
    advanceMmc5Irq(s, m, {
      kind: "cpu-read",
      address: 0x2002,
      ppu_status: { mask: 128, value: 128 },
    }),
  ).toMatchObject({
    state: { in_frame: false },
    read: {
      value: null,
      known_bits: { mask: 128, value: 128 },
      source: {
        kind: "mmc5-ppu-status-snoop",
        supplied_byte: { mask: 128, value: 128 },
      },
    },
  });
  for (const event of [
    { kind: "cpu-read", address: 0x2002 },
    { kind: "cpu-read", address: null },
    {
      kind: "cpu-write",
      address: 0x4014,
      value: 0,
      preceded_by_cpu_write: null,
    },
  ] as NesMapperEvent[]) {
    const after = advanceMmc5Irq(s, m, event).state;
    expect(after).toMatchObject({
      counter: { mask: 246, value: 0 },
      in_frame: null,
      pending: null,
      asserted: null,
    });
    expect(after.matching_reads).toEqual([0, 3]);
  }
});

it("distinguishes disabling IRQ, explicit reset detection and PPUMASK enable transitions", () => {
  const m = mapper(),
    s = irq({
      counter: 9,
      in_frame: true,
      pending: true,
      enabled: true,
      asserted: true,
    });
  const reset = advanceMmc5Irq(s, m, { kind: "mmc5-reset" }).state;
  expect(reset).toMatchObject({
    counter: 9,
    in_frame: true,
    pending: true,
    enabled: false,
    asserted: false,
  });
  expect(
    advanceMmc5Irq(reset, m, {
      kind: "cpu-write",
      address: 0x5204,
      value: 128,
      preceded_by_cpu_write: null,
    }).state.asserted,
  ).toBe(true);
  m.ppu_mask = 0;
  expect(
    advanceMmc5Irq(s, m, {
      kind: "cpu-write",
      address: 0x2001,
      value: null,
      known_bits: { mask: 8, value: 8 },
      preceded_by_cpu_write: null,
    }).state,
  ).toMatchObject({
    counter: 0,
    in_frame: false,
    pending: false,
    asserted: false,
    enabled: true,
  });
  expect(
    advanceMmc5Irq(s, m, {
      kind: "cpu-write",
      address: 0x2009,
      value: 24,
      preceded_by_cpu_write: null,
    }).state,
  ).toEqual(s);
  m.ppu_mask = 24;
  const disable = advanceMmc5Irq(s, m, {
    kind: "cpu-write",
    address: 0x2001,
    value: 0,
    preceded_by_cpu_write: null,
  }).state;
  expect(disable).toMatchObject({
    in_frame: null,
    counter: 9,
    pending: true,
    asserted: true,
  });
});

it("preserves unknown histories and normalizes only proven logical flag constraints", () => {
  const parsed = nesMmc5IrqStateSchema.parse({ model: "mmc5" });
  const initialized = initializeMmc5Irq(parsed);
  if (!initialized.ok) throw new Error(initialized.error);
  expect(initialized.value).toEqual(parsed);
  const m = mapper();
  let s = parsed;
  const ppu = read(0x2000);
  expect(advanceMmc5Irq(s, m, ppu).clock).toBeNull();
  for (let i = 0; i < 3; i++) s = advanceMmc5Irq(s, m, ppu).state;
  expect(s.matching_reads).toEqual([3]);
  expect(advanceMmc5Irq(s, m, clock).clock).toBe(true);
  const inferred = initializeMmc5Irq(
    nesMmc5IrqStateSchema.parse({ model: "mmc5", asserted: true }),
  );
  if (!inferred.ok) throw new Error(inferred.error);
  expect(inferred.value).toMatchObject({
    enabled: true,
    pending: true,
    asserted: true,
  });
  expect(
    nesMmc5IrqStateSchema.safeParse({
      model: "mmc5",
      enabled: false,
      asserted: true,
    }).success,
  ).toBe(false);
  expect(
    nesMmc5IrqStateSchema.safeParse({
      model: "mmc5",
      pending: true,
      enabled: true,
      asserted: false,
    }).success,
  ).toBe(false);
});

it("matches a separate concrete counter oracle for all 65,536 counter/comparator pairs", () => {
  const m = mapper(),
    s = irq({
      in_frame: true,
      enabled: true,
      matching_reads: [3],
      last_ppu_address: 0x2000,
    });
  for (let before = 0; before < 256; before++)
    for (let target = 0; target < 256; target++) {
      s.counter = before;
      m.irq_target = target;
      const actual = advanceMmc5Irq(s, m, clock).state,
        next = (before + 1) % 256,
        release = next >= 240;
      expect([
        actual.counter,
        actual.in_frame,
        actual.pending,
        actual.asserted,
      ]).toEqual(
        release
          ? [0, false, false, false]
          : [
              next,
              true,
              next !== 0 && next === target,
              next !== 0 && next === target,
            ],
      );
    }
});

it("retains the exact byte envelope for every partial counter under representative comparisons", () => {
  const m = mapper(),
    s = irq({
      in_frame: true,
      enabled: true,
      matching_reads: [3],
      last_ppu_address: 0x2000,
    });
  for (let mask = 0; mask < 256; mask++)
    for (let value = 0; value < 256; value++)
      if ((value & ~mask) === 0) {
        s.counter = mask === 0 ? null : mask === 255 ? value : { mask, value };
        const possible = Array.from({ length: 256 }, (_, n) => n).filter(
          (n) => (n & mask) === value,
        );
        for (const target of [0, 2, 127, 239, 240, 255]) {
          m.irq_target = target;
          const result = advanceMmc5Irq(s, m, clock).state;
          expect(result.counter).toEqual(
            byteProof(
              possible.map((n) => ((n + 1) % 256 >= 240 ? 0 : (n + 1) % 256)),
            ),
          );
          const pending = possible.map(
            (n) =>
              (n + 1) % 256 < 240 &&
              (n + 1) % 256 !== 0 &&
              (n + 1) % 256 === target,
          );
          expect(result.pending).toBe(
            pending.every((p) => p === pending[0]) ? pending[0] : null,
          );
        }
      }
});

it("joins partial comparator proofs without treating an unknown byte as zero", () => {
  const m = mapper(),
    s = irq({
      in_frame: true,
      counter: 1,
      enabled: true,
      matching_reads: [3],
      last_ppu_address: 0x2000,
    });
  for (let mask = 0; mask < 256; mask++)
    for (let value = 0; value < 256; value++)
      if ((value & ~mask) === 0) {
        m.irq_target =
          mask === 0 ? null : mask === 255 ? value : { mask, value };
        const concrete = Array.from({ length: 256 }, (_, n) => n)
          .filter((n) => (n & mask) === value)
          .map((n) => n === 2);
        expect(advanceMmc5Irq(s, m, clock).state.pending).toBe(
          concrete.every((v) => v === concrete[0]) ? concrete[0] : null,
        );
      }
});

it("derives frame-qualified ExRAM writes and resumes without mutating caller state", async () => {
  const parsed = parseNesHeader(mmc5Fixture().bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/game.nes",
    initial: { mapper: 5, exram_mode: 0, ppu_mask: 24 },
    initial_irq: irq(),
    events: [
      read(0x2000),
      read(0x2000),
      read(0x2000),
      clock,
      { kind: "cpu-write", address: 0x5c00, value: 90 },
      { kind: "cpu-write", address: 0x5104, value: 2 },
      { kind: "cpu-read", address: 0x5c00 },
    ],
  });
  const before = structuredClone(input),
    trace = await deriveNesMapperEvents(
      parsed.value,
      input.initial,
      input.events,
      { initialIrq: input.initial_irq },
    );
  if (trace.status !== "derived") throw new Error(trace.reason);

  expect(trace.steps[4]).toMatchObject({
    write_effect: "exram-write",
    state: { exram: { "0": 90 } },
  });
  expect(trace.steps[6]).toMatchObject({ cpu_read: { value: 90 } });
  const snapshot = nesMapperEventSnapshot(trace, trace.steps[3]!)!;
  const resumed = await deriveNesMapperEvents(
    parsed.value,
    snapshot.state,
    input.events.slice(4),
    { initialIrq: snapshot.irq },
  );
  if (resumed.status !== "derived") throw new Error(resumed.reason);

  expect(resumed.final).toEqual(trace.final);
  expect(resumed.final_irq).toEqual(trace.final_irq);
  expect(input).toEqual(before);
  expect(
    nesMapperEventSchema.safeParse({
      kind: "cpu-read",
      address: 0x200a,
      ppu_status: 128,
    }).success,
  ).toBe(false);
  expect(
    await deriveNesMapperEvents(parsed.value, input.initial, [
      { kind: "mmc5-cpu-cycle" },
    ]),
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("initial_irq"),
  });
});
