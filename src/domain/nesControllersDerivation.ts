import type {
  NesControllersState,
  NesControllerOperation,
  NesControllerCpuRead,
} from "./nesControllers.js";
import {
  nesByteBits,
  joinNesBytes,
  type NesByteValue,
  type NesKnownBits,
} from "./nesByteValue.js";
import { mergeNesDmaRequests } from "./nesCpuDma.js";
import { ok, err, type Result } from "./result.js";
import type { NesMapperEvent } from "./nesMapperEvents.js";
type Port = 1 | 2;
type Reports = NesControllersState["ports"][number]["serial_reports"];
type Event =
  | Extract<NesMapperEvent, { kind: "controller-hold" }>
  | { kind: "controller-buttons"; port: Port; buttons: NesByteValue }
  | { kind: "cpu-read"; address: number | null }
  | {
      kind: "cpu-write";
      address: number;
      value: number | null;
      known_bits?: NesKnownBits;
    }
  | { kind: "oam-dma"; page: NesByteValue; halted_cpu_address?: number | null }
  | { kind: "oam-dma-start"; page: number }
  | {
      kind: Exclude<
        NesMapperEvent["kind"],
        | "controller-buttons"
        | "cpu-read"
        | "cpu-write"
        | "oam-dma"
        | "oam-dma-start"
        | "controller-hold"
      >;
    };
type ControllerFailure = {
  kind: "invalid-controller-state" | "invalid-controller-event";
  reason: string;
};
export const nesControllerButtonsAt = (
  state: NesControllersState,
  port: Port,
) => {
  const fact = state.buttons[port - 1]!;
  return typeof fact === "object" && fact !== null && "origin" in fact
    ? fact
    : {
        value: fact,
        origin: { kind: "initial-buttons" as const, port },
      };
};
export const admitNesControllers = (
  state: NesControllersState,
): Result<null, ControllerFailure> => {
  for (const port of [1, 2] as const) {
    const origins = [
      nesControllerButtonsAt(state, port).origin,
      ...state.ports[port - 1]!.serial_reports.flatMap<
        Reports[number]["origin"]
      >((report) =>
        report.origin.kind === "latch-write"
          ? [report.origin, report.origin.buttons_origin]
          : [report.origin],
      ),
    ];
    for (const origin of origins)
      if (
        origin.port !== port ||
        ("index" in origin && origin.index >= state.next_event_index)
      )
        return err({
          kind: "invalid-controller-state",
          reason:
            "Controller origins must identify their own port and precede next_event_index.",
        });
  }
  return ok(null);
};
export const admitNesControllerEvents = (
  initial: NesControllersState | null,
  events: readonly Event[],
): Result<null, ControllerFailure> => {
  if (initial === null)
    return events.some((event) => event.kind === "controller-buttons")
      ? err({
          kind: "invalid-controller-event",
          reason:
            "controller-buttons requires initial_controllers model standard-controllers.",
        })
      : ok(null);
  const admitted = admitNesControllers(initial);
  if (!admitted.ok) return admitted;
  if (events.length > Number.MAX_SAFE_INTEGER - initial.next_event_index)
    return err({
      kind: "invalid-controller-event",
      reason:
        "Supplied events exceed the remaining safe controller event identity range.",
    });
  let pending = initial.oam_dma_pending;
  for (const event of events) {
    if (event.kind === "cpu-read") pending = { status: "none" };
    else if (
      event.kind === "cpu-write" &&
      "address" in event &&
      event.address === 0x4014
    )
      pending = {
        status: "pending",
        page: event.value ?? ("known_bits" in event ? event.known_bits : null),
      };
    else if (
      (event.kind === "oam-dma" || event.kind === "oam-dma-start") &&
      "page" in event
    ) {
      const merged = mergeNesDmaRequests([
        pending,
        { status: "pending", page: event.page },
      ]);
      if (!merged.ok)
        return err({
          kind: "invalid-controller-event",
          reason: merged.error.reason,
        });
      pending = { status: "none" };
    }
  }
  return ok(null);
};
const captured = (
  state: NesControllersState,
  port: Port,
  initial = false,
): Reports => {
  const fact = nesControllerButtonsAt(state, port);
  return [
    {
      position: 0,
      buttons: fact.value,
      origin: initial
        ? fact.origin
        : {
            kind: "latch-write",
            port,
            index: state.next_event_index,
            buttons_origin: fact.origin,
          },
    },
  ];
};
export const initializeNesControllers = (
  initial: NesControllersState,
): NesControllersState => {
  const state = structuredClone(initial);
  if (state.strobe === true)
    for (const port of [1, 2] as const)
      state.ports[port - 1]!.serial_reports = captured(state, port, true);
  return state;
};
const view = (
  state: NesControllersState,
): NesControllerOperation["before"] => ({
  strobe: state.strobe,
  dma_reads: state.dma_reads,
  oam_dma_pending: structuredClone(state.oam_dma_pending),
  positions: [
    state.ports[0].serial_reports.map((report) => report.position),
    state.ports[1].serial_reports.map((report) => report.position),
  ],
});
const mergeReports = (
  state: NesControllersState,
  port: Port,
  reports: Reports,
): Reports => {
  const byPosition = new Map<number, Reports[number]>();
  for (const report of reports) {
    const before = byPosition.get(report.position);
    byPosition.set(
      report.position,
      before === undefined || JSON.stringify(before) === JSON.stringify(report)
        ? { ...report }
        : {
            position: report.position,
            buttons: joinNesBytes(before.buttons, report.buttons),
            origin: {
              kind: "joined-report",
              port,
              index: state.next_event_index,
            },
          },
    );
  }
  return [...byPosition.values()].sort((a, b) => a.position - b.position);
};
const extraClocks = (state: NesControllersState, port: Port): Reports =>
  mergeReports(
    state,
    port,
    state.ports[port - 1]!.serial_reports.flatMap((report) =>
      Array.from({ length: 9 - report.position }, (_, offset) => ({
        ...report,
        position: report.position + offset,
      })),
    ),
  );
const shifted = (reports: Reports): Reports =>
  reports.map((report) => ({
    ...report,
    position: Math.min(8, report.position + 1),
  }));
const mayDeviceDma = (page: NesByteValue, halted: number | null): boolean => {
  const selected = nesByteBits(page, 255);
  const mask = typeof page === "number" ? 255 : (page?.mask ?? 0),
    bits = typeof page === "number" ? page : (page?.value ?? 0);
  return (
    selected === 0x40 ||
    (selected === null && (0x40 & mask) === bits) ||
    halted === null ||
    (halted >= 0x4000 && halted <= 0x401f)
  );
};
const consumeDma = (
  state: NesControllersState,
  halted: number | null,
): boolean => {
  const request = state.oam_dma_pending;
  if (request.status === "none") return false;
  const interferes = mayDeviceDma(
    request.status === "pending" ? request.page : null,
    halted,
  );
  if (interferes && state.strobe !== true)
    for (const port of [1, 2] as const)
      state.ports[port - 1]!.serial_reports = extraClocks(state, port);
  state.oam_dma_pending = { status: "none" };
  return interferes;
};
export const nesControllerSourceD0 = (
  strobe: boolean | null,
  live: NesByteValue,
  reports: Reports,
): 0 | 1 | null => {
  const bits: (number | null)[] = [];
  if (strobe !== false) bits.push(nesByteBits(live, 1));
  if (strobe !== true)
    for (const report of reports) {
      const sampled = nesByteBits(report.buttons, 1 << report.position);
      bits.push(
        report.position === 8
          ? 1
          : sampled === null
            ? null
            : sampled >> report.position,
      );
    }
  return bits.every((value) => value !== null && value === bits[0])
    ? (bits[0]! as 0 | 1)
    : null;
};
const readPad = (
  state: NesControllersState,
  port: Port,
  reason: string | null,
): NesControllerCpuRead => {
  const live = nesControllerButtonsAt(state, port),
    reports = state.ports[port - 1]!.serial_reports,
    bit = nesControllerSourceD0(state.strobe, live.value, reports);
  const source = {
    kind: "standard-controller" as const,
    port,
    strobe: state.strobe,
    live: structuredClone(live),
    serial_reports: structuredClone(reports),
    tail_bit: 1 as const,
    dma_reads: state.dma_reads,
    reason: reason ?? (bit === null ? "unresolved-controller-bit" : null),
  };
  if (state.strobe !== true)
    state.ports[port - 1]!.serial_reports = mergeReports(
      state,
      port,
      shifted(reports),
    );
  return {
    address: port === 1 ? 16406 : 16407,
    value: null,
    source,
    ...(bit === null
      ? {}
      : {
          known_bits: {
            mask: 1 as const,
            value: bit === 0 ? (0 as const) : (1 as const),
          },
        }),
  };
};

type ControllerDelta = Pick<
  NesControllerOperation,
  "address" | "port" | "effects" | "reason"
> & { read: NesControllerCpuRead | null };
const writeControllerCpu = (
  state: NesControllersState,
  event: Extract<Event, { kind: "cpu-write" }>,
  dmcReadsModeled: boolean,
): ControllerDelta => {
  let address: number | null = null,
    reason: string | null = null;
  const effects: NesControllerOperation["effects"] = [];
  address = event.address;
  const byte = event.value ?? event.known_bits ?? null;
  if (address === 0x4014) {
    state.oam_dma_pending = { status: "pending", page: byte };
    effects.push("dma-queued");
  } else if (
    !dmcReadsModeled &&
    address === 0x4015 &&
    nesByteBits(byte, 16) !== 0
  ) {
    state.dma_reads = "unobserved";
    effects.push("dmc-uncertainty");
    reason = "unobserved-dmc-enablement";
  } else if (address === 0x4016) {
    const strobe = nesByteBits(byte, 1);
    for (const number of [1, 2] as const) {
      const current = state.ports[number - 1]!.serial_reports,
        fresh = captured(state, number);
      state.ports[number - 1]!.serial_reports =
        strobe === 1 || state.strobe === true
          ? fresh
          : state.strobe === false
            ? current
            : mergeReports(state, number, [...current, ...fresh]);
    }
    state.strobe = strobe === null ? null : strobe !== 0;
    effects.push("strobe-write");
  }
  return { address, port: null, effects, reason, read: null };
};
const readControllerCpu = (
  state: NesControllersState,
  event: Extract<Event, { kind: "cpu-read" }>,
): ControllerDelta => {
  let address: number | null = null,
    reason: string | null = null,
    port: Port | null = null,
    read: NesControllerCpuRead | null = null;
  const effects: NesControllerOperation["effects"] = [];
  address = event.address;
  if (state.oam_dma_pending.status !== "none") {
    if (consumeDma(state, address)) {
      effects.push("oam-interference");
      reason = "unobserved-oam-controller-reads";
    }
    effects.push("dma-consumed");
  }
  if (
    address !== null &&
    address >= 0x4000 &&
    address <= 0x401f &&
    state.dma_reads === "unobserved" &&
    state.strobe !== true
  ) {
    for (const number of [1, 2] as const)
      state.ports[number - 1]!.serial_reports = extraClocks(state, number);
    effects.push("dmc-uncertainty");
    reason ??= "unobserved-dmc-controller-clocks";
  }
  if (address === 0x4016 || address === 0x4017) {
    port = address === 0x4016 ? 1 : 2;
    read = readPad(state, port, reason);
    effects.push("serial-read");
  } else if (address === null) {
    if (state.strobe !== true)
      for (const number of [1, 2] as const) {
        const reports =
          state.dma_reads === "unobserved"
            ? extraClocks(state, number)
            : state.ports[number - 1]!.serial_reports;
        state.ports[number - 1]!.serial_reports = mergeReports(state, number, [
          ...reports,
          ...shifted(reports),
        ]);
      }
    effects.push("serial-read");
    reason ??= "unresolved-cpu-read-address";
  }
  return { address, port, effects, reason, read };
};

/** Apply one modeled bus event; the caller owns its single event-index increment. */
export const advanceNesControllers = (
  state: NesControllersState,
  event: Event,
  { dmcReadsModeled = false }: { dmcReadsModeled?: boolean } = {},
): Result<
  {
    operation: NesControllerOperation;
    read: NesControllerCpuRead | null;
  } | null,
  ControllerFailure
> => {
  const before = view(state);
  let delta: ControllerDelta;
  if (event.kind === "controller-buttons") {
    const port = event.port;
    state.buttons[port - 1] = {
      value: event.buttons,
      origin: { kind: "buttons-event", port, index: state.next_event_index },
    };
    if (state.strobe === true)
      state.ports[port - 1]!.serial_reports = captured(state, port, true);
    delta = {
      address: null,
      port,
      effects: ["buttons-update"],
      reason: null,
      read: null,
    };
  } else if (event.kind === "cpu-write")
    delta = writeControllerCpu(state, event, dmcReadsModeled);
  else if (event.kind === "cpu-read") delta = readControllerCpu(state, event);
  else if (event.kind === "controller-hold")
    delta = {
      address: event.address,
      port: event.address === 0x4016 ? 1 : 2,
      effects: ["held-read"],
      reason: null,
      read: null,
    };
  else if (event.kind === "oam-dma-start") {
    state.oam_dma_pending = { status: "none" };
    delta = {
      address: null,
      port: null,
      effects: ["dma-consumed"],
      reason: null,
      read: null,
    };
  } else if (event.kind === "oam-dma") {
    const merged = mergeNesDmaRequests([
      state.oam_dma_pending,
      { status: "pending", page: event.page },
    ]);
    if (!merged.ok)
      return err({
        kind: "invalid-controller-event",
        reason: merged.error.reason,
      });
    state.oam_dma_pending = merged.value;
    const interferes = consumeDma(state, event.halted_cpu_address ?? null);
    delta = {
      address: null,
      port: null,
      effects: interferes
        ? ["oam-interference", "dma-consumed"]
        : ["dma-consumed"],
      reason: interferes ? "unobserved-oam-controller-reads" : null,
      read: null,
    };
  } else return ok(null);
  if (delta.effects.length === 0) return ok(null);
  const { read, ...fields } = delta;
  return ok({
    operation: {
      event_index: state.next_event_index,
      kind: event.kind,
      before,
      after: view(state),
      ...fields,
    },
    read,
  });
};
