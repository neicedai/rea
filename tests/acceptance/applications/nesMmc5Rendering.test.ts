import {
  connectTestMcp,
  mcpContractsFor,
  createToolDelivery,
} from "../../support/cliMcpDelivery.js";
import type { Client } from "@modelcontextprotocol/client";

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  mmc5RenderingFixture,
  mmc5ExtendedInput,
  mmc5SplitInput,
} from "../../../src/domain/nesMmc5Rendering.fixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

type Context = {
  cli: TestCli;
  client: Client;
  path: string;
  bytes: Buffer;
  chrOffset: number;
  validInput: (v: unknown) => boolean;
};
async function both(context: Context, input: Record<string, unknown>) {
  const { cli, client, path, validInput } = context,
    contract = toolContract("trace_nes_mapper_events");
  const request = { path, ...input };
  expect(validInput(request)).toBe(true);
  const b = toolContract("trace_nes_mapper_events").outputSchema.parse(
    await (
      await createToolDelivery(client, cli)
    ).invoke("trace-nes-mapper-events", request),
  );
  expect(b.subject?.digest?.sha256).toBe(
    createHash("sha256").update(context.bytes).digest("hex"),
  );
  const trace = b.normalized_result.trace;
  if (trace.status !== "derived") throw new Error(trace.reason);
  if ("mapper_snapshots" in trace)
    throw new Error("Unexpected PPU profile in this legacy mapper workflow");
  for (const step of trace.steps) {
    const source = step.read_source;
    if (
      source !== null &&
      "mmc5" in source &&
      "rom_sources" in source.mmc5 &&
      source.mmc5.rom_sources.status === "examined"
    ) {
      const offsets = source.mmc5.rom_sources.file_offsets;
      expect(offsets).toEqual([...new Set(offsets)].sort((a, b) => a - b));
      for (const offset of offsets) {
        const value = context.bytes[offset]!;
        if (source.value !== null) expect(value).toBe(source.value);
        else if ("known_bits" in source)
          expect(value & source.known_bits.mask).toBe(source.known_bits.value);
      }
    }
  }
  return trace;
}

async function verifyLatches(context: Context) {
  for (const scenario of [mmc5ExtendedInput, mmc5SplitInput]) {
    const trace = await both(context, scenario),
      extended = scenario === mmc5ExtendedInput;
    const indices = extended ? [5, 9] : [4, 6];
    const offsets = extended
      ? [67 * 4096 + 0x112, 131 * 4096 + 0x11a]
      : [7 * 4096 + 0x213, 9 * 4096 + 0x21b];
    for (const [index, stepIndex] of indices.entries()) {
      const offset = context.chrOffset + offsets[index]!;
      expect(trace.steps[stepIndex]!.read_source).toMatchObject({
        file_offset: offset,
        value: context.bytes[offset],
        mmc5: {
          rom_sources: { status: "examined", file_offsets: [offset] },
          rendering: { paths: [extended ? "extended" : "split"] },
        },
      });
    }
    expect(trace.steps[extended ? 2 : 3]!.read_source).toMatchObject({
      value: extended ? 170 : 85,
    });
    expect(trace.steps[1]!.read_source).toMatchObject({
      mmc5: extended
        ? { nametable_sources: ["fill"] }
        : { nametable_sources: ["exram"], cell_address: 933, cell_value: 33 },
    });
    const split = extended ? 6 : 5;
    const continued = await both(context, {
      initial: trace.steps[split - 1]!.state,
      events: scenario.events.slice(split),
    });
    expect(continued.final).toEqual(trace.final);
    expect(continued.steps.map(({ index: _index, ...s }) => s)).toEqual(
      trace.steps.slice(split).map(({ index: _index, ...s }) => s),
    );
    expect(trace.final_irq).toBeNull();
    expect(
      trace.steps
        .filter(
          (s) =>
            s.event.kind === "mmc5-render-frame" ||
            s.event.kind === "mmc5-render-line",
        )
        .every((s) => s.irq_clock === false),
    ).toBe(true);
  }
  const unknownWiring = await both(context, {
    ...mmc5SplitInput,
    initial: {
      ...mmc5SplitInput.initial,
      ppu: { ...mmc5SplitInput.initial.ppu, split_wiring: null },
    },
  });
  expect(unknownWiring.steps[4]!.read_source).toMatchObject({
    status: "unknown-chr-offset",
    bank: 28,
    file_offset: null,
    mmc5: {
      rom_sources: {
        file_offsets: [1, 3].map(
          (row) => context.chrOffset + 7 * 4096 + 0x210 + row,
        ),
      },
    },
  });
  const mixed = await both(context, {
    ...mmc5SplitInput,
    initial: {
      ...mmc5SplitInput.initial,
      ppu: { ...mmc5SplitInput.initial.ppu, pin92_high: null },
    },
  });
  expect(mixed.steps[3]!.read_source).toMatchObject({
    status: "unknown-nametable-bank",
    value: null,
    known_bits: { mask: 170, value: 0 },
    mmc5: { rendering: { paths: ["normal", "split"] } },
  });
}

async function verifyCapacityAndClocks(context: Context) {
  const trace = await both(context, {
    initial: { mapper: 5, ppu: { model: "mmc5-background" } },
    events: [
      { kind: "ppu-read", address: 0x2000, mmc5_fetch: "background" },
      { kind: "ppu-read", address: 0x23c0, mmc5_fetch: "background" },
      { kind: "ppu-read", address: 0, mmc5_fetch: "background" },
    ],
  });
  const expected = new Set(
    Array.from({ length: 1024 }, (_, bank) => context.chrOffset + bank * 1024),
  );
  for (let bank = 0; bank < 256; bank++)
    for (let row = 0; row < 8; row++)
      expected.add(context.chrOffset + bank * 4096 + row);
  expect(expected.size).toBe(2816);
  expect(trace.steps[2]!.read_source).toMatchObject({
    bank: null,
    file_offset: null,
    mmc5: {
      rom_sources: {
        status: "examined",
        file_offsets: [...expected].sort((a, b) => a - b),
      },
    },
  });
  const counters = await both(context, {
    initial: mmc5SplitInput.initial,
    initial_irq: {
      model: "mmc5",
      counter: 3,
      in_frame: true,
      pending: false,
      enabled: false,
      asserted: false,
      last_ppu_address: 8192,
      matching_reads: [0],
      idle_cycles: [0],
      ppu_read_since_cycle: false,
    },
    events: [{ kind: "mmc5-render-frame" }, { kind: "mmc5-render-line" }],
  });
  expect(counters.final_irq).toEqual(counters.initial_irq);
  expect(counters.final).toMatchObject({ ppu: { split_y: 236 } });
}

async function verifyInputs(context: Context) {
  const { client, path, validInput } = context;
  for (const input of [
    { initial: { mapper: 5, ppu: { model: "other" } }, events: [] },
    {
      initial: mmc5SplitInput.initial,
      events: [
        {
          kind: "ppu-read",
          address: 0x23c0,
          mmc5_fetch: "background",
          mmc5_tile: { column: 0, line: "current" },
        },
      ],
    },
    {
      initial: mmc5SplitInput.initial,
      events: [
        {
          kind: "ppu-read",
          address: 0x2000,
          mmc5_fetch: "background",
          mmc5_tile: { column: 32, line: "current" },
        },
      ],
    },
    {
      initial: {
        ...mmc5SplitInput.initial,
        ppu: { model: "mmc5-background", paths: [] },
      },
      events: [],
    },
  ]) {
    expect(validInput({ path, ...input })).toBe(false);
    expect(
      (
        await client.callTool({
          name: "trace_nes_mapper_events",
          arguments: { path, ...input },
        })
      ).isError,
    ).toBe(true);
  }
  const response = await client.callTool({
    name: "trace_nes_mapper_events",
    arguments: {
      path,
      initial: { mapper: 5 },
      events: [{ kind: "mmc5-render-frame" }],
    },
  });
  expect(response.isError).not.toBe(true);
  expect(
    toolContract("trace_nes_mapper_events").outputSchema.parse(
      response.structuredContent,
    ).normalized_result.trace,
  ).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("initial.ppu"),
  });
}

async function verifyInactiveGeometry(context: Context) {
  const trace = await both(context, {
    initial: {
      ...mmc5SplitInput.initial,
      exram_mode: 0,
      ppu_control: 0,
      chr_mode: 3,
      chr_banks: [5, ...Array(11).fill(null)],
      chr_bank_modes: [3, ...Array(11).fill(null)],
      chr_bank_upper: [0, ...Array(11).fill(null)],
      ppu: {
        ...mmc5SplitInput.initial.ppu,
        phase: "unknown",
        tile_column: 31,
        paths: ["normal"],
      },
    },
    events: [{ kind: "ppu-read", address: 0, mmc5_fetch: "background" }],
  });
  expect(trace.steps[0]!.read_source).toMatchObject({
    value: null,
    file_offset: null,
    mmc5: {
      rom_sources: {
        status: "unresolved",
        file_offsets: [context.chrOffset + 5 * 1024],
      },
      rendering: { paths: ["normal", "split"], reason: "missing-tile" },
    },
  });
}

cliTest(
  "analyzes MMC5 extended and split background sources with resumable context through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-mmc5-render-"),
      f = mmc5RenderingFixture(),
      path = join(root, "render.nes");
    await writeFile(path, f.bytes);

    const client = await connectTestMcp("mmc5-render");

    const schemas = (await mcpContractsFor(client))("trace_nes_mapper_events");
    const context: Context = {
      cli,
      client,
      path,
      ...f,
      validInput: schemas.input,
    };
    await verifyLatches(context);
    await verifyCapacityAndClocks(context);
    await verifyInputs(context);
    await verifyInactiveGeometry(context);
    expect(await readFile(path)).toEqual(f.bytes);
  },
  120_000,
);
