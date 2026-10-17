import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesSunsoft3StateSchema } from "./nesSunsoft3.js";
import {
  admitSunsoft3Irq,
  clockSunsoft3CpuCycle,
  nesSunsoft3IrqStateSchema,
  writeSunsoft3Irq,
} from "./nesSunsoft3Irq.js";
import {
  nesMapperEventsTraceSchema,
  traceNesMapperEventsInputSchema,
} from "./nesMapperEvents.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { admitNesMapperIrqEvents } from "./nesMapperIrqAdmission.js";
import {
  clockNesCpuMapperIrq,
  nesCpuMapperIrqEvent,
} from "./nesCpuMapperIrq.js";
import type { NesByteValue } from "./nesByteValue.js";

const mapper = () =>
  nesSunsoft3StateSchema.parse({ mapper: 67, irq_control: 16, irq_data: 37 });
const irq = () =>
  nesSunsoft3IrqStateSchema.parse({
    model: "sunsoft3",
    counter_low: 1,
    counter_high: 0,
    next_write: "high",
    enabled: true,
    asserted: false,
  });
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});
const cycle = { kind: "sunsoft3-cpu-cycle" } as const;
const header = () => {
  const bytes = Buffer.alloc(16 + 128 * 1024 + 8192, 0xea);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 1, 0x30, 0x48]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

it("asserts only on old-zero underflow and retains effective auto-disable independently from raw D4", () => {
  const zero = clockSunsoft3CpuCycle(irq());
  expect(zero).toEqual({
    clock: true,
    state: { ...irq(), counter_low: 0 },
  });
  const underflow = clockSunsoft3CpuCycle(zero.state);
  expect(underflow).toEqual({
    clock: true,
    state: {
      ...irq(),
      counter_low: 255,
      counter_high: 255,
      enabled: false,
      asserted: true,
    },
  });
  expect(clockNesCpuMapperIrq(underflow.state, mapper())).toEqual({
    clock: false,
    state: underflow.state,
  });
  expect(nesCpuMapperIrqEvent(underflow.state)).toEqual(cycle);
  expect(
    clockSunsoft3CpuCycle({ ...irq(), counter_low: 0, counter_high: 1 }),
  ).toEqual({
    clock: true,
    state: { ...irq(), counter_low: 255, counter_high: 0 },
  });
});

const values = (proof: NesByteValue): number[] =>
  Array.from({ length: 256 }, (_, value) => value).filter((value) =>
    typeof proof === "number"
      ? value === proof
      : proof === null || (value & proof.mask) === proof.value,
  );
const envelope = (numbers: readonly number[]): NesByteValue => {
  const mask = numbers.reduce(
      (mask, value) => mask & ~(numbers[0]! ^ value),
      255,
    ),
    value = numbers[0]! & mask;
  return mask === 0 ? null : mask === 255 ? value : { mask, value };
};
const common = (flags: readonly boolean[]) =>
  flags.every((flag) => flag === flags[0]) ? flags[0]! : null;

it("preserves the common facts of partial counters and unknown enable across enabled/disabled paths", () => {
  const pairs: readonly (readonly [NesByteValue, NesByteValue])[] = [
    [0, 0],
    [1, 0],
    [{ mask: 254, value: 0 }, 0],
    [0, { mask: 254, value: 0 }],
    [
      { mask: 240, value: 16 },
      { mask: 240, value: 0 },
    ],
    [{ mask: 128, value: 128 }, null],
    [null, null],
  ];
  for (const [low, high] of pairs)
    for (const enabled of [true, false, null])
      for (const asserted of [true, false, null]) {
        const outcomes = values(low).flatMap((low) =>
          values(high).flatMap((high) =>
            (enabled === null ? [false, true] : [enabled]).flatMap((active) =>
              (asserted === null ? [false, true] : [asserted]).map((line) => {
                const old = low + high * 256,
                  underflow = active && old === 0;
                return {
                  counter: active ? (old - 1) & 65535 : old,
                  enabled: active && !underflow,
                  asserted: line || underflow,
                  clock: active,
                };
              }),
            ),
          ),
        );
        expect(
          clockSunsoft3CpuCycle({
            ...irq(),
            counter_low: low,
            counter_high: high,
            enabled,
            asserted,
          }),
        ).toEqual({
          clock: common(outcomes.map((outcome) => outcome.clock)),
          state: {
            ...irq(),
            counter_low: envelope(
              outcomes.map((outcome) => outcome.counter & 255),
            ),
            counter_high: envelope(
              outcomes.map((outcome) => outcome.counter >> 8),
            ),
            enabled: common(outcomes.map((outcome) => outcome.enabled)),
            asserted: common(outcomes.map((outcome) => outcome.asserted)),
          },
        });
      }
});

it("writes the live high/low counter halves and keeps acknowledgement separate from C800/D800", () => {
  const previous = { ...irq(), asserted: true, enabled: false };
  for (const address of [0xc800, 0xcfff]) {
    const high = writeSunsoft3Irq(previous, write(address, 0x12)),
      low = writeSunsoft3Irq(high, write(address, 0x34));
    expect(high).toEqual({
      ...previous,
      counter_high: 0x12,
      next_write: "low",
    });
    expect(low).toEqual({
      ...previous,
      counter_high: 0x12,
      counter_low: 0x34,
      next_write: "high",
    });
    expect(clockSunsoft3CpuCycle(low)).toEqual({ state: low, clock: false });
  }
  for (const address of [0xd800, 0xdfff]) {
    const lowNext = { ...previous, next_write: "low" as const };
    expect(writeSunsoft3Irq(lowNext, write(address, 16))).toEqual({
      ...previous,
      enabled: true,
    });
    expect(writeSunsoft3Irq(lowNext, write(address, 0))).toEqual(previous);
    expect(writeSunsoft3Irq(lowNext, write(address, null))).toEqual({
      ...previous,
      enabled: null,
    });
    expect(
      writeSunsoft3Irq(lowNext, {
        ...write(address, null),
        known_bits: { mask: 16, value: 16 },
      }),
    ).toEqual({ ...previous, enabled: true });
  }
});

it("joins an unknown counter-write phase without fabricating reset history or losing common byte proofs", () => {
  const previous = {
    ...irq(),
    counter_low: 0xa0,
    counter_high: 0xb0,
    next_write: null,
    asserted: true,
  };
  expect(writeSunsoft3Irq(previous, write(0xc800, 0xa1))).toEqual({
    ...previous,
    counter_low: { mask: 254, value: 160 },
    counter_high: { mask: 238, value: 160 },
  });
  expect(
    nesSunsoft3IrqStateSchema.parse({ model: "sunsoft3" }).next_write,
  ).toBeNull();
});

it("acknowledges every A11-clear upper-address mirror without resetting the write phase or counter", () => {
  const previous = { ...irq(), next_write: "low" as const, asserted: true };
  for (let page = 8; page < 16; page++)
    for (const offset of [0, 0x7ff])
      expect(
        writeSunsoft3Irq(previous, write(page * 4096 + offset, null)),
      ).toEqual({
        ...previous,
        asserted: false,
      });
  for (const address of [
    0x7fff, 0x8800, 0x9800, 0xa800, 0xb800, 0xe800, 0xf800,
  ])
    expect(writeSunsoft3Irq(previous, write(address, 255))).toEqual(previous);
});

it("rejects mismatched IRQ families and proven raw-disabled/effective-enabled facts while retaining honest unknowns", () => {
  const board = mapper(),
    parsed = header();
  expect(admitSunsoft3Irq(irq(), { ...board, irq_control: 0 })).toMatch(
    /contradicts/,
  );
  expect(
    admitSunsoft3Irq({ ...irq(), enabled: null }, { ...board, irq_control: 0 }),
  ).toBeNull();
  expect(admitSunsoft3Irq({ ...irq(), enabled: false }, board)).toBeNull();
  expect(
    admitNesMapperIrqEvents(
      parsed,
      { mapper: 0, prg_ram_write_enabled: null },
      [],
      irq(),
    ),
  ).toMatch(/Mapper 67/);
  expect(admitNesMapperIrqEvents(parsed, board, [cycle], null)).toMatch(
    /matching explicit/,
  );
  for (const kind of [
    "h3001-cpu-cycle",
    "vrc-cpu-cycle",
    "bandai-cpu-cycle",
    "fme7-cpu-cycle",
    "namco163-cpu-cycle",
    "mmc5-cpu-cycle",
    "mmc5-reset",
    "mmc3-irq-clock",
  ] as const)
    expect(admitNesMapperIrqEvents(parsed, board, [{ kind }], irq())).toMatch(
      /Other clock families/,
    );
  for (const events of [
    [{ kind: "ppu-a12", high: true }, { kind: "cpu-m2-fall" }],
    [{ kind: "cpu-read", address: 0x2002, ppu_status: 0 }],
  ] as const)
    expect(admitNesMapperIrqEvents(parsed, board, events, irq())).toMatch(
      /Other clock families/,
    );
});

it("replays supplied live-counter writes and clocks without changing raw mapper bytes, including mid-write continuation", async () => {
  const parsed = header(),
    input = traceNesMapperEventsInputSchema.parse({
      path: "/sunsoft3.nes",
      initial: mapper(),
      initial_irq: { ...irq(), enabled: false },
      events: [
        { kind: "cpu-write", address: 0xc800, value: 0 },
        { kind: "cpu-write", address: 0xcfff, value: 1 },
        { kind: "cpu-write", address: 0xd800, value: 16 },
        cycle,
        cycle,
        cycle,
        { kind: "cpu-read", address: 0x8000 },
        { kind: "cpu-write", address: 0xdfff, value: 16 },
        { kind: "cpu-write", address: 0xf7ff, value: 255 },
      ],
    }),
    full = nesMapperEventsTraceSchema.parse(
      await deriveNesMapperEvents(parsed, input.initial, input.events, {
        initialIrq: input.initial_irq,
      }),
    );
  if (full.status !== "derived") throw new Error(full.reason);
  const irqAt = (index: number) => {
    const step = full.steps[index]!;
    if (!("irq" in step)) throw new Error("Expected retained CPU IRQ state");
    return step.irq;
  };
  expect(irqAt(0)).toMatchObject({ next_write: "low", counter_high: 0 });
  expect(irqAt(3)).toMatchObject({
    counter_low: 0,
    enabled: true,
    asserted: false,
  });
  expect(irqAt(4)).toMatchObject({
    counter_low: 255,
    counter_high: 255,
    enabled: false,
    asserted: true,
  });
  expect(irqAt(5)).toEqual(irqAt(4));
  expect(full.steps[5]!.irq_clock).toBe(false);
  expect(irqAt(6)).toEqual(irqAt(4));
  expect(irqAt(7)).toMatchObject({
    enabled: true,
    asserted: true,
    next_write: "high",
  });
  expect(full.final_irq).toMatchObject({
    counter_low: 255,
    counter_high: 255,
    enabled: true,
    asserted: false,
  });
  expect(full.final).toEqual({ ...mapper(), irq_data: 1 });
  for (const split of [1, 5]) {
    const prefix = await deriveNesMapperEvents(
      parsed,
      input.initial,
      input.events.slice(0, split),
      { initialIrq: input.initial_irq },
    );
    if (prefix.status !== "derived") throw new Error(prefix.reason);
    const continued = await deriveNesMapperEvents(
      parsed,
      prefix.final,
      input.events.slice(split),
      { initialIrq: prefix.final_irq },
    );
    if (continued.status !== "derived") throw new Error(continued.reason);
    expect(continued.final_irq).toEqual(full.final_irq);
    expect(continued.final).toEqual(full.final);
  }
});
