import { z } from "zod";
import {
  nesDmcTimingSchema,
  writeNesDmcTiming,
  type NesDmcTransferType,
} from "./nesDmcTiming.js";
import {
  nesByteValueSchema,
  nesKnownBitsSchema,
  nesByteCandidates,
  nesByteBits,
  nesByteProof,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesApuState } from "./nesApu.js";
import { err, ok, type Result } from "./result.js";
import {
  applyNesDmcDelivery,
  classifyNesDmcDelivery,
  contradictsNesDmcBoundary,
  type NesDmcDeliveryKind,
} from "./nesDmcDelivery.js";
export type { NesDmcDeliveryKind } from "./nesDmcDelivery.js";
import {
  apuRegister,
  apuSetCounter,
  apuSetFlag,
  apuFlags,
} from "./nesApuUnits.js";

const index = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const origin = z.union([
  z.strictObject({ kind: z.literal("initial-state") }),
  z.strictObject({
    kind: z.enum(["event-clock", "event-write", "dmc-read"]),
    index,
  }),
]);
const level = z
  .union([
    z.number().int().min(0).max(127),
    nesKnownBitsSchema
      .safeExtend({
        mask: z.number().int().min(1).max(126),
        value: z.number().int().min(0).max(127),
      })
      .meta(nesKnownBitsSchema.meta() ?? {}),
  ])
  .nullable();
const buffer = z.union([
  z.strictObject({ status: z.literal("empty") }),
  z.strictObject({ status: z.literal("unknown") }),
  z.strictObject({
    status: z.literal("full"),
    value: nesByteValueSchema,
    origin,
  }),
]);
export const nesDmcStateSchema = z
  .strictObject({
    model: z.literal("dmc-reader-output"),
    region: z.enum(["ntsc", "pal"]),
    clocks: z.enum(["explicit", "cpu-ordered"]),
    cpu_timing: nesDmcTimingSchema.nullable().default(null),
    current_address: z
      .number()
      .int()
      .min(0x8000)
      .max(0xffff)
      .nullable()
      .default(null),
    buffer: buffer.prefault({ status: "unknown" }),
    shift: nesByteValueSchema.default(null),
    shift_origin: origin.prefault({ kind: "initial-state" }),
    bits_remaining: z.number().int().min(1).max(8).nullable().default(null),
    silence: z.boolean().nullable().default(null),
    level: level.default(null),
    timer_remaining: z.number().int().min(1).max(428).nullable().default(null),
    origin: origin.prefault({ kind: "initial-state" }),
  })
  .superRefine((state, ctx) => {
    if (
      state.region === "pal" &&
      state.timer_remaining !== null &&
      state.timer_remaining > 398
    )
      ctx.addIssue({
        code: "custom",
        path: ["timer_remaining"],
        message:
          "PAL DMC timer cannot exceed its longest 398-CPU-cycle period.",
      });
  })
  .meta({
    allOf: [
      {
        if: { properties: { region: { const: "pal" } }, required: ["region"] },
        then: { properties: { timer_remaining: { maximum: 398 } } },
      },
    ],
  })
  .describe(
    "Qualified DMC reader/output state, with no inferred power-on state. Explicit uncontended DMA grants fill the byte buffer from the retained mapper; they do not establish CPU halt/arbitration timing by themselves. Optional cpu_timing selects qualified NTSC source bus arbitration with cycle-linked delivered sample facts and independent delayed reader stops retaining their disabling write or triggering delivered-read origin. A qualified initial one-byte load can select a near-boundary implicit stop or a same-edge duplication; reload/duplicate follow-ups do not establish a new initial-load history. The duplication selector and output-boundary relation remain unknown when omitted. Raw 4015 D4 and effective reader bytes can differ until stop expires, including a re-enable that does not cancel an earlier stop. Explicit output clocks or CPU-ordered timer edges are mutually exclusive. Reader stop preserves the buffer, output shift and held 7-bit DAC; unknown bits/phase remain conservative common proofs. Buffer/shift origins identify the retained sample-read event.",
  );
type NesDmcState = z.infer<typeof nesDmcStateSchema>;
export const nesDmcEventSchema = z.union([
  z
    .strictObject({ kind: z.literal("apu-dmc-stop") })
    .describe(
      "Qualified explicit or implicit reader stop at the start of its due put cycle, before that cycle's bus action. Requires retained pending stop delay one and known current put phase. Clears effective reader bytes and the pending request, preserving buffer/output/DAC and its write or delivered-read origin. It consumes no CPU edge, frame phase or DMC timer clock; the ordered cycle still follows separately.",
    ),
  z
    .strictObject({ kind: z.literal("apu-dmc-read") })
    .describe(
      "Externally qualified completed uncontended DMC DMA get. Reads the retained current sample address through the current mapper, fills the buffer, advances/wraps the reader and applies end/loop/IRQ effects. Requires initial_apu.dmc and dmc_reads explicit. Internal-register bus conflicts are outside this raw sample-read model. No halt, dummy, alignment, CPU edge, OAM arbitration or hardware timing is inferred.",
    ),
  z
    .strictObject({ kind: z.literal("apu-dmc-clock") })
    .describe(
      "One externally qualified DMC output-bit clock, after its timer divider. Requires initial_apu.dmc clocks explicit; it does not imply a CPU or frame-sequencer edge.",
    ),
  z
    .strictObject({
      kind: z.literal("apu-dmc-cpu-read"),
      address: z.number().int().min(0x8000).max(0xffff),
      value: nesByteValueSchema,
      cycle_index: index,
      output_boundary: z.boolean().nullable().default(null),
    })
    .describe(
      "Qualified DMC sample delivered by a retained CPU DMA cycle. value is the actual buffer byte/proof, which may differ from raw external ROM data under internal-register conflicts. output_boundary records whether this same get edge reset the output bit counter; omission remains unknown and matching post-clock bits/timer values do not establish it. Source code tracing retains that cycle's complete raw/device/RAM proof inline; supplied replay treats value, cycle and boundary identity as caller history facts, not a new ROM observation.",
    ),
]);
export const nesDmcMappedReadSchema = z.strictObject({
  address: z.number().int().min(0x8000).max(0xffff).nullable(),
  value: nesByteValueSchema,
  file_offset: z.number().int().nonnegative().nullable(),
  source: z.strictObject({
    kind: z.literal("dmc-sample"),
    index,
    window: z
      .strictObject({
        start: z.number().int().nonnegative(),
        size: z.number().int().positive(),
        bank: z.number().int().nonnegative().nullable(),
        file_offset: z.number().int().nonnegative().nullable(),
      })
      .nullable(),
    reason: z
      .enum([
        "unknown-address",
        "unresolved-prg-window",
        "prg-bytes-unavailable",
      ])
      .nullable(),
  }),
});
export const nesDmcReadSchema = z.union([
  nesDmcMappedReadSchema,
  z.strictObject({
    address: z.number().int().min(0x8000).max(0xffff),
    value: nesByteValueSchema,
    source: z.strictObject({
      kind: z.literal("cpu-dma"),
      index,
      cycle_index: index,
    }),
  }),
]);
export type NesDmcRead = z.infer<typeof nesDmcReadSchema>;
export type NesDmcMappedRead = z.infer<typeof nesDmcMappedReadSchema>;
export const nesDmcFactSchema = z
  .strictObject({
    model: z.literal("dmc-fact"),
    value: z.union([
      nesByteValueSchema,
      z.number().int().min(0).max(65535),
      z.boolean(),
      buffer,
      origin,
      nesDmcTimingSchema,
    ]),
    origin,
  })
  .describe(
    "One changed DMC field and the unit transition that derived it. Unchanged field values are omitted from operation deltas; buffer and shift-origin values retain their sample provenance. Complete state remains in the APU initial/final/frontier models.",
  );
const rates = {
  ntsc: [
    428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72, 54,
  ],
  pal: [
    398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66, 50,
  ],
};
const dmcPeriods = (state: NesApuState): number[] => [
  ...new Set(
    nesByteCandidates(apuRegister(state, 0x4010)).map(
      (control) => rates[state.dmc!.region][control & 15]!,
    ),
  ),
];
const joinLevel = (values: readonly number[]): NesByteValue => {
  const first = values[0]!;
  let mask = 127;
  for (const value of values) mask &= ~(value ^ first);
  return mask === 127 ? first : nesByteProof(mask, first & mask);
};
const joinByte = (values: readonly NesByteValue[]): NesByteValue => {
  let first: number | null = null,
    mask = 255;
  for (const value of values)
    for (const candidate of nesByteCandidates(value)) {
      if (first === null) first = candidate;
      else mask &= ~(first ^ candidate);
    }
  return nesByteProof(mask, first! & mask);
};
const common = <T>(values: readonly T[]): T | null =>
  values.every((value) => value === values[0]) ? values[0]! : null;

/** Preview only the output timer; no reader, bus, frame or actual state advances. */
export const previewNesDmcDelivery = (
  state: NesApuState,
  transfer?: NesDmcTransferType,
): { kind: NesDmcDeliveryKind; output_boundary: boolean | null } => {
  const dmc = state.dmc!,
    phase =
      state.frame_clocks === "cpu-ordered"
        ? state.frame_sequencer.cpu_phase
        : null,
    outputBoundary =
      (dmc.bits_remaining !== null && dmc.bits_remaining !== 1) ||
      (dmc.timer_remaining !== null && dmc.timer_remaining !== 1)
        ? false
        : dmc.bits_remaining === 1 && dmc.timer_remaining === 1
          ? true
          : null,
    preview = structuredClone(state);
  clockNesDmcTimer(preview);
  return {
    kind: classifyNesDmcDelivery(preview, {
      output_boundary: outputBoundary,
      periods: dmcPeriods(preview),
      ...(transfer === undefined ? {} : { transfer }),
      post_phase: phase === null ? null : phase === "get" ? "put" : "get",
    }),
    output_boundary: outputBoundary,
  };
};

/** The output unit runs even when the reader is stopped. */
export const clockNesDmcOutput = (
  dmc: NesDmcState,
  eventIndex: number,
): void => {
  const levels: number[] = [];
  for (const value of nesByteCandidates(dmc.level).filter(
    (value) => value <= 127,
  )) {
    for (const silent of dmc.silence === null ? [false, true] : [dmc.silence]) {
      const bit = nesByteBits(dmc.shift, 1);
      for (const selected of bit === null ? [0, 1] : [bit])
        levels.push(
          silent
            ? value
            : selected === 1
              ? value <= 125
                ? value + 2
                : value
              : value >= 2
                ? value - 2
                : value,
        );
    }
  }
  dmc.level = joinLevel(levels);
  const positions =
    dmc.bits_remaining === null
      ? [1, 2, 3, 4, 5, 6, 7, 8]
      : [dmc.bits_remaining];
  const shifts: NesByteValue[] = [],
    silent: (boolean | null)[] = [];
  const shifted = joinByte(
    nesByteCandidates(dmc.shift).map((value) => value >> 1),
  );
  for (const position of positions) {
    if (position !== 1) {
      shifts.push(shifted);
      silent.push(dmc.silence);
    } else if (dmc.buffer.status === "empty") {
      shifts.push(shifted);
      silent.push(true);
    } else if (dmc.buffer.status === "full") {
      shifts.push(dmc.buffer.value);
      silent.push(false);
    } else {
      shifts.push(null);
      silent.push(null);
    }
  }
  dmc.shift = joinByte(shifts);
  dmc.silence = common(silent);
  dmc.bits_remaining = common(
    positions.map((position) => (position === 1 ? 8 : position - 1)),
  );
  if (positions.length === 1 && positions[0] === 1) {
    if (dmc.buffer.status === "full")
      dmc.shift_origin = structuredClone(dmc.buffer.origin);
    else if (dmc.buffer.status === "unknown")
      dmc.shift_origin = { kind: "event-clock", index: eventIndex };
    dmc.buffer = { status: "empty" };
  } else if (positions.length > 1) {
    dmc.shift_origin = { kind: "event-clock", index: eventIndex };
    if (dmc.buffer.status !== "empty") dmc.buffer = { status: "unknown" };
  }
  dmc.origin = { kind: "event-clock", index: eventIndex };
};
export const clockNesDmcTimer = (state: NesApuState): void => {
  const dmc = state.dmc!;
  const periods = dmcPeriods(state);
  if (dmc.timer_remaining === null) {
    const without = structuredClone(dmc),
      withClock = structuredClone(dmc);
    clockNesDmcOutput(withClock, state.next_event_index);
    dmc.level = joinLevel(
      [
        ...nesByteCandidates(without.level),
        ...nesByteCandidates(withClock.level),
      ].filter((value) => value <= 127),
    );
    dmc.shift = joinByte([without.shift, withClock.shift]);
    dmc.bits_remaining = common([
      without.bits_remaining,
      withClock.bits_remaining,
    ]);
    dmc.silence = common([without.silence, withClock.silence]);
    if (JSON.stringify(without.buffer) !== JSON.stringify(withClock.buffer))
      dmc.buffer = { status: "unknown" };
    dmc.shift_origin = { kind: "event-clock", index: state.next_event_index };
  } else if (dmc.timer_remaining > 1) dmc.timer_remaining--;
  else {
    clockNesDmcOutput(dmc, state.next_event_index);
    dmc.timer_remaining = common(periods);
  }
  dmc.origin = { kind: "event-clock", index: state.next_event_index };
};
export const writeNesDmc = (
  state: NesApuState,
  address: number,
  byte: NesByteValue,
  previousRemaining: { min: number; max: number },
): void => {
  const dmc = state.dmc!;
  if (address === 0x4015) writeNesDmcTiming(state, byte, previousRemaining);
  if (address === 0x4011)
    dmc.level = joinLevel(nesByteCandidates(byte).map((value) => value & 127));
  if (
    address === 0x4015 &&
    nesByteBits(byte, 16) !== 0 &&
    previousRemaining.min === 0
  ) {
    const starts = nesByteCandidates(apuRegister(state, 0x4012)).map(
      (value) => 0xc000 + value * 64,
    );
    dmc.current_address = common([
      ...starts,
      ...(nesByteBits(byte, 16) === 16 && previousRemaining.max === 0
        ? []
        : [dmc.current_address]),
    ]);
  }
  if (address >= 0x4010 && address <= 0x4015)
    dmc.origin = { kind: "event-write", index: state.next_event_index };
};
const admitNesDmcDelivery = (
  state: NesApuState,
  read: NesDmcRead,
  outputBoundary: boolean | null,
): Result<
  Exclude<NesDmcDeliveryKind, "unknown">,
  { kind: "invalid-dmc-delivery"; reason: string }
> => {
  const dmc = state.dmc!;
  if (
    read.address !== dmc.current_address ||
    read.source.index !== state.next_event_index
  )
    return err({
      kind: "invalid-dmc-delivery",
      reason:
        "DMC get proof must identify the retained reader address and current APU event.",
    });
  if (state.dmc_remaining.value.max === 0 || dmc.buffer.status === "full")
    return err({
      kind: "invalid-dmc-delivery",
      reason:
        "Qualified DMC get requires a nonempty reader and an empty or unknown sample buffer.",
    });
  const delivery =
    read.source.kind === "cpu-dma"
      ? classifyNesDmcDelivery(state, {
          output_boundary: outputBoundary,
          periods: dmcPeriods(state),
          post_phase:
            state.frame_clocks === "cpu-ordered"
              ? state.frame_sequencer.cpu_phase
              : null,
        })
      : "normal";
  if (delivery === "unknown")
    return err({
      kind: "invalid-dmc-delivery",
      reason:
        "DMC one-byte delivery requires qualified request, output-boundary and duplication history; this stop/duplicate window is unsupported.",
    });
  if (contradictsNesDmcBoundary(state, outputBoundary, dmcPeriods(state)))
    return err({
      kind: "invalid-dmc-delivery",
      reason:
        "DMC output-boundary proof contradicts the retained post-clock output/CPU phase.",
    });
  return ok(delivery);
};

export const fillNesDmcBuffer = (
  state: NesApuState,
  read: NesDmcRead,
  outputBoundary: boolean | null = null,
): string | null => {
  const admitted = admitNesDmcDelivery(state, read, outputBoundary);
  if (!admitted.ok) return admitted.error.reason;
  const dmc = state.dmc!,
    delivery = admitted.value;
  const origin = { kind: "dmc-read" as const, index: state.next_event_index };
  dmc.buffer = { status: "full", value: structuredClone(read.value), origin };
  const next =
    dmc.current_address === null
      ? null
      : dmc.current_address === 0xffff
        ? 0x8000
        : dmc.current_address + 1;
  const remaining = state.dmc_remaining.value;
  const control = apuRegister(state, 0x4010),
    loops = nesByteCandidates(control).map((value) => Boolean(value & 64));
  const lengths = nesByteCandidates(apuRegister(state, 0x4013)).map(
    (value) => value * 16 + 1,
  );
  const addresses: (number | null)[] = [],
    counts: number[] = [],
    irqs: boolean[] = [];
  for (const count of new Set([Math.max(1, remaining.min), remaining.max]))
    for (const loop of new Set(loops)) {
      const ends = count === 1;
      counts.push(...(ends && loop ? lengths : [count - 1]));
      addresses.push(
        ...(ends && loop
          ? nesByteCandidates(apuRegister(state, 0x4012)).map(
              (value) => 0xc000 + value * 64,
            )
          : [next]),
      );
      irqs.push(
        ...(ends && !loop && nesByteBits(control, 128) !== 0
          ? nesByteBits(control, 128) === 128
            ? [true]
            : [...apuFlags(state.dmc_irq.value), true]
          : apuFlags(state.dmc_irq.value)),
      );
    }
  apuSetCounter(state.dmc_remaining, counts, origin);
  apuSetFlag(state.dmc_irq, irqs, origin);
  dmc.current_address = common(addresses);
  dmc.origin = origin;
  if (dmc.cpu_timing !== null) dmc.cpu_timing.request = { status: "none" };
  if (delivery !== "normal" && read.source.kind === "cpu-dma")
    applyNesDmcDelivery(state, read.value, read.source.cycle_index, delivery);
  return null;
};
