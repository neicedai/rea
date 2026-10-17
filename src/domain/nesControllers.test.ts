import { expect, it } from "vitest";
import {
  nesControllersStateSchema,
  type NesControllersState,
} from "./nesControllers.js";
import {
  advanceNesControllers,
  initializeNesControllers,
  admitNesControllers,
  admitNesControllerEvents,
} from "./nesControllersDerivation.js";
import { mergeNesDmaRequests, bindNesCpuDma } from "./nesCpuDma.js";
import { nesPpuFixtureState } from "./nesPpu.fixture.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";

const state = (extra: Record<string, unknown> = {}) =>
  initializeNesControllers(
    nesControllersStateSchema.parse({
      model: "standard-controllers",
      dma_reads: "absent",
      oam_dma_pending: { status: "none" },
      ...extra,
    }),
  );
const step = (
  current: NesControllersState,
  event: Parameters<typeof advanceNesControllers>[1],
) => {
  const result = advanceNesControllers(current, event);
  if (!result.ok) throw new Error(result.error.reason);
  current.next_event_index++;
  return result.value;
};
const strobe = (current: NesControllersState, value: 0 | 1) =>
  step(current, { kind: "cpu-write", address: 0x4016, value });
const read = (current: NesControllersState, port: 1 | 2) => {
  const result = step(current, {
    kind: "cpu-read",
    address: port === 1 ? 0x4016 : 0x4017,
  });
  if (result?.read == null) throw new Error("Missing controller read");
  return result.read;
};

it("reads every complete button report LSB-first independently on both ports, followed by a wiring-one tail", () => {
  for (let value = 0; value < 256; value++) {
    const current = state({
      buttons: [value, value ^ 255],
      next_event_index: 100,
    });
    strobe(current, 1);
    strobe(current, 0);
    for (let bit = 0; bit < 10; bit++)
      for (const port of [1, 2] as const) {
        const result = read(current, port);
        expect(result.value).toBeNull();
        expect("known_bits" in result ? result.known_bits : null).toEqual({
          mask: 1,
          value: bit >= 8 ? 1 : ((port === 1 ? value : value ^ 255) >> bit) & 1,
        });
        expect(result.source.port).toBe(port);
        expect(result.source.serial_reports).toHaveLength(1);
        expect(result.source.serial_reports[0]!.position).toBe(
          Math.min(bit, 8),
        );
        expect(result.source.serial_reports[0]!.origin).toEqual({
          kind: "latch-write",
          index: 101,
          port,
          buttons_origin: { kind: "initial-buttons", port },
        });
      }
    const admitted = admitNesControllers(current);
    if (!admitted.ok) throw new Error(admitted.error.reason);
  }
});

it("holds live A under high strobe and freezes both reports at the falling edge", () => {
  const current = state({ buttons: [165, 90] });
  strobe(current, 1);
  for (let count = 0; count < 3; count++)
    expect(read(current, 1)).toMatchObject({
      known_bits: { mask: 1, value: 1 },
    });
  step(current, { kind: "controller-buttons", port: 1, buttons: 4 });
  expect(read(current, 1)).toMatchObject({
    known_bits: { mask: 1, value: 0 },
    source: { live: { origin: { kind: "buttons-event", index: 4, port: 1 } } },
  });
  strobe(current, 0);
  step(current, { kind: "controller-buttons", port: 1, buttons: 255 });
  expect(
    Array.from({ length: 8 }, () => read(current, 1)).map((item) =>
      "known_bits" in item ? item.known_bits.value : null,
    ),
  ).toEqual([0, 0, 1, 0, 0, 0, 0, 0]);
  expect(read(current, 2)).toMatchObject({ known_bits: { mask: 1, value: 0 } });
  step(current, { kind: "cpu-write", address: 0x4017, value: 1 });
  expect(current.strobe).toBe(false);
  expect(current.ports[1].serial_reports[0]!.position).toBe(1);
});

it("retains unknown-strobe phase correlation and partial reports instead of choosing an alignment", () => {
  const current = state({
    buttons: [0, null],
    strobe: null,
    ports: [
      {
        serial_reports: [
          {
            position: 8,
            buttons: null,
            origin: { kind: "initial-report", port: 1 },
          },
        ],
      },
      {},
    ],
  });
  expect("known_bits" in read(current, 1)).toBe(false);
  expect(
    current.ports[0].serial_reports.map((report) => report.position),
  ).toEqual([8]);
  strobe(current, 0);
  expect(
    current.ports[0].serial_reports.map((report) => report.position),
  ).toEqual([0, 8]);
  const partial = state({ buttons: [{ mask: 129, value: 129 }, null] });
  strobe(partial, 1);
  strobe(partial, 0);
  const bits = Array.from({ length: 8 }, () => read(partial, 1)).map((item) =>
    "known_bits" in item ? item.known_bits.value : null,
  );
  expect(bits).toEqual([1, null, null, null, null, null, null, 1]);
});

it("keeps DMA repeats monotonic, honors queued replacement pages and preserves high-strobe and tail proofs", () => {
  const current = state({ buttons: [0, 255] });
  strobe(current, 1);
  strobe(current, 0);
  step(current, { kind: "cpu-write", address: 0x4014, value: 0x40 });
  step(current, { kind: "cpu-write", address: 0x4014, value: 2 });
  const drained = step(current, { kind: "cpu-read", address: 0x8000 });
  expect(drained!.operation.effects).toEqual(["dma-consumed"]);
  expect(current.ports[0].serial_reports[0]!.position).toBe(0);
  expect(read(current, 1)).toMatchObject({ known_bits: { mask: 1, value: 0 } });
  step(current, { kind: "cpu-write", address: 0x4015, value: 16 });
  expect("known_bits" in read(current, 1)).toBe(false);
  expect(
    current.ports[0].serial_reports.map((report) => report.position),
  ).toEqual([2, 3, 4, 5, 6, 7, 8]);
  expect(read(current, 2)).toMatchObject({ known_bits: { mask: 1, value: 1 } });
  strobe(current, 1);
  expect(read(current, 1)).toMatchObject({ known_bits: { mask: 1, value: 0 } });
});

it("reconciles shared pending CPU DMA facts and rejects contradictory queues, provenance and serial duplicates", () => {
  const merged = mergeNesDmaRequests([
    { status: "pending", page: { mask: 240, value: 32 } },
    { status: "pending", page: { mask: 15, value: 7 } },
  ]);
  if (!merged.ok) throw new Error(merged.error.reason);
  expect(merged.value).toEqual({ status: "pending", page: 39 });
  expect(
    mergeNesDmaRequests([
      { status: "none" },
      { status: "pending", page: null },
    ]),
  ).toMatchObject({ ok: false, error: { kind: "incompatible-dma-request" } });
  const controllers = state(),
    ppu = nesPpuFixtureState({ oam: { model: "oam-memory" } }),
    mapper = nesMapperStateSchema.parse({ mapper: 0 });
  const bound = bindNesCpuDma(controllers, ppu, mapper);
  if (!bound.ok) throw new Error(bound.error.reason);
  expect(ppu.oam!.dma_pending).toEqual({ status: "none" });
  const invalid = state({
    next_event_index: 1,
    buttons: [
      { value: 1, origin: { kind: "buttons-event", port: 2, index: 0 } },
      null,
    ],
  });
  expect(admitNesControllers(invalid)).toMatchObject({
    ok: false,
    error: { kind: "invalid-controller-state" },
  });
  const duplicate = {
    position: 0,
    buttons: 1,
    origin: { kind: "initial-report", port: 1 },
  };
  expect(
    nesControllersStateSchema.safeParse({
      model: "standard-controllers",
      ports: [{ serial_reports: [duplicate, duplicate] }, {}],
    }).success,
  ).toBe(false);
  expect(
    admitNesControllerEvents(controllers, [{ kind: "oam-dma", page: 2 }]),
  ).toMatchObject({ ok: false });
});
