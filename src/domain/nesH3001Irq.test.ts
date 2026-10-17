import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesH3001StateSchema } from "./nesH3001.js";
import {
  nesH3001IrqStateSchema,
  clockH3001CpuCycle,
  writeH3001Irq,
  admitH3001Irq,
} from "./nesH3001Irq.js";
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
  nesH3001StateSchema.parse({
    mapper: 65,
    irq_control: 128,
    irq_low: 2,
    irq_high: 1,
  });
const irq = () =>
  nesH3001IrqStateSchema.parse({
    model: "h3001",
    counter_low: 2,
    counter_high: 0,
    enabled: true,
    asserted: false,
  });
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});
const cycle = { kind: "h3001-cpu-cycle" } as const;
const header = () => {
  const bytes = Buffer.alloc(16 + 128 * 1024 + 8192, 0xea);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 1, 0x10, 0x48]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

it("matches every nonzero countdown and disables exactly at 1-to-0", () => {
  for (let counter = 1; counter < 65536; counter++) {
    const state = {
      ...irq(),
      counter_low: counter & 255,
      counter_high: counter >> 8,
    };
    const next = clockH3001CpuCycle(state),
      target = counter - 1;
    expect(next).toEqual({
      clock: true,
      state: {
        ...state,
        counter_low: target & 255,
        counter_high: target >> 8,
        enabled: target !== 0,
        asserted: target === 0,
      },
    });
  }
  const stopped = clockH3001CpuCycle({ ...irq(), counter_low: 1 }).state;
  expect(clockNesCpuMapperIrq(stopped, mapper())).toEqual({
    clock: false,
    state: stopped,
  });
  expect(nesCpuMapperIrqEvent(stopped)).toEqual(cycle);
});

it.each([
  {
    zero_behavior: "wrap",
    byte: 255,
    enabled: true,
    asserted: false,
    clock: true,
  },
  {
    zero_behavior: "pause",
    byte: 0,
    enabled: true,
    asserted: false,
    clock: false,
  },
  {
    zero_behavior: "assert",
    byte: 0,
    enabled: false,
    asserted: true,
    clock: true,
  },
  {
    zero_behavior: null,
    byte: null,
    enabled: null,
    asserted: null,
    clock: null,
  },
] as const)(
  "retains the explicit zero-start policy $zero_behavior without inventing a default",
  ({ zero_behavior, byte, enabled, asserted, clock }) => {
    const state = { ...irq(), zero_behavior, counter_low: 0, counter_high: 0 };
    expect(clockH3001CpuCycle(state)).toEqual({
      clock,
      state: {
        ...state,
        counter_low: byte,
        counter_high: byte,
        enabled,
        asserted,
      },
    });
    expect(
      nesH3001IrqStateSchema.parse({ model: "h3001" }).zero_behavior,
    ).toBeNull();
  },
);

it("joins unknown effective enable separately from zero policy and never revives from raw D7", () => {
  const state = { ...irq(), enabled: null, counter_low: 1 };
  expect(clockH3001CpuCycle(state)).toEqual({
    clock: null,
    state: {
      ...state,
      counter_low: { mask: 254, value: 0 },
      enabled: false,
      asserted: null,
    },
  });
  const paused = { ...state, counter_low: 0, zero_behavior: "pause" as const };
  expect(clockH3001CpuCycle(paused)).toEqual({ clock: false, state: paused });
  const disabled = { ...state, enabled: false, asserted: true };
  expect(clockNesCpuMapperIrq(disabled, mapper())).toEqual({
    clock: false,
    state: disabled,
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

it("matches independent concrete-word covers for partial low/high proofs across borrow, zero and terminal paths", () => {
  for (const mask of [0, 1, 3, 7, 15, 31, 63, 127, 128, 129, 240, 254, 255])
    for (let value = 0; value < 256; value++) {
      if ((value & ~mask) !== 0) continue;
      const proof: NesByteValue =
        mask === 0 ? null : mask === 255 ? value : { mask, value };
      for (const [low, high] of [
        [proof, 0],
        [proof, 1],
        [0, proof],
        [1, proof],
      ] as const)
        for (const zero_behavior of ["pause", "assert", null] as const) {
          const concrete = values(low).flatMap((low) =>
            values(high).map((high) => low + high * 256),
          );
          const outcomes = concrete.flatMap((counter) =>
            (zero_behavior === null
              ? ["wrap", "pause", "assert"]
              : [zero_behavior]
            ).map((behavior) => {
              if (counter > 0)
                return {
                  counter: counter - 1,
                  enabled: counter !== 1,
                  asserted: counter === 1,
                  clock: true,
                };
              return {
                counter: behavior === "wrap" ? 65535 : 0,
                enabled: behavior !== "assert",
                asserted: behavior === "assert",
                clock: behavior !== "pause",
              };
            }),
          );
          expect(
            clockH3001CpuCycle({
              ...irq(),
              counter_low: low,
              counter_high: high,
              zero_behavior,
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
              zero_behavior,
            },
          });
        }
    }
});

it("keeps latch writes separate from reload/enable and acknowledges the decoded aliases", () => {
  const board = mapper(),
    previous = { ...irq(), enabled: false, asserted: true };
  for (const address of [0x9004, 0x900c, 0x9ffc]) {
    const loaded = writeH3001Irq(previous, board, write(address, 255));
    expect(loaded).toEqual({
      ...previous,
      counter_low: 2,
      counter_high: 1,
      asserted: false,
    });
    expect(clockH3001CpuCycle(loaded)).toEqual({ state: loaded, clock: false });
  }
  for (const address of [0x9003, 0x900b, 0x9ffb]) {
    expect(writeH3001Irq(previous, board, write(address, 128))).toEqual({
      ...previous,
      enabled: true,
      asserted: false,
    });
    expect(writeH3001Irq(previous, board, write(address, 0))).toEqual({
      ...previous,
      enabled: false,
      asserted: false,
    });
  }
  expect(
    writeH3001Irq(previous, board, {
      ...write(0x9003, null),
      known_bits: { mask: 127, value: 0 },
    }),
  ).toEqual({ ...previous, enabled: null, asserted: false });
  for (const address of [0x9005, 0x9006, 0x9002, 0x8003, 0xa003])
    expect(writeH3001Irq(previous, board, write(address, 128))).toEqual(
      previous,
    );
});

it("rejects mismatched boards/families and known raw-disabled/effective-enabled contradictions", () => {
  const board = mapper(),
    parsed = header();
  expect(admitH3001Irq(irq(), { ...board, irq_control: 0 })).toMatch(
    /contradicts/,
  );
  expect(
    admitH3001Irq({ ...irq(), enabled: null }, { ...board, irq_control: 0 }),
  ).toBeNull();
  expect(admitH3001Irq({ ...irq(), enabled: false }, board)).toBeNull();
  expect(
    admitNesMapperIrqEvents(
      parsed,
      { mapper: 0, prg_ram_write_enabled: null },
      [],
      irq(),
    ),
  ).toMatch(/Mapper 65/);
  expect(admitNesMapperIrqEvents(parsed, board, [cycle], null)).toMatch(
    /matching explicit/,
  );
  for (const kind of [
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
  expect(
    admitNesMapperIrqEvents(
      parsed,
      board,
      [{ kind: "ppu-a12", high: true }, { kind: "cpu-m2-fall" }],
      irq(),
    ),
  ).toMatch(/Other clock families/);
});

it("replays supplied clocks/writes with effective auto-disable retained through continuation", async () => {
  const parsed = header();
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/h3001.nes",
    initial: {
      mapper: 65,
      control: 0,
      mirroring: 0,
      prg_banks: [0, 1],
      chr_banks: [0, 1, 2, 3, 4, 5, 6, 7],
      irq_control: 128,
      irq_low: 2,
      irq_high: 0,
    },
    initial_irq: irq(),
    events: [
      cycle,
      cycle,
      cycle,
      { kind: "cpu-read", address: 0x9003 },
      { kind: "cpu-write", address: 0x9005, value: 1 },
      { kind: "cpu-write", address: 0x9004, value: 0 },
      cycle,
      { kind: "cpu-write", address: 0x9003, value: 128 },
      cycle,
    ],
  });
  const full = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(parsed, input.initial, input.events, {
      initialIrq: input.initial_irq,
    }),
  );
  if (full.status !== "derived") throw new Error(full.reason);
  const irqAt = (index: number) => {
    const step = full.steps[index]!;
    if (!("irq" in step)) throw new Error("Expected a retained CPU IRQ step");
    return step.irq;
  };
  expect(irqAt(1)).toMatchObject({
    counter_low: 0,
    enabled: false,
    asserted: true,
  });
  expect(irqAt(2)).toEqual(irqAt(1));
  expect(irqAt(4)).toEqual(irqAt(1));
  expect(irqAt(5)).toMatchObject({
    counter_low: 2,
    counter_high: 1,
    enabled: false,
    asserted: false,
  });
  expect(full.steps[6]!.irq_clock).toBe(false);
  expect(full.final_irq).toMatchObject({
    counter_low: 1,
    counter_high: 1,
    enabled: true,
    asserted: false,
  });
  const prefix = await deriveNesMapperEvents(
    parsed,
    input.initial,
    input.events.slice(0, 2),
    { initialIrq: input.initial_irq },
  );
  if (prefix.status !== "derived") throw new Error(prefix.reason);
  const continued = await deriveNesMapperEvents(
    parsed,
    prefix.final,
    input.events.slice(2),
    { initialIrq: prefix.final_irq },
  );
  if (continued.status !== "derived") throw new Error(continued.reason);
  expect(continued.final_irq).toEqual(full.final_irq);
  expect(continued.final).toEqual(full.final);
});
