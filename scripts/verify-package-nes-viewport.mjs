import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed whole-viewport oracle; imports no source fixtures/models. */
export async function verifyPackageNesViewport(invoke, workspace) {
  const prg = 16,
    chr = prg + 32768,
    bytes = Buffer.alloc(chr + 8192);
  bytes.set([78, 69, 83, 26, 2, 1, 8, 8]);
  bytes.set(
    [
      169, 253, 141, 3, 32, 169, 133, 141, 20, 64, 234, 165, 16, 141, 0, 32,
      165, 17, 141, 1, 32, 96,
    ],
    prg + 256,
  );
  bytes.writeUInt16LE(0x8100, prg + 32768 - 4);
  const oam = [];
  for (let index = 0; index < 64; index++)
    oam.push(
      index < 14
        ? 23
        : index === 62
          ? 238
          : index === 63
            ? 255
            : (index * 11 + 17) % 239,
      (index * 9 + 7) & 255,
      (index & 3) | ((index * 37) & 224),
      index === 60 ? 255 : (index * 23 + 2) & 255,
    );
  for (let address = 0; address < 256; address++)
    bytes[prg + 1280 + ((address - 253) & 255)] =
      oam[address] | (address % 4 === 2 ? 28 : 0);
  for (let offset = 0; offset < 8192; offset++)
    bytes[chr + offset] = (offset * 17 + (offset >> 5) * 11) & 255;
  const nametable = {},
    palette = {};
  for (let page = 0; page < 4; page++) {
    for (let y = 0; y < 30; y++)
      for (let x = 0; x < 32; x++)
        nametable[page * 1024 + y * 32 + x] =
          (page * 61 + y * 7 + x * 19) & 255;
    for (let index = 0; index < 64; index++)
      nametable[page * 1024 + 960 + index] = (index * 31 + page * 37) & 255;
  }
  const addresses = Array.from({ length: 32 }, (_, address) => address).filter(
    (address) => ![16, 20, 24, 28].includes(address),
  );
  for (const address of addresses) palette[address] = (address * 5 + 13) & 63;
  const path = join(workspace, "packaged-frozen-viewport.nes");
  await writeFile(path, bytes);
  for (const [control, mask] of [
    [0, 30],
    [48, 31],
  ]) {
    const input = {
      path,
      initial: { mapper: 0 },
      initial_ram: [
        { address: 16, value: control },
        { address: 17, value: mask },
      ],
      ppu_viewport: { model: "frozen-viewport", origin_x: 319, origin_y: 359 },
      initial_ppu: {
        model: "ppu-memory",
        register_writes_enabled: true,
        access_phase: "non-rendering",
        dma_reads: "absent",
        chr_ram_size: null,
        nametable_layout: "four-screen-4k",
        control: 0,
        mask: 0,
        v: { low: 0, high: 32 },
        nametable,
        palette,
        oam: {
          model: "oam-memory",
          retention: "stable",
          address_writes: "uncorrupted",
          dma_pending: { status: "none" },
        },
      },
    };
    const evidence = await invoke("trace-nes-code", input),
      code = evidence.normalized_result.code_trace;
    assert.equal(code.status, "derived");
    assert.equal(code.stop.reason, "return");
    const mapped = code.mapper_trace,
      ppu = mapped.ppu_trace;
    assert.equal(ppu.final.control, control);
    assert.equal(ppu.final.mask, mask);
    for (const instruction of code.instructions)
      for (const [index, offset] of instruction.file_offsets.entries())
        assert.equal(
          parseInt(instruction.bytes_hex.slice(index * 2, index * 2 + 2), 16),
          bytes[offset],
        );
    const transfer = code.instructions.find(
      (instruction) => instruction.oam_dma_reads,
    );
    assert.equal(transfer.oam_dma_reads.length, 256);
    for (const [offset, read] of transfer.oam_dma_reads.entries()) {
      assert.equal(read.file_offset, prg + 1280 + offset);
      assert.equal(read.value, bytes[read.file_offset]);
      assert.deepEqual(read.ram_origins, []);
    }
    for (let address = 0; address < 256; address++)
      assert.equal(ppu.final.oam.cells[address].value, oam[address]);
    verifyViewport(ppu.viewport, {
      bytes,
      chr,
      nametable,
      palette,
      oam,
      addresses,
      control,
      mask,
    });
    const replay = await invoke("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      initial_ppu: input.initial_ppu,
      ppu_viewport: input.ppu_viewport,
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
      ppu_viewport: input.ppu_viewport,
      events: [],
    });
    assert.deepEqual(
      continued.normalized_result.trace.ppu_trace.viewport,
      ppu.viewport,
    );
    assert.equal(
      continued.normalized_result.trace.ppu_trace.final.next_event_index,
      ppu.final.next_event_index,
    );
    assert.equal(
      evidence.subject.digest.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(await readFile(path), bytes);
  }
  return {
    workflows: 2,
    conditional_frozen_viewport: true,
    original_unchanged: true,
  };
}

function verifyViewport(viewport, facts) {
  assert.equal(viewport.interpretation, "frozen-viewport-envelope");
  assert.equal(viewport.origin_x, 319);
  assert.equal(viewport.origin_y, 359);
  assert.deepEqual(
    viewport.palette_cells.map((cell) => cell.address),
    facts.addresses,
  );
  assert.equal(viewport.modes.length, 1);
  const mode = viewport.modes[0],
    height = facts.control & 32 ? 16 : 8;
  assert.equal(mode.sprite_height, height);
  const bit = (value) => (1n << BigInt(value)).toString(16).padStart(16, "0");
  for (let y = 0; y < 240; y++) {
    const nominees = Array.from({ length: 64 }, (_, index) => index)
      .filter(
        (index) =>
          y > facts.oam[index * 4] && y <= facts.oam[index * 4] + height,
      )
      .slice(0, 8);
    for (let x = 0; x < 256; x++) {
      const ax = (319 + x) % 512,
        ay = (359 + y) % 480,
        page = Math.floor(ax / 256) + Math.floor(ay / 240) * 2,
        cx = Math.floor((ax % 256) / 8),
        cy = Math.floor((ay % 240) / 8),
        tile = facts.nametable[page * 1024 + cy * 32 + cx],
        attribute =
          facts.nametable[
            page * 1024 + 960 + Math.floor(cy / 4) * 8 + Math.floor(cx / 4)
          ],
        sub =
          (attribute >>
            (2 * ((Math.floor(cy / 2) % 2) * 2 + (Math.floor(cx / 2) % 2)))) &
          3,
        bg = pattern(facts, facts.control & 16 ? 1 : 0, tile, ax % 8, ay % 8);
      let address = bg ? sub * 4 + bg : 0,
        layer = bg ? 2 : 1,
        front = null,
        visible = null;
      for (const index of nominees) {
        const base = index * 4,
          dx = x - facts.oam[base + 3];
        if (dx < 0 || dx > 7) continue;
        const attr = facts.oam[base + 2],
          raw = facts.oam[base + 1],
          dy = y - facts.oam[base] - 1,
          sy = attr & 128 ? height - 1 - dy : dy,
          sx = attr & 64 ? 7 - dx : dx,
          sp = pattern(
            facts,
            height === 8 ? (facts.control & 8 ? 1 : 0) : raw & 1,
            height === 8 ? raw : (raw & 254) + Math.floor(sy / 8),
            sx,
            sy % 8,
          );
        if (!sp) continue;
        front = index;
        if (!bg || !(attr & 32)) {
          visible = index;
          address = 16 + (attr & 3) * 4 + sp;
          layer = 4;
        }
        break;
      }
      const rawCode = facts.palette[address],
        code = facts.mask & 1 ? rawCode & 48 : rawCode,
        state = mode.pixel_states[mode.rows[y][x]];
      assert.deepEqual(state, {
        palette_mask: 1 << facts.addresses.indexOf(address),
        code_mask: bit(code),
        layers: layer,
        front_sprites: front === null ? "0000000000000000" : bit(front),
        visible_sprites: visible === null ? "0000000000000000" : bit(visible),
      });
    }
  }
  assert.deepEqual(mode.coverage, {
    examined_pixels: 61440,
    ambiguous_palette_pixels: 0,
    ambiguous_code_pixels: 0,
    unknown_code_pixels: 0,
  });
  for (const block of viewport.chr_blocks)
    assert.deepEqual(
      block.sources.map(
        (index) => viewport.chr_source_pages[index].file_offset,
      ),
      [facts.chr + block.ppu_address],
    );
  for (const page of viewport.chr_source_pages)
    assert.equal(
      page.bytes_hex,
      facts.bytes
        .subarray(page.file_offset, page.file_offset + 1024)
        .toString("hex"),
    );
  assert.deepEqual(
    viewport.nametables.map((page) => page.source_pages),
    [[0], [1024], [2048], [3072]],
  );
}
function pattern(facts, table, tile, x, y) {
  const offset = facts.chr + table * 4096 + tile * 16 + y;
  return (
    ((facts.bytes[offset] >> (7 - x)) & 1) |
    (((facts.bytes[offset + 8] >> (7 - x)) & 1) << 1)
  );
}
