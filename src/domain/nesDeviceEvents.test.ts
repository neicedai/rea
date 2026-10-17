import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesPpuFixture, nesPpuFixtureState } from "./nesPpu.fixture.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";
import { deriveNesCode } from "./nesCodeDerivation.js";

const initialApu = {
  model: "apu-registers",
  frame_clocks: "explicit",
  dmc_reads: "unobserved",
  next_event_index: 500,
  registers: { 16400: { value: 128, origin: { kind: "initial-state" } } },
  dmc_remaining: {
    value: { min: 1, max: 1 },
    origin: { kind: "initial-state" },
  },
};
it.each(["initial_apu", "initial_ppu", "initial_controllers"] as const)(
  "reserves accepted-entry event identities for %s",
  async (profile) => {
    const fixture = nesPpuFixture([173, 21, 64, 96]),
      header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    for (const reserve of [8, 11]) {
      const raw = {
        path: "/entry.nes",
        initial: { mapper: 0 },
        cpu: { sp: 253 },
        entry: { accepted_interrupt: "irq", return_address: 0x8100 },
        max_instructions: 1,
        initial_apu: { ...initialApu },
        initial_ppu: nesPpuFixtureState({ next_event_index: 300 }),
        initial_controllers: {
          model: "standard-controllers",
          next_event_index: 400,
          dma_reads: "absent",
          oam_dma_pending: { status: "none" },
        },
      };
      raw[profile].next_event_index = Number.MAX_SAFE_INTEGER - reserve;
      const input = traceNesCodeInputSchema.parse(raw),
        result = nesCodeTraceSchema.parse(
          await deriveNesCode(
            header.value,
            fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
            input,
          ),
        );
      if (reserve === 8)
        expect(result).toMatchObject({
          status: "unsupported",
          reason: expect.stringContaining("accepted-entry"),
        });
      else expect(result.status).toBe("derived");
    }
  },
);
it.each([[173, 21, 64, 96], [2]])(
  "retains accepted-entry device events before handler instructions or frontiers: %j",
  async (...program) => {
    const fixture = nesPpuFixture(program),
      header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const input = traceNesCodeInputSchema.parse({
      path: "/entry.nes",
      initial: { mapper: 0 },
      cpu: { sp: 253 },
      entry: { accepted_interrupt: "irq", return_address: 0x8100 },
      initial_apu: initialApu,
      initial_ppu: nesPpuFixtureState({ next_event_index: 300 }),
      initial_controllers: {
        model: "standard-controllers",
        next_event_index: 400,
        dma_reads: "absent",
        oam_dma_pending: { status: "none" },
      },
    });
    const result = nesCodeTraceSchema.parse(
      await deriveNesCode(
        header.value,
        fixture.bytes.subarray(fixture.prgOffset, fixture.chrOffset),
        input,
      ),
    );
    if (
      result.status !== "derived" ||
      result.mapper_trace.status !== "derived" ||
      !("apu_trace" in result.mapper_trace) ||
      !("ppu_trace" in result.mapper_trace) ||
      result.mapper_trace.controller_trace === null
    )
      throw new Error(JSON.stringify(result));
    const trace = result.mapper_trace;
    expect(trace.steps.slice(0, 3).map((step) => step.event)).toMatchObject([
      { kind: "cpu-write", address: 509 },
      { kind: "cpu-write", address: 508 },
      { kind: "cpu-write", address: 507 },
    ]);
    expect(trace.apu_trace.final.next_event_index).toBe(
      500 + trace.steps.length,
    );
    expect(trace.ppu_trace.final.next_event_index).toBe(
      300 + trace.steps.length,
    );
    expect(trace.controller_trace!.final.next_event_index).toBe(
      400 + trace.steps.length,
    );
    if (program.length > 1) {
      expect(
        result.instructions[0]!.data_reads[0]!.mapper_origins[0],
      ).toMatchObject({ kind: "apu-status", index: 503 });
      expect(trace.steps[3]).toMatchObject({
        cpu_read: { source: { kind: "apu-status", index: 503 } },
      });
    }
    expect(
      trace.apu_trace.frontier.every(
        (operation) => operation.kind !== "cpu-write",
      ),
    ).toBe(true);
    expect(result.entry_interrupt).toMatchObject({
      mapper_event_range: { start: 0, count: 3 },
    });
  },
);
