import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { NesMapperTraceService } from "../../../src/application/binaryDiagnostics/NesMapperTraceService.js";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { fme7Fixture } from "../../../src/domain/nesFme7.fixture.js";
import { NesCartridgeProvider } from "../../../src/native/nes/NesCartridgeProvider.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** Enumerate three independent six-bit selectors, retaining ignored source bits. */
function fme7Writes() {
  const writes: { address: number; value: number }[] = [];
  const writeRegister = (register: number, value: number) =>
    writes.push(
      { address: 0x9fff, value: 0xf0 | register },
      { address: 0xbfff, value: 0xc0 | value },
    );
  for (let state = 1; state <= 8192; state++) {
    if (state % 4096 === 0) writeRegister(11, state / 4096);
    if (state % 64 === 0) writeRegister(10, (state >> 6) & 63);
    writeRegister(9, state & 63);
  }
  return writes;
}

it.each(["writes", "events"] as const)(
  "retains more than 8192 FME-7 raw views and complete %s evidence through native file capture",
  async (kind) => {
    const root = await createTestTempDirectory("rea-nes-many-views-");
    const path = join(root, "fme7.nes");
    const { bytes } = fme7Fixture("fme7");
    await writeFile(path, bytes);
    const service = new NesMapperTraceService(new NesCartridgeProvider());
    const writes = fme7Writes();
    const initial = {
      mapper: 69,
      variant: "fme7",
      bank_6000: 0x80,
      prg_banks: [0xc0, 0xc0, 0xc0],
    };
    const events = writes.map((write) => ({
      kind: "cpu-write" as const,
      ...write,
    }));
    const supplied = kind === "writes" ? { writes } : { events };
    const invoke = (input: unknown) =>
      kind === "writes" ? service.trace(input) : service.traceEvents(input);
    const name =
      kind === "writes" ? "trace_nes_mapper_writes" : "trace_nes_mapper_events";
    try {
      expect(writes).toHaveLength(16_644);
      expect(await invoke({ path, initial, ...supplied })).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisResourceConstraintError",
          operation: name,
        },
      });
      const result = await invoke({
        path,
        initial,
        ...supplied,
        max_steps: writes.length,
      });
      if (!result.ok) throw result.error;
      const evidence = toolContract(name).outputSchema.parse(result.value);
      expect(evidence.normalized_result.artifact).toMatchObject({
        path,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      });
      expect(evidence.parameters).toMatchObject({
        path,
        ...supplied,
        max_steps: writes.length,
        initial: {
          ...initial,
          prg_ram_enable: null,
          command: null,
          chr_banks: Array.from({ length: 8 }, () => null),
        },
      });
      expect(evidence.normalized_result.header).toMatchObject({
        mapper: 69,
        header: Array.from(bytes.subarray(0, 16)),
        trainer: { offset: 16, size: 512 },
        prgRom: { offset: 528, size: 65536 },
      });
      const trace = evidence.normalized_result.trace;
      if (trace.status !== "derived") throw new Error(trace.reason);
      expect(trace.steps).toHaveLength(writes.length);
      const selectors = [0, 0, 0];
      const expected = new Set(["0:0:0"]);
      let command = 0;
      for (const [index, write] of writes.entries()) {
        if (write.address === 0x9fff) command = write.value & 15;
        else selectors[command - 9] = write.value & 63;
        expected.add(selectors.join(":"));
        const step = trace.steps[index]!;
        expect(step.index).toBe(index);
        if ("write" in step)
          expect(step.write).toEqual({ ...write, preceded_by_cpu_write: null });
        else
          expect(step.event).toEqual({
            ...events[index],
            preceded_by_cpu_write: null,
          });
        if (!("state" in step)) throw new Error("Expected legacy mapper step");
        expect(step.state).toMatchObject({
          command: 0xf0 | command,
          bank_6000: 0x80,
          prg_banks: selectors.map((bank) => 0xc0 | bank),
        });
        expect(step.mapping.prg_windows.map((window) => window.bank)).toEqual([
          0,
          ...selectors.map((bank) => bank & 7),
          7,
        ]);
      }
      const expectedViews = [...expected]
        .map((key) => key.split(":").map(Number))
        .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!)
        .map(([a, b, c]) => ({
          mapper: 69,
          variant: "fme7",
          lower_window: { source: "rom", bank: 0 },
          prg_bank_0: a,
          prg_bank_1: b,
          prg_bank_2: c,
        }));
      expect(expectedViews).toHaveLength(8195);
      expect(trace.nes_prg_views).toEqual(expectedViews);
      expect(trace.final).toMatchObject({
        command: 0xf9,
        prg_banks: [0xc0, 0xc0, 0xc2],
      });
      expect(trace.coverage).toMatchObject(
        kind === "writes"
          ? { supplied_writes: writes.length, processed_writes: writes.length }
          : { supplied_events: writes.length, processed_events: writes.length },
      );
      expect(await readFile(path)).toEqual(bytes);
    } finally {
      await service.close();
    }
  },
  120_000,
);
