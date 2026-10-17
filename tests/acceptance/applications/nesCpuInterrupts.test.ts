import { createNesSourceCaller } from "../../support/nesSourceDelivery.js";
import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nesCodeFixture } from "../../../src/domain/nesCode.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

cliTest(
  "derives IRQ-driven MMC3 window switches with shared CLI/MCP schemas and resumable requests",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-cpu-interrupts-");
    const client = await connectTestMcp("cpu-interrupt-oracle");
    const source = await createNesSourceCaller(cli, client);
    const { call, contract } = source;
    const code = async (input: Record<string, unknown>) => {
      const { trace, evidence } = await source.code(input);
      if (!("interrupts" in trace)) throw new Error(JSON.stringify(trace));
      return { trace, evidence };
    };
    const fixture = nesCodeFixture(4, [0x58, 0xea, 0xea]);
    const handlerOffset = fixture.prgOffset + 6 * 8192 + 0x100;
    fixture.bytes.set([0xa9, 0x46, 0x8d, 0, 0x80], handlerOffset);
    fixture.bytes[fixture.prgOffset + 2 * 8192 + 0x105] = 0x40;
    fixture.bytes.writeUInt16LE(
      0xc100,
      fixture.prgOffset + fixture.prgSize - 2,
    );
    const path = join(root, "irq-bank-switch.nes");
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 2, 1] },
      initial_cpu_bus: {
        model: "nmos-6502-bus",
        dma_reads: "absent",
        next_cycle_index: 100,
      },
      initial_interrupts: {
        model: "nmos-6502-interrupts",
        external_irq: true,
        nmi_edges: "absent",
        pending_irq: false,
        pending_nmi: false,
      },
      cpu: { sp: 0xfd, i: true },
      max_instructions: 5,
    };
    const { trace, evidence } = await code(input);
    expect(
      trace.instructions.map((instruction) => instruction.address),
    ).toEqual([0xe000, 0xe001, 0xc100, 0xc102, 0xc105]);
    expect(trace.instructions[2]!.file_offsets[0]).toBe(handlerOffset);
    expect(trace.instructions[4]!.file_offsets[0]).toBe(
      fixture.prgOffset + 2 * 8192 + 0x105,
    );
    expect(trace.cpu_bus!.final.next_cycle_index).toBe(123);
    expect(trace.interrupts.final.pending_irq).toBe(true);
    expect(trace.interrupts.entries[0]!).toMatchObject({
      return_address: 0xe002,
      target_address: 0xc100,
      before_instruction_index: 2,
    });
    expect(trace.instructions[4]!.data_reads[0]!.ram_origins[0]).toMatchObject({
      interrupt_index: 0,
      interrupt_write_index: 2,
    });
    expect(evidence.subject?.digest?.sha256).toBe(
      createHash("sha256").update(fixture.bytes).digest("hex"),
    );
    const explored = toolContract("explore_nes_code").outputSchema.parse(
      await call("explore_nes_code", input),
    ).normalized_result.code_exploration;
    expect(explored).toMatchObject({ paths: [{ trace }] });
    if (
      trace.mapper_trace.status !== "derived" ||
      !("final_irq" in trace.mapper_trace)
    )
      throw new Error("Missing event trace");
    const replay = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await call("trace_nes_mapper_events", {
        path,
        initial: input.initial,
        events: trace.mapper_trace.steps.map((step) => step.event),
      }),
    ).normalized_result.trace;
    expect(replay).toEqual(trace.mapper_trace);
    const prefix = (await code({ ...input, max_instructions: 2 })).trace;
    const continued = (
      await code({
        ...input,
        entry: prefix.stop.address,
        cpu: prefix.final_cpu,
        initial_cpu_bus: prefix.cpu_bus!.final,
        initial_interrupts: prefix.interrupts.final,
        max_instructions: 3,
      })
    ).trace;
    expect(continued.interrupts.entries[0]!.cpu_bus_cycles).toEqual(
      trace.interrupts.entries[0]!.cpu_bus_cycles,
    );
    expect(continued.final_cpu).toEqual(trace.final_cpu);
    expect(
      (
        await code({
          ...input,
          initial_interrupts: {
            ...input.initial_interrupts,
            pending_nmi: null,
          },
        })
      ).trace.stop.reason,
    ).toBe("interrupt-uncertain");
    const unsupported = toolContract("trace_nes_code").outputSchema.parse(
      await call("trace_nes_code", { ...input, initial_cpu_bus: null }),
    ).normalized_result.code_trace;
    expect(unsupported).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("requires initial_cpu_bus"),
    });
    const invalid = {
      ...input,
      initial_interrupts: {
        ...input.initial_interrupts,
        external_irq: "low",
      },
    };
    expect(contract("trace_nes_code").input(invalid)).toBe(false);
    expect(
      (await client.callTool({ name: "trace_nes_code", arguments: invalid }))
        .isError,
    ).toBe(true);
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  180000,
);
