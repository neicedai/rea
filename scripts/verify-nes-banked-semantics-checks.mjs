import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  checkDiscoveryCoverage,
  checkDiscoveryWitnesses,
  nodesAt,
  stateOf,
} from "./verify-package-nes-discovery-graph.mjs";

export function graphSources(graph, bytes, prgBytes) {
  assert.equal(graph.status, "derived");
  checkDiscoveryCoverage(graph, bytes, 16, prgBytes);
  checkDiscoveryWitnesses(graph);
}

export function novaSound(graph) {
  const binding = graph.continuations.find(
    (item) => graph.nodes[item.call_node_index].address === 0xc2bb,
  );
  assert.ok(binding, "Original bank6 call binds the real serial setter");
  for (const [address, value] of [
    [0xca5d, 6],
    [0xca61, 3],
    [0xca65, 1],
    [0xca69, 0],
    [0xca6d, 0],
  ]) {
    const writes = graph.data_references.filter(
      (item) =>
        item.kind === "mapper-write" &&
        item.address === 0xe000 &&
        graph.nodes[item.node_index].address === address &&
        graph.nodes[item.node_index].invocation_index ===
          binding.callee_invocation_index,
    );
    assert.ok(writes.length > 0);
    assert.ok(writes.every((write) => write.value === value));
  }
  const calls = graph.edges.filter(
    (edge) => graph.nodes[edge.from].address === 0xc2be && edge.kind === "call",
  );
  assert.ok(
    calls.length > 0,
    "Matched setter returns reach the original JSR8000",
  );
  for (const edge of calls) {
    assert.equal(edge.target_address, 0x8000);
    assert.notEqual(edge.to, null);
    const target = graph.nodes[edge.to];
    assert.equal(target.file_offsets[0], 98320);
    assert.equal(stateOf(graph, target).prg_bank, 6);
    assert.equal(stateOf(graph, target).prg_mode, 3);
  }
}

export function novaControl(graph) {
  const resets = graph.data_references.filter(
    (item) =>
      graph.nodes[item.node_index].address === 0xca39 &&
      item.kind === "mapper-write",
  );
  assert.ok(
    resets.some((item) => item.address === 0x8000 && item.value === 0x80),
  );
  const binding = graph.continuations.find(
    (item) => graph.nodes[item.call_node_index].address === 0xca3e,
  );
  assert.ok(binding);
  for (const [address, value] of [
    [0xca7e, 14],
    [0xca82, 7],
    [0xca86, 3],
    [0xca8a, 1],
    [0xca8e, 0],
  ]) {
    const writes = graph.data_references.filter(
      (item) =>
        graph.nodes[item.node_index].address === address &&
        graph.nodes[item.node_index].invocation_index ===
          binding.callee_invocation_index &&
        item.kind === "mapper-write",
    );
    assert.ok(
      writes.some((item) => item.address === 0x8000 && item.value === value),
    );
  }
  const final = nodesAt(graph, 0xca52);
  assert.ok(final.length > 0);
  for (const node of final) {
    const state = stateOf(graph, node);
    assert.equal(state.prg_mode, 3);
    assert.equal(state.chr_mode, 0);
    assert.equal(state.mirroring, 2);
    assert.equal(state.chr_bank_0, 0);
    assert.deepEqual(state.shift_bits, []);
    const mapping = graph.contexts[node.context_index].mapping;
    assert.equal(mapping.mirroring, "vertical");
    assert.equal(mapping.chr_source, "ram-unobserved");
  }
}

export function novaRam(trace, bytes, disabled) {
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.address, 0xcabf);
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.sp, 255);
  for (const instruction of trace.instructions)
    assert.equal(
      Buffer.from(
        instruction.file_offsets.map((offset) => bytes[offset]),
      ).toString("hex"),
      instruction.bytes_hex,
    );
  const writes = trace.instructions.flatMap((instruction) =>
    instruction.writes
      .filter((write) => write.address === 0x7fff)
      .map((write) => ({ instruction, write })),
  );
  assert.deepEqual(
    writes.map(({ instruction, write }) => [instruction.address, write.value]),
    [
      [0xcaa8, 0x65],
      [0xcab2, 2],
    ],
  );
  const serial = trace.mapper_trace.steps;
  assert.equal(serial.length, 10);
  assert.equal(serial[4].state.chr_bank_0, 12);
  assert.equal(serial[9].state.chr_bank_0, 0);
  assert.ok(
    serial.every((step) => step.state.prg_ram_disable_bit === disabled),
  );
  const load = trace.instructions.find(
    (instruction) => instruction.address === 0xcaba,
  );
  assert.ok(load);
  assert.equal(load.data_reads.length, 1);
  const read = load.data_reads[0];
  assert.equal(read.address, 0x7fff);
  assert.equal(read.file_offset, null);
  if (disabled === 0) {
    assert.equal(
      read.value,
      0x65,
      "CHR register12 selects a distinct bank3; its02 write cannot replace bank0's65",
    );
    assert.deepEqual(read.ram_origins, [
      {
        byte_index: 0,
        region: "prg-ram",
        bank: 0,
        ram_address: 0x7fff,
        instruction_index: writes[0].instruction.index,
        write_index: 0,
      },
    ]);
    assert.equal(trace.final_cpu.a, 0x65);
    assert.equal(trace.final_cpu.c, true);
    assert.equal(trace.final_cpu.z, true);
  } else {
    assert.equal(read.value, null);
    assert.deepEqual(read.ram_origins, []);
    assert.equal(trace.final_cpu.a, null);
    assert.equal(trace.final_cpu.c, null);
  }
}

export function novaRamBankQuery(trace) {
  assert.equal(trace.status, "derived");
  assert.equal(trace.instructions[0].address, 0xcaba);
  assert.equal(trace.instructions[0].bytes_hex, "adff7f");
  assert.deepEqual(
    trace.instructions[0].file_offsets,
    [248522, 248523, 248524],
  );
  assert.equal(trace.instructions[0].data_reads.length, 1);
  const read = trace.instructions[0].data_reads[0];
  assert.equal(read.address, 0x7fff);
  assert.equal(read.value, 0xa3);
  assert.equal(read.file_offset, null);
  assert.deepEqual(read.ram_origins, [
    {
      byte_index: 0,
      region: "prg-ram",
      ram_address: 0x7fff,
      bank: 3,
      initial_prg_ram_index: 3,
    },
  ]);
  assert.equal(trace.final_cpu.a, 0xa3);
  assert.equal(trace.final_cpu.z, false);
}

export function mmc3Initializer(graph) {
  for (const [call, selector, bank] of [
    [0xe067, 0x86, 0],
    [0xe06c, 0x87, 13],
  ]) {
    const binding = graph.continuations.find(
      (item) => graph.nodes[item.call_node_index].address === call,
    );
    assert.ok(binding);
    const writes = graph.data_references.filter(
      (item) =>
        item.kind === "mapper-write" &&
        graph.nodes[item.node_index].invocation_index ===
          binding.callee_invocation_index,
    );
    assert.ok(
      writes.some((item) => item.address === 0x8000 && item.value === selector),
    );
    assert.ok(
      writes.some((item) => item.address === 0x8001 && item.value === bank),
    );
    const branchAddress = call === 0xe067 ? 0xe10d : 0xe117,
      branches = graph.edges.filter(
        (edge) =>
          graph.nodes[edge.from].address === branchAddress &&
          graph.nodes[edge.from].invocation_index ===
            binding.callee_invocation_index,
      );
    assert.ok(branches.length > 0);
    assert.ok(
      branches.every(
        (edge) =>
          edge.kind === "branch-taken" && edge.target_address === 0xe11c,
      ),
    );
    assert.ok(
      branches.every(
        (edge) => edge.condition.flag === "z" && edge.condition.value === false,
      ),
    );
  }
  const resumed = nodesAt(graph, 0xe06f);
  assert.ok(resumed.length > 0);
  for (const node of resumed) {
    const state = stateOf(graph, node),
      mapping = graph.contexts[node.context_index].mapping;
    assert.equal(state.banks[6], 0);
    assert.equal(state.banks[7], 13);
    assert.deepEqual(
      mapping.prg_windows.map((window) => [
        window.start,
        window.bank,
        window.file_offset,
      ]),
      [
        [0x8000, 0, 16],
        [0xa000, 13, 106512],
        [0xc000, 14, 114704],
        [0xe000, 15, 122896],
      ],
    );
  }
}

export function chrPage(report, bytes, page) {
  const chr = report.chr,
    offset = 131088 + page * 4096;
  assert.equal(chr.status, "rom");
  assert.equal(chr.page, page);
  assert.equal(chr.total_pages, 32);
  assert.deepEqual(chr.location, { offset, size: 4096 });
  assert.equal(
    chr.bytes_hex,
    bytes.subarray(offset, offset + 4096).toString("hex"),
  );
  assert.equal(chr.palette, null);
  assert.equal(chr.ppu_mapping, "unknown");
  assert.equal(chr.tiles.length, 256);
  for (const [index, tile] of chr.tiles.entries()) {
    assert.equal(tile.index, page * 256 + index);
    assert.equal(tile.file_offset, offset + index * 16);
    for (let row = 0; row < 8; row++)
      for (let x = 0; x < 8; x++) {
        const bit = 7 - x,
          expected =
            ((bytes[tile.file_offset + row] >> bit) & 1) +
            2 * ((bytes[tile.file_offset + row + 8] >> bit) & 1);
        assert.equal(Number(tile.rows[row][x]), expected);
      }
  }
  return Buffer.from(chr.bytes_hex, "hex");
}

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
