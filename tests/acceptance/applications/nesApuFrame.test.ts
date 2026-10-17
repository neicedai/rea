import { createStdioToolClient } from "../../support/cliMcpDelivery.js";
import { createNesSourceCaller } from "../../support/nesSourceDelivery.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  nesPpuFixture,
  nesPpuFixtureState,
} from "../../../src/domain/nesPpu.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";
const origin = { kind: "initial-state" };
const count = (value: number) => ({
  value: { min: value, max: value },
  origin,
});
const apuResult = (value: unknown) => {
  const result = toolContract("trace_nes_mapper_events").outputSchema.parse(
    value,
  ).normalized_result.trace;
  if (result.status !== "derived" || !("apu_trace" in result))
    throw new Error(JSON.stringify(result));
  return result;
};
const clocked = (region = "ntsc", position = 0) => ({
  model: "apu-registers",
  frame_clocks: "cpu-ordered",
  dmc_reads: "absent",
  next_event_index: 9000,
  frame_sequencer: {
    region,
    position: { min: position, max: position },
    five_step: false,
    cpu_phase: "get",
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
  },
  registers: Object.fromEntries(
    [
      [0x4000, 0],
      [0x4001, 0],
      [0x4004, 0],
      [0x4005, 0],
      [0x4008, 0],
      [0x400c, 0],
      [0x4010, 0],
      [0x4015, 1],
      [0x4017, 0],
    ].map(([address, value]) => [address!, { value, origin }]),
  ),
  lengths: [count(2), count(0), count(0), count(0)],
  dmc_remaining: count(0),
  frame_irq: { value: false, origin },
  dmc_irq: { value: false, origin },
  envelopes: [
    { start: { value: true, origin }, divider: count(0), decay: count(0) },
    {},
    {},
  ],
  pulse_timers: [
    { low: { value: 0, origin }, high: { value: 0, origin } },
    { low: { value: 0, origin }, high: { value: 0, origin } },
  ],
});

cliTest(
  "retains accepted IRQ entry events and cross-profile identity before a valid or unmapped handler",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-entry-events-"),
      connection = createStdioToolClient("apu-frame-oracle"),
      { transport, client } = connection;
    try {
      await client.connect(transport);
      const { call } = await createNesSourceCaller(cli, client);
      for (const stopped of [false, true]) {
        const fixture = nesPpuFixture(stopped ? [2] : [173, 21, 64, 64]),
          path = join(root, stopped ? "stopped.nes" : "status.nes");
        await writeFile(path, fixture.bytes);
        const input = {
          path,
          initial: { mapper: 0 },
          entry: { accepted_interrupt: "irq", return_address: 0x8100 },
          cpu: { sp: 253 },
          initial_apu: {
            model: "apu-registers",
            frame_clocks: "explicit",
            next_event_index: 500,
            dmc_remaining: count(1),
            registers: { [0x4010]: { value: 128, origin } },
          },
          initial_ppu: nesPpuFixtureState({ next_event_index: 300 }),
          initial_controllers: {
            model: "standard-controllers",
            next_event_index: 400,
            dma_reads: "absent",
            oam_dma_pending: { status: "none" },
          },
        };
        const evidence = toolContract("trace_nes_code").outputSchema.parse(
            await call("trace_nes_code", input),
          ),
          code = evidence.normalized_result.code_trace;
        if (
          code.status !== "derived" ||
          code.mapper_trace.status !== "derived" ||
          !("apu_trace" in code.mapper_trace) ||
          !("ppu_trace" in code.mapper_trace) ||
          code.mapper_trace.controller_trace === null
        )
          throw new Error(JSON.stringify(code));
        const mapped = code.mapper_trace;
        expect(code.entry_interrupt).toMatchObject({
          mapper_event_range: { start: 0, count: 3 },
        });
        expect(
          mapped.steps.slice(0, 3).map((step) => step.event),
        ).toMatchObject([
          { kind: "cpu-write", address: 509 },
          { kind: "cpu-write", address: 508 },
          { kind: "cpu-write", address: 507 },
        ]);
        expect(mapped.apu_trace.final.next_event_index).toBe(
          500 + mapped.steps.length,
        );
        expect(mapped.ppu_trace.final.next_event_index).toBe(
          300 + mapped.steps.length,
        );
        expect(mapped.controller_trace!.final.next_event_index).toBe(
          400 + mapped.steps.length,
        );
        if (!stopped) {
          expect(code.stop).toMatchObject({
            reason: "unsupported-opcode",
            address: 0x8100,
          });
          expect(code.final_cpu.sp).toBe(253);
          expect(code.instructions[0]).toMatchObject({
            mapper_event_range: { start: 3, count: 1 },
            data_reads: [
              { mapper_origins: [{ kind: "apu-status", index: 503 }] },
            ],
          });
          expect(mapped.steps[3]).toMatchObject({
            cpu_read: { source: { kind: "apu-status", index: 503 } },
          });
          const explored = toolContract("explore_nes_code").outputSchema.parse(
            await call("explore_nes_code", input),
          ).normalized_result.code_exploration;
          if (explored.status !== "derived")
            throw new Error(JSON.stringify(explored));
          expect(explored.paths[0]!.trace).toEqual(code);
          const constrained = toolContract("trace_nes_code").outputSchema.parse(
            await call("trace_nes_code", {
              ...input,
              max_instructions: 1,
              initial_apu: {
                ...input.initial_apu,
                next_event_index: Number.MAX_SAFE_INTEGER - 8,
              },
            }),
          ).normalized_result.code_trace;
          expect(constrained).toMatchObject({
            status: "unsupported",
            reason: expect.stringContaining("accepted-entry"),
          });
        } else expect(code.stop.reason).toBe("unsupported-opcode");
        const replay = apuResult(
          await call("trace_nes_mapper_events", {
            path: input.path,
            initial: input.initial,
            initial_apu: input.initial_apu,
            initial_ppu: input.initial_ppu,
            initial_controllers: input.initial_controllers,
            events: mapped.steps.map((step) => step.event),
          }),
        );
        expect(replay).toEqual(mapped);
        for (const instruction of code.instructions)
          for (const [index, offset] of instruction.file_offsets.entries())
            expect(fixture.bytes[offset!]).toBe(
              parseInt(
                instruction.bytes_hex.slice(index * 2, index * 2 + 2),
                16,
              ),
            );
        expect(evidence.subject!.digest.sha256).toBe(
          createHash("sha256").update(fixture.bytes).digest("hex"),
        );
        expect(await readFile(path)).toEqual(fixture.bytes);
      }
    } finally {
      await connection.close();
    }
  },
  180000,
);

cliTest(
  "derives a full NTSC frame from CPU edges and preserves all three IRQ requests, PAL boundaries and delayed continuation",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-apu-cpu-edges-"),
      fixture = nesPpuFixture([96]),
      path = join(root, "clocked.nes"),
      connection = createStdioToolClient("apu-frame-oracle"),
      { transport, client } = connection;
    await writeFile(path, fixture.bytes);
    try {
      await client.connect(transport);
      const { call, contract } = await createNesSourceCaller(cli, client),
        events: Record<string, unknown>[] = [];
      for (let cycle = 1; cycle <= 29830; cycle++) {
        events.push({ kind: "apu-cpu-cycle" });
        if (cycle >= 29828) events.push({ kind: "cpu-read", address: 0x4015 });
      }
      const mapped = apuResult(
          await call(
            "trace_nes_mapper_events",
            {
              path,
              initial: { mapper: 0 },
              initial_apu: clocked(),
              events,
              max_steps: events.length,
            },
            false,
          ),
        ),
        apu = mapped.apu_trace;
      expect(mapped.steps).toHaveLength(29833);
      expect(
        "mapper_snapshots" in mapped && mapped.mapper_snapshots,
      ).toHaveLength(1);
      expect(
        apu.operations.filter(
          (operation) => operation.frame_clock?.quarter === true,
        ),
      ).toHaveLength(4);
      expect(
        apu.operations.filter(
          (operation) => operation.frame_clock?.half === true,
        ),
      ).toHaveLength(2);
      expect(
        apu.operations.filter(
          (operation) => operation.frame_clock?.irq === true,
        ),
      ).toHaveLength(3);
      const reads = mapped.steps
        .filter((step) => "cpu_read" in step)
        .map((step) => ("cpu_read" in step ? step.cpu_read : null));
      expect(reads).toMatchObject(
        [65, 64, 64].map((value) => ({
          known_bits: { mask: 223, value },
          source: { frame_irq: { value: true } },
        })),
      );
      expect(apu.final.lengths[0]!.value).toEqual({ min: 0, max: 0 });
      expect(apu.final.envelopes[0]!.decay.value).toEqual({ min: 12, max: 12 });
      expect(apu.final.frame_irq.value).toBe(false);
      expect(apu.final.next_event_index).toBe(38833);
      if (apu.final.frame_clocks !== "cpu-ordered")
        throw new Error("Missing CPU phase");
      expect(apu.final.frame_sequencer.position).toEqual({ min: 0, max: 0 });
      const continued = apuResult(
        await call("trace_nes_mapper_events", {
          path,
          initial: mapped.final,
          initial_apu: apu.final,
          events: [
            { kind: "cpu-write", address: 0x4017, value: 128 },
            ...Array.from({ length: 3 }, () => ({ kind: "apu-cpu-cycle" })),
          ],
        }),
      );
      expect(continued.apu_trace.operations[0]!.effects).toEqual([
        "register-write",
        "frame-reset-queued",
      ]);
      expect(continued.apu_trace.operations.at(-1)).toMatchObject({
        frame_clock: { quarter: true, half: true, reset: true },
      });
      expect(continued.apu_trace.final).toMatchObject({
        frame_sequencer: {
          five_step: true,
          position: { min: 0, max: 0 },
          reset_delay: { min: 0, max: 0 },
        },
      });
      const pal = apuResult(
        await call("trace_nes_mapper_events", {
          path,
          initial: { mapper: 0 },
          initial_apu: clocked("pal", 16626),
          events: [{ kind: "apu-cpu-cycle" }],
        }),
      );
      expect(pal.apu_trace.operations[0]).toMatchObject({
        frame_clock: { quarter: true, half: true, irq: false },
      });
      expect(pal.apu_trace.final.lengths[0]!.value).toEqual({ min: 1, max: 1 });
      const validateInput = contract("trace_nes_mapper_events").input;
      expect(
        validateInput({
          path,
          initial: { mapper: 0 },
          initial_apu: {
            ...clocked(),
            frame_sequencer: {
              ...clocked().frame_sequencer,
              position: { min: 40000, max: 40000 },
            },
          },
          events: [],
        }),
      ).toBe(false);
      const unsupported = toolContract("trace_nes_code").outputSchema.parse(
        await call("trace_nes_code", {
          path,
          initial: { mapper: 0 },
          initial_apu: clocked(),
        }),
      ).normalized_result.code_trace;
      expect(unsupported).toMatchObject({
        status: "unsupported",
        reason: expect.stringContaining("CPU-edge timing"),
      });
      expect(await readFile(path)).toEqual(fixture.bytes);
    } finally {
      await connection.close();
    }
  },
  180000,
);
