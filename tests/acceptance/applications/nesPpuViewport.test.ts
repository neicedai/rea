import { createStdioToolClient } from "../../support/cliMcpDelivery.js";
import { createNesSourceCaller } from "../../support/nesSourceDelivery.js";
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
import {
  nesPpuViewportFixture,
  nesViewportPixelOracle,
  type NesViewportOracleInput,
} from "../../../src/domain/nesPpuViewport.fixture.js";
import type { NesPpuViewport } from "../../../src/domain/nesPpuViewport.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

type Operation =
  | "trace_nes_code"
  | "explore_nes_code"
  | "trace_nes_mapper_events";
const caller = async (cli: TestCli, client: Client) => {
  const { call } = await createNesSourceCaller(cli, client);
  return async (
    name: Operation,
    input: Record<string, unknown>,
    parity = true,
  ) => toolContract(name).outputSchema.parse(await call(name, input, parity));
};
const verifyViewport = (
  viewport: NesPpuViewport,
  input: NesViewportOracleInput,
) => {
  const addresses = Object.keys(input.palette)
      .map(Number)
      .sort((a, b) => a - b),
    mode = viewport.modes[0]!;
  expect(viewport.palette_cells.map((cell) => cell.address)).toEqual(addresses);
  expect(viewport.origin_x).toBe(input.origin_x);
  expect(viewport.origin_y).toBe(input.origin_y);
  expect(viewport.modes).toHaveLength(1);
  expect(mode.sprite_height).toBe(input.control & 32 ? 16 : 8);
  const codes = Array.from({ length: 64 }, (_, code) =>
      (1n << BigInt(code)).toString(16).padStart(16, "0"),
    ),
    sprites = Array.from({ length: 64 }, (_, index) =>
      (1n << BigInt(index)).toString(16).padStart(16, "0"),
    );
  for (let y = 0; y < 240; y++)
    for (let x = 0; x < 256; x++) {
      const wanted = nesViewportPixelOracle(input, x, y),
        actual = mode.pixel_states[mode.rows[y]![x]!]!;
      expect(actual).toEqual({
        palette_mask: 1 << addresses.indexOf(wanted.address),
        code_mask: codes[wanted.code],
        layers: wanted.layer,
        front_sprites:
          wanted.front === null ? "0000000000000000" : sprites[wanted.front],
        visible_sprites:
          wanted.visible === null
            ? "0000000000000000"
            : sprites[wanted.visible],
      });
    }
  expect(mode.coverage).toEqual({
    examined_pixels: 61440,
    ambiguous_palette_pixels: 0,
    ambiguous_code_pixels: 0,
    unknown_code_pixels: 0,
  });
  for (const page of viewport.chr_source_pages) {
    if (page.kind !== "rom") throw new Error("Missing CHR ROM");
    expect(page.bytes_hex).toBe(
      Buffer.from(
        input.bytes.subarray(page.file_offset, page.file_offset + 1024),
      ).toString("hex"),
    );
  }
  for (const block of viewport.chr_blocks)
    expect(
      block.sources.map((index) => viewport.chr_source_pages[index]),
    ).toMatchObject([
      { kind: "rom", file_offset: input.chrOffset + block.ppu_address },
    ]);
  expect(viewport.nametables.map((page) => page.source_pages)).toEqual([
    [0],
    [1024],
    [2048],
    [3072],
  ]);
};

async function prepareViewportSource() {
  const root = await createTestTempDirectory("rea-viewport-source-"),
    scene = nesPpuViewportFixture(),
    upload = nesOamUploadFixture({
      viaRam: false,
      startAddress: 249,
      tail: [
        234, 44, 22, 64, 240, 11, 169, 0, 141, 0, 32, 169, 30, 141, 1, 32, 96,
        169, 48, 141, 0, 32, 169, 31, 141, 1, 32, 96,
      ],
    });
  for (let address = 0; address < 256; address++)
    upload.values[(address - 249) & 255] =
      scene.oam[address]! | (address % 4 === 2 ? 28 : 0);
  upload.bytes.set(upload.values, upload.prgOffset + 512);
  const chrOffset = upload.bytes.length,
    bytes = Buffer.concat([
      upload.bytes,
      scene.bytes.subarray(scene.chrOffset),
    ]),
    path = join(root, "viewport.nes");
  bytes[5] = 1;
  bytes[11] = 0;
  bytes[6] = bytes[6]! | 8;
  await writeFile(path, bytes);
  return { scene, upload, chrOffset, bytes, path };
}

cliTest(
  "composes every source-backed viewport pixel through branch-local control/mask, replay and continuation over CLI/MCP",
  async ({ cli }) => {
    const { scene, upload, chrOffset, bytes, path } =
      await prepareViewportSource();
    const input = {
        path,
        initial: { mapper: 0 },
        initial_ppu: {
          ...scene.initialPpu,
          ...upload.initial_ppu,
          chr_ram_size: null,
          nametable_layout: "four-screen-4k",
          control: 8,
          mask: 30,
          nametable: scene.nametable,
          palette: scene.palette,
        },
        ppu_viewport: {
          model: "frozen-viewport",
          origin_x: 507,
          origin_y: 477,
        },
      },
      connection = createStdioToolClient("viewport-oracle"),
      { transport, client } = connection;
    try {
      await client.connect(transport);
      const definitions = (await client.listTools()).tools,
        call = await caller(cli, client);
      const evidence = await call("trace_nes_code", input),
        code =
          toolContract("trace_nes_code").outputSchema.parse(evidence)
            .normalized_result.code_trace;
      if (
        code.status !== "derived" ||
        code.mapper_trace.status !== "derived" ||
        !("ppu_trace" in code.mapper_trace) ||
        code.mapper_trace.ppu_trace.viewport === null
      )
        throw new Error("Missing source viewport");
      expect(code.stop.reason).toBe("unknown-branch");
      expect(code.mapper_trace.ppu_trace.sprites).toBeNull();
      verifyViewport(code.mapper_trace.ppu_trace.viewport, {
        ...scene,
        bytes,
        chrOffset,
        control: 8,
        mask: 30,
        origin_x: 507,
        origin_y: 477,
      });
      const transfer = code.instructions.find(
        (instruction) => "oam_dma_reads" in instruction,
      );
      if (!transfer || !("oam_dma_reads" in transfer))
        throw new Error("Missing DMA sources");
      for (const [offset, read] of transfer.oam_dma_reads.entries())
        expect(read).toMatchObject({
          address: 0x8200 + offset,
          value: upload.values[offset],
          file_offset: upload.prgOffset + 512 + offset,
          ram_origins: [],
        });
      const explored = await call("explore_nes_code", input),
        exploration =
          toolContract("explore_nes_code").outputSchema.parse(explored)
            .normalized_result.code_exploration;
      if (exploration.status !== "derived") throw new Error(exploration.reason);
      expect(exploration.paths).toHaveLength(3);
      for (const branch of exploration.paths) {
        const traced = branch.trace,
          choice = branch.branch_choices.at(-1)?.taken,
          control = choice === undefined ? 8 : choice ? 48 : 0,
          mask = choice ? 31 : 30;
        if (
          traced.status !== "derived" ||
          traced.mapper_trace.status !== "derived" ||
          !("ppu_trace" in traced.mapper_trace) ||
          traced.mapper_trace.ppu_trace.viewport === null
        )
          throw new Error("Missing branch viewport");
        const mapped = traced.mapper_trace,
          ppu = mapped.ppu_trace;
        expect(ppu.final.control).toBe(control);
        expect(ppu.final.mask).toBe(mask);
        for (let address = 0; address < 256; address++)
          expect(ppu.final.oam!.cells[address]).toMatchObject({
            value: scene.oam[address],
            origin: { kind: "dma-write", address, start_address: 249 },
          });
        verifyViewport(ppu.viewport!, {
          ...scene,
          bytes,
          chrOffset,
          control,
          mask,
          origin_x: 507,
          origin_y: 477,
        });
        const replay = await call(
          "trace_nes_mapper_events",
          { ...input, events: mapped.steps.map((step) => step.event) },
          false,
        );
        expect(
          toolContract("trace_nes_mapper_events").outputSchema.parse(replay)
            .normalized_result.trace,
        ).toEqual(mapped);
        const continued = await call(
            "trace_nes_mapper_events",
            {
              ...input,
              initial: mapped.final,
              initial_ppu: ppu.final,
              events: [],
            },
            false,
          ),
          final = toolContract("trace_nes_mapper_events").outputSchema.parse(
            continued,
          ).normalized_result.trace;
        if (final.status !== "derived" || !("ppu_trace" in final))
          throw new Error("Missing continued viewport");
        expect(final.ppu_trace.viewport).toEqual(ppu.viewport);
        expect(final.ppu_trace.final.next_event_index).toBe(
          ppu.final.next_event_index,
        );
      }
      await verifyViewportBoundaries({
        call,
        client,
        definitions,
        input,
        evidence,
      });
      expect(evidence.subject?.digest?.sha256).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(await readFile(path)).toEqual(bytes);
    } finally {
      await connection.close();
    }
  },
  240000,
);

async function verifyViewportBoundaries(context: {
  call: Awaited<ReturnType<typeof caller>>;
  client: Client;
  definitions: Awaited<ReturnType<Client["listTools"]>>["tools"];
  input: Record<string, unknown>;
  evidence: unknown;
}) {
  const { call, client, definitions, input, evidence } = context;
  const definition = definitions.find(
      (tool) => tool.name === "trace_nes_code",
    )!,
    ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const selection of [
    { model: "frozen-viewport", origin_x: 512, origin_y: 0 },
    { model: "frozen-viewport", origin_x: 0, origin_y: 480 },
    { model: "frozen-viewport", origin_x: 0 },
  ]) {
    const bad = { ...input, ppu_viewport: selection };
    expect(ajv.validate(definition.inputSchema, bad)).toBe(false);
    expect(
      (await client.callTool({ name: "trace_nes_code", arguments: bad }))
        .isError,
    ).toBe(true);
  }
  const parsed = toolContract("trace_nes_code").outputSchema.parse(evidence),
    code = parsed.normalized_result.code_trace;
  if (
    code.status !== "derived" ||
    code.mapper_trace.status !== "derived" ||
    !("ppu_trace" in code.mapper_trace) ||
    code.mapper_trace.ppu_trace.viewport === null
  )
    throw new Error("Missing schema viewport");
  const viewport = code.mapper_trace.ppu_trace.viewport,
    validate = ajv.compile(definition.outputSchema as Record<string, unknown>),
    first = viewport.modes[0]!.pixel_states[0]!;
  const original = first.code_mask;
  first.code_mask = "0000000000000000";
  expect(validate(parsed)).toBe(false);
  first.code_mask = original;
  viewport.palette_cells[0]!.address = 1;
  expect(validate(parsed)).toBe(false);
  viewport.palette_cells[0]!.address = 0;
  const ref = viewport.modes[0]!.rows[0]![0]!;
  viewport.modes[0]!.rows[0]![0] = 61440;
  expect(validate(parsed)).toBe(false);
  viewport.modes[0]!.rows[0]![0] = ref;
  const stopped = await call(
      "trace_nes_code",
      { ...input, max_oam_dma_source_bytes: 0 },
      false,
    ),
    limited =
      toolContract("trace_nes_code").outputSchema.parse(stopped)
        .normalized_result.code_trace;
  if (
    limited.status !== "derived" ||
    limited.mapper_trace.status !== "derived" ||
    !("ppu_trace" in limited.mapper_trace) ||
    limited.mapper_trace.ppu_trace.viewport === null
  )
    throw new Error("Missing budget viewport");
  expect(limited.stop.reason).toBe("oam-dma-source-budget");
  expect(limited.mapper_trace.ppu_trace.final.oam!.cells).toEqual({});
  expect(
    limited.mapper_trace.ppu_trace.viewport.modes[0]!.coverage
      .ambiguous_palette_pixels,
  ).toBeGreaterThan(0);
  const initial =
    toolContract("trace_nes_code").inputSchema.parse(input).initial_ppu;
  if (initial === null) throw new Error("Missing blanking input");
  const blanked = await call(
      "trace_nes_mapper_events",
      {
        path: input.path,
        initial: input.initial,
        ppu_viewport: input.ppu_viewport,
        initial_ppu: {
          ...initial,
          mask: { mask: 254, value: 0 },
          v: { low: 20, high: 63 },
          palette: { 4: 3 },
        },
        events: [],
      },
      false,
    ),
    blank = toolContract("trace_nes_mapper_events").outputSchema.parse(blanked)
      .normalized_result.trace;
  if (
    blank.status !== "derived" ||
    !("ppu_trace" in blank) ||
    blank.ppu_trace.viewport === null
  )
    throw new Error("Missing blanking result");
  expect(blank.ppu_trace.viewport.modes[0]!.pixel_states).toEqual([
    {
      palette_mask: 16,
      code_mask: "0000000000000009",
      layers: 8,
      front_sprites: "0000000000000000",
      visible_sprites: "0000000000000000",
    },
  ]);
}

cliTest(
  "retains a complete viewport plus all graphics facets and 512 CHR pages under the default MCP budget",
  async () => {
    const root = await createTestTempDirectory("rea-viewport-capacity-"),
      fixture = nesPpuFixture([], { mapper: 4, chrSize: 524288 }),
      path = join(root, "vrc4.nes");
    fixture.bytes[6] = 84;
    fixture.bytes[7] = 24;
    fixture.bytes[8] = 16;
    for (let bank = 0; bank < 512; bank++)
      for (let tile = 0; tile < 64; tile++) {
        const base = fixture.chrOffset + bank * 1024 + tile * 16,
          pixel = [1, 2, 3][bank % 3]!;
        fixture.bytes.fill(pixel & 1 ? 255 : 0, base, base + 8);
        fixture.bytes.fill(pixel & 2 ? 255 : 0, base + 8, base + 16);
      }
    await writeFile(path, fixture.bytes);
    const connection = createStdioToolClient("viewport-oracle"),
      { transport, client } = connection;
    try {
      await client.connect(transport);
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
            mask: 30,
            oam: { model: "oam-memory", retention: "stable" },
          }),
          ppu_viewport: {
            model: "frozen-viewport",
            origin_x: 507,
            origin_y: 477,
          },
          ppu_pattern_table: 1,
          ppu_nametable: 0,
          ppu_sprites: true,
          events: [],
        },
      });
      expect(
        response.isError,
        response.isError ? JSON.stringify(response) : undefined,
      ).not.toBe(true);
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
        trace.ppu_trace.viewport === null
      )
        throw new Error("Missing capacity viewport");
      const viewport = trace.ppu_trace.viewport;
      expect(viewport.chr_source_pages).toHaveLength(512);
      expect(viewport.chr_blocks).toHaveLength(8);
      expect(viewport.unresolved_chr_blocks).toBe(8);
      expect(viewport.modes.map((mode) => mode.sprite_height)).toEqual([8, 16]);
      for (const mode of viewport.modes) {
        expect(mode.rows).toHaveLength(240);
        expect(mode.rows.every((row) => row.length === 256)).toBe(true);
        expect(mode.coverage).toEqual({
          examined_pixels: 61440,
          ambiguous_palette_pixels: 61440,
          ambiguous_code_pixels: 0,
          unknown_code_pixels: 61440,
        });
        for (let y = 0; y < 240; y++)
          for (let x = 0; x < 256; x++)
            expect(mode.pixel_states[mode.rows[y]![x]!]!).toMatchObject({
              palette_mask: y === 0 ? 61166 : 268431086,
              layers: y === 0 ? 2 : 6,
              front_sprites: y === 0 ? "0000000000000000" : "ffffffffffffffff",
              visible_sprites:
                y === 0 ? "0000000000000000" : "ffffffffffffffff",
            });
      }
      for (const page of viewport.chr_source_pages) {
        if (page.kind !== "rom") throw new Error("Missing ROM source");
        expect(page.bytes_hex).toBe(
          fixture.bytes
            .subarray(page.file_offset, page.file_offset + 1024)
            .toString("hex"),
        );
      }
      expect(await readFile(path)).toEqual(fixture.bytes);
    } finally {
      await connection.close();
    }
  },
  180000,
);
