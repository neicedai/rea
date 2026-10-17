import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
} from "./nesCodeDiscovery.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";

async function derive(program: readonly number[], callee?: readonly number[]) {
  const fixture = nesCodeFixture(4, program);
  if (callee !== undefined)
    fixture.bytes.set(callee, fixture.programOffset + 0x100);
  const parsed = parseNesHeader(fixture.bytes);
  assert.ok(parsed.ok);
  const header = parsed.value,
    graph = nesCodeDiscoverySchema.parse(
      await discoverNesCode(
        header,
        fixture.bytes.subarray(
          header.prgRom.offset,
          header.prgRom.offset + header.prgRom.size,
        ),
        discoverNesCodeInputSchema.parse({
          path: "/ram-provenance.nes",
          initial: {
            mapper: 4,
            bank_select: 6,
            banks: [0, 2, 4, 5, 6, 7, 0, 1],
          },
          roots: [fixture.entry],
          max_work_items: 128,
        }),
      ),
    );
  if (graph.status !== "derived") throw Error(graph.reason);
  return graph;
}
const bitmap = (values: readonly number[]) =>
  values
    .reduce((bits, value) => bits | (1n << BigInt(value)), 0n)
    .toString(16)
    .padStart(64, "0");

describe("RAM current-value provenance validation", () => {
  it("keeps an unknown actual store separate from a later conditional domain with the same bit envelope", async () => {
    // The initial STA writes all 256 bytes. BEQ's fallthrough excludes only 0;
    // after LDA #42, the repeated RAM load still has 255 values and no known bits.
    const graph = await derive([
      0xad, 0, 0x20, 0x85, 0x10, 0xc9, 0, 0xf0, 4, 0xa9, 0x42, 0xa5, 0x10, 0x02,
    ]);
    const witness = graph.write_witnesses.find(
      (item) => graph.nodes[item.node_index]?.address === 0xe003,
    );
    assert.ok(witness);
    expect(witness.value).toBeNull();
    expect(graph.byte_domains[witness.domain_index]?.count).toBe(256);
    const constrained = graph.byte_domains.find(
      (domain) =>
        domain.bitmap_hex ===
        bitmap(Array.from({ length: 255 }, (_, value) => value + 1)),
    );
    assert.ok(constrained);
    const corrupt = structuredClone(graph);
    corrupt.write_witnesses[witness.index]!.domain_index = constrained.index;
    // The common-bit value remains null, so value-only comparison misses this.
    expect(corrupt.write_witnesses[witness.index]!.value).toBeNull();
    expect(nesCodeDiscoverySchema.safeParse(corrupt).success).toBe(false);
  });

  it("rejects replacing an RMW operand read by its later written byte", async () => {
    const graph = await derive([
      0xa9, 1, 0x85, 0x10, 0xe6, 0x10, 0xa5, 0x10, 0x02,
    ]);
    const read = graph.data_references.find(
      (item) =>
        graph.nodes[item.node_index]?.address === 0xe004 &&
        item.kind === "read",
    );
    assert.ok(read);
    expect(read.value).toBe(1);
    const after = graph.byte_domains.find(
      (domain) => domain.bitmap_hex === bitmap([2]),
    );
    assert.ok(after);
    const corrupt = structuredClone(graph),
      forged = corrupt.data_references[read.index]!;
    forged.value = 2;
    assert.equal(forged.ram_origins.length, 1);
    forged.ram_origins[0]!.domain_index = after.index;
    expect(nesCodeDiscoverySchema.safeParse(corrupt).success).toBe(false);
  });

  it("accepts a physical return conditioned from an unknown actual writer without rewriting that writer", async () => {
    const graph = await derive(
      [0xa2, 0xfd, 0x9a, 0x20, 0, 0xe1, 0x02],
      [
        0xad,
        0,
        0x20, // unknown device byte
        0x8d,
        0xfc,
        1, // overwrite the actual low return slot
        0xad,
        0xfc,
        1,
        0xc9,
        5,
        0xd0,
        3, // only low=5 reaches the RTS
        0xa9,
        0x42,
        0x60,
        0x02,
      ],
    );
    const summary = graph.return_summaries.find(
      (item) => item.stack_target === 0xe006,
    );
    assert.ok(summary);
    expect(summary.return_proof).toBe("physical-bytes");
    expect(summary.cpu_out).toMatchObject({ a: 0x42, sp: 0xfd });
    const read = graph.data_references.find(
      (item) =>
        item.analysis_index === summary.return_analysis_index &&
        item.address === 0x1fc &&
        item.kind === "read",
    );
    assert.ok(read);
    expect(read.value).toBe(5);
    assert.equal(read.ram_origins.length, 1);
    const origin = read.ram_origins[0]!;
    expect(origin.condition_witness_indices.length).toBeGreaterThan(0);
    assert.equal(origin.writer_witness_indices.length, 1);
    const writer = graph.write_witnesses[origin.writer_witness_indices[0]!]!;
    expect(graph.nodes[writer.node_index]?.address).toBe(0xe103);
    expect(writer.value).toBeNull();
    expect(graph.byte_domains[writer.domain_index]?.count).toBe(256);
  });
});
