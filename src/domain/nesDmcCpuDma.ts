import { z } from "zod";
import type { Nes6502Context } from "./nes6502Context.js";
import { previewNesDmcDelivery } from "./nesDmc.js";
import {
  nesDmcStopWindowHazard,
  nesDmcStopOriginSchema,
  nesDmcReadOriginSchema,
  type NesDmcStopProof,
} from "./nesDmcTiming.js";

const cycle = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const episodeFields = {
  before_instruction_index: z.number().int().nonnegative(),
  halted_address: z.number().int().min(0).max(65535),
  first_cycle_index: cycle,
  setup: z
    .array(
      z.strictObject({
        cycle_index: cycle,
        phase: z.enum(["halt", "dummy", "alignment"]),
        shared_with_oam: z.boolean(),
      }),
    )
    .max(3),
};
const ordinaryEpisode = z.strictObject({
  ...episodeFields,
  type: z.enum(["load", "reload"]),
});
const duplicateEpisode = z.strictObject({
  ...episodeFields,
  type: z.literal("duplicate"),
  request_origin: nesDmcReadOriginSchema,
});
const withEpisodeKind = <T extends z.ZodRawShape>(fields: T) =>
  z.union([ordinaryEpisode.extend(fields), duplicateEpisode.extend(fields)]);
const episode = withEpisodeKind({
  sample_cycle_index: cycle.nullable(),
  mapper_event_index: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});
const sampleEpisode = withEpisodeKind({
  outcome: z.literal("sample"),
  sample_cycle_index: cycle,
  mapper_event_index: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
});
const stoppedFields = {
  cause: z.enum(["explicit-stop", "implicit-stop"]),
  stop_origin: nesDmcStopOriginSchema,
  stop_event_index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
};
const completedEpisode = z.union([
  sampleEpisode,
  withEpisodeKind({
    ...stoppedFields,
    outcome: z.literal("aborted"),
    setup: z
      .array(episodeFields.setup.element.extend({ phase: z.literal("halt") }))
      .length(1),
  }),
  withEpisodeKind({
    ...stoppedFields,
    outcome: z.literal("discarded"),
    get_cycle_index: cycle,
  }),
]);
export const nesDmcCpuDmaTraceSchema = z
  .strictObject({
    transfers: z.array(completedEpisode),
    retained_source_bytes: z
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER),
    frontier: z
      .strictObject({
        transfers: z.array(completedEpisode),
        active: episode.nullable(),
      })
      .nullable(),
  })
  .describe(
    "Source DMC DMA cycles are inline in instruction, interrupt or OAM bus records. setup references actual halt/dummy/alignment cycles, including cycles shared with OAM. A sample outcome retains non-null delivered-sample and mapper-event identities; a duplicate episode additionally requires the first delivery's absolute APU event and physical cycle origin. Its get is a fresh bus read in the same held burst. An aborted outcome retains only its actual halt and explicit/implicit stop origin; a discarded outcome retains a real raw get without a delivered sample event. Completed boundary episodes commit before opcode analysis. Episodes inside an unapplied instruction remain frontier facts. CPU cycle indices alone do not establish target identity.",
  );
type Episode = z.infer<typeof episode>;

/** Request timing belongs to the APU; this owner arbitrates actual bus cycles. */
export class NesDmcCpuDma {
  readonly transfers: z.infer<typeof completedEpisode>[] = [];
  active: Episode | null = null;
  private stage: "halt" | "dummy" | "get" = "halt";
  private sampling = false;
  private beforeInstruction = 0;
  private stopProof: NesDmcStopProof | null = null;
  constructor(private readonly context: Nes6502Context) {}
  beginInstruction(index: number): void {
    this.beforeInstruction = index;
  }
  /** APU owns effective reader stops; this owner decides their bus outcome. */
  stop(proof: NesDmcStopProof): void {
    if (this.active !== null) this.stopProof = structuredClone(proof);
  }
  private ready(address: number | null): boolean {
    const bus = this.context.bus!;
    if (!bus.permitRead(address)) return false;
    const dmc = this.context.apu!.dmc!,
      request = dmc.cpu_timing!.request;
    const reason =
      dmc.cpu_timing!.stop.status === "unknown"
        ? "dmc-dma-stop-timing"
        : request.status === "unknown"
          ? "dmc-dma-request"
          : request.status === "pending" &&
              request.delay === 0 &&
              this.phase === null
            ? "dmc-dma-phase"
            : request.status === "pending" &&
                request.delay === 0 &&
                dmc.current_address === null
              ? "dmc-dma-address"
              : request.status === "pending" &&
                  request.delay === 0 &&
                  address === null
                ? "dmc-dma-address"
                : request.status === "pending" &&
                    request.delay === 0 &&
                    address !== null &&
                    address >= 0x4000 &&
                    address <= 0x401f &&
                    this.context.io === null
                  ? "cpu-dma-io-conflict"
                  : null;
    if (reason !== null) {
      bus.stopped = { reason, address };
      return false;
    }
    return request.status === "pending" && request.delay === 0;
  }
  get phase(): "get" | "put" | null {
    const apu = this.context.apu!;
    return apu.frame_clocks === "cpu-ordered"
      ? apu.frame_sequencer.cpu_phase
      : null;
  }
  private start(address: number): void {
    const request = this.context.apu!.dmc!.cpu_timing!.request;
    if (request.status !== "pending") return;
    this.stage = "halt";
    this.stopProof = null;
    const base = {
      before_instruction_index: this.beforeInstruction,
      halted_address: address,
      first_cycle_index: this.context.bus!.state.next_cycle_index,
      setup: [],
      sample_cycle_index: null,
      mapper_event_index: null,
    };
    this.active =
      request.type === "duplicate"
        ? {
            ...base,
            type: "duplicate",
            request_origin: structuredClone(request.origin),
          }
        : { ...base, type: request.type };
  }
  /** OAM actions can simultaneously provide DMC halt/dummy/alignment clocks. */
  beforeSharedCycle(address: number): void {
    if (this.active === null && this.ready(address)) this.start(address);
  }
  get takesGet(): boolean {
    return this.active !== null && this.stage === "get" && this.phase === "get";
  }
  get setupRole(): "dmc-halt" | "dmc-dummy" | "dmc-alignment" {
    return this.stage === "halt"
      ? "dmc-halt"
      : this.stage === "dummy"
        ? "dmc-dummy"
        : "dmc-alignment";
  }
  afterCycle(index: number, shared: boolean): void {
    if (this.active === null || this.sampling) return;
    this.active.setup.push({
      cycle_index: index,
      phase: this.stage === "get" ? "alignment" : this.stage,
      shared_with_oam: shared,
    });
    if (this.stage === "halt" && this.stopProof !== null) {
      const {
        sample_cycle_index: _sample,
        mapper_event_index: _event,
        ...base
      } = this.active;
      this.transfers.push({
        ...base,
        setup: [{ ...base.setup[0]!, phase: "halt" }],
        outcome: "aborted",
        cause:
          this.stopProof.cause === "implicit"
            ? "implicit-stop"
            : "explicit-stop",
        stop_origin: this.stopProof.origin,
        stop_event_index: this.stopProof.event_index,
      });
      this.active = null;
      this.stopProof = null;
      return;
    }
    if (this.stage === "halt") this.stage = "dummy";
    else if (this.stage === "dummy") this.stage = "get";
  }
  getSample(): void {
    const context = this.context,
      bus = context.bus!,
      active = this.active!;
    const preview = previewNesDmcDelivery(context.apu!, active.type);
    if (
      (this.stopProof === null && preview.kind === "unknown") ||
      (this.stopProof !== null &&
        nesDmcStopWindowHazard(context.apu!, active.type, true))
    ) {
      bus.stopped = {
        reason: "dmc-dma-stop-window",
        address: active.halted_address,
      };
      return;
    }
    const address = context.apu!.dmc!.current_address!,
      index = bus.state.next_cycle_index;
    this.sampling = true;
    try {
      const value = context.readDma(address, active.halted_address, "dmc-get");
      if (bus.stopped !== null) return;
      if (this.stopProof !== null) {
        const {
          sample_cycle_index: _sample,
          mapper_event_index: _event,
          ...base
        } = active;
        this.transfers.push({
          ...base,
          outcome: "discarded",
          cause:
            this.stopProof.cause === "implicit"
              ? "implicit-stop"
              : "explicit-stop",
          stop_origin: this.stopProof.origin,
          stop_event_index: this.stopProof.event_index,
          get_cycle_index: index,
        });
        this.active = null;
        this.stopProof = null;
        return;
      }
      const eventIndex = context.nextMapperEventIndex;
      context.deliverDmcSample(address, value, index, preview.output_boundary);
      if (bus.stopped !== null) return;
      this.transfers.push({
        ...active,
        outcome: "sample",
        sample_cycle_index: index,
        mapper_event_index: eventIndex,
      });
      this.active = null;
      // Delivery can re-arm the silicon-qualified duplicate immediately. It
      // belongs to this held CPU read, without a nominal CPU cycle in between.
      const request = context.apu!.dmc!.cpu_timing!.request;
      if (
        request.status === "pending" &&
        request.type === "duplicate" &&
        this.ready(active.halted_address)
      )
        this.start(active.halted_address);
    } finally {
      this.sampling = false;
    }
  }
  /** A write never calls this path, leaving an eligible halt latched for retry. */
  beforeCpuRead(address: number | null): void {
    const context = this.context,
      bus = context.bus!;
    if (!this.ready(address)) return;
    this.start(address!);
    const old = context.dmaActive;
    context.dmaActive = true;
    try {
      while (this.active !== null && bus.stopped === null) {
        if (this.takesGet) this.getSample();
        else context.readBus(address, this.setupRole);
      }
    } finally {
      context.dmaActive = old;
    }
  }
}
