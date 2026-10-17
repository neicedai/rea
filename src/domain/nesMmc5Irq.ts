import { z } from "zod";
import {
  joinNesBytes,
  nesByteBits,
  nesByteCandidates,
  nesByteProof,
  nesByteValueSchema,
  nesKnownBitsSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesMmc5State } from "./nesMmc5.js";
import type { NesMapperEvent } from "./nesMapperEvents.js";
import { err, ok } from "./result.js";

const flag = z.boolean().nullable().default(null);
const phases = z
  .array(z.number().int().min(0).max(3))
  .min(1)
  .max(4)
  .nullable()
  .default(null);
export const nesMmc5IrqStateSchema = z
  .strictObject({
    model: z.literal("mmc5"),
    counter: nesByteValueSchema.default(null),
    in_frame: flag,
    pending: flag,
    enabled: flag.describe(
      "Current IRQ enable latch, including explicit reset effects. Independent of the mapper's retained last raw 5204 write.",
    ),
    asserted: flag.describe(
      "Scanline IRQ contribution, pending AND enabled. Other CPU IRQ sources, including PCM/audio/timer/APU, remain unknown.",
    ),
    last_ppu_address: z
      .number()
      .int()
      .min(0)
      .max(16383)
      .nullable()
      .default(null),
    matching_reads: phases.describe(
      "Possible counts of consecutive identical 2xxx PPU reads, saturated at 3. Three arms the detector; the following PPU read clocks. Null means all four possibilities; 0 excludes an armed history even with unknown last address.",
    ),
    idle_cycles: phases.describe(
      "Possible consecutive M2 rises without a PPU read, saturated at 3. The third clears in-frame and matching history; CPU accesses do not imply M2 rises.",
    ),
    ppu_read_since_cycle: flag.describe(
      "Whether any supplied PPU read occurred since the preceding explicit M2 rise; null retains unknown pre-trace history.",
    ),
  })
  .refine(
    (v) =>
      !(v.asserted === true && (v.pending === false || v.enabled === false)) &&
      !(v.asserted === false && v.pending === true && v.enabled === true),
    {
      message:
        "MMC5 scanline assertion must be consistent with pending AND enabled",
      path: ["asserted"],
    },
  )
  .meta({
    allOf: [
      {
        if: {
          properties: { asserted: { const: true } },
          required: ["asserted"],
        },
        then: {
          properties: {
            pending: { enum: [true, null] },
            enabled: { enum: [true, null] },
          },
        },
      },
      {
        if: {
          properties: { pending: { const: true }, enabled: { const: true } },
          required: ["pending", "enabled"],
        },
        then: { properties: { asserted: { enum: [true, null] } } },
      },
    ],
  })
  .describe(
    "Explicit conventional MMC5 scanline model, not silicon identification. Models stable state after supplied bus events, delayed fourth-read clocks, first-line zero and 241-line auto-release. OAMDMA reset is unconfirmed and joins reset/no-reset. PCM/audio/timer IRQs and transient pulse widths are not included.",
  );
export type NesMmc5IrqState = z.infer<typeof nesMmc5IrqStateSchema>;
export const isMmc5IrqState = (
  state: { model: string } | null,
): state is NesMmc5IrqState => state?.model === "mmc5";
const values = (flag: boolean | null) =>
  flag === null ? [false, true] : [flag];
const common = <T>(items: readonly T[]): T | null =>
  items.every((v) => v === items[0]) ? items[0]! : null;
const counts = (value: number[] | null) => value ?? [0, 1, 2, 3];
const phaseSet = (items: number[]) => {
  const set = [...new Set(items)].sort((a, b) => a - b);
  return set.length === 4 ? null : set;
};
const merge = (states: NesMmc5IrqState[]): NesMmc5IrqState => ({
  model: "mmc5",
  counter: states.map((s) => s.counter).reduce(joinNesBytes),
  in_frame: common(states.map((s) => s.in_frame)),
  pending: common(states.map((s) => s.pending)),
  enabled: common(states.map((s) => s.enabled)),
  asserted: common(states.map((s) => s.asserted)),
  last_ppu_address: common(states.map((s) => s.last_ppu_address)),
  matching_reads: phaseSet(states.flatMap((s) => counts(s.matching_reads))),
  idle_cycles: phaseSet(states.flatMap((s) => counts(s.idle_cycles))),
  ppu_read_since_cycle: common(states.map((s) => s.ppu_read_since_cycle)),
});

/** Normalize only logical flag constraints; raw mapper writes do not establish post-reset enable. */
export const initializeMmc5Irq = (input: NesMmc5IrqState) => {
  const possible = values(input.enabled)
    .flatMap((enabled) =>
      values(input.pending).map((pending) => ({
        enabled,
        pending,
        asserted: enabled && pending,
      })),
    )
    .filter((v) => input.asserted === null || v.asserted === input.asserted);
  return possible.length === 0
    ? err("MMC5 scanline assertion contradicts its pending/enable assumptions.")
    : ok({
        ...structuredClone(input),
        enabled: common(possible.map((v) => v.enabled)),
        pending: common(possible.map((v) => v.pending)),
        asserted: common(possible.map((v) => v.asserted)),
      });
};
const resetFrame = (s: NesMmc5IrqState): NesMmc5IrqState => ({
  ...s,
  counter: 0,
  in_frame: false,
  pending: false,
  asserted: false,
  last_ppu_address: null,
  matching_reads: [0],
});
const match = (
  byte: NesMmc5State["irq_target"],
  target: number,
): boolean | null => {
  if (target === 0) return false;
  const known = nesByteBits(byte, 255);
  if (known !== null) return known === target;
  return byte !== null &&
    typeof byte !== "number" &&
    (byte.value ^ target) & byte.mask
    ? false
    : null;
};
const triggered = (
  s: NesMmc5IrqState,
  hit: boolean | null,
): NesMmc5IrqState => ({
  ...s,
  pending:
    s.pending === true || hit === true
      ? true
      : s.pending === false && hit === false
        ? false
        : null,
  asserted:
    hit === false
      ? s.asserted
      : hit === true
        ? s.enabled
        : s.asserted === true
          ? true
          : s.enabled === false
            ? false
            : null,
});
const clockScanline = (
  s: NesMmc5IrqState,
  mapper: NesMmc5State,
): NesMmc5IrqState => {
  const alternatives: NesMmc5IrqState[] = [];
  if (s.in_frame !== true)
    alternatives.push({
      ...s,
      counter: 0,
      in_frame: true,
      pending: false,
      asserted: false,
    });
  if (s.in_frame !== false)
    for (const old of nesByteCandidates(s.counter)) {
      const next = (old + 1) & 255;
      // The 241st detected line releases the IRQ and frame. Transient pulses at
      // that boundary are outside this stable post-event conventional model.
      alternatives.push(
        next >= 240
          ? resetFrame(s)
          : triggered(
              { ...s, counter: next, in_frame: true },
              match(mapper.irq_target, next),
            ),
      );
    }
  return merge(alternatives);
};
const ppuRead = (s: NesMmc5IrqState, mapper: NesMmc5State, address: number) => {
  const before = counts(s.matching_reads),
    clock = common(before.map((n) => n === 3));
  const next =
    clock === true
      ? clockScanline(s, mapper)
      : clock === false
        ? s
        : merge([s, clockScanline(s, mapper)]);
  const nametable = address >= 0x2000 && address < 0x3000;
  const matches = nametable
    ? before.flatMap((n) =>
        n === 0 ||
        (s.last_ppu_address !== null && s.last_ppu_address !== address)
          ? [1]
          : s.last_ppu_address === address
            ? [Math.min(n + 1, 3)]
            : [1, Math.min(n + 1, 3)],
      )
    : [0];
  return {
    state: {
      ...next,
      last_ppu_address: address,
      matching_reads: phaseSet(matches),
      ppu_read_since_cycle: true,
    },
    clock,
  };
};
const cpuCycle = (s: NesMmc5IrqState): NesMmc5IrqState =>
  merge(
    values(s.ppu_read_since_cycle).flatMap((read) =>
      read
        ? [{ ...s, idle_cycles: [0], ppu_read_since_cycle: false }]
        : counts(s.idle_cycles).map((old) => ({
            ...s,
            ...(old >= 2
              ? { in_frame: false, last_ppu_address: null, matching_reads: [0] }
              : {}),
            idle_cycles: [Math.min(old + 1, 3)],
            ppu_read_since_cycle: false,
          })),
    ),
  );

const statusSource = z.strictObject({
  kind: z.literal("mmc5-scanline-status"),
  pending: z.boolean().nullable(),
  in_frame: z.boolean().nullable(),
  enabled: z.boolean().nullable(),
  counter: nesByteValueSchema,
});
const statusRead = z.strictObject({
  address: z.literal(0x5204),
  value: z.null(),
  source: statusSource,
});
const snoopedStatusRead = z.strictObject({
  address: z.literal(0x2002),
  value: z.null(),
  source: z.strictObject({
    kind: z.literal("mmc5-ppu-status-snoop"),
    supplied_byte: nesByteValueSchema,
  }),
});
export const nesMmc5IrqReadSchema = z.union([
  statusRead,
  statusRead.extend({ known_bits: nesKnownBitsSchema }),
  snoopedStatusRead,
  snoopedStatusRead.extend({ value: z.number().int().min(0).max(255) }),
  snoopedStatusRead.extend({ known_bits: nesKnownBitsSchema }),
]);
export type NesMmc5IrqRead = z.infer<typeof nesMmc5IrqReadSchema>;
const readStatus = (s: NesMmc5IrqState): NesMmc5IrqRead => {
  const mask = (s.pending === null ? 0 : 128) | (s.in_frame === null ? 0 : 64),
    value = (s.pending === true ? 128 : 0) | (s.in_frame === true ? 64 : 0);
  const proof = nesByteProof(mask, value);
  return {
    address: 0x5204,
    value: null,
    source: {
      kind: "mmc5-scanline-status",
      pending: s.pending,
      in_frame: s.in_frame,
      enabled: s.enabled,
      counter: s.counter,
    },
    ...(proof !== null && typeof proof !== "number"
      ? { known_bits: proof }
      : {}),
  };
};
const readSnoopedStatus = (byte: NesByteValue): NesMmc5IrqRead => {
  const source = {
    kind: "mmc5-ppu-status-snoop" as const,
    supplied_byte: byte,
  };
  return typeof byte === "number"
    ? { address: 0x2002, value: byte, source }
    : byte === null
      ? { address: 0x2002, value: null, source }
      : { address: 0x2002, value: null, known_bits: byte, source };
};
const write = (
  s: NesMmc5IrqState,
  mapper: NesMmc5State,
  event: Extract<NesMapperEvent, { kind: "cpu-write" }>,
): NesMmc5IrqState => {
  const byte = event.value ?? ("known_bits" in event ? event.known_bits : null);
  if (event.address === 0x5204) {
    const bit = nesByteBits(byte, 128),
      enabled = bit === null ? null : bit === 128;
    return {
      ...s,
      enabled,
      asserted:
        enabled === false || s.pending === false
          ? false
          : enabled === true && s.pending === true
            ? true
            : null,
    };
  }
  if (event.address === 0x4014) return merge([s, resetFrame(s)]);
  if (event.address !== 0x2001) return s;
  const active = (v: NesMmc5State["ppu_mask"]) =>
    nesByteBits(v, 8) === 8 || nesByteBits(v, 16) === 16
      ? true
      : nesByteBits(v, 24) === 0
        ? false
        : null;
  const old = active(mapper.ppu_mask),
    next = active(byte);
  const enableTransition =
    old === true || next === false
      ? false
      : old === false && next === true
        ? true
        : null;
  if (enableTransition === true) return resetFrame(s);
  // Direct disable-to-idle timing is not fully confirmed; join the ordinary
  // no-reset state and loss of frame until explicit idle M2 rises resolve it.
  const disabled =
    next === true
      ? s
      : {
          ...s,
          in_frame: common([s.in_frame, false]),
          last_ppu_address: null,
          matching_reads: phaseSet([...counts(s.matching_reads), 0]),
        };
  return enableTransition === false
    ? disabled
    : merge([disabled, resetFrame(s)]);
};

/** One supplied bus event; no instruction timing, interrupt polling or power-on state is invented. */
export const advanceMmc5Irq = (
  s: NesMmc5IrqState,
  mapper: NesMmc5State,
  event: NesMapperEvent,
): { state: NesMmc5IrqState; clock: boolean | null; read?: NesMmc5IrqRead } => {
  if (event.kind === "ppu-read") return ppuRead(s, mapper, event.address);
  if (event.kind === "mmc5-cpu-cycle")
    return { state: cpuCycle(s), clock: false };
  if (event.kind === "mmc5-reset")
    return { state: { ...s, enabled: false, asserted: false }, clock: false };
  if (event.kind === "cpu-write")
    return { state: write(s, mapper, event), clock: false };
  if (event.kind !== "cpu-read") return { state: s, clock: false };
  if (event.address === 0x5204)
    return {
      state: { ...s, pending: false, asserted: false },
      clock: false,
      read: readStatus(s),
    };
  if (event.address === 0xfffa || event.address === 0xfffb)
    return { state: resetFrame(s), clock: false };
  if (event.address === 0x2002) {
    const bit = nesByteBits(
      "ppu_status" in event ? event.ppu_status : null,
      128,
    );
    return {
      ...("ppu_status" in event
        ? { read: readSnoopedStatus(event.ppu_status) }
        : {}),
      state:
        bit === 128 ? resetFrame(s) : bit === 0 ? s : merge([s, resetFrame(s)]),
      clock: false,
    };
  }
  return {
    state:
      event.address === null
        ? merge([s, resetFrame(s), { ...s, pending: false, asserted: false }])
        : s,
    clock: false,
  };
};
