import { scheduler } from "node:timers/promises";
import type { Nes6502Context } from "./nes6502Context.js";
import type { NesCodePath } from "./nesCodeTrace.js";

type DmaTrace = Extract<NesCodePath, { cpu_dma: unknown }>["cpu_dma"];
/** A transfer owns its commitment independently of the following CPU instruction. */
export const deriveNesOamCpuDma = async (
  context: Nes6502Context,
  haltedAddress: number,
  beforeInstruction: number,
  {
    index,
    eventStart,
    signal,
  }: { index: number; eventStart: number; signal?: AbortSignal | undefined },
): Promise<
  | { status: "none" }
  | { status: "stopped"; frontier: NonNullable<DmaTrace["frontier"]> }
  | { status: "complete"; transfer: DmaTrace["transfers"][number] }
> => {
  const dma = context.cpuDma;
  if (dma === null || dma.state.oam_dma_pending.status === "none")
    return { status: "none" };
  const bus = context.bus!,
    request = dma.state.oam_dma_pending;
  const page = request.status === "pending" ? request.page : null,
    phase = dma.state.cpu_phase;
  const frontier = (): NonNullable<DmaTrace["frontier"]> => ({
    before_instruction_index: beforeInstruction,
    halted_address: haltedAddress,
    page,
    start_phase: phase,
    cpu_bus_cycles: bus.cycles,
    writes: context.writes,
    mapper_events: context.mapperEvents,
    blocked_address: bus.stopped?.address ?? null,
  });
  if (bus.permitRead(haltedAddress)) {
    const reason =
      request.status !== "pending" || typeof page !== "number"
        ? "cpu-dma-request"
        : phase === null
          ? "cpu-dma-phase"
          : haltedAddress >= 0x4000 &&
              haltedAddress <= 0x401f &&
              context.io === null
            ? "cpu-dma-io-conflict"
            : null;
    if (reason !== null) bus.stopped = { reason, address: haltedAddress };
  }
  if (bus.stopped !== null) return { status: "stopped", frontier: frontier() };
  context.dmaActive = true;
  context.oamActive = true;
  try {
    context.startOrderedOamDma(page as number);
    context.dmc?.beforeSharedCycle(haltedAddress);
    context.readBus(haltedAddress, "dummy");
    if (dma.state.cpu_phase === "put" && bus.stopped === null) {
      context.dmc?.beforeSharedCycle(haltedAddress);
      context.readBus(haltedAddress, "dummy");
    }
    let offset = 0;
    let held: { value: import("./nesByteValue.js").NesByteValue } | null = null;
    while (
      (offset < 256 || context.dmc?.active != null) &&
      bus.stopped === null
    ) {
      if (offset % 32 === 0) {
        await scheduler.yield();
        signal?.throwIfAborted();
      }
      context.dmc?.beforeSharedCycle(haltedAddress);
      if (bus.stopped !== null) break;
      if (context.dmc?.takesGet === true) context.dmc.getSample();
      else if (dma.state.cpu_phase === "get" && offset < 256) {
        held = {
          value: context.readDma(
            (page as number) * 256 + offset,
            haltedAddress,
          ),
        };
      } else if (dma.state.cpu_phase === "put" && held !== null) {
        context.write(0x2004, held.value);
        offset++;
        held = null;
        if (offset === 256) {
          context.oamActive = false;
          const lastDmc = context.dmc?.transfers.at(-1);
          if (
            lastDmc?.outcome === "aborted" &&
            lastDmc.cause === "implicit-stop" &&
            lastDmc.setup[0]!.shared_with_oam &&
            lastDmc.setup[0]!.cycle_index === bus.state.next_cycle_index - 1
          )
            // The reference CPU still owes a held dummy after this exact
            // shared-halt tail. Preserve the uncommitted OAM boundary until
            // that distinct tail has a qualified source model.
            bus.stopped = {
              reason: "dmc-dma-stop-window",
              address: haltedAddress,
            };
          // The final OAM write can empty the DMC buffer on its own edge.
          // Drain that new request in this held burst before committing OAM.
          context.dmc?.beforeSharedCycle(haltedAddress);
        }
      } else
        context.readBus(
          haltedAddress,
          context.oamActive ? "dummy" : context.dmc!.setupRole,
        );
    }
  } finally {
    context.dmaActive = false;
    context.oamActive = false;
  }
  if (bus.stopped !== null) return { status: "stopped", frontier: frontier() };
  return {
    status: "complete",
    transfer: {
      index,
      before_instruction_index: beforeInstruction,
      halted_address: haltedAddress,
      page: page as number,
      start_phase: phase!,
      cpu_bus_cycles: bus.cycles,
      writes: context.writes,
      mapper_event_range: {
        start: eventStart,
        count: context.mapperEvents.length,
      },
    },
  };
};
