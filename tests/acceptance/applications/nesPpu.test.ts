import { createStdioToolClient } from "../../support/cliMcpDelivery.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  nesPpuFixture,
  nesPpuFixtureState,
  nesPpuUploadFixture,
  nesPpuNametableUploadFixture,
  nesOamUploadFixture,
} from "../../../src/domain/nesPpu.fixture.js";
import {
  nesMapperEventsTraceSchema,
  nesMapperEventSnapshot,
} from "../../../src/domain/nesMapperEvents.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import type { NesPpuNametable } from "../../../src/domain/nesPpuNametable.js";
import type { NesCodePath } from "../../../src/domain/nesCodeTrace.js";
import { fme7Fixture } from "../../../src/domain/nesFme7.fixture.js";

const names = [
  "trace_nes_mapper_events",
  "trace_nes_code",
  "explore_nes_code",
] as const;
type Name = (typeof names)[number];
const schemas = new Map<
  Name,
  { input: (value: unknown) => boolean; output: (value: unknown) => boolean }
>();
const connection = createStdioToolClient("nes-ppu-memory");
const { client, transport } = connection;
beforeAll(async () => {
  await client.connect(transport);
  const tools = (await client.listTools()).tools;
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  for (const name of names) {
    const definition = tools.find((tool) => tool.name === name);
    if (!definition?.outputSchema) throw new Error(`Missing schemas: ${name}`);
    const input: Record<string, unknown> = definition.inputSchema,
      output: Record<string, unknown> = definition.outputSchema;
    schemas.set(name, {
      input: ajv.compile(input),
      output: ajv.compile(output),
    });
  }
}, 120_000);
afterAll(async () => {
  await connection.close();
});

cliTest(
  "decodes switched and uncertain CHR sources through bounded public pattern-table reports",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ppu-pattern-");
    for (const mapper of [4, 21] as const) {
      const banks = mapper === 4 ? 256 : 512,
        fixture = nesPpuFixture([], { mapper: 4, chrSize: banks * 1024 });
      if (mapper === 21) {
        fixture.bytes[6] = 0x54;
        fixture.bytes[7] = 0x18;
        fixture.bytes[8] = 0x10;
      }
      for (let bank = 0; bank < banks; bank++) {
        const start = fixture.chrOffset + bank * 1024;
        fixture.bytes.fill(0, start, start + 16);
        fixture.bytes[start] = bank & 1 ? 0x81 : 0xc1;
        fixture.bytes[start + 8] = 0x60;
      }
      const path = join(root, `${mapper}-pattern.nes`);
      await writeFile(path, fixture.bytes);
      const input = {
        path,
        initial:
          mapper === 4
            ? { mapper: 4, bank_select: 128 }
            : { mapper: 21, variant: "vrc4" },
        initial_ppu: nesPpuFixtureState({
          chr_ram_size: null,
          next_event_index: 700,
        }),
        ppu_pattern_table: 0,
        events:
          mapper === 4
            ? [
                { kind: "cpu-write", address: 0x8000, value: 0x82 },
                { kind: "cpu-write", address: 0x8001, value: 5 },
              ]
            : [],
      };
      expect(
        schemas
          .get("trace_nes_mapper_events")!
          .input({ ...input, ppu_pattern_table: 2 }),
      ).toBe(false);
      const evidence = await both(cli, root, "trace_nes_mapper_events", input);
      const parsed = toolContract("trace_nes_mapper_events").outputSchema.parse(
          evidence,
        ),
        trace = parsed.normalized_result.trace;
      if (
        trace.status !== "derived" ||
        !("ppu_trace" in trace) ||
        !("pattern_table" in trace.ppu_trace)
      )
        throw new Error("Missing pattern table");
      const pattern = trace.ppu_trace.pattern_table;
      expect(pattern.source_pages).toHaveLength(banks);
      expect(pattern.blocks.map((block) => block.sources.length)).toEqual(
        mapper === 4 ? [1, banks, banks, banks] : [banks, banks, banks, banks],
      );
      expect(pattern.coverage.unresolved_source_blocks).toBe(
        mapper === 4 ? 3 : 4,
      );
      expect(pattern.tiles[64]!.rows[0]).toEqual([
        1,
        { mask: 2, value: 2 },
        2,
        0,
        0,
        0,
        0,
        1,
      ]);
      if (mapper === 4)
        expect(pattern.tiles[0]!.rows[0]).toEqual([1, 2, 2, 0, 0, 0, 0, 1]);
      for (const source of pattern.source_pages) {
        if (source.kind !== "rom") throw new Error("Expected ROM source");
        expect(source.bytes_hex).toBe(
          fixture.bytes
            .subarray(source.file_offset, source.file_offset + 1024)
            .toString("hex"),
        );
      }
      expect(trace.ppu_trace.operations).toEqual([]);
      expect(trace.ppu_trace.coverage.bus_reads).toBe(0);
      expect(trace.ppu_trace.final.next_event_index).toBe(
        700 + input.events.length,
      );
      expect(evidence.subject?.digest?.sha256).toBe(
        createHash("sha256").update(fixture.bytes).digest("hex"),
      );
      expect(await readFile(path)).toEqual(fixture.bytes);
      pattern.tiles[0]!.rows[0]![0] = { mask: 1, value: 2 };
      expect(schemas.get("trace_nes_mapper_events")!.output(parsed)).toBe(
        false,
      );
    }
  },
  120_000,
);

const verifyNametableGeometry = (
  map: NesPpuNametable,
  memory: Record<number, number>,
  base: number,
) => {
  const expected = new Map<
    number,
    { attribute: number; quadrant: number; palette: number }
  >();
  for (let row = 0; row < 8; row++)
    for (let column = 0; column < 8; column++) {
      const attribute = row * 8 + column,
        byte = memory[base + 960 + attribute]!;
      for (let dy = 0; dy < 2; dy++)
        for (let dx = 0; dx < 2; dx++)
          for (
            let y = row * 4 + dy * 2;
            y < Math.min(30, row * 4 + dy * 2 + 2);
            y++
          )
            for (
              let x = column * 4 + dx * 2;
              x < column * 4 + dx * 2 + 2;
              x++
            ) {
              const quadrant = dy * 2 + dx;
              expected.set(y * 32 + x, {
                attribute,
                quadrant,
                palette: Math.floor(byte / 4 ** quadrant) % 4,
              });
            }
    }
  expect(map.cells.map((cell) => cell.y * 32 + cell.x)).toEqual(
    Array.from({ length: 960 }, (_, index) => index),
  );
  for (const cell of map.cells) {
    const offset = cell.y * 32 + cell.x,
      proof = expected.get(offset)!;
    expect(cell.tile_index).toBe(memory[base + offset]);
    expect({ attribute: cell.attribute, quadrant: cell.quadrant }).toEqual({
      attribute: proof.attribute,
      quadrant: proof.quadrant,
    });
    expect(map.attributes[cell.attribute]!.quadrants[cell.quadrant]).toEqual({
      value: proof.palette,
      choices: [proof.palette],
    });
  }
};

cliTest(
  "joins source-uploaded background tile, attribute, palette and pattern origins through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ppu-map-upload-"),
      fixture = nesPpuNametableUploadFixture(),
      path = join(root, "map-upload.nes");
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: { mapper: 0 },
      initial_ppu: fixture.initial_ppu,
      ppu_pattern_table: 1,
      ppu_nametable: 1,
    };
    const evidence = await both(cli, root, "trace_nes_code", input);
    const code =
      toolContract("trace_nes_code").outputSchema.parse(evidence)
        .normalized_result.code_trace;
    if (code.status !== "derived") throw new Error(code.reason);
    const mapped = nesMapperEventsTraceSchema.parse(code.mapper_trace);
    if (
      mapped.status !== "derived" ||
      !("ppu_trace" in mapped) ||
      !("nametable" in mapped.ppu_trace) ||
      !("pattern_table" in mapped.ppu_trace)
    )
      throw new Error("Missing graphics");
    const ppu = mapped.ppu_trace;
    expect(ppu.nametable.source_pages).toEqual([0]);
    expect(
      ppu.nametable.cells.slice(0, 2).map((cell) => cell.tile_index),
    ).toEqual([18, 52]);
    expect(ppu.nametable.pattern_tables).toEqual([1]);
    expect(
      ppu.nametable.attributes[0]!.quadrants.map((quadrant) => quadrant.value),
    ).toEqual([0, 1, 2, 3]);
    expect(ppu.pattern_table.tiles[18]!.rows[0]).toEqual([
      1, 2, 0, 0, 0, 0, 0, 0,
    ]);
    const selector = ppu.nametable.attributes[0]!.quadrants[0]!.choices[0]!,
      paletteIndex = ppu.nametable.palettes[selector]!.cells[1]!;
    expect(ppu.nametable.palette_cells[paletteIndex]).toEqual({
      address: 1,
      value: 41,
      code: 41,
    });
    expect(ppu.final.nametable[0]).toEqual({
      value: 18,
      origin: { kind: "event-write", index: 502 },
    });
    expect(ppu.final.nametable[960]).toEqual({
      value: 228,
      origin: { kind: "event-write", index: 506 },
    });
    expect(ppu.final.palette[1]).toEqual({
      value: 41,
      origin: { kind: "event-write", index: 509 },
    });
    expect(ppu.final.next_event_index).toBe(510);
    for (const instruction of code.instructions) {
      const bytes = Buffer.from(instruction.bytes_hex, "hex");
      for (const [index, offset] of instruction.file_offsets.entries()) {
        if (offset === null) throw new Error("Expected ROM instruction byte");
        expect(fixture.bytes[offset]).toBe(bytes[index]);
      }
    }
    const replay = await both(cli, root, "trace_nes_mapper_events", {
      ...input,
      events: mapped.steps.map((step) => step.event),
    });
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(replay)
        .normalized_result.trace,
    ).toEqual(mapped);
    const explored = await both(cli, root, "explore_nes_code", input);
    expect(
      toolContract("explore_nes_code").outputSchema.parse(explored)
        .normalized_result.code_exploration,
    ).toMatchObject({ paths: [{ trace: code }] });
    const continued = await both(cli, root, "trace_nes_mapper_events", {
      ...input,
      initial: mapped.final,
      initial_ppu: ppu.final,
      events: [],
    });
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(continued)
        .normalized_result.trace,
    ).toMatchObject({
      ppu_trace: { nametable: ppu.nametable, final: { next_event_index: 510 } },
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
    expect(evidence.subject?.digest?.sha256).toBe(
      createHash("sha256").update(fixture.bytes).digest("hex"),
    );
  },
  120_000,
);

cliTest(
  "decodes complete background geometry, exact mirror alternatives and unavailable memory over CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ppu-map-grid-"),
      fixture = nesPpuFixture([], { mapper: 4 }),
      path = join(root, "grid.nes");
    await writeFile(path, fixture.bytes);
    const memory: Record<number, number> = {};
    for (let page = 0; page < 2; page++) {
      for (let index = 0; index < 960; index++)
        memory[page * 1024 + index] = (index * 7 + page * 61) & 255;
      for (let index = 0; index < 64; index++)
        memory[page * 1024 + 960 + index] =
          index === 0 ? page * 3 : (index * 29 + 228) & 255;
    }
    for (const mode of ["unknown", "vertical", "missing"]) {
      const input = {
        path,
        initial: { mapper: 4 },
        initial_ppu: nesPpuFixtureState({
          control: 16,
          mask: null,
          nametable_layout: mode === "missing" ? null : "ciram-2k",
          nametable: mode === "missing" ? {} : memory,
          palette: { 0: 15, 1: 45, 4: 63 },
        }),
        ppu_nametable: 1,
        events:
          mode === "vertical"
            ? [
                { kind: "cpu-write", address: 0xa000, value: 1 },
                { kind: "cpu-write", address: 0xa000, value: 0 },
              ]
            : [],
      };
      expect(
        schemas
          .get("trace_nes_mapper_events")!
          .input({ ...input, ppu_nametable: 4 }),
      ).toBe(false);
      const evidence = await both(cli, root, "trace_nes_mapper_events", input),
        parsed = toolContract("trace_nes_mapper_events").outputSchema.parse(
          evidence,
        ),
        trace = parsed.normalized_result.trace;
      if (
        trace.status !== "derived" ||
        !("ppu_trace" in trace) ||
        !("nametable" in trace.ppu_trace)
      )
        throw new Error("Missing map");
      const map = trace.ppu_trace.nametable;
      expect(map.pattern_tables).toEqual([1]);
      expect(map.palette_cells[1]).toEqual({
        address: 1,
        value: 45,
        code: { mask: 50, value: 32 },
      });
      expect(map.palettes.every((palette) => palette.cells[0] === 0)).toBe(
        true,
      );
      if (mode === "vertical") {
        expect(map.source_pages).toEqual([1024]);
        verifyNametableGeometry(map, memory, 1024);
        expect(map.coverage.unknown_tile_indices).toBe(0);
      } else if (mode === "unknown") {
        expect(map.source_pages).toEqual([0, 1024]);
        expect(map.attributes[0]!.quadrants[0]).toEqual({
          value: null,
          choices: [0, 3],
        });
      } else {
        expect(map.source_pages).toEqual([]);
        expect(map.reason).toBe("unknown-nametable-wiring");
        expect(map.coverage.unknown_tile_indices).toBe(960);
      }
      expect(trace.ppu_trace.operations).toEqual([]);
      expect(trace.ppu_trace.coverage.bus_reads).toBe(0);
      expect(trace.ppu_trace.final.next_event_index).toBe(input.events.length);
      map.palette_cells[1]!.code = { mask: 16, value: 1 };
      expect(schemas.get("trace_nes_mapper_events")!.output(parsed)).toBe(
        false,
      );
    }
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  120_000,
);

const verifyOamUpload = (
  code: NesCodePath,
  fixture: ReturnType<typeof nesOamUploadFixture>,
  viaRam: boolean,
  start: number,
) => {
  const mapped = nesMapperEventsTraceSchema.parse(code.mapper_trace);
  if (mapped.status !== "derived" || !("ppu_trace" in mapped))
    throw new Error("Missing OAM trace");
  expect(code.final_cpu.a).toBe(5);
  const transfer = code.instructions.find(
    (instruction) => "oam_dma_reads" in instruction,
  );
  if (transfer === undefined || !("oam_dma_reads" in transfer))
    throw new Error("Missing DMA proof");
  expect(transfer.mnemonic).toBe("NOP");
  expect(transfer.data_reads).toEqual([]);
  for (const [offset, read] of transfer.oam_dma_reads.entries()) {
    const fileOffset = fixture.prgOffset + 512 + offset;
    expect(read.value).toBe(fixture.bytes[fileOffset]);
    expect(read.address).toBe((viaRam ? 512 : 0x8200) + offset);
    if (viaRam) {
      const origin = read.ram_origins[0];
      if (origin === undefined || !("instruction_index" in origin))
        throw new Error("Missing RAM writer");
      expect(origin.instruction_index).toBe(2 + offset * 4);
      expect(
        code.instructions[origin.instruction_index]!.writes[origin.write_index]!
          .value,
      ).toBe(read.value);
      expect(
        code.instructions[origin.instruction_index - 1]!.data_reads[0],
      ).toMatchObject({ value: read.value, file_offset: fileOffset });
      expect(read.file_offset).toBeNull();
    } else {
      expect(read.file_offset).toBe(fileOffset);
      expect(read.ram_origins).toEqual([]);
    }
  }
  for (let address = 0; address < 256; address++)
    expect(mapped.ppu_trace.final.oam!.cells[address]).toEqual({
      value:
        fixture.values[(address - start) & 255]! &
        (address % 4 === 2 ? 227 : 255),
      origin: { kind: "dma-write", index: 102, address, start_address: start },
    });
  const operation = mapped.ppu_trace.operations.find(
    (operation) => operation.kind === "oam-dma",
  );
  if (operation === undefined || !("oam" in operation.before))
    throw new Error("Missing DMA operation");
  expect("cells" in operation.before.oam).toBe(false);
  expect(operation.write).toEqual({
    status: "written",
    range: { space: "oam", start: 0, size: 256 },
    invalidated_spaces: [],
    reason: null,
  });
  expect(mapped.ppu_trace.final.oam!.dma_pending).toEqual({ status: "none" });
  expect(mapped.ppu_trace.final.next_event_index).toBe(104);
  expect(mapped.ppu_trace.frontier).toEqual([]);
  return mapped;
};

cliTest(
  "derives RAM and ROM OAM DMA uploads with per-byte origins, replay and continuation over CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-oam-upload-");
    for (const viaRam of [true, false]) {
      const start = viaRam ? 0 : 253,
        fixture = nesOamUploadFixture({ viaRam, startAddress: start }),
        path = join(root, `${viaRam ? "ram" : "rom"}.nes`);
      await writeFile(path, fixture.bytes);
      const input = {
        path,
        initial: { mapper: 0 },
        initial_ppu: fixture.initial_ppu,
        max_instructions: 1100,
      };
      const evidence = await both(cli, root, "trace_nes_code", input),
        code =
          toolContract("trace_nes_code").outputSchema.parse(evidence)
            .normalized_result.code_trace;
      if (code.status !== "derived") throw new Error(code.reason);
      const mapped = verifyOamUpload(code, fixture, viaRam, start);
      const replay = await both(cli, root, "trace_nes_mapper_events", {
        path,
        initial: input.initial,
        initial_ppu: input.initial_ppu,
        events: mapped.steps.map((step) => step.event),
      });
      expect(
        toolContract("trace_nes_mapper_events").outputSchema.parse(replay)
          .normalized_result.trace,
      ).toEqual(mapped);
      const explored = await both(cli, root, "explore_nes_code", input);
      expect(
        toolContract("explore_nes_code").outputSchema.parse(explored)
          .normalized_result.code_exploration,
      ).toMatchObject({ paths: [{ trace: code }] });
      const continued = await both(cli, root, "trace_nes_mapper_events", {
        path,
        initial: mapped.final,
        initial_ppu: mapped.ppu_trace.final,
        events: [{ kind: "cpu-read", address: 0x2004 }],
      });
      expect(
        toolContract("trace_nes_mapper_events").outputSchema.parse(continued)
          .normalized_result.trace,
      ).toMatchObject({
        steps: [{ cpu_read: { value: 5 } }],
        ppu_trace: { final: { next_event_index: 105 } },
      });
      expect(await readFile(path)).toEqual(fixture.bytes);
      expect(evidence.subject?.digest?.sha256).toBe(
        createHash("sha256").update(fixture.bytes).digest("hex"),
      );
    }
  },
  150_000,
);

cliTest(
  "keeps OAM qualification and budget frontiers explicit through advertised schemas",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-oam-qualification-"),
      fixture = nesOamUploadFixture({ viaRam: false }),
      path = join(root, "qualifications.nes");
    await writeFile(path, fixture.bytes);
    const base = {
      path,
      initial: { mapper: 0 },
      initial_ppu: fixture.initial_ppu,
    };
    const limited = await both(cli, root, "trace_nes_code", {
      ...base,
      max_oam_dma_source_bytes: 0,
    });
    expect(
      toolContract("trace_nes_code").outputSchema.parse(limited)
        .normalized_result.code_trace,
    ).toMatchObject({
      stop: {
        reason: "oam-dma-source-budget",
        oam_dma_frontier: {
          reads: [],
          available_source_bytes: 0,
          retained_source_bytes: 0,
        },
      },
      mapper_trace: {
        ppu_trace: {
          final: {
            oam: { cells: {}, dma_pending: { status: "pending", page: 130 } },
          },
        },
      },
    });
    const values = Array.from(
      { length: 256 },
      (_, index) => (index * 7 + 9) & 255,
    );
    const packetInput = {
      ...base,
      initial_ppu: {
        ...fixture.initial_ppu,
        oam: { ...fixture.initial_ppu.oam!, address: 0 },
      },
      events: [
        { kind: "cpu-write", address: 0x4014, value: 1 },
        { kind: "cpu-write", address: 0x4014, value: 2 },
        { kind: "oam-dma", page: 2, values },
        { kind: "cpu-read", address: 0x2004 },
      ],
    };
    const packet = await both(
      cli,
      root,
      "trace_nes_mapper_events",
      packetInput,
    );
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(packet)
        .normalized_result.trace,
    ).toMatchObject({
      steps: [{}, {}, {}, { cpu_read: { value: 9 } }],
      ppu_trace: {
        final: {
          oam: {
            cells: {
              0: {
                value: 9,
                origin: {
                  kind: "dma-write",
                  index: 102,
                  address: 0,
                  start_address: 0,
                },
              },
            },
          },
        },
      },
    });
    const bad = {
      ...packetInput,
      events: [{ kind: "oam-dma", page: 2, values: values.slice(0, 255) }],
    };
    expect(schemas.get("trace_nes_mapper_events")!.input(bad)).toBe(false);
    expect(
      (
        await client.callTool({
          name: "trace_nes_mapper_events",
          arguments: bad,
        })
      ).isError,
    ).toBe(true);
    const wired = await both(cli, root, "trace_nes_mapper_events", {
      ...base,
      initial_ppu: {
        ...fixture.initial_ppu,
        oam: {
          ...fixture.initial_ppu.oam!,
          address: 2,
          retention: "unobserved",
          cells: { 2: 227 },
        },
      },
      events: [{ kind: "cpu-read", address: 0x2004 }],
    });
    const parsed = toolContract("trace_nes_mapper_events").outputSchema.parse(
        wired,
      ),
      trace = parsed.normalized_result.trace;
    if (trace.status !== "derived" || !("ppu_trace" in trace))
      throw new Error("Missing wiring proof");
    expect(trace.steps[0]).toMatchObject({
      cpu_read: { value: null, known_bits: { mask: 28, value: 0 } },
    });
    const operation = trace.ppu_trace.operations[0];
    if (operation?.kind !== "cpu-port" || operation.read === null)
      throw new Error("Missing OAM read");
    const wire = operation.read.alternatives
      .flatMap((alternative) => alternative.sources)
      .find((source) => source.kind === "oam-attribute-zeroes");
    if (wire === undefined) throw new Error("Missing scoped zero-bit proof");
    wire.addresses[0] = 1;
    expect(schemas.get("trace_nes_mapper_events")!.output(parsed)).toBe(false);
  },
  120_000,
);

cliTest(
  "retains every origin of a 64-bank cartridge RAM DMA within the default MCP message budget",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-oam-capacity-"),
      fixture = fme7Fixture("fme7", 13),
      path = join(root, "64-banks.nes");
    fixture.bytes.set(
      [0xa9, 0x60, 0x8d, 0x14, 0x40, 0xea, 0xad, 4, 0x20, 0x60],
      528 + 7 * 8192 + 256,
    );
    await writeFile(path, fixture.bytes);
    const initial_prg_ram = Array.from({ length: 64 }, (_, bank) =>
      Array.from({ length: 256 }, (_, offset) => ({
        bank,
        address: 0x6000 + offset,
        value: (offset * 13 + 5) & 255,
      })),
    ).flat();
    const initial_ppu = nesPpuFixtureState({
      chr_ram_size: null,
      oam: {
        model: "oam-memory",
        retention: "stable",
        reads: "supported",
        address: 0,
        dma_pending: { status: "none" },
      },
    });
    const evidence = await both(cli, root, "trace_nes_code", {
      path,
      initial: {
        ...fixture.initial,
        bank_6000: { mask: 64, value: 64 },
        prg_ram_enable: "ungated",
      },
      initial_ppu,
      initial_prg_ram,
    });
    const code =
      toolContract("trace_nes_code").outputSchema.parse(evidence)
        .normalized_result.code_trace;
    if (code.status !== "derived") throw new Error(code.reason);
    expect(code.stop.reason).toBe("return");
    const packet = code.instructions.find(
      (instruction) => "oam_dma_reads" in instruction,
    );
    if (packet === undefined || !("oam_dma_reads" in packet))
      throw new Error("Missing capacity proof");
    for (const [offset, read] of packet.oam_dma_reads.entries()) {
      expect(read.ram_origins).toHaveLength(64);
      for (const [bank, origin] of read.ram_origins.entries())
        expect(origin).toEqual({
          byte_index: 0,
          region: "prg-ram",
          bank,
          ram_address: 0x6000 + offset,
          initial_prg_ram_index: bank * 256 + offset,
        });
    }
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  120_000,
);

cliTest(
  "shares the DMA source budget across real explored branch prefixes without committing partial uploads",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-oam-branch-budget-"),
      fixture = nesPpuFixture([
        0xa9, 2, 0x2c, 0x16, 0x40, 0x8d, 0x14, 0x40, 0xf0, 8, 0xa9, 0xaa, 0x8d,
        4, 0x20, 0x4c, 0x17, 0xc1, 0xa9, 0xbb, 0x8d, 4, 0x20, 0x60,
      ]),
      path = join(root, "branches.nes");
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: { mapper: 0 },
      initial_ppu: nesPpuFixtureState({
        oam: {
          model: "oam-memory",
          retention: "stable",
          reads: "supported",
          address: 0,
          dma_pending: { status: "none" },
        },
      }),
      initial_ram: Array.from({ length: 256 }, (_, offset) => ({
        address: 512 + offset,
        value: (offset * 13 + 5) & 255,
      })),
    };
    const first = await both(cli, root, "trace_nes_code", input),
      prefix =
        toolContract("trace_nes_code").outputSchema.parse(first)
          .normalized_result.code_trace;
    if (prefix.status !== "derived" || !("oam_dma_reads" in prefix.stop))
      throw new Error("Missing prefix DMA");
    const budget =
      Buffer.byteLength(JSON.stringify(prefix.stop.oam_dma_reads), "utf8") -
      2 +
      500;
    const explored = await both(cli, root, "explore_nes_code", {
        ...input,
        max_oam_dma_source_bytes: budget,
      }),
      result =
        toolContract("explore_nes_code").outputSchema.parse(explored)
          .normalized_result.code_exploration;
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.termination).toBe("oam-dma-source-budget");
    expect(result.paths).toHaveLength(2);
    expect(result.paths).toMatchObject([
      {
        index: 0,
        parent_index: null,
        branch_choices: [],
        trace: { stop: { reason: "unknown-branch", address: 49416 } },
      },
      {
        index: 1,
        parent_index: 0,
        branch_choices: [{ address: 49416, taken: false }],
        trace: {
          stop: {
            reason: "oam-dma-source-budget",
            address: 49416,
            oam_dma_frontier: { page: 2, available_source_bytes: 500 },
          },
        },
      },
    ]);
    // Replayed prefixes consume the global budget; its frontier leaves the sibling pending.
    expect(result.pending_paths).toEqual([
      {
        parent_index: 0,
        branch_choices: [{ address: 49416, taken: true }],
      },
    ]);
    let used = 0;
    for (const path of result.paths) {
      if (path.trace.status !== "derived") throw new Error(path.trace.reason);
      const arrays = path.trace.instructions.flatMap((instruction) =>
        "oam_dma_reads" in instruction ? [instruction.oam_dma_reads] : [],
      );
      if ("oam_dma_reads" in path.trace.stop)
        arrays.push(path.trace.stop.oam_dma_reads);
      if ("oam_dma_frontier" in path.trace.stop) {
        const frontier = path.trace.stop.oam_dma_frontier;
        expect(frontier.available_source_bytes).toBe(500);
        expect(frontier.retained_source_bytes).toBe(
          frontier.reads.length === 0
            ? 0
            : Buffer.byteLength(JSON.stringify(frontier.reads), "utf8") - 2,
        );
        arrays.push(path.trace.stop.oam_dma_frontier.reads);
      }
      for (const reads of arrays)
        if (reads.length !== 0)
          used += Buffer.byteLength(JSON.stringify(reads), "utf8") - 2;
      const mapped = path.trace.mapper_trace;
      if (
        mapped.status !== "derived" ||
        !("ppu_trace" in mapped) ||
        mapped.ppu_trace.final.oam === null
      )
        throw new Error("Missing branch OAM state");
      expect(mapped.ppu_trace.final.oam.cells).toEqual({});
      expect(mapped.ppu_trace.final.oam.dma_pending).toEqual({
        status: "pending",
        page: 2,
      });
    }
    expect(used).toBeLessThanOrEqual(budget);
    expect(explored.parameters).toMatchObject({
      max_oam_dma_source_bytes: budget,
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  120_000,
);

async function both(
  cli: TestCli,
  root: string,
  name: Name,
  input: Record<string, unknown>,
) {
  const schema = schemas.get(name)!;
  expect(schema.input(input)).toBe(true);
  const request = join(root, `${name}-request.json`);
  await writeFile(request, JSON.stringify(input));
  const result = await cli.run({
    arguments: [name.replaceAll("_", "-"), request, "--json"],
    timeoutMs: 90_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  const response = await client.callTool(
    { name, arguments: input },
    { timeout: 90_000 },
  );
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  expect(schema.output(response.structuredContent)).toBe(true);
  const contract = toolContract(name),
    a = contract.outputSchema.parse(result.json),
    b = contract.outputSchema.parse(response.structuredContent);
  expect(a.evidence_id).toBe(b.evidence_id);
  expect(a.normalized_result).toEqual(b.normalized_result);
  return b;
}

cliTest(
  "traces ROM-to-CHR RAM uploads with event provenance, continuation and exploration over CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ppu-source-");
    const fixture = nesPpuUploadFixture(),
      path = join(root, "upload.nes");
    await writeFile(path, fixture.bytes);
    const initial_ppu = nesPpuFixtureState({ next_event_index: 17 });
    const input = {
      path,
      initial: { mapper: 0 },
      initial_ppu,
      ppu_pattern_table: 0,
    };
    const evidence = await both(cli, root, "trace_nes_code", input);
    const trace =
      toolContract("trace_nes_code").outputSchema.parse(evidence)
        .normalized_result.code_trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    const mapped = nesMapperEventsTraceSchema.parse(trace.mapper_trace);
    if (mapped.status !== "derived" || !("ppu_trace" in mapped))
      throw new Error("Missing PPU model");
    expect(trace.stop.reason).toBe("return");
    expect(trace.final_cpu.a).toBe(fixture.values[1]);
    expect(mapped.ppu_trace.frontier).toEqual([]);
    if (!("pattern_table" in mapped.ppu_trace))
      throw new Error("Missing pattern table");
    const pattern = mapped.ppu_trace.pattern_table;
    expect(pattern.tiles[0]!.byte_values).toEqual([
      ...fixture.values,
      ...Array(12).fill(null),
    ]);
    expect(pattern.tiles[0]!.rows[0]).toEqual(
      [1, 0, 1, 0, 0, 1, 0, 1].map((value) => ({ mask: 1, value })),
    );
    expect(pattern.coverage).toEqual({
      examined_tiles: 256,
      unresolved_source_blocks: 0,
      unknown_bytes: 4092,
      partial_bytes: 0,
      unknown_pixels: 16352,
      partial_pixels: 32,
    });
    for (const instruction of trace.instructions) {
      const bytes = Buffer.from(instruction.bytes_hex, "hex");
      for (const [index, offset] of instruction.file_offsets.entries())
        expect(fixture.bytes[offset!]).toBe(bytes[index]);
      for (const read of instruction.data_reads) {
        if (read.file_offset !== null)
          expect(read.value).toBe(fixture.bytes[read.file_offset]);
        if (read.address === 0x2007) expect(read.file_offset).toBeNull();
        for (const origin of read.mapper_origins)
          if (origin.kind === "ppu-register")
            for (const alternative of origin.alternatives)
              for (const source of alternative.sources)
                if (
                  source.kind === "memory" &&
                  source.origin?.kind === "event-write"
                ) {
                  const index =
                    source.origin.index - initial_ppu.next_event_index;
                  expect(mapped.steps[index]!.event).toMatchObject({
                    kind: "cpu-write",
                    address: 0x2007,
                    value: source.value,
                  });
                  expect(
                    trace.instructions.some(
                      (i) =>
                        "mapper_event_range" in i &&
                        i.mapper_event_range.start <= index &&
                        index <
                          i.mapper_event_range.start +
                            i.mapper_event_range.count,
                    ),
                  ).toBe(true);
                }
      }
    }
    const replay = await both(cli, root, "trace_nes_mapper_events", {
      ...input,
      events: mapped.steps.map((step) => step.event),
    });
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(replay)
        .normalized_result.trace,
    ).toEqual(mapped);
    const explored = await both(cli, root, "explore_nes_code", input);
    expect(
      toolContract("explore_nes_code").outputSchema.parse(explored)
        .normalized_result.code_exploration,
    ).toMatchObject({ paths: [{ trace }] });
    const resumed = await both(cli, root, "trace_nes_mapper_events", {
      path,
      initial: mapped.final,
      initial_ppu: mapped.ppu_trace.final,
      events: [{ kind: "cpu-read", address: 0x200f }],
    });
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(resumed)
        .normalized_result.trace,
    ).toMatchObject({ steps: [{ cpu_read: { value: fixture.values[2] } }] });
    expect(evidence.subject?.digest?.sha256).toBe(
      createHash("sha256").update(fixture.bytes).digest("hex"),
    );
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  120_000,
);

cliTest(
  "retains an 8 KiB external-bus upload through public schemas without repeated memory snapshots",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ppu-capacity-");
    const fixture = nesPpuFixture(),
      path = join(root, "8k.nes");
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: { mapper: 0 },
      initial_ppu: nesPpuFixtureState({ next_event_index: 100 }),
      max_steps: 8192,
      ppu_pattern_table: 1,
      ppu_nametable: 0,
      events: Array.from({ length: 8192 }, (_, address) => ({
        kind: "ppu-write",
        address,
        value: ((address * 23) ^ (address >> 3)) & 255,
      })),
    };
    const evidence = await both(cli, root, "trace_nes_mapper_events", input);
    const result = toolContract("trace_nes_mapper_events").outputSchema.parse(
      evidence,
    ).normalized_result.trace;
    if (result.status !== "derived" || !("ppu_trace" in result))
      throw new Error("Missing PPU model");
    expect(result.mapper_snapshots).toHaveLength(1);
    expect(result.steps.every((step) => step.mapper_snapshot === 0)).toBe(true);
    expect(result.ppu_trace.final.next_event_index).toBe(8292);
    if (!("pattern_table" in result.ppu_trace))
      throw new Error("Missing pattern table");
    const pattern = result.ppu_trace.pattern_table;
    if (!("nametable" in result.ppu_trace))
      throw new Error("Missing background map");
    expect(result.ppu_trace.nametable.coverage.unknown_tile_indices).toBe(960);
    expect(pattern.source_pages).toEqual(
      [4096, 5120, 6144, 7168].map((address) => ({ kind: "chr-ram", address })),
    );
    expect(pattern.coverage).toEqual({
      examined_tiles: 256,
      unresolved_source_blocks: 0,
      unknown_bytes: 0,
      partial_bytes: 0,
      unknown_pixels: 0,
      partial_pixels: 0,
    });
    for (const tile of pattern.tiles) {
      const bytes = Array.from({ length: 16 }, (_, offset) => {
        const address = tile.ppu_address + offset;
        return ((address * 23) ^ (address >> 3)) & 255;
      });
      expect(tile.byte_values).toEqual(bytes);
      expect(tile.rows).toEqual(
        Array.from({ length: 8 }, (_, y) =>
          Array.from(
            { length: 8 },
            (_, x) =>
              ((bytes[y]! >> (7 - x)) & 1) +
              2 * ((bytes[y + 8]! >> (7 - x)) & 1),
          ),
        ),
      );
    }
    expect(Object.keys(result.ppu_trace.final.chr_ram)).toHaveLength(8192);
    for (let address = 0; address < 8192; address++)
      expect(result.ppu_trace.final.chr_ram[String(address)]).toEqual({
        value: ((address * 23) ^ (address >> 3)) & 255,
        origin: { kind: "event-write", index: 100 + address },
      });
    expect(
      result.ppu_trace.operations.every(
        (op) => op.kind === "ppu-bus" && !("before" in op) && !("after" in op),
      ),
    ).toBe(true);
    expect(result.final_mapping).toMatchObject({
      chr_source: "ram-assumed",
      chr_windows: [
        { bank: 0, file_offset: null },
        { bank: 1, file_offset: null },
      ],
    });
    const rejected = await client.callTool({
      name: "trace_nes_mapper_events",
      arguments: { ...input, max_steps: 8191 },
    });
    expect(rejected.isError).toBe(true);
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  120_000,
);

cliTest(
  "authenticates CHR buffer reads before MMC2 latches and rejects invalid PPU snapshots",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ppu-chr-");
    const fixture = nesPpuFixture([0x60], { mapper: 9, chrSize: 32768 }),
      path = join(root, "latch.nes");
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: {
        mapper: 9,
        prg_bank: 0,
        latch_0: "fe",
        chr_fd_0: 2,
        chr_fe_0: 3,
      },
      initial_ppu: nesPpuFixtureState({
        chr_ram_size: null,
        v: { low: 216, high: 15 },
        read_buffer: { value: 0x11 },
      }),
      events: [
        { kind: "cpu-read", address: 0x2007 },
        { kind: "cpu-read", address: 0x2007 },
      ],
    };
    const evidence = await both(cli, root, "trace_nes_mapper_events", input);
    const trace = toolContract("trace_nes_mapper_events").outputSchema.parse(
      evidence,
    ).normalized_result.trace;
    if (trace.status !== "derived" || !("ppu_trace" in trace))
      throw new Error("Missing PPU model");
    for (const [index, bank] of [3, 2].entries()) {
      const offset = fixture.chrOffset + bank * 4096 + 0xfd8 + index;
      expect(trace.ppu_trace.operations[index]!.bus_reads[0]).toMatchObject({
        bank,
        file_offset: offset,
        value: fixture.bytes[offset],
      });
    }
    expect(nesMapperEventSnapshot(trace, trace.steps[0]!)!.state).toMatchObject(
      { latch_0: "fd" },
    );
    const schema = schemas.get("trace_nes_mapper_events")!;
    for (const invalid of [
      { palette: { "16": 1 } },
      { palette: { "0": 64 } },
      { v: { high: 128 } },
      { chr_ram: { "8192": 1 } },
    ]) {
      const request = {
        ...input,
        initial_ppu: { ...input.initial_ppu, ...invalid },
      };
      expect(schema.input(request)).toBe(false);
      expect(
        (
          await client.callTool({
            name: "trace_nes_mapper_events",
            arguments: request,
          })
        ).isError,
      ).toBe(true);
    }
    const changed = await client.callTool({
      name: "trace_nes_mapper_events",
      arguments: {
        ...input,
        initial_ppu: {
          ...trace.ppu_trace.final,
          read_buffer: {
            value: 1,
            sources: [
              {
                kind: "rom",
                file_offset: fixture.chrOffset,
                value: 1,
                mask: 255,
              },
            ],
          },
        },
      },
    });
    expect(changed.isError).not.toBe(true);
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(
        changed.structuredContent,
      ).normalized_result.trace,
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("authenticated"),
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  90_000,
);

cliTest(
  "preserves nametable aliases, palette overlay and shadow buffer through CLI/MCP",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-ppu-nametable-");
    const fixture = nesPpuFixture([0x60], { mapper: 4 }),
      path = join(root, "nametable.nes");
    await writeFile(path, fixture.bytes);
    const input = {
      path,
      initial: { mapper: 4 },
      initial_ppu: nesPpuFixtureState({
        v: { low: 16, high: 63 },
        mask: 1,
        io_latch: { value: 0xc0 },
        palette: { "0": 0x21 },
        nametable: { "0": 0xa5, "1024": 0xbb, "1808": 0x77 },
      }),
      events: [
        { kind: "ppu-read", address: 0x2000 },
        { kind: "ppu-read", address: 0x2c00 },
        { kind: "ppu-read", address: 0x2400 },
        { kind: "cpu-read", address: 0x2007 },
      ],
    };
    const evidence = await both(cli, root, "trace_nes_mapper_events", input);
    const trace = toolContract("trace_nes_mapper_events").outputSchema.parse(
      evidence,
    ).normalized_result.trace;
    if (trace.status !== "derived" || !("ppu_trace" in trace))
      throw new Error("Missing PPU model");
    expect(trace.steps).toMatchObject([
      { read_source: { value: 0xa5, bank: 0 } },
      { read_source: { value: 0xbb, bank: 1 } },
      { read_source: { value: null, known_bits: { mask: 225, value: 161 } } },
      { cpu_read: { value: 0xe0 } },
    ]);
    expect(trace.ppu_trace.final.read_buffer.value).toBe(0x77);
    expect(
      trace.ppu_trace.operations
        .slice(0, 3)
        .every((op) => op.kind === "ppu-bus"),
    ).toBe(true);
    expect(trace.ppu_trace.operations[3]).toMatchObject({
      kind: "cpu-port",
      after: { read_buffer: 0x77 },
    });
    const unqualified = await both(cli, root, "trace_nes_mapper_events", {
      ...input,
      initial_ppu: {
        ...input.initial_ppu,
        palette_read_mode: null,
        read_buffer: { value: 0xe0 },
      },
      events: [{ kind: "cpu-read", address: 0x2007 }],
    });
    expect(
      toolContract("trace_nes_mapper_events").outputSchema.parse(unqualified)
        .normalized_result.trace,
    ).toMatchObject({
      steps: [
        { cpu_read: { value: null, known_bits: { mask: 192, value: 192 } } },
      ],
    });
    expect(await readFile(path)).toEqual(fixture.bytes);
  },
  90_000,
);
