import {
  createToolDelivery,
  createStdioToolClient,
  invokeMcpEvidence,
} from "../../support/cliMcpDelivery.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, afterAll, expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import { nesControllerBankFixture } from "../../../src/domain/nesControllers.fixture.js";
import {
  nesPpuFixture,
  nesOamUploadFixture,
} from "../../../src/domain/nesPpu.fixture.js";
import type { NesByteValue } from "../../../src/domain/nesByteValue.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

type Name = "trace_nes_code" | "explore_nes_code" | "trace_nes_mapper_events";
const controller = (buttons: NesByteValue = 105, safe = true) => ({
  model: "standard-controllers",
  buttons: [buttons, 90],
  dma_reads: safe ? "absent" : "unobserved",
  oam_dma_pending: { status: "none" },
  next_event_index: 1000,
});
const connection = createStdioToolClient("controller-proof");
const { client, transport } = connection;
beforeAll(async () => {
  await client.connect(transport);
}, 120_000);
afterAll(async () => {
  await connection.close();
});
const both = async (cli: TestCli, name: Name, input: Record<string, unknown>) =>
  (await createToolDelivery(client, cli)).invoke(name, input, {
    timeoutMs: 90_000,
  });

cliTest(
  "reconstructs full and partial button reports, switches MMC3 banks and preserves every input-byte proof over CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-controllers-bank-"),
      fixture = nesControllerBankFixture(),
      path = join(root, "input-bank.nes");
    await writeFile(path, fixture.bytes);
    for (const sample of [
      { buttons: 105, safe: true, bank: 2 },
      { buttons: { mask: 192, value: 128 }, safe: true, bank: 1 },
      { buttons: 105, safe: false, bank: null },
    ]) {
      const input = {
          path,
          initial: fixture.initial,
          initial_controllers: controller(sample.buttons, sample.safe),
        },
        evidence = await both(cli, "trace_nes_code", input),
        code =
          toolContract("trace_nes_code").outputSchema.parse(evidence)
            .normalized_result.code_trace;
      if (
        code.status !== "derived" ||
        code.mapper_trace.status !== "derived" ||
        !("controller_trace" in code.mapper_trace) ||
        code.mapper_trace.controller_trace === null
      )
        throw new Error("Missing controller trace");
      expect(code.stop.reason).toBe(
        sample.bank === null ? "unmapped-instruction" : "return",
      );
      if (sample.bank !== null) expect(code.final_cpu.a).toBe(32 + sample.bank);
      const reads = code.instructions
        .flatMap((instruction) => instruction.data_reads)
        .filter((read) => read.address === 0x4016);
      expect(reads).toHaveLength(8);
      for (const [position, read] of reads.entries()) {
        expect(read.value).toBeNull();
        expect(read.file_offset).toBeNull();
        expect(read.ram_origins).toEqual([]);
        const origin = read.mapper_origins[0];
        if (origin?.kind !== "standard-controller")
          throw new Error("Missing serial proof");
        expect(origin.port).toBe(1);
        expect(origin.strobe).toBe(false);
        if (sample.safe) {
          expect(origin.serial_reports).toMatchObject([
            {
              position,
              buttons: sample.buttons,
              origin: {
                kind: "latch-write",
                index: 1001,
                buttons_origin: { kind: "initial-buttons", port: 1 },
              },
            },
          ]);
          if (typeof sample.buttons === "number" || position >= 6)
            expect(read).toMatchObject({
              known_bits: {
                mask: 1,
                value:
                  ((typeof sample.buttons === "number"
                    ? sample.buttons
                    : sample.buttons.value) >>
                    position) &
                  1,
              },
            });
          else expect("known_bits" in read).toBe(false);
        }
      }
      for (const instruction of code.instructions)
        for (const [index, offset] of instruction.file_offsets.entries())
          expect(fixture.bytes[offset!]).toBe(
            Buffer.from(instruction.bytes_hex, "hex")[index],
          );
      expect(code.mapper_trace.final_mapping.prg_windows[0]!.bank).toBe(
        sample.bank,
      );
      const replay = await both(cli, "trace_nes_mapper_events", {
        ...input,
        events: code.mapper_trace.steps.map((step) => step.event),
      });
      expect(
        toolContract("trace_nes_mapper_events").outputSchema.parse(replay)
          .normalized_result.trace,
      ).toEqual(code.mapper_trace);
      const explored = await both(cli, "explore_nes_code", input);
      expect(
        toolContract("explore_nes_code").outputSchema.parse(explored)
          .normalized_result.code_exploration,
      ).toMatchObject({ paths: [{ trace: code }] });
      const continued = await both(cli, "trace_nes_mapper_events", {
        path,
        initial: code.mapper_trace.final,
        initial_controllers: code.mapper_trace.controller_trace.final,
        events: [
          { kind: "cpu-read", address: 0x4016 },
          { kind: "cpu-read", address: 0x4017 },
        ],
      });
      const resumed = toolContract(
        "trace_nes_mapper_events",
      ).outputSchema.parse(continued).normalized_result.trace;
      if (resumed.status !== "derived") throw new Error(resumed.reason);
      expect(resumed.steps[0]).toMatchObject({
        cpu_read: { known_bits: { mask: 1, value: 1 } },
      });
      if (sample.safe)
        expect(resumed.steps[1]).toMatchObject({
          cpu_read: { known_bits: { mask: 1, value: 0 } },
        });
      else {
        const read = resumed.steps[1]!;
        if (!("cpu_read" in read))
          throw new Error("Missing uncertain continuation");
        expect("known_bits" in read.cpu_read).toBe(false);
      }
      expect(evidence.subject?.digest?.sha256).toBe(
        createHash("sha256").update(fixture.bytes).digest("hex"),
      );
    }
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  180_000,
);

cliTest(
  "isolates controller strobe state across explored branches and retains indexed dummy reads",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-controller-branches-"),
      fixture = nesPpuFixture([
        169, 1, 141, 22, 64, 169, 0, 141, 22, 64, 173, 22, 64, 41, 1, 240, 5,
        169, 17, 133, 0, 96, 169, 34, 133, 0, 169, 1, 141, 22, 64, 96,
      ]),
      path = join(root, "branches.nes");
    await writeFile(path, fixture.bytes);
    const input = {
        path,
        initial: { mapper: 0 },
        initial_controllers: controller({ mask: 254, value: 104 }),
      },
      evidence = await both(cli, "explore_nes_code", input),
      explored =
        toolContract("explore_nes_code").outputSchema.parse(evidence)
          .normalized_result.code_exploration;
    if (explored.status !== "derived") throw new Error(explored.reason);
    expect(explored.paths).toHaveLength(3);
    for (const [index, branch] of explored.paths.entries()) {
      const replay = await both(cli, "trace_nes_code", {
        ...input,
        branch_choices: branch.branch_choices,
      });
      expect(
        toolContract("trace_nes_code").outputSchema.parse(replay)
          .normalized_result.code_trace,
      ).toEqual(branch.trace);
      if (
        branch.trace.status !== "derived" ||
        branch.trace.mapper_trace.status !== "derived" ||
        !("controller_trace" in branch.trace.mapper_trace) ||
        branch.trace.mapper_trace.controller_trace === null
      )
        throw new Error("Missing branch state");
      expect(branch.trace.mapper_trace.controller_trace.final.strobe).toBe(
        index === 2,
      );
      expect(
        branch.trace.mapper_trace.controller_trace.final.ports[0]
          .serial_reports[0]!.position,
      ).toBe(index === 2 ? 0 : 1);
    }
    expect(await readFile(path)).toEqual(fixture.bytes);
    const indexed = nesPpuFixture([
        169, 1, 141, 22, 64, 169, 0, 141, 22, 64, 162, 23, 189, 255, 64, 173,
        22, 64, 96,
      ]),
      otherPath = join(root, "dummy.nes");
    await writeFile(otherPath, indexed.bytes);
    const result = await both(cli, "trace_nes_code", {
        path: otherPath,
        initial: { mapper: 0 },
        initial_controllers: controller(1),
      }),
      code =
        toolContract("trace_nes_code").outputSchema.parse(result)
          .normalized_result.code_trace;
    if (code.status !== "derived") throw new Error(code.reason);
    expect(code.instructions.at(-1)!.data_reads).toMatchObject([
      {
        address: 0x4016,
        known_bits: { mask: 1, value: 0 },
        mapper_origins: [{ serial_reports: [{ position: 1 }] }],
      },
    ]);
    expect(await readFile(otherPath)).toEqual(indexed.bytes);
    for (const button of [0, 1]) {
      const rmw = nesPpuFixture([
          169, 1, 141, 22, 64, 169, 0, 141, 22, 64, 14, 22, 64, 173, 22, 64, 96,
        ]),
        rmwPath = join(root, `rmw-${button}.nes`);
      await writeFile(rmwPath, rmw.bytes);
      const response = await both(cli, "trace_nes_code", {
          path: rmwPath,
          initial: { mapper: 0 },
          initial_controllers: controller(button),
        }),
        trace =
          toolContract("trace_nes_code").outputSchema.parse(response)
            .normalized_result.code_trace;
      if (trace.status !== "derived") throw new Error(trace.reason);
      expect(
        trace.instructions.find(
          (instruction) => instruction.mnemonic === "ASL",
        )!.writes,
      ).toMatchObject([
        {
          address: 0x4016,
          value: null,
          known_bits: { mask: 1, value: button },
        },
        {
          address: 0x4016,
          value: null,
          known_bits: { mask: 3, value: button << 1 },
        },
      ]);
      expect(trace.instructions.at(-1)!.data_reads).toMatchObject([
        {
          known_bits: { mask: 1, value: button },
          mapper_origins: [
            { serial_reports: [{ position: button === 1 ? 0 : 1 }] },
          ],
        },
      ]);
      expect(await readFile(rmwPath)).toEqual(rmw.bytes);
    }
  },
  150_000,
);

cliTest(
  "joins explicit button events and DMA qualifications while rejecting invalid controller inputs through actual schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-controller-events-"),
      fixture = nesPpuFixture(),
      path = join(root, "events.nes");
    await writeFile(path, fixture.bytes);
    const initialPpu = nesOamUploadFixture().initial_ppu;
    for (const qualified of [true, false]) {
      const packet = {
        kind: "oam-dma",
        page: 2,
        values: Array(256).fill(0),
        ...(qualified ? { halted_cpu_address: fixture.entry } : {}),
      };
      const input = {
        path,
        initial: { mapper: 0 },
        initial_controllers: controller(0),
        initial_ppu: initialPpu,
        events: [
          { kind: "cpu-write", address: 0x4016, value: 1 },
          { kind: "cpu-write", address: 0x4016, value: 0 },
          { kind: "controller-buttons", port: 1, buttons: 255 },
          { kind: "cpu-read", address: 0x4016 },
          { kind: "cpu-write", address: 0x4017, value: 1 },
          { kind: "cpu-write", address: 0x4014, value: 0x40 },
          { kind: "cpu-write", address: 0x4014, value: 2 },
          packet,
          { kind: "cpu-read", address: 0x4016 },
        ],
      };
      const result = await both(cli, "trace_nes_mapper_events", input),
        trace = toolContract("trace_nes_mapper_events").outputSchema.parse(
          result,
        ).normalized_result.trace;
      if (
        trace.status !== "derived" ||
        !("ppu_trace" in trace) ||
        trace.controller_trace === null
      )
        throw new Error("Missing joined trace");
      expect(trace.controller_trace.final.next_event_index).toBe(
        1000 + input.events.length,
      );
      expect(trace.ppu_trace.final.next_event_index).toBe(
        100 + input.events.length,
      );
      const last = trace.steps.at(-1)!;
      if (!("cpu_read" in last)) throw new Error("Missing serial result");
      if (qualified)
        expect(last.cpu_read).toMatchObject({
          known_bits: { mask: 1, value: 0 },
        });
      else expect("known_bits" in last.cpu_read).toBe(false);
      expect(trace.controller_trace.final.buttons[0]).toMatchObject({
        value: 255,
        origin: { kind: "buttons-event", index: 1002 },
      });
    }
    const duplicate = {
        position: 0,
        buttons: 1,
        origin: { kind: "initial-report", port: 1 },
      },
      invalid = {
        path,
        initial: { mapper: 0 },
        initial_controllers: {
          ...controller(),
          ports: [{ serial_reports: [duplicate, duplicate] }, {}],
        },
        events: [],
      };
    const validateInput = (await createToolDelivery(client, cli)).contract(
      "trace_nes_mapper_events",
    ).input;
    expect(validateInput(invalid)).toBe(false);
    expect(
      (
        await client.callTool({
          name: "trace_nes_mapper_events",
          arguments: invalid,
        })
      ).isError,
    ).toBe(true);
    const conflict = structuredClone(initialPpu);
    conflict.oam!.dma_pending = { status: "pending", page: 2 };
    const rejected = await both(cli, "trace_nes_mapper_events", {
      path,
      initial: { mapper: 0 },
      initial_controllers: controller(),
      initial_ppu: conflict,
      events: [],
    });
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(rejected)
        .normalized_result.trace,
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("contradict"),
    });
    const future = await both(cli, "trace_nes_mapper_events", {
      path,
      initial: { mapper: 0 },
      initial_controllers: {
        ...controller(),
        strobe: true,
        ports: [
          {
            serial_reports: [
              {
                position: 0,
                buttons: 1,
                origin: { kind: "joined-report", port: 1, index: 1000 },
              },
            ],
          },
          {},
        ],
      },
      events: [],
    });
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(future)
        .normalized_result.trace,
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("precede"),
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  150_000,
);

cliTest(
  "retains all 1,024 controller events and nine report positions within the default MCP budget",
  async () => {
    const root = await createTestTempDirectory("rea-controller-capacity-"),
      fixture = nesPpuFixture(),
      path = join(root, "capacity.nes");
    await writeFile(path, fixture.bytes);
    const reports = (port: 1 | 2) =>
        Array.from({ length: 9 }, (_, position) => ({
          position,
          buttons: { mask: 129, value: 129 },
          origin: { kind: "initial-report", port },
        })),
      input = {
        path,
        initial: { mapper: 0 },
        initial_controllers: {
          ...controller({ mask: 129, value: 129 }),
          buttons: [
            { mask: 129, value: 129 },
            { mask: 129, value: 129 },
          ],
          ports: [
            { serial_reports: reports(1) },
            { serial_reports: reports(2) },
          ],
        },
        events: Array.from({ length: 1024 }, (_, index) =>
          index % 2 === 0
            ? { kind: "cpu-write", address: 0x4016, value: null }
            : { kind: "cpu-read", address: index % 4 === 1 ? 0x4016 : 0x4017 },
        ),
      };
    const trace = toolContract("trace_nes_mapper_events").outputSchema.parse(
      await invokeMcpEvidence(client, "trace_nes_mapper_events", input),
    ).normalized_result.trace;
    if (
      trace.status !== "derived" ||
      !("controller_trace" in trace) ||
      trace.controller_trace === null ||
      !("mapper_snapshots" in trace)
    )
      throw new Error("Missing capacity trace");
    expect(trace.steps).toHaveLength(1024);
    expect(trace.mapper_snapshots).toHaveLength(1);
    expect(trace.controller_trace.operations).toHaveLength(1024);
    expect(trace.controller_trace.final.next_event_index).toBe(2024);
    for (const [index, step] of trace.steps.entries()) {
      expect(step.mapper_snapshot).toBe(0);
      if (
        "cpu_read" in step &&
        step.cpu_read.source?.kind === "standard-controller"
      ) {
        expect(step.cpu_read.source.serial_reports).toHaveLength(9);
        expect(
          step.cpu_read.source.serial_reports.map((report) => report.position),
        ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
      }
      expect(trace.controller_trace.operations[index]!.event_index).toBe(
        1000 + index,
      );
      expect(
        "buttons" in trace.controller_trace.operations[index]!.before,
      ).toBe(false);
    }
    expect(trace.coverage).toMatchObject({
      processed_events: 1024,
      unknown_cpu_reads: 512,
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  120_000,
);
