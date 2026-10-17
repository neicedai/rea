import { describe, expect, it } from "vitest";
import { NesDiscoveryEvidence } from "./nesCodeDiscoveryEvidence.js";
import { NesDiscoveryRelativeEvidence } from "./nesCodeDiscoveryRelativeEvidence.js";
import { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import { initialNesDiscoveryGraph } from "./nesCodeDiscoveryGraph.js";
import {
  emptyNesDiscoveryRelativeStack,
  relativeStackValueKey,
  shiftNesDiscoveryRelativeStack,
  writeNesDiscoveryRelativeStack,
} from "./nesCodeDiscoveryRelativeStack.js";
const ALL = (1n << 256n) - 1n;
const byte = (value: number) => 1n << BigInt(value);
const setup = () => {
  const graph = initialNesDiscoveryGraph(),
    domains = new NesDiscoveryDomainEvidence(graph);
  return {
    graph,
    domains,
    evidence: new NesDiscoveryRelativeEvidence(graph, domains),
  };
};

describe("relative stack evidence ownership", () => {
  it("appends analyses to stable writer-local offset/domain identities", () => {
    const { graph, evidence } = setup();
    const write = { node_index: 4, offset: 0, domain: byte(0x25) };
    const writer = evidence.write({ ...write, analysis_index: 3 });
    expect(evidence.write({ ...write, analysis_index: 9 })).toBe(writer);
    evidence.write({ ...write, analysis_index: 9 });
    const stack = writeNesDiscoveryRelativeStack(
      emptyNesDiscoveryRelativeStack(),
      0,
      { domain: byte(0x25), writer_witness_indices: [writer] },
    );
    const pushed = evidence.snapshot(shiftNesDiscoveryRelativeStack(stack, -1));
    expect(graph.relative_stack_pages[pushed[0]!]!.cells[0]).toEqual({
      offset: 1,
      value: 0x25,
      domain_index: 0,
      writer_witness_indices: [writer],
    });
    expect(graph.relative_stack_write_witnesses).toEqual([
      {
        index: 0,
        node_index: 4,
        offset: 0,
        value: 0x25,
        domain_index: 0,
        analysis_indices: [3, 9],
      },
    ]);
    expect(evidence.writerNodes([writer, writer])).toEqual([4]);
  });
  it("keeps physical RAM and relative writer ID namespaces independent", () => {
    const { graph, domains, evidence: relative } = setup();
    const physical = new NesDiscoveryEvidence(graph, domains);
    expect(
      relative.write({
        node_index: 2,
        analysis_index: 2,
        offset: 0,
        domain: byte(7),
      }),
    ).toBe(0);
    expect(
      physical.write({
        node_index: 9,
        analysis_index: 9,
        address: 0x100,
        domain: byte(7),
      }),
    ).toBe(0);
    expect(relative.writerNodes([0])).toEqual([2]);
    expect(physical.writerNodes([0])).toEqual([9]);
    expect(graph.relative_stack_write_witnesses[0]).not.toHaveProperty(
      "address",
    );
    expect(graph.write_witnesses[0]).not.toHaveProperty("offset");
    expect(graph.byte_domains).toHaveLength(1);
  });
  it("deduplicates immutable page contents while preserving distinct provenance", () => {
    const { graph, evidence } = setup();
    const writer = evidence.write({
      node_index: 0,
      analysis_index: 0,
      offset: 31,
      domain: byte(7),
    });
    const other = evidence.write({
      node_index: 1,
      analysis_index: 1,
      offset: 31,
      domain: byte(7),
    });
    const cell = { domain: byte(7), writer_witness_indices: [writer] };
    const a = writeNesDiscoveryRelativeStack(
        emptyNesDiscoveryRelativeStack(),
        31,
        cell,
      ),
      first = evidence.snapshot(a);
    const b = writeNesDiscoveryRelativeStack(
      emptyNesDiscoveryRelativeStack(),
      31,
      { domain: byte(7), writer_witness_indices: [other] },
    );
    expect(relativeStackValueKey(a)).toBe(relativeStackValueKey(b));
    expect(evidence.snapshot(b)).not.toEqual(first);
    cell.writer_witness_indices.push(other);
    cell.domain = byte(8);
    expect(evidence.snapshot(a)).toEqual(first);
    expect(
      evidence.snapshot(
        shiftNesDiscoveryRelativeStack(
          shiftNesDiscoveryRelativeStack(a, 17),
          -17,
        ),
      ),
    ).toEqual(first);
    expect(graph.relative_stack_pages).toHaveLength(2);
    first[0] = null;
    expect(evidence.snapshot(a)[0]).toBe(0);
  });
});

describe("relative stack snapshot coverage", () => {
  it("retains all 256 slots through exactly eight canonical page references", () => {
    const { graph, evidence } = setup();
    let stack = emptyNesDiscoveryRelativeStack();
    for (let offset = 0; offset < 256; offset++) {
      const writer = evidence.write({
        node_index: offset,
        analysis_index: offset,
        offset,
        domain: byte(offset),
      });
      stack = writeNesDiscoveryRelativeStack(stack, offset, {
        domain: byte(offset),
        writer_witness_indices: [writer],
      });
    }
    const snapshot = evidence.snapshot(stack);
    expect(snapshot).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(
      graph.relative_stack_pages.every((page) => page.cells.length === 32),
    ).toBe(true);
    expect(graph.relative_stack_pages[7]!.cells[31]).toEqual({
      offset: 31,
      value: 255,
      domain_index: 255,
      writer_witness_indices: [255],
    });
    expect(evidence.snapshot(stack)).toEqual(snapshot);
    expect(graph.relative_stack_pages).toHaveLength(8);
  });
  it("retains an actual unknown write and snapshot without inventing a known byte or new value identity", () => {
    const { graph, evidence } = setup();
    const writer = evidence.write({
      node_index: 0,
      analysis_index: 0,
      offset: 5,
      domain: ALL,
    });
    const empty = emptyNesDiscoveryRelativeStack();
    const stack = writeNesDiscoveryRelativeStack(empty, 5, {
      domain: ALL,
      writer_witness_indices: [writer],
    });
    expect(graph.relative_stack_write_witnesses[0]).toMatchObject({
      offset: 5,
      value: null,
      domain_index: 0,
    });
    const snapshot = evidence.snapshot(stack);
    expect(graph.relative_stack_pages[snapshot[0]!]!.cells).toEqual([
      {
        offset: 5,
        value: null,
        domain_index: 0,
        writer_witness_indices: [writer],
      },
    ]);
    expect(relativeStackValueKey(stack)).toBe(relativeStackValueKey(empty));
    expect(evidence.snapshot(empty)).toEqual(Array<null>(8).fill(null));
    expect(graph.relative_stack_pages).toHaveLength(1);
  });
});
