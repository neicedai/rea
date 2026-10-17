import { z } from "zod";
import { nesByteValueSchema, nesKnownBitsSchema } from "./nesByteValue.js";
import { nesApuFrameSchema, nesApuFrameSignalsSchema } from "./nesApuFrame.js";
import { nesDmcStateSchema, nesDmcFactSchema } from "./nesDmc.js";

export const nesApuRegisters = [
  0x4000, 0x4001, 0x4002, 0x4003, 0x4004, 0x4005, 0x4006, 0x4007, 0x4008,
  0x400a, 0x400b, 0x400c, 0x400e, 0x400f, 0x4010, 0x4011, 0x4012, 0x4013,
  0x4015, 0x4017,
] as const;
const eventIndex = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const originSchema = z.union([
  z.strictObject({ kind: z.literal("initial-state") }),
  z.strictObject({
    kind: z.enum([
      "event-write",
      "event-clock",
      "status-read",
      "unobserved-dmc",
      "dmc-read",
    ]),
    index: eventIndex,
  }),
]);
export type NesApuOrigin = z.infer<typeof originSchema>;
const origin = originSchema.prefault({ kind: "initial-state" });
const range = (maximum: number) =>
  z
    .strictObject({
      min: z.number().int().min(0).max(maximum),
      max: z.number().int().min(0).max(maximum),
    })
    .refine(
      (value) => value.min <= value.max,
      "Counter minimum exceeds maximum",
    );
const counter = (maximum: number) =>
  z
    .strictObject({
      value: range(maximum).prefault({ min: 0, max: maximum }),
      origin,
    })
    .prefault({});
const flag = z
  .strictObject({ value: z.boolean().nullable().default(null), origin })
  .prefault({});
const register = z.strictObject({
  value: nesByteValueSchema.default(null),
  origin,
});
const timer = z
  .strictObject({
    low: register.prefault({}),
    high: register
      .safeExtend({
        value: z
          .union([
            z.number().int().min(0).max(7),
            nesKnownBitsSchema
              .safeExtend({
                mask: z.number().int().min(1).max(6),
                value: z.number().int().min(0).max(7),
              })
              .meta(nesKnownBitsSchema.meta() ?? {}),
          ])
          .nullable()
          .default(null),
      })
      .prefault({}),
  })
  .prefault({});
const envelope = z
  .strictObject({ start: flag, divider: counter(15), decay: counter(15) })
  .prefault({});
const sweep = z
  .strictObject({ reload: flag, divider: counter(7) })
  .prefault({});

export const nesApuLimitations =
  "Optional initial_apu model apu-registers derives the conventional ordered 2A03/2A07 CPU audio ports, four length counters, pulse/noise envelopes, triangle linear counter, pulse sweep timers, DMC enable/start/stop and pre-acknowledgement 4015 status. frame_clocks explicit qualifies every supplied quarter/half-frame edge and delayed reset. frame_clocks cpu-ordered adds a caller-selected NTSC/PAL sequencer driven by apu-cpu-cycle edges, with three/four-edge reset delay, pulse blocking and three end-of-four-step IRQ requests. Its phase, active mode, get/put parity and pending delay are retained, including conservative unknown-phase covers. Manual unit clocks and scheduled edges cannot be mixed. Source initial_cpu_bus model nmos-6502-bus generates subsequent edges for qualified nominal and selected DMA CPU actions; without it, cpu-ordered framing requires supplied apu-cpu-cycle events. No source clocks are physical observations. Register facts retain raw bytes and absolute event origins; counter intervals are conservative covers, not independently selectable correlated states. Optional dmc_reads explicit with initial_apu.dmc model dmc-reader-output derives qualified uncontended mapped sample grants, 7-bit DAC output bits, NTSC/PAL timer periods, buffer/shift origins, address wrapping, loop and fetch-end IRQ separately from buffered playback. Optional dmc.cpu_timing model 2a03-dmc-dma selects qualified NTSC source load/reload/duplicate timing, write-cycle halt retries, OAM arbitration, independent delayed explicit/implicit reader stops and cycle-linked delivered sample proofs. Near-boundary implicit stops and optional same-edge duplication require qualified initial one-byte load history; changing live 4013 does not turn a reload into an initial load. These conditional initial-load rules are not a verbatim mapping of arbitrarily seeded emulator states. Stop expiry retains its original disabling write or triggering delivered-read event/cycle and can abort a halted DMA or discard its physical get without delivering a buffer byte; re-enables do not cancel an already pending stop. Omitted stop history and duplication selection stay unknown, independent of raw 4015. Matching post-clock bits/timer values alone do not establish a same-edge output boundary. apu-dmc-read grants and explicit output clocks alone establish no source CPU halt/arbitration timing; CPU-ordered output timers require matching region framing. Unobserved DMC reads retain possible depletion/restart/IRQ effects; possible 4015 D4 enable invalidates an absent-read qualification. D5 of 4015 remains CPU internal open bus, with no fake ROM/RAM source. Reads of write-only ports remain unknown. Within-cycle clock/write/read races, unqualified CPU timing, unselected waveform phases/timers, unselected source DMC scheduling, unqualified silicon stop-window behavior, mixer, RGB/video, physical hardware and observed audio are not inferred. Source frontiers never commit a stopped instruction's hypothetical APU effects.";
const manualApuState = z
  .strictObject({
    model: z.literal("apu-registers"),
    frame_clocks: z.literal("explicit"),
    dmc_reads: z
      .enum(["absent", "unobserved", "explicit"])
      .default("unobserved"),
    dmc: nesDmcStateSchema.nullable().default(null),
    next_event_index: eventIndex.default(0),
    registers: z
      .record(
        z.string().regex(new RegExp(`^(?:${nesApuRegisters.join("|")})$`, "u")),
        register,
      )
      .meta({ maxProperties: 20 })
      .default({}),
    lengths: z
      .array(counter(254))
      .length(4)
      .prefault([{}, {}, {}, {}])
      .describe(
        "Pulse 1, pulse 2, triangle and noise physical length counters; inclusive conservative intervals.",
      ),
    envelopes: z
      .array(envelope)
      .length(3)
      .prefault([{}, {}, {}])
      .describe(
        "Pulse 1, pulse 2 and noise envelope units, independent of constant-volume selection.",
      ),
    pulse_timers: z
      .array(timer)
      .length(2)
      .prefault([{}, {}])
      .describe(
        "Effective 11-bit periods, including sweep changes; raw last-written timer registers retain separate provenance.",
      ),
    sweeps: z.array(sweep).length(2).prefault([{}, {}]),
    triangle_linear: counter(127),
    triangle_reload: flag,
    dmc_remaining: counter(4081),
    frame_irq: flag,
    dmc_irq: flag,
    frame_reset_pending: flag,
  })
  .describe(nesApuLimitations);
export const nesApuStateSchema = z.union([
  manualApuState,
  manualApuState.omit({ frame_reset_pending: true }).extend({
    frame_clocks: z.literal("cpu-ordered"),
    frame_sequencer: nesApuFrameSchema,
  }),
]);
export type NesApuState = z.infer<typeof nesApuStateSchema>;
export type NesApuCounter = NesApuState["lengths"][number];
export type NesApuFlag = NesApuState["frame_irq"];

export const nesApuClockEventSchema = z.union([
  z
    .strictObject({
      kind: z.literal("apu-cpu-phase"),
      phase: z.enum(["get", "put"]),
    })
    .describe(
      "Caller-qualified current get/put phase without an elapsed CPU edge. Refines an unknown CPU-ordered phase; a contradictory known phase is unsupported.",
    ),
  z
    .strictObject({ kind: z.literal("apu-cpu-cycle") })
    .describe(
      "One explicitly supplied subsequent CPU edge for the cpu-ordered APU profile. Drives its frame sequencer only; no CPU instruction, cartridge IRQ, PPU or waveform timer clock is inferred.",
    ),
  z
    .strictObject({
      kind: z.literal("apu-frame-clock"),
      clock: z.enum(["quarter", "quarter-half", "irq", "quarter-half-irq"]),
    })
    .describe(
      "Externally qualified APU unit clocks. IRQ requests are gated by the retained 4017 mode/inhibit bits; writes, PPU events and instruction counts imply no such edge.",
    ),
  z
    .strictObject({ kind: z.literal("apu-frame-reset") })
    .describe(
      "Externally qualified completion of a pending 4017 reset after its hardware delay. Mode 5 clocks quarter/half units here, never at the CPU write itself. A definitely absent pending reset is incompatible.",
    ),
]);

const statusFacts = z.strictObject({
  lengths: z.array(counter(254)).length(4),
  dmc_remaining: counter(4081),
  frame_irq: flag,
  dmc_irq: flag,
});
export const nesApuReadSourceSchema = statusFacts
  .extend({
    kind: z.literal("apu-status"),
    index: eventIndex,
  })
  .describe(
    "Pre-acknowledgement physical counter/IRQ facts. Bit 5 is unresolved internal CPU open bus; reading clears only frame IRQ under this ordered model.",
  );
export const nesApuCpuReadSchema = z.union([
  z.strictObject({
    address: z.literal(0x4015),
    value: z.null(),
    source: nesApuReadSourceSchema,
  }),
  z.strictObject({
    address: z.literal(0x4015),
    value: z.null(),
    known_bits: nesKnownBitsSchema,
    source: nesApuReadSourceSchema,
  }),
]);
export type NesApuCpuRead = z.infer<typeof nesApuCpuReadSchema>;
const cell = z.union([counter(4081), flag, register, nesDmcFactSchema]);
export const nesApuOperationSchema = z
  .strictObject({
    event_index: eventIndex,
    kind: z.enum([
      "cpu-read",
      "cpu-write",
      "apu-frame-clock",
      "apu-frame-reset",
      "apu-cpu-cycle",
      "apu-cpu-phase",
      "unobserved-dmc",
      "apu-dmc-read",
      "apu-dmc-cpu-read",
      "apu-dmc-clock",
      "apu-dmc-stop",
    ]),
    address: z.number().int().min(0).max(65535).nullable(),
    frame_clock: nesApuFrameSignalsSchema.nullable().default(null),
    changes: z
      .array(
        z.strictObject({
          field: z.string().min(1),
          before: cell.nullable(),
          after: cell,
        }),
      )
      .max(64),
    effects: z
      .array(
        z.enum([
          "register-write",
          "length-load",
          "channel-enables",
          "envelope-start",
          "linear-reload",
          "sweep-reload",
          "quarter-clock",
          "half-clock",
          "frame-irq",
          "frame-reset-queued",
          "frame-reset-complete",
          "status-read",
          "unknown-read-address",
          "dmc-uncertainty",
          "possible-quarter-clock",
          "possible-half-clock",
          "possible-frame-irq",
          "possible-frame-reset",
          "phase-assumption",
          "dmc-read",
          "dmc-clock",
          "dmc-stop",
          "dmc-duplicate",
          "dmc-implicit-stop-queued",
        ]),
      )
      .max(18),
  })
  .describe(
    "Compact physical state deltas, not repeated register/storage snapshots. An unapplied instruction retains these only in frontier.",
  );
export type NesApuOperation = z.infer<typeof nesApuOperationSchema>;
export const nesApuTraceSchema = z.strictObject({
  dmc_read_ready: z
    .boolean()
    .nullable()
    .describe(
      "Whether retained nonempty bytes and an empty sample buffer require a reader access. This is a derived dataflow condition, not a scheduled DMA halt or observed bus grant.",
    ),
  initial: nesApuStateSchema,
  initialized: nesApuStateSchema,
  operations: z.array(nesApuOperationSchema),
  final: nesApuStateSchema,
  frontier: z.array(nesApuOperationSchema),
});
