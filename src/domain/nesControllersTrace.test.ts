import { deriveNesFixtureTrace } from "./nesSource.fixture.js";
import { namco163RamFixture } from "./nesNamco163Ram.fixture.js";
import { expect, it } from "vitest";

import { nesPpuFixture, nesOamUploadFixture } from "./nesPpu.fixture.js";

const initialControllers = {
  model: "standard-controllers",
  buttons: [105, 90],
  dma_reads: "absent",
  oam_dma_pending: { status: "none" },
  next_event_index: 1000,
};
const source = async (
  fixture: Pick<
    ReturnType<typeof nesPpuFixture>,
    "bytes" | "prgOffset" | "chrOffset"
  >,
  extra: Record<string, unknown> = {},
) => {
  const {
    trace: code,
    input,
    header,
  } = await deriveNesFixtureTrace(
    fixture.bytes,
    fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
    {
      path: "/joy.nes",
      initial: { mapper: 0 },
      initial_controllers: initialControllers,
      ...extra,
    },
  );
  if (
    code.mapper_trace.status !== "derived" ||
    !("controller_trace" in code.mapper_trace) ||
    code.mapper_trace.controller_trace === null
  )
    throw new Error(JSON.stringify(code));
  return {
    code,
    mapped: code.mapper_trace,
    controllers: code.mapper_trace.controller_trace,
    header: header,
    input,
  };
};

it("keeps unobserved DMA reads uncertain and retains atomic hypothetical DMA frontiers", async () => {
  const fixture = nesPpuFixture([
    169, 1, 141, 22, 64, 169, 0, 141, 22, 64, 173, 22, 64, 96,
  ]);
  const unknown = await source(fixture, {
    initial_controllers: { ...initialControllers, dma_reads: "unobserved" },
  });
  expect(unknown.code.instructions.at(-1)!.data_reads[0]!.value).toBeNull();
  expect("known_bits" in unknown.code.instructions.at(-1)!.data_reads[0]!).toBe(
    false,
  );
  const stopped = await source(nesPpuFixture([96]), {
    initial_controllers: {
      ...initialControllers,
      oam_dma_pending: { status: "pending", page: 2 },
    },
  });
  expect(stopped.controllers.final.oam_dma_pending).toEqual({
    status: "pending",
    page: 2,
  });
  expect(stopped.controllers.final.next_event_index).toBe(1000);
  expect(stopped.controllers.operations).toEqual([]);
  expect(stopped.controllers.frontier).toMatchObject([
    { event_index: 1000, effects: ["dma-consumed"] },
  ]);
});

it("binds OAM and controller queues, captures the held opcode address and leaves both pending on a source-byte budget stop", async () => {
  const fixture = nesOamUploadFixture({
    viaRam: false,
    tail: [234, 173, 22, 64, 96],
  });
  const controllerInput = {
    ...initialControllers,
    strobe: false,
    ports: [
      {
        serial_reports: [
          {
            position: 0,
            buttons: 105,
            origin: { kind: "initial-report", port: 1 },
          },
        ],
      },
      {},
    ],
  };
  const traced = await source(fixture, {
    initial_ppu: fixture.initial_ppu,
    initial_controllers: controllerInput,
  });
  expect(traced.code.instructions.at(-1)!.data_reads).toMatchObject([
    { address: 0x4016, known_bits: { mask: 1, value: 1 } },
  ]);
  const packet = traced.mapped.steps.find(
    (step) => step.event.kind === "oam-dma",
  )!;
  expect(packet.event).toMatchObject({
    halted_cpu_address: fixture.entry + 10,
  });
  expect(
    traced.controllers.operations.find(
      (operation) => operation.kind === "oam-dma",
    )!.effects,
  ).toEqual(["dma-consumed"]);
  const stopped = await source(fixture, {
    initial_controllers: controllerInput,
    initial_ppu: fixture.initial_ppu,
    max_oam_dma_source_bytes: 0,
  });
  expect(stopped.code.stop.reason).toBe("oam-dma-source-budget");
  expect(stopped.controllers.final.oam_dma_pending).toEqual({
    status: "pending",
    page: 0x82,
  });
  expect(
    "ppu_trace" in stopped.mapped
      ? stopped.mapped.ppu_trace.final.oam!.dma_pending
      : null,
  ).toEqual({ status: "pending", page: 0x82 });
});

it("reconciles a Namco DMA request without a PPU profile or shared mutable input", async () => {
  for (const mode of ["wrap", "saturate"] as const) {
    const fixture = namco163RamFixture(mode);
    fixture.bytes.set(
      [234, 173, 22, 64, 96],
      fixture.prgOffset + 15 * 8192 + 256,
    );
    const initial = {
        ...fixture.initial,
        chip_ram: { ...fixture.initial.chip_ram, oam_dma_pending: 72 },
      },
      controls = {
        ...initialControllers,
        strobe: false,
        oam_dma_pending: { status: "unknown" },
        ports: [
          {
            serial_reports: [
              {
                position: 0,
                buttons: 105,
                origin: { kind: "initial-report", port: 1 },
              },
            ],
          },
          {},
        ],
      };
    const result = await source(
      { ...fixture, chrOffset: fixture.prgOffset + fixture.prgSize },
      { initial, initial_controllers: controls },
    );
    expect(result.code.stop.reason).toBe("return");
    expect(result.code.instructions.at(-1)!.data_reads[0]).toMatchObject({
      address: 0x4016,
      known_bits: { mask: 1, value: 1 },
    });
    expect(result.controllers.initial.oam_dma_pending).toEqual({
      status: "unknown",
    });
    expect(result.controllers.initialized.oam_dma_pending).toEqual({
      status: "pending",
      page: 72,
    });
    expect(result.controllers.final.oam_dma_pending).toEqual({
      status: "none",
    });
    expect(result.controllers.final.next_event_index).toBe(1002);
    expect(result.mapped.final).toMatchObject({
      chip_ram: {
        oam_dma_pending: "none",
        address_port: mode === "wrap" ? 128 : 255,
      },
    });
    expect(result.input.initial).toMatchObject({
      chip_ram: { oam_dma_pending: 72, address_port: 128 },
    });
    expect(result.input.initial_controllers!.oam_dma_pending).toEqual({
      status: "unknown",
    });
  }
});
