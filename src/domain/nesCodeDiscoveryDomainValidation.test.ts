import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
} from "./nesCodeDiscovery.js";

async function rangeGraph() {
  // Unknown X, CPX #10, BCS exit, then a single indexed load for X in 0..9.
  const fixture = nesCodeFixture(
      4,
      [0xae, 0, 0, 0xe0, 10, 0xb0, 4, 0xbd, 0, 0x90, 0x60, 0x60],
    ),
    parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw new Error("Invalid authored cartridge");
  const header = parsed.value,
    graph = nesCodeDiscoverySchema.parse(
      await discoverNesCode(
        header,
        fixture.bytes.subarray(
          header.prgRom.offset,
          header.prgRom.offset + header.prgRom.size,
        ),
        discoverNesCodeInputSchema.parse({
          path: "/domain-contract.nes",
          roots: [fixture.entry],
          initial: {
            mapper: 4,
            bank_select: 6,
            banks: [0, 2, 4, 5, 6, 7, 0, 1],
          },
        }),
      ),
    );
  if (graph.status !== "derived") throw new Error(graph.reason);
  return graph;
}

describe("exact byte-domain evidence contract", () => {
  it("qualifies bitmap counts, projections and each predicate-filtered successor", async () => {
    const graph = await rangeGraph(),
      edge = graph.edges.find((item) => item.kind === "branch-not-taken")!,
      index = edge.register_domains!.x,
      domain = graph.byte_domains[index]!,
      unknown = graph.invocations[0]!.register_domains.x;
    expect(domain).toMatchObject({
      bitmap_hex: 1023n.toString(16).padStart(64, "0"),
      count: 10,
    });
    const corruptions = [
      (value: typeof graph) => {
        value.byte_domains[index]!.count = 16;
      },
      (value: typeof graph) => {
        value.byte_domains[index]!.bitmap_hex = "g".repeat(64);
      },
      (value: typeof graph) => {
        value.byte_domains[index]!.bitmap_hex = "0".repeat(64);
      },
      (value: typeof graph) => {
        value.byte_domains.push({
          ...value.byte_domains[index]!,
          index: value.byte_domains.length,
        });
      },
      (value: typeof graph) => {
        value.edges[edge.index]!.register_domains!.x = unknown;
      },
      (value: typeof graph) => {
        value.edges[edge.index]!.flag_predicates = {
          c: null,
          z: null,
          n: null,
        };
      },
      (value: typeof graph) => {
        value.analyses.find(
          (analysis) => analysis.refinement !== null,
        )!.register_domains_in.x = unknown;
      },
    ];
    for (const corrupt of corruptions) {
      const value = structuredClone(graph);
      corrupt(value);
      expect(nesCodeDiscoverySchema.safeParse(value).success).toBe(false);
    }
  });

  it("requires the original comparison and exact source analysis for range predicates", async () => {
    const graph = await rangeGraph(),
      source = graph.flag_predicate_sources.find(
        (item) => item.kind === "compare",
      )!;
    expect(source).toMatchObject({ register: "x", operand: 10 });
    const corruptions = [
      (value: typeof graph) => {
        const witness = value.flag_predicate_sources[source.index]!;
        witness.analysis_indices = [
          value.analyses.find(
            (analysis) => analysis.node_index !== source.node_index,
          )!.index,
        ];
      },
      (value: typeof graph) => {
        value.flag_predicate_sources[source.index]!.analysis_indices = [
          value.analyses.length,
        ];
      },
      (value: typeof graph) => {
        value.nodes[source.node_index]!.bytes_hex = "e00b";
      },
      (value: typeof graph) => {
        value.nodes[source.node_index]!.bytes_hex = "02";
      },
      (value: typeof graph) => {
        const analysis = value.analyses.find((item) =>
          item.flag_predicates_out.c?.source_witness_indices.includes(
            source.index,
          ),
        )!;
        analysis.flag_predicates_out.c!.source_witness_indices = [
          value.flag_predicate_sources.length,
        ];
      },
    ];
    for (const corrupt of corruptions) {
      const value = structuredClone(graph);
      corrupt(value);
      expect(nesCodeDiscoverySchema.safeParse(value).success).toBe(false);
    }
  });

  it("requires an indexed selection to belong to its exact source set", async () => {
    const graph = await rangeGraph(),
      analysis = graph.analyses.find((item) => item.refinement?.value === 5)!;
    expect(analysis).toBeDefined();
    const value = structuredClone(graph),
      bitmap_hex = 1n.toString(16).padStart(64, "0");
    let index = value.byte_domains.findIndex(
      (domain) => domain.bitmap_hex === bitmap_hex,
    );
    if (index === -1) {
      index = value.byte_domains.length;
      value.byte_domains.push({ index, bitmap_hex, count: 1 });
    }
    for (const source of [index, value.byte_domains.length]) {
      const corrupted = structuredClone(value);
      corrupted.analyses[analysis.index]!.refinement!.source_domain_index =
        source;
      expect(nesCodeDiscoverySchema.safeParse(corrupted).success).toBe(false);
    }
  });
});
