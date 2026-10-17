import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
} from "./nesCodeDiscovery.js";

async function ramPredicateGraph() {
  // C retains the comparison's RAM subject after LDA #77 overwrites A and Z/N.
  const fixture = nesCodeFixture(
      4,
      [0xa5, 0x20, 0xc9, 10, 0xa9, 77, 0xb0, 3, 0xa5, 0x20, 0x60, 0x60],
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
          path: "/ram-predicate-contract.nes",
          roots: [fixture.entry],
          max_work_items: 64,
          initial: {
            mapper: 4,
            bank_select: 6,
            banks: [0, 2, 4, 5, 6, 7, 0, 1],
          },
        }),
      ),
    );
  if (graph.status !== "derived") throw new Error(graph.reason);
  const branch = graph.analyses.find(
      (analysis) =>
        graph.nodes[analysis.node_index]!.address === fixture.entry + 6,
    )!,
    reread = graph.data_references.find(
      (reference) =>
        reference.kind === "read" &&
        graph.nodes[reference.node_index]!.address === fixture.entry + 8,
    )!;
  return { graph, branch, reread };
}

describe("current-value and RAM conditional proof contract", () => {
  it("qualifies RAM-only flag carriers and the initial byte's conditional reread", async () => {
    const { graph, branch, reread } = await ramPredicateGraph();
    expect(branch.flag_predicates_in.c).toMatchObject({
      carrier_variable: 36,
      registers: [],
    });
    expect(reread.ram_origins[0]).toMatchObject({
      ram_address: 0x20,
      initial_unwritten_possible: true,
      unknown_write_possible: false,
      writer_nodes: [],
      writer_witness_indices: [],
    });
    expect(graph.byte_domains[reread.ram_origins[0]!.domain_index]!.count).toBe(
      10,
    );
    const corruptions = [
      (value: typeof graph) => {
        value.analyses[branch.index]!.flag_predicates_in.c!.carrier_variable =
          0;
      },
      (value: typeof graph) => {
        value.analyses[branch.index]!.flag_predicates_in.c!.registers = ["a"];
        value.value_state_records++;
      },
      (value: typeof graph) => {
        value.data_references[
          reread.index
        ]!.ram_origins[0]!.initial_unwritten_possible = false;
      },
      (value: typeof graph) => {
        value.data_references[
          reread.index
        ]!.ram_origins[0]!.unknown_write_possible = true;
      },
      (value: typeof graph) => {
        value.value_state_records -=
          value.data_references[
            reread.index
          ]!.ram_origins[0]!.condition_witness_indices.length;
        value.data_references[
          reread.index
        ]!.ram_origins[0]!.condition_witness_indices = [];
      },
    ];
    for (const corrupt of corruptions) {
      const value = structuredClone(graph);
      corrupt(value);
      expect(nesCodeDiscoverySchema.safeParse(value).success).toBe(false);
    }
  });

  it("requires canonical snapshot ownership and actual conditional support", async () => {
    const { graph } = await ramPredicateGraph(),
      witness = graph.condition_witnesses.find(
        (item) => item.kind === "branch" && !item.value,
      )!;
    expect(witness).toBeDefined();
    const corruptions = [
      (value: typeof graph) => {
        value.value_state_records +=
          1 +
          value.value_pages[0]!.entries.reduce(
            (count, entry) =>
              count + 1 + entry.condition_witness_indices.length,
            0,
          );
        value.value_pages.push({
          ...value.value_pages[0]!,
          index: value.value_pages.length,
        });
      },
      (value: typeof graph) => {
        value.value_snapshots[0]!.pages[64] = value.value_pages.length;
      },
      (value: typeof graph) => {
        value.analyses[0]!.value_snapshot_in = value.value_snapshots.length;
      },
      (value: typeof graph) => {
        value.condition_witnesses[witness.index]!.analysis_indices = [0];
      },
      (value: typeof graph) => {
        const proof = value.condition_witnesses[witness.index]!;
        if (proof.kind === "branch") proof.value = true;
      },
      (value: typeof graph) => {
        value.value_state_records++;
      },
    ];
    for (const corrupt of corruptions) {
      const value = structuredClone(graph);
      corrupt(value);
      expect(nesCodeDiscoverySchema.safeParse(value).success).toBe(false);
    }
  });
});
