import { createStdioToolClient } from "../../support/cliMcpDelivery.js";
import { createNesSourceCaller } from "../../support/nesSourceDelivery.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { nesCodeFixture } from "../../../src/domain/nesCode.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const origin = { kind: "initial-state" };
const counter = (value: number) => ({
  value: { min: value, max: value },
  origin,
});
const pairs = [
  [0x4000, 31],
  [0x4001, 137],
  [0x4002, 64],
  [0x4003, 25],
  [0x4004, 34],
  [0x4005, 137],
  [0x4006, 128],
  [0x4007, 16],
  [0x4008, 5],
  [0x400a, 52],
  [0x400b, 8],
  [0x400c, 0],
  [0x400e, 143],
  [0x400f, 24],
  [0x4010, 0],
  [0x4011, 63],
  [0x4012, 7],
  [0x4013, 1],
  [0x4017, 0],
];
const mapped = (value: unknown) => {
  const result = toolContract("trace_nes_mapper_events").outputSchema.parse(
    value,
  ).normalized_result.trace;
  if (result.status !== "derived" || !("apu_trace" in result))
    throw new Error(JSON.stringify(result));
  return result;
};
async function prepareSource() {
  const root = await createTestTempDirectory("rea-apu-source-"),
    stores = [[0x4015, 0], [0x4015, 15], ...pairs].flatMap(
      ([address, value]) => [169, value!, 141, address! & 255, address! >> 8],
    ),
    fixture = nesCodeFixture(4, [
      ...stores,
      169,
      6,
      141,
      0,
      128,
      44,
      21,
      64,
      112,
      8,
      169,
      2,
      141,
      1,
      128,
      76,
      0,
      128,
      169,
      3,
      141,
      1,
      128,
      76,
      0,
      128,
    ]),
    path = join(root, "apu-status-banks.nes");
  fixture.bytes.set([169, 34, 96], fixture.prgOffset + 2 * 8192);
  fixture.bytes.set([169, 51, 96], fixture.prgOffset + 3 * 8192);
  await writeFile(path, fixture.bytes);
  const input = {
    path,
    initial: { mapper: 4, bank_select: 0, banks: [0, 2, 4, 5, 6, 7, 0, 1] },
    initial_apu: {
      model: "apu-registers",
      frame_clocks: "explicit",
      next_event_index: 500,
      sweeps: [{ divider: counter(0) }, { divider: counter(0) }],
    },
    initial_ppu: {
      model: "ppu-memory",
      chr_ram_size: null,
      nametable_layout: "ciram-2k",
      next_event_index: 300,
    },
    initial_controllers: {
      model: "standard-controllers",
      buttons: [105, 90],
      dma_reads: "absent",
      oam_dma_pending: { status: "none" },
      next_event_index: 400,
    },
  };
  return { fixture, path, input };
}

async function verifyPath(
  trace: NesCodePath,
  context: Awaited<ReturnType<typeof prepareSource>> & {
    call: Awaited<ReturnType<typeof createNesSourceCaller>>["call"];
  },
) {
  const { fixture, path, input, call } = context;
  const mapping = trace.mapper_trace;
  if (
    mapping.status !== "derived" ||
    !("apu_trace" in mapping) ||
    !("ppu_trace" in mapping) ||
    mapping.controller_trace === null
  )
    throw new Error(JSON.stringify(mapping));
  expect(trace.stop.reason).toBe("return");
  expect([34, 51]).toContain(trace.final_cpu.a);
  const finalBank = trace.final_cpu.a === 34 ? 2 : 3;
  expect(
    trace.instructions.find((instruction) => instruction.address === 0x8000)!
      .file_offsets,
  ).toEqual([
    fixture.prgOffset + finalBank * 8192,
    fixture.prgOffset + finalBank * 8192 + 1,
  ]);
  for (const instruction of trace.instructions)
    for (const [index, offset] of instruction.file_offsets.entries()) {
      expect(offset).not.toBeNull();
      expect(fixture.bytes[offset!]).toBe(
        parseInt(instruction.bytes_hex.slice(index * 2, index * 2 + 2), 16),
      );
    }
  const bit = trace.instructions.find(
      (instruction) => instruction.mnemonic === "BIT",
    )!,
    read = bit.data_reads[0]!;
  expect(read).toMatchObject({
    address: 0x4015,
    value: null,
    known_bits: { mask: 159, value: 15 },
    file_offset: null,
    ram_origins: [],
    mapper_origins: [
      {
        kind: "apu-status",
        byte_index: 0,
        frame_irq: { value: null, origin },
        lengths: [{ value: { min: 2, max: 2 } }, {}, {}, {}],
      },
    ],
  });
  expect(mapping.apu_trace.final.frame_irq.value).toBe(false);
  for (const [address, value] of pairs) {
    const fact = mapping.apu_trace.final.registers[address!]!;
    expect(fact.value).toBe(value);
    if (!("index" in fact.origin)) throw new Error("Missing APU writer");
    const event = mapping.steps[fact.origin.index - 500]!.event;
    expect(event).toMatchObject({ kind: "cpu-write", address, value });
  }
  expect(mapping.apu_trace.final.next_event_index).toBe(
    500 + mapping.steps.length,
  );
  expect(mapping.ppu_trace.final.next_event_index).toBe(
    300 + mapping.steps.length,
  );
  expect(mapping.controller_trace.final.next_event_index).toBe(
    400 + mapping.steps.length,
  );
  const replay = mapped(
    await call("trace_nes_mapper_events", {
      ...input,
      events: mapping.steps.map((step) => step.event),
    }),
  );
  expect(replay).toEqual(mapping);
  const continued = mapped(
    await call("trace_nes_mapper_events", {
      path,
      initial: mapping.final,
      initial_apu: mapping.apu_trace.final,
      events: [{ kind: "apu-frame-clock", clock: "quarter-half" }],
    }),
  );
  expect(continued.apu_trace.final.lengths.map((fact) => fact.value)).toEqual(
    [1, 20, 253, 1].map((value) => ({ min: value, max: value })),
  );
  expect(
    continued.apu_trace.final.envelopes.map((unit) => unit.decay.value),
  ).toEqual([15, 15, 15].map((value) => ({ min: value, max: value })));
  expect(continued.apu_trace.final.triangle_linear.value).toEqual({
    min: 5,
    max: 5,
  });
  expect(continued.apu_trace.final.pulse_timers).toMatchObject([
    { low: { value: 159 }, high: { value: 0 } },
    { low: { value: 64 }, high: { value: 0 } },
  ]);
}

cliTest(
  "follows APU status branches into MMC3 banks with physical audio origins, replay and continuation over CLI/MCP",
  async ({ cli }) => {
    const { fixture, path, input } = await prepareSource(),
      connection = createStdioToolClient("apu-source-oracle"),
      { transport, client } = connection;
    try {
      await client.connect(transport);
      const { call, contract } = await createNesSourceCaller(cli, client),
        evidence = toolContract("trace_nes_code").outputSchema.parse(
          await call("trace_nes_code", input),
        ),
        code = evidence.normalized_result.code_trace;
      if (
        code.status !== "derived" ||
        code.mapper_trace.status !== "derived" ||
        !("apu_trace" in code.mapper_trace)
      )
        throw new Error(JSON.stringify(code));
      expect(code.stop.reason).toBe("unknown-branch");
      expect(code.mapper_trace.apu_trace.final.pulse_timers).toMatchObject([
        { low: { value: 64 }, high: { value: 1 } },
        { low: { value: 128 }, high: { value: 0 } },
      ]);
      expect(
        code.mapper_trace.apu_trace.final.lengths.map((fact) => fact.value),
      ).toEqual([2, 20, 254, 2].map((value) => ({ min: value, max: value })));
      const explored = toolContract("explore_nes_code").outputSchema.parse(
        await call("explore_nes_code", input),
      ).normalized_result.code_exploration;
      if (explored.status !== "derived")
        throw new Error(JSON.stringify(explored));
      expect(explored.paths).toHaveLength(3);
      expect(explored.paths[0]!.trace).toEqual(code);
      for (const pathResult of explored.paths.slice(1)) {
        if (pathResult.trace.status !== "derived")
          throw new Error(JSON.stringify(pathResult));
        await verifyPath(pathResult.trace, { fixture, path, input, call });
      }
      const validateInput = contract("trace_nes_mapper_events").input;
      for (const change of [
        { frame_clocks: "automatic" },
        { lengths: [counter(1)] },
        { pulse_timers: [{ high: { value: 8, origin } }, {}] },
        { registers: { [0x4009]: { value: 0, origin } } },
      ])
        expect(
          validateInput({
            ...input,
            initial_apu: { ...input.initial_apu, ...change },
            events: [],
          }),
        ).toBe(false);
      const unsupported = toolContract(
        "trace_nes_mapper_events",
      ).outputSchema.parse(
        await call("trace_nes_mapper_events", {
          path,
          initial: input.initial,
          events: [{ kind: "apu-frame-clock", clock: "quarter" }],
        }),
      ).normalized_result.trace;
      expect(unsupported).toMatchObject({
        status: "unsupported",
        reason: expect.stringContaining("initial_apu"),
      });
      const looping = mapped(
        await call("trace_nes_mapper_events", {
          path,
          initial: input.initial,
          initial_apu: {
            model: "apu-registers",
            frame_clocks: "explicit",
            dmc_reads: "absent",
            dmc_remaining: counter(0),
            frame_irq: { value: true, origin },
            registers: { [0x4017]: { value: 0, origin } },
          },
          events: [
            { kind: "cpu-write", address: 0x4013, value: 0 },
            { kind: "cpu-write", address: 0x4010, value: 192 },
            { kind: "cpu-write", address: 0x4015, value: 16 },
            { kind: "cpu-read", address: 0x4015 },
          ],
        }),
      );
      expect(looping.steps.at(-1)).toMatchObject({
        cpu_read: {
          known_bits: { mask: 159, value: 16 },
          source: {
            frame_irq: { value: null },
            dmc_irq: { value: false },
            dmc_remaining: { value: { min: 1, max: 1 } },
          },
        },
      });
      expect(looping.apu_trace.final.frame_irq.value).toBe(false);
      expect(evidence.subject!.digest.sha256).toBe(
        createHash("sha256").update(fixture.bytes).digest("hex"),
      );
      expect(await readFile(path)).toEqual(fixture.bytes);
    } finally {
      await connection.close();
    }
  },
  180000,
);

cliTest(
  "retains all 1024 APU frame clocks and compact state deltas under the default MCP budget",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-apu-capacity-"),
      fixture = nesCodeFixture(4, [96]),
      path = join(root, "apu-capacity.nes"),
      connection = createStdioToolClient("apu-source-oracle"),
      { transport, client } = connection;
    await writeFile(path, fixture.bytes);
    try {
      await client.connect(transport);
      const { call } = await createNesSourceCaller(cli, client),
        result = mapped(
          await call(
            "trace_nes_mapper_events",
            {
              path,
              initial: { mapper: 4 },
              max_steps: 1024,
              initial_apu: {
                model: "apu-registers",
                frame_clocks: "explicit",
                dmc_reads: "absent",
                registers: {
                  [0x4015]: { value: 0, origin },
                  [0x4010]: { value: 0, origin },
                  [0x4017]: { value: 64, origin },
                },
                pulse_timers: [
                  { low: { value: 0, origin }, high: { value: 0, origin } },
                  { low: { value: 0, origin }, high: { value: 0, origin } },
                ],
                lengths: [counter(0), counter(0), counter(0), counter(0)],
                dmc_remaining: counter(0),
              },
              events: Array.from({ length: 1024 }, () => ({
                kind: "apu-frame-clock",
                clock: "quarter-half",
              })),
            },
            false,
          ),
        );
      expect(result.steps).toHaveLength(1024);
      expect(result.apu_trace.operations).toHaveLength(1024);
      expect(result.apu_trace.final.next_event_index).toBe(1024);
      expect(
        "mapper_snapshots" in result && result.mapper_snapshots,
      ).toHaveLength(1);
      expect(result.apu_trace.final.lengths.map((fact) => fact.value)).toEqual(
        [0, 0, 0, 0].map((value) => ({ min: value, max: value })),
      );
      expect(
        result.apu_trace.operations.every(
          (operation) =>
            operation.effects.join(",") === "quarter-clock,half-clock",
        ),
      ).toBe(true);
      expect(
        result.apu_trace.operations
          .slice(16)
          .every((operation) => operation.changes.length === 0),
      ).toBe(true);
      expect(await readFile(path)).toEqual(fixture.bytes);
    } finally {
      await connection.close();
    }
  },
  180000,
);
