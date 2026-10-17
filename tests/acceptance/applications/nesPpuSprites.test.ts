import { connectTestMcp } from "../../support/cliMcpDelivery.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { Client } from "@modelcontextprotocol/client";

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  nesOamUploadFixture,
  nesPpuFixture,
  nesPpuFixtureState,
} from "../../../src/domain/nesPpu.fixture.js";
import type { NesPpuSprites } from "../../../src/domain/nesPpuSprites.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const verifyPixels = (
  sprites: NesPpuSprites,
  {
    bytes,
    chrOffset,
    values,
    height,
  }: { bytes: Buffer; chrOffset: number; values: number[]; height: 8 | 16 },
) => {
  expect(sprites.sprites).toHaveLength(64);
  for (const [index, sprite] of sprites.sprites.entries()) {
    const y = values[(index * 4 + 3) & 255]!,
      tile = values[(index * 4 + 4) & 255]!,
      attributes = values[(index * 4 + 5) & 255]! & 227,
      x = values[(index * 4 + 6) & 255]!,
      table = height === 8 ? 0 : tile & 1,
      base = height === 8 ? tile : tile & 254;
    expect(sprite).toMatchObject({
      index,
      y,
      x,
      tile_index: tile,
      attributes,
      top_rows: [y + 1],
      subpalette: attributes & 3,
      behind_background: (attributes & 32) !== 0,
    });
    expect(sprite.modes).toHaveLength(1);
    const mode = sprite.modes[0]!;
    expect(mode.height).toBe(height);
    expect(mode.pattern_tables).toEqual([table]);
    expect(mode.first_tiles).toEqual([base]);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < 8; x++) {
        const sy = attributes & 128 ? height - y - 1 : y,
          sx = attributes & 64 ? 7 - x : x,
          offset =
            chrOffset +
            table * 4096 +
            (base + Math.floor(sy / 8)) * 16 +
            (sy % 8);
        expect(mode.rows[y]![x]).toBe(
          ((bytes[offset]! >> (7 - sx)) & 1) |
            (((bytes[offset + 8]! >> (7 - sx)) & 1) << 1),
        );
      }
  }
  for (const source of sprites.source_pages) {
    if (source.kind !== "rom") throw new Error("Missing CHR ROM");
    expect(source.bytes_hex).toBe(
      bytes
        .subarray(source.file_offset, source.file_offset + 1024)
        .toString("hex"),
    );
  }
  const selection = sprites.scanline_selection;
  expect(selection.interpretation).toBe("frozen-oam-0-first-eight");
  expect(selection.modes).toHaveLength(1);
  expect(selection.modes[0]!.height).toBe(height);
  for (const line of selection.modes[0]!.lines) {
    const eligible = Array.from({ length: 64 }, (_, sprite) => ({
      sprite,
      row: line.y - values[(sprite * 4 + 3) & 255]! - 1,
    })).filter(({ row }) => row >= 0 && row < height);
    expect(selection.modes[0]!.candidate_sets[line.candidate_set]).toEqual(
      eligible.map(({ sprite, row }, slot) => ({
        sprite,
        row_mask: 2 ** row,
        selection: slot < 8 ? "definite" : "excluded",
        slots: slot < 8 ? [slot, slot] : null,
      })),
    );
    expect(line.in_range).toEqual({
      minimum: eligible.length,
      maximum: eligible.length,
    });
    expect(line.selected).toEqual({
      minimum: Math.min(8, eligible.length),
      maximum: Math.min(8, eligible.length),
    });
  }
};

cliTest(
  "joins source-backed DMA OAM, CHR pixels and branch-local sprite modes over real CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sprite-sources-"),
      fixture = nesOamUploadFixture({
        viaRam: true,
        startAddress: 253,
        tail: [
          234, 44, 22, 64, 240, 6, 169, 0, 141, 0, 32, 96, 169, 32, 141, 0, 32,
          96,
        ],
      }),
      chrOffset = fixture.bytes.length,
      bytes = Buffer.concat([fixture.bytes, Buffer.alloc(8192)]),
      path = join(root, "sprites.nes");
    bytes[5] = 1;
    bytes[11] = 0;
    for (let offset = 0; offset < 8192; offset++)
      bytes[chrOffset + offset] = (offset * 29 + (offset >> 3) * 7) & 255;
    await writeFile(path, bytes);
    const input = {
      path,
      initial: { mapper: 0 },
      initial_ppu: {
        ...fixture.initial_ppu,
        chr_ram_size: null,
        palette: { 17: 45 },
      },
      ppu_sprites: true,
      ppu_pattern_table: 1,
      ppu_nametable: 0,
      max_instructions: 1100,
    };
    const client = await connectTestMcp("sprite-oracle");

    const definitions = (await client.listTools()).tools;
    const call = bothCaller(cli, client, definitions);
    const first = await call("trace_nes_code", input);
    const code =
      toolContract("trace_nes_code").outputSchema.parse(first).normalized_result
        .code_trace;
    if (
      code.status !== "derived" ||
      code.mapper_trace.status !== "derived" ||
      !("ppu_trace" in code.mapper_trace) ||
      code.mapper_trace.ppu_trace.sprites === null
    )
      throw new Error("Missing sprites");
    expect(code.stop.reason).toBe("unknown-branch");
    verifyPixels(code.mapper_trace.ppu_trace.sprites, {
      bytes,
      chrOffset,
      values: fixture.values,
      height: 8,
    });
    const transfer = code.instructions.find(
      (instruction) => "oam_dma_reads" in instruction,
    );
    if (!transfer || !("oam_dma_reads" in transfer))
      throw new Error("Missing DMA proofs");
    for (const [offset, read] of transfer.oam_dma_reads.entries()) {
      expect(read.value).toBe(fixture.values[offset]);
      expect(read.ram_origins[0]).toMatchObject({
        instruction_index: 2 + offset * 4,
      });
    }
    const explored = await call("explore_nes_code", input),
      exploration =
        toolContract("explore_nes_code").outputSchema.parse(explored)
          .normalized_result.code_exploration;
    if (exploration.status !== "derived") throw new Error(exploration.reason);
    expect(exploration.paths).toHaveLength(3);
    for (const [index, branch] of exploration.paths.entries()) {
      const traced = branch.trace;
      if (
        traced.status !== "derived" ||
        traced.mapper_trace.status !== "derived" ||
        !("ppu_trace" in traced.mapper_trace) ||
        traced.mapper_trace.ppu_trace.sprites === null
      )
        throw new Error("Missing branch sprite state");
      verifyPixels(traced.mapper_trace.ppu_trace.sprites, {
        bytes,
        chrOffset,
        values: fixture.values,
        height: index === 2 ? 16 : 8,
      });
      const replay = await call("trace_nes_mapper_events", {
        path,
        initial: input.initial,
        initial_ppu: input.initial_ppu,
        ppu_sprites: true,
        ppu_pattern_table: 1,
        ppu_nametable: 0,
        events: traced.mapper_trace.steps.map((step) => step.event),
      });
      expect(
        toolContract("trace_nes_mapper_events").outputSchema.parse(replay)
          .normalized_result.trace,
      ).toEqual(traced.mapper_trace);
      const continued = await call("trace_nes_mapper_events", {
        path,
        initial: traced.mapper_trace.final,
        initial_ppu: traced.mapper_trace.ppu_trace.final,
        ppu_sprites: true,
        events: [],
      });
      const final = toolContract("trace_nes_mapper_events").outputSchema.parse(
        continued,
      ).normalized_result.trace;
      if (final.status !== "derived" || !("ppu_trace" in final))
        throw new Error("Missing continued PPU");
      expect(final.ppu_trace.sprites).toEqual(
        traced.mapper_trace.ppu_trace.sprites,
      );
      expect(final.ppu_trace.final.next_event_index).toBe(
        traced.mapper_trace.ppu_trace.final.next_event_index,
      );
    }
    verifyOutputConstraints(
      first,
      definitions.find((tool) => tool.name === "trace_nes_code")!.outputSchema!,
    );
    expect(first.subject?.digest?.sha256).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );
    expect(await readFile(path)).toEqual(bytes);
  },
  180_000,
);

cliTest(
  "retains all 512 CHR source pages across both sprite tables within the default MCP budget",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-sprite-capacity-"),
      fixture = nesPpuFixture([], { mapper: 4, chrSize: 512 * 1024 }),
      path = join(root, "vrc4.nes");
    fixture.bytes[6] = 0x54;
    fixture.bytes[7] = 0x18;
    fixture.bytes[8] = 0x10;
    fixture.bytes.fill(0, fixture.chrOffset);
    for (let bank = 0; bank < 512; bank++) {
      const base = fixture.chrOffset + bank * 1024,
        pixel = [1, 2, 3][bank % 3]!;
      for (let tile = 0; tile < 64; tile++) {
        fixture.bytes.fill(
          pixel & 1 ? 255 : 0,
          base + tile * 16,
          base + tile * 16 + 8,
        );
        fixture.bytes.fill(
          pixel & 2 ? 255 : 0,
          base + tile * 16 + 8,
          base + tile * 16 + 16,
        );
      }
    }
    await writeFile(path, fixture.bytes);

    const client = await connectTestMcp("sprite-capacity");

    const definition = (await client.listTools()).tools.find(
        (tool) => tool.name === "trace_nes_mapper_events",
      )!,
      ajv = new Ajv2020({ strict: false, validateFormats: false });
    const response = await client.callTool({
      name: "trace_nes_mapper_events",
      arguments: {
        path,
        initial: { mapper: 21, variant: "vrc4" },
        initial_ppu: nesPpuFixtureState({
          chr_ram_size: null,
          control: null,
          oam: { model: "oam-memory", retention: "stable" },
        }),
        ppu_sprites: true,
        ppu_pattern_table: 1,
        ppu_nametable: 0,
        events: [],
      },
    });
    expect(response.isError).not.toBe(true);
    expect(
      ajv.validate(
        definition.outputSchema as Record<string, unknown>,
        response.structuredContent,
      ),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    const trace = toolContract("trace_nes_mapper_events").outputSchema.parse(
      response.structuredContent,
    ).normalized_result.trace;
    if (
      trace.status !== "derived" ||
      !("ppu_trace" in trace) ||
      trace.ppu_trace.sprites === null
    )
      throw new Error("Missing capacity result");
    const sprites = trace.ppu_trace.sprites;
    expect(sprites.source_pages).toHaveLength(512);
    expect(sprites.blocks).toHaveLength(8);
    expect(sprites.coverage.unknown_pixels).toBe(0);
    expect(sprites.coverage.partial_pixels).toBeGreaterThan(0);
    expect(sprites.sprites[0]!.modes[0]!.rows[0]![0]).toEqual({
      choices: [1, 2, 3],
    });
    if (!("pattern_table" in trace.ppu_trace))
      throw new Error("Missing capacity pattern");
    expect(trace.ppu_trace.pattern_table.tiles[0]!.rows[0]![0]).toEqual({
      choices: [1, 2, 3],
    });
    expect(sprites.scanline_selection.modes.map((mode) => mode.height)).toEqual(
      [8, 16],
    );
    for (const mode of sprites.scanline_selection.modes) {
      expect(mode.candidate_sets[mode.lines[0]!.candidate_set]).toEqual([]);
      expect(mode.candidate_sets).toHaveLength(mode.height + 1);
      expect(mode.coverage).toEqual({
        examined_scanlines: 240,
        uncertain_selection_scanlines: 239,
        guaranteed_excess_scanlines: 0,
        possible_excess_scanlines: 239,
      });
      for (const line of mode.lines.slice(1)) {
        expect(line.in_range).toEqual({ minimum: 0, maximum: 64 });
        expect(line.selected).toEqual({ minimum: 0, maximum: 8 });
        const candidates = mode.candidate_sets[line.candidate_set]!;
        expect(candidates).toHaveLength(64);
        expect(
          candidates.every((candidate) => candidate.selection === "possible"),
        ).toBe(true);
      }
    }
    for (const [bank, source] of sprites.source_pages.entries()) {
      if (source.kind !== "rom") throw new Error("Missing ROM page");
      expect(source.file_offset).toBe(fixture.chrOffset + bank * 1024);
      expect(source.bytes_hex).toBe(
        fixture.bytes
          .subarray(source.file_offset, source.file_offset + 1024)
          .toString("hex"),
      );
    }
    const transparent = Buffer.from(fixture.bytes),
      overlapPath = join(root, "transparent.nes");
    transparent.fill(0, fixture.chrOffset);
    await writeFile(overlapPath, transparent);
    await verifyOverlappedSprites(
      bothCaller(cli, client, [definition]),
      overlapPath,
    );
    expect(await readFile(overlapPath)).toEqual(transparent);
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  120_000,
);

const bothCaller = (
  cli: TestCli,
  client: Client,
  definitions: Awaited<ReturnType<Client["listTools"]>>["tools"],
) => {
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  return async (
    name: "trace_nes_code" | "explore_nes_code" | "trace_nes_mapper_events",
    parameters: Record<string, unknown>,
  ) => {
    const definition = definitions.find((tool) => tool.name === name)!;
    expect(ajv.validate(definition.inputSchema, parameters)).toBe(true);
    const compiled = await cli.run({
      arguments: [
        name.replaceAll("_", "-"),
        JSON.stringify(parameters),
        "--json",
      ],
    });
    expect(compiled.exitCode).toBe(0);
    const response = await client.callTool({ name, arguments: parameters });
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toEqual(compiled.json);
    expect(
      ajv.validate(
        definition.outputSchema as Record<string, unknown>,
        response.structuredContent,
      ),
      JSON.stringify(ajv.errors),
    ).toBe(true);
    return toolContract(name).outputSchema.parse(response.structuredContent);
  };
};

async function verifyOverlappedSprites(
  call: ReturnType<typeof bothCaller>,
  path: string,
) {
  const cells = Object.fromEntries(
    Array.from({ length: 64 }, (_, index) => [
      [index * 4, 0],
      [index * 4 + 1, 2],
      [index * 4 + 2, 224],
      [index * 4 + 3, 255],
    ]).flat(),
  );
  const overlap = await call("trace_nes_mapper_events", {
    path,
    initial: { mapper: 21, variant: "vrc4" },
    initial_ppu: nesPpuFixtureState({
      chr_ram_size: null,
      control: null,
      mask: 0,
      oam: { model: "oam-memory", retention: "stable", cells },
    }),
    ppu_sprites: true,
    events: [],
  });
  const overlapped = toolContract("trace_nes_mapper_events").outputSchema.parse(
    overlap,
  ).normalized_result.trace;
  if (
    overlapped.status !== "derived" ||
    !("ppu_trace" in overlapped) ||
    overlapped.ppu_trace.sprites === null
  )
    throw new Error("Missing overlapped scanlines");
  const frozen = overlapped.ppu_trace.sprites;
  expect(frozen.sprites_enabled).toBe(false);
  expect(
    frozen.sprites.every((sprite) =>
      sprite.modes.every((mode) =>
        mode.rows.flat().every((pixel) => pixel === 0),
      ),
    ),
  ).toBe(true);
  for (const mode of frozen.scanline_selection.modes) {
    expect(mode.coverage.guaranteed_excess_scanlines).toBe(mode.height);
    for (const line of mode.lines) {
      const hit = line.y >= 1 && line.y <= mode.height;
      expect(line.selected).toEqual({
        minimum: hit ? 8 : 0,
        maximum: hit ? 8 : 0,
      });
      expect(line.excess).toEqual({
        minimum: hit ? 56 : 0,
        maximum: hit ? 56 : 0,
      });
      expect(mode.candidate_sets[line.candidate_set]).toEqual(
        hit
          ? Array.from({ length: 64 }, (_, sprite) => ({
              sprite,
              row_mask: 2 ** (line.y - 1),
              selection: sprite < 8 ? "definite" : "excluded",
              slots: sprite < 8 ? [sprite, sprite] : null,
            }))
          : [],
      );
    }
  }
}

const verifyOutputConstraints = (
  evidence: unknown,
  schema: Record<string, unknown>,
) => {
  const parsed = toolContract("trace_nes_code").outputSchema.parse(evidence),
    code = parsed.normalized_result.code_trace;
  if (
    code.status !== "derived" ||
    code.mapper_trace.status !== "derived" ||
    !("ppu_trace" in code.mapper_trace) ||
    code.mapper_trace.ppu_trace.sprites === null
  )
    throw new Error("Missing schema oracle");
  const sprites = code.mapper_trace.ppu_trace.sprites,
    ajv = new Ajv2020({ strict: false, validateFormats: false });
  const row = sprites.sprites[0]!.modes[0]!.rows[0]!,
    original = row[0];
  for (const choices of [
    [0, 3],
    [1, 2],
    [0, 1, 2],
    [0, 1, 3],
    [0, 2, 3],
    [1, 2, 3],
  ]) {
    Reflect.set(row, 0, { choices });
    expect(ajv.validate(schema, parsed)).toBe(true);
  }
  for (const choices of [[], [1, 1], [2, 1], [0, 1], [0, 1, 2, 3], [1, 4]]) {
    Reflect.set(row, 0, { choices });
    expect(ajv.validate(schema, parsed)).toBe(false);
  }
  row[0] = original!;
  sprites.palette_cells[0]!.code = 64;
  expect(ajv.validate(schema, parsed)).toBe(false);
  sprites.palette_cells[0]!.code = 45;
  const candidate =
    sprites.scanline_selection.modes[0]!.candidate_sets.flat()[0]!;
  const rows = candidate.row_mask;
  candidate.row_mask = 0;
  expect(ajv.validate(schema, parsed)).toBe(false);
  candidate.row_mask = 256;
  expect(ajv.validate(schema, parsed)).toBe(false);
  candidate.row_mask = rows;
  const slots = candidate.slots;
  candidate.slots = [8, 8];
  expect(ajv.validate(schema, parsed)).toBe(false);
  for (const slots of [[], [0], [0, 1, 2]]) {
    Reflect.set(candidate, "slots", slots);
    expect(ajv.validate(schema, parsed)).toBe(false);
  }
  candidate.slots = slots;
  const mode = sprites.sprites[0]!.modes[0]!;
  sprites.sprites[0]!.modes[0] = {
    ...mode,
    height: 16,
    first_tiles: [1],
    rows: [...mode.rows, ...mode.rows],
  };
  expect(ajv.validate(schema, parsed)).toBe(false);
};
