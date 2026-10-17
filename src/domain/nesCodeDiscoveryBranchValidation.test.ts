import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
} from "./nesCodeDiscovery.js";

async function discover(program: number[]) {
  const fixture = nesCodeFixture(4, program),
    parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw new Error("Invalid authored cartridge");
  const header = parsed.value;
  const graph = nesCodeDiscoverySchema.parse(
    await discoverNesCode(
      header,
      fixture.bytes.subarray(
        header.prgRom.offset,
        header.prgRom.offset + header.prgRom.size,
      ),
      discoverNesCodeInputSchema.parse({
        path: "/branch-contract.nes",
        initial: { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 0, 1] },
        roots: [fixture.entry],
      }),
    ),
  );
  if (graph.status !== "derived") throw new Error(graph.reason);
  return graph;
}

describe("branch evidence contract", () => {
  it("qualifies the original bytes, exact source flag and signed target", async () => {
    const graph = await discover([0xa9, 1, 0xd0, 2, 0xa9, 0xff, 0xea, 0x60]);
    const edge = graph.edges.find((item) => item.kind === "branch-taken")!;
    expect(edge).toMatchObject({
      condition: { flag: "z", value: false },
      target_address: 0xe006,
    });
    expect(graph.nodes.some((node) => node.address === 0xe004)).toBe(false);
    const corruptions = [
      (value: typeof graph) => {
        value.edges[edge.index]!.condition = { flag: "z", value: true };
      },
      (value: typeof graph) => {
        value.edges[edge.index]!.target_address = 0xe004;
        value.edges[edge.index]!.to = null;
      },
      (value: typeof graph) => {
        value.nodes[edge.from]!.bytes_hex = "f002";
      },
      (value: typeof graph) => {
        value.analyses[edge.analysis_index]!.cpu_out.z = true;
      },
      (value: typeof graph) => {
        value.edges[edge.index]!.condition = null;
      },
      (value: typeof graph) => {
        value.edges[edge.index]!.target_context_index = value.contexts.length;
      },
    ];
    for (const corrupt of corruptions) {
      const value = structuredClone(graph);
      corrupt(value);
      expect(nesCodeDiscoverySchema.safeParse(value).success).toBe(false);
    }
  });

  it("preserves both zero-displacement conditions without qualifying either from the target envelope", async () => {
    const graph = await discover([0xd0, 0, 0x60]);
    const branches = graph.edges.filter((item) => item.from === 0);
    expect(
      branches.map((item) => [item.kind, item.target_address, item.condition]),
    ).toEqual([
      ["branch-not-taken", 0xe002, { flag: "z", value: true }],
      ["branch-taken", 0xe002, { flag: "z", value: false }],
    ]);
    expect(graph.analyses[branches[0]!.analysis_index]!.cpu_out.z).toBeNull();
    for (const mode of ["missing", "duplicate"]) {
      const value = structuredClone(graph);
      if (mode === "missing")
        value.edges = value.edges.filter(
          (item) => item.index !== branches[0]!.index,
        );
      else value.edges.push({ ...value.edges[branches[0]!.index]! });
      value.edges.forEach((item, index) => {
        item.index = index;
      });
      expect(nesCodeDiscoverySchema.safeParse(value).success).toBe(false);
    }
  });

  it("rejects branch conditions attached to an ordinary instruction", async () => {
    const graph = await discover([0xea, 0x60]);
    graph.edges[0]!.condition = { flag: "c", value: false };
    expect(nesCodeDiscoverySchema.safeParse(graph).success).toBe(false);
  });
});
