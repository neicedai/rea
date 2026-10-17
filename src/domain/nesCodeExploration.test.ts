import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture, mmc3BranchCodeFixture } from "./nesCode.fixture.js";
import {
  exploreNesCodeInputSchema,
  nesCodeExplorationSchema,
} from "./nesCodeExploration.js";
import { exploreNesCode } from "./nesCodeExplorationDerivation.js";
import { nesPpuFixtureState } from "./nesPpu.fixture.js";

const run = async (
  fixture: ReturnType<typeof nesCodeFixture>,
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
) => {
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  return nesCodeExplorationSchema.parse(
    await exploreNesCode(
      header.value,
      fixture.bytes.subarray(
        fixture.prgOffset,
        fixture.prgOffset + fixture.prgSize,
      ),
      exploreNesCodeInputSchema.parse({
        path: "/source.nes",
        initial: {
          mapper: 4,
          bank_select: 6,
          banks: [null, null, null, null, null, null, 0, 1],
        },
        ...extra,
      }),
      { signal: signal },
    ),
  );
};

describe("conditional NES code exploration", () => {
  it("isolates branch RAM/mapper state and fetches each successor from its selected bank", async () => {
    const fixture = mmc3BranchCodeFixture();
    const result = await run(fixture);
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.termination).toBe("queue-exhausted");
    expect(result.pending_paths).toEqual([]);
    expect(result.paths.map((path) => path.parent_index)).toEqual([null, 0, 0]);
    expect(
      result.paths.map((path) =>
        path.trace.status === "derived" ? path.trace.stop.reason : null,
      ),
    ).toEqual(["unknown-branch", "return", "return"]);
    expect(result.paths.slice(1).map((path) => path.branch_choices)).toEqual([
      [{ address: 0xe003, taken: false }],
      [{ address: 0xe003, taken: true }],
    ]);
    for (const [index, selected] of [
      [1, 2],
      [2, 3],
    ] as const) {
      const trace = result.paths[index]!.trace;
      if (trace.status !== "derived") throw new Error(trace.reason);
      expect(trace.final_cpu.a).toBe(selected === 2 ? 0x22 : 0x33);
      expect(
        trace.instructions.filter(
          (instruction) => instruction.address === 0xe018,
        )[0]?.writes,
      ).toMatchObject([{ address: 0x8001, value: selected }]);
      expect(trace.instructions.at(-1)).toMatchObject({
        address: 0x8000,
        file_offsets: [
          fixture.prgOffset + selected * 8192,
          fixture.prgOffset + selected * 8192 + 1,
        ],
      });
      for (const instruction of trace.instructions)
        expect(
          Buffer.from(
            instruction.file_offsets.map((offset) => {
              if (offset === null)
                throw new Error("Expected ROM-backed fixture instruction");
              return fixture.bytes[offset]!;
            }),
          ).toString("hex"),
        ).toBe(instruction.bytes_hex);
    }
    expect(result.nes_prg_views).toEqual(
      [0, 2, 3].map((r6) => ({ mapper: 4, prg_mode: 0, r6, r7: 1 })),
    );
    expect(result.instructions_applied).toBe(
      result.paths.reduce(
        (count, path) =>
          count +
          (path.trace.status === "derived"
            ? path.trace.instructions.length
            : 0),
        0,
      ),
    );
  });

  it("expands nested alternatives breadth-first and respects a caller-selected initial subtree", async () => {
    const fixture = nesCodeFixture(
      4,
      [
        0xad, 2, 0x20, 0xf0, 2, 0xea, 0xea, 0xad, 2, 0x20, 0xf0, 2, 0xea, 0xea,
        0x60,
      ],
    );
    const result = await run(fixture);
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.paths.map((path) => path.parent_index)).toEqual([
      null,
      0,
      0,
      1,
      1,
      2,
      2,
    ]);
    expect(
      result.paths
        .slice(3)
        .map((path) => path.branch_choices.map((choice) => choice.taken)),
    ).toEqual([
      [false, false],
      [false, true],
      [true, false],
      [true, true],
    ]);
    const subtree = await run(fixture, {
      branch_choices: [{ address: 0xe003, taken: true }],
    });
    if (subtree.status !== "derived") throw new Error(subtree.reason);
    expect(subtree.paths).toHaveLength(3);
    expect(subtree.paths.every((path) => path.branch_choices[0]?.taken)).toBe(
      true,
    );
  });
});

it.each(["oam", "dmc"] as const)(
  "retains the current path's proven mapper views at the %s DMA source budget frontier",
  async (dma) => {
    const program = [
      0xa9,
      6,
      0x8d,
      0,
      0x80,
      0xa9,
      2,
      0x8d,
      1,
      0x80,
      ...(dma === "oam"
        ? [0xa9, 0x82, 0x8d, 0x14, 0x40]
        : [0xa9, 16, 0x8d, 0x15, 0x40]),
      0xea,
      0xea,
    ];
    const origin = { kind: "initial-state" };
    const selected =
      dma === "oam"
        ? {
            initial_ppu: nesPpuFixtureState({
              chr_ram_size: null,
              oam: {
                model: "oam-memory",
                address: 0,
                retention: "stable",
                reads: "supported",
                address_writes: "uncorrupted",
                dma_pending: { status: "none" },
              },
            }),
            initial_cpu_dma: {
              model: "oam-cpu-dma",
              region: "ntsc",
              cpu_phase: "get",
            },
            max_oam_dma_source_bytes: 0,
          }
        : {
            initial_apu: {
              model: "apu-registers",
              frame_clocks: "cpu-ordered",
              dmc_reads: "explicit",
              registers: Object.fromEntries(
                [
                  [0x4010, 128],
                  [0x4012, 32],
                  [0x4013, 0],
                  [0x4015, 0],
                  [0x4017, 64],
                ].map(([address, value]) => [address, { value, origin }]),
              ),
              dmc_remaining: { value: { min: 0, max: 0 }, origin },
              dmc_irq: { value: false, origin },
              frame_irq: { value: false, origin },
              frame_sequencer: {
                region: "ntsc",
                cpu_phase: "get",
                position: { min: 0, max: 0 },
                five_step: false,
                reset_delay: { min: 0, max: 0 },
                clock_block: 0,
              },
              dmc: {
                model: "dmc-reader-output",
                region: "ntsc",
                clocks: "cpu-ordered",
                current_address: 0xc800,
                buffer: { status: "empty" },
                shift: 0,
                bits_remaining: 8,
                silence: true,
                level: 64,
                timer_remaining: 428,
                cpu_timing: {
                  model: "2a03-dmc-dma",
                  stop: { status: "none" },
                  request: { status: "none" },
                },
              },
            },
            max_dmc_dma_source_bytes: 0,
          };
    const result = await run(nesCodeFixture(4, program), {
      ...selected,
      initial_cpu_bus: {
        model: "nmos-6502-bus",
        dma_reads: "absent",
        next_cycle_index: 100,
      },
      max_instructions: 16,
    });
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.termination).toBe(`${dma}-dma-source-budget`);
    expect(result.paths).toHaveLength(1);
    const trace = result.paths[0]!.trace;
    if (trace.status !== "derived" || trace.mapper_trace.status !== "derived")
      throw new Error("Expected a retained derived mapper trace");
    const views = [0, 2].map((r6) => ({ mapper: 4, prg_mode: 0, r6, r7: 1 }));
    expect(trace.mapper_trace.nes_prg_views).toEqual(views);
    expect(result.nes_prg_views).toEqual(views);
    expect(trace.stop.reason).toBe(`${dma}-dma-source-budget`);
    if (dma === "oam") {
      if (
        !("cpu_dma" in trace) ||
        trace.cpu_dma === null ||
        !("retained_source_bytes" in trace.cpu_dma)
      )
        throw new Error("Expected retained OAM DMA source facts");
      expect(trace.cpu_dma.retained_source_bytes).toBe(0);
    } else {
      if (trace.cpu_bus === null || !("dmc" in trace.cpu_bus))
        throw new Error("Expected retained DMC bus facts");
      expect(trace.cpu_bus.dmc.retained_source_bytes).toBe(0);
    }
  },
);

describe("exploration boundaries", () => {
  it("retains unexecuted alternatives and counts replayed instructions against global budgets", async () => {
    const fixture = mmc3BranchCodeFixture();
    const capped = await run(fixture, { max_paths: 1 });
    expect(capped).toMatchObject({
      status: "derived",
      termination: "path-budget",
      instructions_applied: 1,
      pending_paths: [
        {
          parent_index: 0,
          branch_choices: [{ address: 0xe003, taken: false }],
        },
        { parent_index: 0, branch_choices: [{ address: 0xe003, taken: true }] },
      ],
    });
    const total = await run(fixture, { max_total_instructions: 3 });
    expect(total).toMatchObject({
      status: "derived",
      termination: "instruction-budget",
      instructions_applied: 3,
      paths: [
        { trace: { stop: { reason: "unknown-branch" } } },
        { trace: { stop: { reason: "instruction-budget", address: 0xe005 } } },
      ],
      pending_paths: [
        { parent_index: 0, branch_choices: [{ address: 0xe003, taken: true }] },
      ],
    });
    const perPath = await run(fixture, { max_instructions: 1 });
    expect(perPath).toMatchObject({
      status: "derived",
      termination: "queue-exhausted",
      paths: [{ trace: { stop: { reason: "instruction-budget" } } }],
      pending_paths: [],
    });
    const loop = await run(nesCodeFixture(4, [0x4c, 0, 0xe0]), {
      max_total_instructions: 3,
    });
    expect(loop).toMatchObject({
      status: "derived",
      termination: "instruction-budget",
      instructions_applied: 3,
    });
  });

  it("does not invent indirect targets or expand mismatched choices and rejects unsupported boards", async () => {
    expect(await run(nesCodeFixture(4, [0x6c, 0, 0]))).toMatchObject({
      status: "derived",
      paths: [{ trace: { stop: { reason: "unknown-control-target" } } }],
      pending_paths: [],
    });
    expect(
      await run(mmc3BranchCodeFixture(), {
        branch_choices: [{ address: 0x8000, taken: true }],
      }),
    ).toMatchObject({
      status: "derived",
      paths: [{ trace: { stop: { reason: "branch-choice-mismatch" } } }],
      pending_paths: [],
    });
    expect(
      await run(mmc3BranchCodeFixture(), { initial: { mapper: 1 } }),
    ).toMatchObject({ status: "unsupported" });
  });

  it("yields between path attempts and respects cancellation before publishing", async () => {
    const controller = new AbortController();
    const pending = run(mmc3BranchCodeFixture(), {}, controller.signal);
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toThrow();
    await expect(
      run(mmc3BranchCodeFixture(), {}, controller.signal),
    ).rejects.toThrow();
  });
});
