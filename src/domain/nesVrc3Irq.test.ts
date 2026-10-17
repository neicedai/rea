import { expect, it } from "vitest";
import { nesVrc3StateSchema } from "./nesVrc3.js";
import {
  clockVrc3CpuCycle,
  isVrc3IrqState,
  nesVrc3IrqStateSchema,
  writeVrc3Irq,
} from "./nesVrc3Irq.js";
import type { NesByteValue } from "./nesByteValue.js";

const mapper = (extra: Record<string, unknown> = {}) =>
  nesVrc3StateSchema.parse({
    mapper: 73,
    irq_latch_nibbles: [14, 7, 5, 10],
    irq_control: 2,
    ...extra,
  });
const irq = (extra: Record<string, unknown> = {}) =>
  nesVrc3IrqStateSchema.parse({
    model: "vrc3",
    counter_low: 254,
    counter_high: 255,
    enabled: true,
    asserted: false,
    ...extra,
  });
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});
const values = (proof: NesByteValue): number[] =>
  Array.from({ length: 256 }, (_, n) => n).filter((n) =>
    typeof proof === "number"
      ? n === proof
      : proof === null || (n & proof.mask) === proof.value,
  );
const proof = (mask: number, value: number): NesByteValue =>
  mask === 0 ? null : mask === 255 ? value : { mask, value };
const flag = (mask: number): boolean | null =>
  mask === 1 ? false : mask === 2 ? true : null;

it("keeps initial effective state unknown and omits duplicate latch/mode owners", () => {
  expect(nesVrc3IrqStateSchema.parse({ model: "vrc3" })).toEqual({
    model: "vrc3",
    counter_low: null,
    counter_high: null,
    enabled: null,
    asserted: null,
  });
  expect(isVrc3IrqState(irq())).toBe(true);
  expect(isVrc3IrqState(null)).toBe(false);
  expect(isVrc3IrqState({ model: "sunsoft3" })).toBe(false);
  expect(nesVrc3IrqStateSchema.safeParse({ ...irq(), mode: 0 }).success).toBe(
    false,
  );
});

it("matches every concrete counter in both modes without carrying or reloading high in eight-bit mode", () => {
  for (const mode of [0, 4]) {
    const board = mapper({ irq_control: mode | 2 });
    for (let counter = 0; counter < 65536; counter++) {
      const previous = irq({
          counter_low: counter & 255,
          counter_high: counter >> 8,
        }),
        overflow = mode === 0 ? counter === 65535 : (counter & 255) === 255,
        expected = overflow
          ? mode === 0
            ? 0xa57e
            : (counter & 0xff00) | 0x7e
          : mode === 0
            ? counter + 1
            : (counter & 0xff00) | ((counter + 1) & 255),
        result = clockVrc3CpuCycle(previous, board);
      if (
        result.clock !== true ||
        result.state.counter_low !== (expected & 255) ||
        result.state.counter_high !== expected >> 8 ||
        result.state.asserted !== overflow ||
        result.state.enabled !== true
      )
        throw new Error(
          `VRC3 mode ${mode}, counter ${counter}: ${JSON.stringify(result)}`,
        );
    }
  }
});

it("continues enabled after repeated overflows and preserves an asserted IRQ until acknowledgement", () => {
  const board = mapper({ irq_control: 6, irq_latch_nibbles: [15, 15, 0, 0] }),
    previous = irq({ counter_low: 255, counter_high: 83 }),
    first = clockVrc3CpuCycle(previous, board);
  expect(first).toEqual({
    clock: true,
    state: { ...previous, asserted: true },
  });
  expect(clockVrc3CpuCycle(first.state, board)).toEqual(first);
  expect(clockVrc3CpuCycle({ ...first.state, enabled: false }, board)).toEqual({
    clock: false,
    state: { ...first.state, enabled: false },
  });
  expect(
    clockVrc3CpuCycle({ ...first.state, counter_low: 7 }, board).state,
  ).toEqual({ ...first.state, counter_low: 8 });
});

it("projects partial counters and unknown enable/mode against an independent complete-word oracle", () => {
  const pairs: readonly (readonly [NesByteValue, NesByteValue])[] = [
    [0, 0],
    [254, 255],
    [255, 254],
    [255, 255],
    [{ mask: 254, value: 254 }, 255],
    [255, { mask: 254, value: 254 }],
    [
      { mask: 240, value: 240 },
      { mask: 128, value: 128 },
    ],
    [null, null],
  ];
  for (const [low, high] of pairs)
    for (const mode of [0, 4, null])
      for (const enabled of [false, true, null])
        for (const asserted of [false, true, null]) {
          let first: number | undefined,
            lowMask = 255,
            highMask = 255,
            assertedMask = 0,
            enabledMask = 0;
          for (const lo of values(low))
            for (const hi of values(high))
              for (const small of mode === null ? [false, true] : [mode !== 0])
                for (const active of enabled === null
                  ? [false, true]
                  : [enabled]) {
                  const old = lo | (hi << 8),
                    overflow = active && (small ? lo === 255 : old === 65535),
                    next = !active
                      ? old
                      : overflow
                        ? small
                          ? (hi << 8) | 126
                          : 42366
                        : small
                          ? (hi << 8) | ((lo + 1) & 255)
                          : old + 1;
                  first ??= next;
                  lowMask &= ~(first ^ next) & 255;
                  highMask &= ~((first ^ next) >> 8) & 255;
                  enabledMask |= active ? 2 : 1;
                  assertedMask |=
                    overflow || asserted === true
                      ? 2
                      : asserted === false
                        ? 1
                        : 3;
                }
          const previous = irq({
            counter_low: low,
            counter_high: high,
            enabled,
            asserted,
          });
          expect(
            clockVrc3CpuCycle(previous, mapper({ irq_control: mode })),
          ).toEqual({
            clock: enabled,
            state: {
              ...previous,
              counter_low: proof(lowMask, first! & lowMask),
              counter_high: proof(highMask, (first! >> 8) & highMask),
              enabled: flag(enabledMask),
              asserted: flag(assertedMask),
            },
          });
        }
});

it("acknowledges every C000 byte and reloads the entire nibble latch exactly when E is set", () => {
  const previous = irq({ counter_low: 165, counter_high: 90, asserted: true }),
    rawLatch = [241, 226, 211, 196];
  for (let control = 0; control < 256; control++)
    for (const address of [0xc000, 0xcfff])
      expect(
        writeVrc3Irq(
          previous,
          mapper({ irq_control: control, irq_latch_nibbles: rawLatch }),
          write(address, control),
        ),
      ).toEqual({
        ...previous,
        ...(control & 2 ? { counter_low: 33, counter_high: 67 } : {}),
        enabled: (control & 2) !== 0,
        asserted: false,
      });
});

it("joins unknown E and retains partial low-nibble facts without treating unused raw bits as zero", () => {
  const previous = irq({ counter_low: 160, counter_high: 80, asserted: true }),
    board = mapper({
      irq_control: { mask: 4, value: 4 },
      irq_latch_nibbles: [
        161,
        250,
        { mask: 3, value: 1 },
        { mask: 8, value: 0 },
      ],
    });
  expect(
    writeVrc3Irq(previous, board, {
      ...write(0xc123, null),
      known_bits: { mask: 4, value: 4 },
    }),
  ).toEqual({
    ...previous,
    counter_low: { mask: 254, value: 160 },
    counter_high: { mask: 130, value: 0 },
    enabled: null,
    asserted: false,
  });
  expect(
    writeVrc3Irq(previous, board, {
      ...write(0xc000, null),
      known_bits: { mask: 2, value: 2 },
    }),
  ).toEqual({
    ...previous,
    counter_low: 161,
    counter_high: { mask: 131, value: 1 },
    enabled: true,
    asserted: false,
  });
});

it("copies A on D000 without reloading, allowing raw E clear with effective enable true", () => {
  const previous = irq({ counter_low: 55, counter_high: 66, asserted: true });
  for (const a of [0, 1, null])
    for (const address of [0xd000, 0xdfff])
      for (const value of [0, 255, null]) {
        const board = mapper({ irq_control: a }),
          result = writeVrc3Irq(previous, board, write(address, value));
        expect(result).toEqual({
          ...previous,
          enabled: a === null ? null : a !== 0,
          asserted: false,
        });
        expect(board.irq_control).toBe(a);
      }
  const disabled = writeVrc3Irq(
      previous,
      mapper({ irq_control: 1 }),
      write(0xc000, 1),
    ),
    enabled = writeVrc3Irq(
      disabled,
      mapper({ irq_control: 1 }),
      write(0xd000, 0),
    );
  expect(disabled.enabled).toBe(false);
  expect(enabled.enabled).toBe(true);
  expect(
    clockVrc3CpuCycle(enabled, mapper({ irq_control: 1 })).state.counter_low,
  ).toBe(56);
});

it("leaves counter/IRQ unchanged for raw latch, PRG, E000 and lower-address writes", () => {
  const previous = irq({ asserted: true });
  for (const address of [
    0, 0x7fff, 0x8000, 0x8fff, 0x9000, 0xafff, 0xb000, 0xbfff, 0xe000, 0xefff,
    0xf000, 0xffff,
  ])
    expect(writeVrc3Irq(previous, mapper(), write(address, 255))).toEqual(
      previous,
    );
});
