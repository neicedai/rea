import { expect, test } from "vitest";
import { NesCodeDiscoveryService } from "./NesCodeDiscoveryService.js";
import type {
  NesRomSnapshotInput,
  NesRomSnapshotPort,
} from "./NesRomSnapshotPort.js";
import { AnalysisOutputError } from "../../domain/analysisErrorCore.js";
import { err } from "../../domain/result.js";

const captureBoundary = () => {
  const calls: NesRomSnapshotInput[] = [];
  const failure = new AnalysisOutputError(
    "capture_rom",
    "Intentional capture boundary",
  );
  const port: NesRomSnapshotPort = {
    identity: { id: "test-nes", name: "Test NES snapshot", version: null },
    close: async () => {},
    captureRom: async (input) => {
      calls.push(input);
      return err(failure);
    },
  };
  return { service: new NesCodeDiscoveryService(port), calls, failure };
};

test("rejects contradictory immutable root profiles before opening the cartridge", async () => {
  for (const [initial, additional] of [
    [{ mapper: 0 }, { mapper: 2 }],
    [
      { mapper: 69, variant: "fme7" },
      { mapper: 69, variant: "5b" },
    ],
    [
      { mapper: 21, variant: "vrc4", wiring: "vrc4a" },
      { mapper: 21, variant: "vrc4", wiring: "vrc4c" },
    ],
    [
      { mapper: 11, bus_conflicts: "and" },
      { mapper: 11, bus_conflicts: "none" },
    ],
    [
      { mapper: 5, ram_wiring: "none" },
      { mapper: 5, ram_wiring: "ekrom" },
    ],
    [
      { mapper: 21, variant: "vrc4", prg_ram_wiring: "internal-2k" },
      { mapper: 21, variant: "vrc4", prg_ram_wiring: "external-8k" },
    ],
    [
      { mapper: 23, latch_present: true },
      { mapper: 23, latch_present: false },
    ],
    [
      { mapper: 0, prg_ram_write_enabled: true },
      { mapper: 0, prg_ram_write_enabled: false },
    ],
  ]) {
    const boundary = captureBoundary();
    const result = await boundary.service.discover({
      path: "/not-opened.nes",
      initial,
      additional_roots: [{ entry: 0x8000, initial: additional }],
    });
    if (result.ok)
      throw new Error("Conflicting board qualifications were accepted");
    expect(result.error).toMatchObject({
      _tag: "AnalysisInputError",
      operation: "discover_nes_code",
      issues: [
        { path: ["additional_roots", 0, "initial"], reason: "invalid_value" },
      ],
    });
    expect(boundary.calls).toEqual([]);
  }
});

test("keeps differing writable root facts and captures only the global PRG profile", async () => {
  const boundary = captureBoundary();
  const result = await boundary.service.discover({
    path: "/selected.nes",
    initial: { mapper: 69, variant: "fme7", command: 9 },
    additional_roots: [
      {
        entry: 0x8000,
        initial: {
          mapper: 69,
          variant: "fme7",
          command: 10,
          prg_banks: [1, 2, 3],
        },
      },
    ],
  });
  if (result.ok) throw new Error("Intentional capture failure was replaced");
  expect(result.error).toBe(boundary.failure);
  expect(boundary.calls).toHaveLength(1);
  expect(boundary.calls[0]).toMatchObject({
    path: "/selected.nes",
    chr_page: 0,
    includeChr: false,
    board: { family: "sunsoft", variant: "fme7" },
  });
});

test("rejects pre-cancelled discovery before parsing or opening any source", async () => {
  const boundary = captureBoundary(),
    controller = new AbortController();
  controller.abort();
  const result = await boundary.service.discover(
    {},
    { signal: controller.signal },
  );
  if (result.ok) throw new Error("Cancelled discovery returned Evidence");
  expect(result.error).toMatchObject({
    _tag: "AnalysisCancelledError",
    operation: "discover_nes_code",
  });
  expect(boundary.calls).toEqual([]);
});
