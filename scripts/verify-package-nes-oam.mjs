import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed CLI OAM/DMA and sprite oracle; no source fixtures or helpers. */
export async function verifyPackageNesOam(invoke, workspace, profile) {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 0xea);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 1, 0, 8]);
  const start = 249,
    page = 0x85;
  bytes.set(
    [169, start, 141, 3, 32, 169, page, 141, 20, 64, 234, 173, 4, 32, 96],
    16 + 256,
  );
  for (let offset = 0; offset < 256; offset++)
    bytes[16 + 1280 + offset] = (offset * 31 + 7) & 255;
  bytes.writeUInt16LE(0x8100, 16 + 32768 - 4);
  for (let offset = 0; offset < 8192; offset++)
    bytes[16 + 32768 + offset] = (offset * 19 + (offset >> 4) * 11) & 255;
  const path = join(workspace, "packaged-oam-rom.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    initial: { mapper: 0 },
    initial_ppu: {
      ...profile,
      next_event_index: 800,
      oam: {
        model: "oam-memory",
        retention: "stable",
        reads: "supported",
        dma_pending: { status: "none" },
      },
    },
  };
  const evidence = await invoke("trace-nes-code", input),
    code = evidence.normalized_result.code_trace;
  assert.equal(code.status, "derived");
  assert.equal(code.stop.reason, "return");
  assert.equal(code.final_cpu.a, 7);
  const transfer = code.instructions.find(
    (instruction) => instruction.oam_dma_reads,
  );
  assert.equal(transfer.mnemonic, "NOP");
  assert.deepEqual(transfer.data_reads, []);
  assert.equal(transfer.oam_dma_reads.length, 256);
  for (const [offset, read] of transfer.oam_dma_reads.entries()) {
    assert.equal(read.address, 0x8500 + offset);
    assert.equal(read.file_offset, 16 + 1280 + offset);
    assert.equal(read.value, bytes[read.file_offset]);
    assert.deepEqual(read.ram_origins, []);
  }
  const mapped = code.mapper_trace,
    ppu = mapped.ppu_trace;
  assert.equal(mapped.status, "derived");
  for (let address = 0; address < 256; address++)
    assert.deepEqual(ppu.final.oam.cells[address], {
      value:
        bytes[16 + 1280 + ((address - start) & 255)] &
        (address % 4 === 2 ? 227 : 255),
      origin: { kind: "dma-write", index: 802, address, start_address: start },
    });
  assert.equal(ppu.final.oam.address, start);
  assert.deepEqual(ppu.final.oam.dma_pending, { status: "none" });
  assert.equal(ppu.final.next_event_index, 804);
  assert.deepEqual(
    ppu.operations.find((operation) => operation.kind === "oam-dma").write,
    {
      status: "written",
      range: { space: "oam", start: 0, size: 256 },
      invalidated_spaces: [],
      reason: null,
    },
  );
  const replay = await invoke("trace-nes-mapper-events", {
    ...input,
    events: mapped.steps.map((step) => step.event),
  });
  assert.deepEqual(replay.normalized_result.trace, mapped);
  const explored = await invoke("explore-nes-code", input);
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    code,
  );
  const continued = await invoke("trace-nes-mapper-events", {
    path,
    initial: mapped.final,
    initial_ppu: ppu.final,
    events: [{ kind: "cpu-read", address: 0x2004 }],
  });
  assert.equal(continued.normalized_result.trace.steps[0].cpu_read.value, 7);
  assert.equal(
    continued.normalized_result.trace.ppu_trace.final.next_event_index,
    805,
  );
  const limited = await invoke("trace-nes-code", {
    ...input,
    max_oam_dma_source_bytes: 0,
  });
  const stopped = limited.normalized_result.code_trace;
  assert.equal(stopped.stop.reason, "oam-dma-source-budget");
  assert.deepEqual(stopped.stop.oam_dma_frontier.reads, []);
  assert.equal(stopped.stop.address, 0x810a);
  assert.deepEqual(stopped.mapper_trace.ppu_trace.final.oam.cells, {});
  assert.deepEqual(stopped.mapper_trace.ppu_trace.final.oam.dma_pending, {
    status: "pending",
    page,
  });
  assert.equal(stopped.mapper_trace.ppu_trace.final.next_event_index, 802);
  assert.equal(limited.parameters.max_oam_dma_source_bytes, 0);
  const unqualified = await invoke("trace-nes-mapper-events", {
    ...input,
    initial_ppu: {
      ...input.initial_ppu,
      oam: { ...input.initial_ppu.oam, retention: "unobserved" },
    },
    events: mapped.steps.map((step) => step.event),
  });
  assert.deepEqual(
    unqualified.normalized_result.trace.ppu_trace.final.oam.cells,
    {},
  );
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.deepEqual(await readFile(path), bytes);
  await verifySprites(invoke, input, bytes);
}

async function verifySprites(invoke, base, bytes) {
  for (const height of [8, 16]) {
    const input = {
      ...base,
      ppu_sprites: true,
      initial_ppu: {
        ...base.initial_ppu,
        control: height === 8 ? 8 : 32,
        mask: height === 8 ? 0 : 1,
        palette: { 17: 46 },
      },
    };
    const evidence = await invoke("trace-nes-code", input),
      code = evidence.normalized_result.code_trace;
    assert.equal(code.status, "derived");
    const mapped = code.mapper_trace,
      sprites = mapped.ppu_trace.sprites;
    assert.equal(sprites.sprites.length, 64);
    for (const [index, sprite] of sprites.sprites.entries()) {
      const raw = (delta) =>
          bytes[16 + 1280 + ((index * 4 + delta - 249) & 255)],
        tile = raw(1),
        attributes = raw(2) & 227,
        table = height === 8 ? 1 : tile & 1,
        first = height === 8 ? tile : tile & 254;
      assert.equal(sprite.y, raw(0));
      assert.equal(sprite.x, raw(3));
      assert.equal(sprite.tile_index, tile);
      assert.equal(sprite.attributes, attributes);
      assert.deepEqual(sprite.top_rows, [raw(0) + 1]);
      assert.equal(sprite.offscreen_y, raw(0) >= 239);
      assert.equal(sprite.subpalette, attributes & 3);
      const mode = sprite.modes[0];
      assert.equal(sprite.modes.length, 1);
      assert.equal(mode.height, height);
      assert.deepEqual(mode.pattern_tables, [table]);
      assert.deepEqual(mode.first_tiles, [first]);
      for (let y = 0; y < height; y++)
        for (let x = 0; x < 8; x++) {
          const sourceY = attributes & 128 ? height - 1 - y : y,
            sourceX = attributes & 64 ? 7 - x : x,
            address =
              16 +
              32768 +
              table * 4096 +
              (first + Math.floor(sourceY / 8)) * 16 +
              (sourceY % 8);
          assert.equal(
            mode.rows[y][x],
            ((bytes[address] >> (7 - sourceX)) & 1) |
              (((bytes[address + 8] >> (7 - sourceX)) & 1) << 1),
          );
        }
    }
    for (const source of sprites.source_pages) {
      assert.equal(source.kind, "rom");
      assert.equal(
        source.bytes_hex,
        bytes
          .subarray(source.file_offset, source.file_offset + 1024)
          .toString("hex"),
      );
    }
    assert.equal(
      sprites.scanline_selection.interpretation,
      "frozen-oam-0-first-eight",
    );
    assert.equal(sprites.scanline_selection.modes.length, 1);
    const selection = sprites.scanline_selection.modes[0];
    assert.equal(selection.height, height);
    assert.equal(selection.lines.length, 240);
    for (const line of selection.lines) {
      const eligible = Array.from({ length: 64 }, (_, sprite) => ({
        sprite,
        row: line.y - bytes[16 + 1280 + ((sprite * 4 - 249) & 255)] - 1,
      })).filter(({ row }) => row >= 0 && row < height);
      assert.deepEqual(
        selection.candidate_sets[line.candidate_set],
        eligible.map(({ sprite, row }, slot) => ({
          sprite,
          row_mask: 2 ** row,
          selection: slot < 8 ? "definite" : "excluded",
          slots: slot < 8 ? [slot, slot] : null,
        })),
      );
      assert.deepEqual(line.in_range, {
        minimum: eligible.length,
        maximum: eligible.length,
      });
      assert.deepEqual(line.selected, {
        minimum: Math.min(8, eligible.length),
        maximum: Math.min(8, eligible.length),
      });
      assert.deepEqual(line.excess, {
        minimum: Math.max(0, eligible.length - 8),
        maximum: Math.max(0, eligible.length - 8),
      });
    }
    assert.deepEqual(sprites.palettes[0].cells, [null, 0, 1, 2]);
    assert.deepEqual(sprites.palette_cells[0], {
      address: 17,
      value: 46,
      code: height === 8 ? 46 : 32,
    });
    const replay = await invoke("trace-nes-mapper-events", {
      ...input,
      events: mapped.steps.map((step) => step.event),
    });
    assert.deepEqual(replay.normalized_result.trace, mapped);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      code,
    );
    const continued = await invoke("trace-nes-mapper-events", {
      path: input.path,
      initial: mapped.final,
      initial_ppu: mapped.ppu_trace.final,
      ppu_sprites: true,
      events: [],
    });
    assert.deepEqual(
      continued.normalized_result.trace.ppu_trace.sprites,
      sprites,
    );
    assert.equal(
      continued.normalized_result.trace.ppu_trace.final.next_event_index,
      mapped.ppu_trace.final.next_event_index,
    );
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
  }
  assert.deepEqual(await readFile(base.path), bytes);
}
