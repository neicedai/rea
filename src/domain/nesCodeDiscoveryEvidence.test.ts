import { describe, expect, it } from "vitest";
import { NesDiscoveryEvidence } from "./nesCodeDiscoveryEvidence.js";
import { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import { initialNesDiscoveryGraph } from "./nesCodeDiscoveryGraph.js";
import {
  emptyNesDiscoveryRam,
  joinNesDiscoveryRam,
  readNesDiscoveryRam,
  writeNesDiscoveryRam,
} from "./nesCodeDiscoveryRam.js";
import {
  assignNesDiscoveryValue,
  emptyNesDiscoveryValues,
} from "./nesCodeDiscoveryValues.js";
const ALL = (1n << 256n) - 1n;
const byte = (value: number) => 1n << BigInt(value);
const setup = () => {
  const graph = initialNesDiscoveryGraph();
  return {
    graph,
    evidence: new NesDiscoveryEvidence(
      graph,
      new NesDiscoveryDomainEvidence(graph),
    ),
  };
};
const written = (writer: number) => ({
  writer_witness_indices: [writer],
  initial_unwritten_possible: false,
  unknown_write_possible: false,
});

describe("discovery RAM evidence ownership", () => {
  it("keeps mirrored write identities finite while appending actual analysis witnesses", () => {
    const { graph, evidence } = setup();
    const write = { node_index: 3, address: 0x824, domain: byte(0xa5) };
    const first = evidence.write({ ...write, analysis_index: 2 });
    expect(
      evidence.write({ ...write, address: 0x1824, analysis_index: 9 }),
    ).toBe(first);
    evidence.write({ ...write, analysis_index: 9 });
    const other = evidence.write({
      ...write,
      node_index: 4,
      analysis_index: 10,
    });
    expect(evidence.writerNodes([other, first, first])).toEqual([3, 4]);
    expect(graph.write_witnesses).toEqual([
      {
        index: 0,
        node_index: 3,
        address: 0x24,
        value: 0xa5,
        domain_index: 0,
        analysis_indices: [2, 9],
      },
      {
        index: 1,
        node_index: 4,
        address: 0x24,
        value: 0xa5,
        domain_index: 0,
        analysis_indices: [10],
      },
    ]);
    expect(graph.byte_domains).toHaveLength(1);
  });
  it("distinguishes exact nonconvex writes whose common-bit proofs coincide", () => {
    const { graph, evidence } = setup();
    const pair = byte(1) | byte(128),
      wider = pair | byte(0) | byte(129);
    const first = evidence.write({
      node_index: 0,
      analysis_index: 1,
      address: 7,
      domain: pair,
    });
    const second = evidence.write({
      node_index: 0,
      analysis_index: 2,
      address: 7,
      domain: wider,
    });
    evidence.write({
      node_index: 0,
      analysis_index: 3,
      address: 7,
      domain: ALL,
    });
    expect(first).not.toBe(second);
    expect(graph.write_witnesses.map((w) => w.value)).toEqual([
      { mask: 126, value: 0 },
      { mask: 126, value: 0 },
      null,
    ]);
    expect(graph.byte_domains.map((d) => d.count)).toEqual([2, 4, 256]);
    expect(
      evidence.write({
        node_index: 0,
        analysis_index: 4,
        address: 7,
        domain: pair,
      }),
    ).toBe(first);
  });
  it("joins actual writers and initial possibilities without erasing either source", () => {
    const { evidence } = setup();
    const first = evidence.write({
      node_index: 0,
      analysis_index: 1,
      address: 31,
      domain: byte(0xa5),
    });
    const second = evidence.write({
      node_index: 1,
      analysis_index: 2,
      address: 31,
      domain: ALL,
    });
    const a = writeNesDiscoveryRam(emptyNesDiscoveryRam(), 31, written(first));
    const b = writeNesDiscoveryRam(emptyNesDiscoveryRam(), 31, written(second));
    const common = joinNesDiscoveryRam(a, b);
    expect(readNesDiscoveryRam(common, 31)).toEqual({
      writer_witness_indices: [first, second],
      initial_unwritten_possible: false,
      unknown_write_possible: false,
    });
    const unlocated = writeNesDiscoveryRam(emptyNesDiscoveryRam(), 31, {
      ...written(second),
      unknown_write_possible: true,
    });
    expect(readNesDiscoveryRam(joinNesDiscoveryRam(a, unlocated), 31)).toEqual({
      writer_witness_indices: [first, second],
      initial_unwritten_possible: false,
      unknown_write_possible: true,
    });
    expect(
      readNesDiscoveryRam(joinNesDiscoveryRam(a, emptyNesDiscoveryRam()), 31),
    ).toEqual({
      writer_witness_indices: [first],
      initial_unwritten_possible: true,
      unknown_write_possible: false,
    });
    evidence.write({
      node_index: 0,
      analysis_index: 100,
      address: 31,
      domain: byte(0xa5),
    });
    expect(joinNesDiscoveryRam(a, a)).toBe(a);
    expect(joinNesDiscoveryRam(common, common)).toBe(common);
  });
});

describe("discovery RAM page retention", () => {
  it("captures current domains while preserving separate actual write facts and provenance-sensitive pages", () => {
    const { graph, evidence } = setup();
    const first = evidence.write({
      node_index: 0,
      analysis_index: 0,
      address: 0x400,
      domain: ALL,
    });
    const second = evidence.write({
      node_index: 1,
      analysis_index: 1,
      address: 0x400,
      domain: ALL,
    });
    const a = writeNesDiscoveryRam(
      emptyNesDiscoveryRam(),
      0x400,
      written(first),
    );
    const b = writeNesDiscoveryRam(
      emptyNesDiscoveryRam(),
      0x400,
      written(second),
    );
    const unknown = emptyNesDiscoveryValues();
    const narrow = assignNesDiscoveryValue(unknown, 4 + 0x400, byte(7), [55]);
    const old = evidence.snapshot(a, unknown);
    expect(evidence.snapshot(b, unknown)[32]).not.toBe(old[32]);
    const next = evidence.snapshot(a, narrow);
    expect(next[32]).not.toBe(old[32]);
    expect(graph.ram_pages[next[32]!]!.cells[0]!.value).toBe(7);
    expect(graph.ram_pages[old[32]!]!.cells[0]!.value).toBeNull();
    expect(graph.write_witnesses[first]!.value).toBeNull();
    const equivalent = writeNesDiscoveryRam(emptyNesDiscoveryRam(), 0x400, {
      ...written(first),
      writer_witness_indices: [first, first],
    });
    expect(evidence.snapshot(equivalent, unknown)).toEqual(old);
    expect(graph.ram_pages).toHaveLength(3);
    old[32] = null;
    expect(evidence.snapshot(a, unknown)[32]).toBe(0);
  });
  it("copies caller provenance before immutable page identity caching", () => {
    const { evidence } = setup();
    const cell = {
      writer_witness_indices: [2, 1, 2],
      initial_unwritten_possible: true,
      unknown_write_possible: false,
    };
    const ram = writeNesDiscoveryRam(emptyNesDiscoveryRam(), 0, cell),
      values = emptyNesDiscoveryValues();
    const snapshot = evidence.snapshot(ram, values);
    cell.writer_witness_indices.push(3);
    cell.unknown_write_possible = true;
    expect(readNesDiscoveryRam(ram, 0)).toEqual({
      writer_witness_indices: [1, 2],
      initial_unwritten_possible: true,
      unknown_write_possible: false,
    });
    expect(Object.isFrozen(readNesDiscoveryRam(ram, 0))).toBe(true);
    expect(evidence.snapshot(ram, values)).toEqual(snapshot);
  });
  it("serializes all 2048 physical cells through exactly 64 shared page refs", () => {
    const { graph, evidence } = setup();
    let ram = emptyNesDiscoveryRam(),
      values = emptyNesDiscoveryValues();
    for (let address = 0; address < 2048; address++) {
      const domain = byte(address & 255);
      const writer = evidence.write({
        node_index: address,
        analysis_index: address,
        address,
        domain,
      });
      ram = writeNesDiscoveryRam(ram, address, written(writer));
      values = assignNesDiscoveryValue(values, 4 + address, domain);
    }
    const snapshot = evidence.snapshot(ram, values);
    expect(snapshot).toHaveLength(64);
    expect(snapshot).toEqual(Array.from({ length: 64 }, (_, index) => index));
    expect(graph.ram_pages).toHaveLength(64);
    expect(graph.ram_pages.every((page) => page.cells.length === 32)).toBe(
      true,
    );
    expect(graph.ram_pages[63]!.cells[31]).toEqual({
      offset: 31,
      value: 255,
      writer_witness_indices: [2047],
      initial_unwritten_possible: false,
      unknown_write_possible: false,
    });
    expect(evidence.snapshot(ram, values)).toEqual(snapshot);
    expect(graph.ram_pages).toHaveLength(64);
  });
});
