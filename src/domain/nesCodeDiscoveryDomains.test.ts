import { describe, expect, it } from "vitest";
import { nesCodeFixture } from "./nesCode.fixture.js";
import { parseNesHeader } from "./nes.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
  type DiscoverNesCodeInput,
} from "./nesCodeDiscovery.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";

async function discover(
  program: readonly number[],
  customize?: (fixture: ReturnType<typeof nesCodeFixture>) => void,
  limits: Partial<DiscoverNesCodeInput> = {},
) {
  const fixture = nesCodeFixture(4, program);
  fixture.bytes.fill(
    0x42,
    fixture.programOffset + 0x300,
    fixture.programOffset + 0x400,
  );
  customize?.(fixture);
  const parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw Error("Invalid authored cartridge");
  const header = parsed.value,
    graph = nesCodeDiscoverySchema.parse(
      await discoverNesCode(
        header,
        fixture.bytes.subarray(
          header.prgRom.offset,
          header.prgRom.offset + header.prgRom.size,
        ),
        discoverNesCodeInputSchema.parse({
          path: "/domains.nes",
          initial: {
            mapper: 4,
            bank_select: 6,
            banks: [0, 2, 4, 5, 6, 7, 0, 1],
          },
          roots: [fixture.entry],
          ...limits,
        }),
      ),
    );
  if (graph.status !== "derived") throw Error(graph.reason);
  return graph;
}
type Graph = Awaited<ReturnType<typeof discover>>;
function domain(graph: Graph, index: number): number[] {
  const bits = BigInt(`0x${graph.byte_domains[index]!.bitmap_hex}`);
  const values = Array.from({ length: 256 }, (_, value) => value).filter(
    (value) => (bits & (1n << BigInt(value))) !== 0n,
  );
  expect(values.length).toBe(graph.byte_domains[index]!.count);
  return values;
}
const at = (graph: Graph, address: number) =>
  graph.nodes.find((node) => node.address === address)!;
const casesAt = (graph: Graph, address: number) =>
  graph.analyses.filter(
    (analysis) =>
      analysis.node_index === at(graph, address).index &&
      analysis.refinement !== null,
  );
const rangeProgram = [0xae, 2, 0x20, 0xe0, 10, 0xb0, 4, 0xbd, 0, 0xe3, 0, 0];

describe("finite byte ranges and live flag slots", () => {
  it("keeps X<10 exact across its bit envelope and records the lazy source domain", async () => {
    const graph = await discover(rangeProgram),
      cases = casesAt(graph, 0xe007);
    expect(cases.map((analysis) => analysis.refinement!.value)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    for (const analysis of cases)
      expect(domain(graph, analysis.refinement!.source_domain_index)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    const branch = at(graph, 0xe005),
      analysis = graph.analyses.find(
        (analysis) => analysis.node_index === branch.index,
      )!;
    expect(domain(graph, analysis.register_domains_out.x)).toHaveLength(256);
    const small = graph.edges.find(
      (edge) => edge.from === branch.index && edge.kind === "branch-not-taken",
    )!;
    expect(domain(graph, small.register_domains!.x)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(small.flag_predicates).toEqual(analysis.flag_predicates_out);
    expect(analysis.cpu_out.c).toBeNull();
    expect(
      graph.data_references
        .filter(
          (ref) =>
            cases.some((analysis) => analysis.index === ref.analysis_index) &&
            ref.kind === "read",
        )
        .map((ref) => ref.address),
    ).toEqual(Array.from({ length: 10 }, (_, index) => 0xe300 + index));
  });
  it("keeps carry's compare carrier while LDA replaces the independent NZ result", async () => {
    const graph = await discover([
      0xae, 2, 0x20, 0xe0, 10, 0xa9, 0, 0x90, 1, 0, 0,
    ]);
    const analysis = graph.analyses.find(
      (analysis) => analysis.node_index === at(graph, 0xe007).index,
    )!;
    expect(analysis.flag_predicates_in.c).toMatchObject({
      kind: "compare",
      registers: ["x"],
      operand: 10,
    });
    expect(analysis.flag_predicates_in.z).toMatchObject({
      kind: "result",
      registers: ["a"],
      operand: null,
    });
    expect(analysis.cpu_in).toMatchObject({ z: true, n: false, c: null });
    const selected = graph.edges.find(
      (edge) =>
        edge.from === analysis.node_index && edge.kind === "branch-taken",
    )!;
    expect(domain(graph, selected.register_domains!.x)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
    expect(
      selected.flag_predicates!.c!.source_witness_indices.map(
        (index) =>
          graph.nodes[graph.flag_predicate_sources[index]!.node_index]!.address,
      ),
    ).toEqual([0xe003]);
  });
  it("does not apply an old CPX predicate to X after INX overwrites its value", async () => {
    const graph = await discover([0xae, 2, 0x20, 0xe0, 5, 0xe8, 0x90, 1, 0, 0]);
    const analysis = graph.analyses.find(
      (analysis) => analysis.node_index === at(graph, 0xe006).index,
    )!;
    expect(analysis.flag_predicates_in.c).toBeNull();
    for (const edge of graph.edges.filter(
      (edge) => edge.from === analysis.node_index,
    ))
      expect(domain(graph, edge.register_domains!.x)).toHaveLength(256);
    expect(
      graph.edges.filter((edge) => edge.from === analysis.node_index),
    ).toHaveLength(2);
  });
  it("uses subtract-result N, including its wrap, and narrows other live compare flags", async () => {
    const graph = await discover([0xae, 2, 0x20, 0xe0, 0x80, 0x10, 1, 0, 0]);
    const node = at(graph, 0xe005),
      positive = graph.edges.find(
        (edge) => edge.from === node.index && edge.kind === "branch-taken",
      )!,
      negative = graph.edges.find(
        (edge) => edge.from === node.index && edge.kind === "branch-not-taken",
      )!;
    expect(domain(graph, positive.register_domains!.x)).toEqual(
      Array.from({ length: 128 }, (_, index) => index + 128),
    );
    expect(domain(graph, negative.register_domains!.x)).toEqual(
      Array.from({ length: 128 }, (_, index) => index),
    );
    expect(at(graph, 0xe008).cpu_in.c).toBe(true);
    expect(at(graph, 0xe007).cpu_in.c).toBe(false);
  });
});

describe("finite domains through copies, calls and images", () => {
  it("keeps a nonconvex joined domain through TXA, EOR and TAX without invented table indices", async () => {
    const graph = await discover([
      0x50, 5, 0xa2, 1, 0x4c, 9, 0xe0, 0xa2, 4, 0x8a, 0x49, 1, 0xaa, 0xbd, 0,
      0xe3, 0,
    ]);
    expect(
      casesAt(graph, 0xe00d).map((analysis) => analysis.refinement!.value),
    ).toEqual([0, 5]);
    const xor = graph.analyses.find(
      (analysis) => analysis.node_index === at(graph, 0xe00a).index,
    )!;
    expect(domain(graph, xor.register_domains_in.a)).toEqual([1, 4]);
    expect(domain(graph, xor.register_domains_out.a)).toEqual([0, 5]);
    expect(xor.cpu_out).toMatchObject({
      a: null,
      register_bits: { a: { mask: 250, value: 0 } },
    });
  });
  it("transfers a callee's exact incremented domain back to its matching caller", async () => {
    const graph = await discover(
      [0xae, 2, 0x20, 0xe0, 10, 0xb0, 7, 0x20, 0, 0xe1, 0xbd, 0, 0xe3, 0, 0],
      (fixture) => {
        fixture.bytes.set([0xe8, 0x60], fixture.programOffset + 0x100);
      },
    );
    expect(
      casesAt(graph, 0xe00a).map((analysis) => analysis.refinement!.value),
    ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const summary = graph.return_summaries[0]!;
    expect(domain(graph, summary.register_domains.x)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(summary.flag_predicates.c).toBeNull();
    expect(summary.flag_predicates.z).toMatchObject({
      kind: "result",
      registers: ["x"],
    });
    const invocation = graph.invocations[summary.invocation_index]!;
    expect(domain(graph, invocation.register_domains.x)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
    ]);
  });
  it("preserves a copy of the compared value when its original register is overwritten", async () => {
    const graph = await discover([
      0xae, 2, 0x20, 0x8a, 0xe0, 5, 0xe8, 0x90, 1, 0, 0,
    ]);
    const analysis = graph.analyses.find(
      (analysis) => analysis.node_index === at(graph, 0xe007).index,
    )!;
    expect(analysis.flag_predicates_in.c).toMatchObject({
      kind: "compare",
      registers: ["a"],
      operand: 5,
    });
    const selected = graph.edges.find(
      (edge) =>
        edge.from === analysis.node_index && edge.kind === "branch-taken",
    )!;
    expect(domain(graph, selected.register_domains!.a)).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(domain(graph, selected.register_domains!.x)).toHaveLength(256);
  });
  it("keeps the exact source domain and next candidate at a real work frontier", async () => {
    const graph = await discover(rangeProgram, undefined, {
      max_work_items: 4,
    });
    expect(graph.termination).toBe("work-item-budget");
    expect(graph.pending_refinements).toHaveLength(1);
    expect(graph.pending_refinements[0]!.next_value).toBe(0);
    expect(
      domain(graph, graph.pending_refinements[0]!.source_domain_index),
    ).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(graph.partitions).toEqual([{ index: 0, selections: [] }]);
  });
});

const rmwCases = [
  { name: "SLO", opcode: 0x13, changesA: true, changesV: false },
  { name: "RLA", opcode: 0x33, changesA: true, changesV: false },
  { name: "SRE", opcode: 0x53, changesA: true, changesV: false },
  { name: "RRA", opcode: 0x73, changesA: true, changesV: true },
  { name: "DCP", opcode: 0xd3, changesA: false, changesV: false },
  { name: "ISC", opcode: 0xf3, changesA: true, changesV: true },
];
describe("carry correlation in unary images", () => {
  it.each([
    { name: "ROL", instruction: [0x2a], expected: [1, 2] },
    { name: "ROR", instruction: [0x6a], expected: [0, 192] },
    { name: "ARR", instruction: [0x6b, 0x7f], expected: [0, 128] },
  ])(
    "keeps original A and compare carry paired for $name",
    async ({ instruction, expected }) => {
      const graph = await discover([
        0x50,
        5,
        0xa9,
        1,
        0x4c,
        9,
        0xe0,
        0xa9,
        128,
        0xc9,
        128,
        ...instruction,
        0xaa,
        0xbd,
        0,
        0xe3,
        0,
      ]);
      const image = graph.analyses.find(
        (analysis) => analysis.node_index === at(graph, 0xe00b).index,
      )!;
      expect(domain(graph, image.register_domains_in.a)).toEqual([1, 128]);
      expect(image.cpu_in.c).toBeNull();
      expect(image.flag_predicates_in.c).toMatchObject({
        kind: "compare",
        registers: ["a"],
        operand: 128,
      });
      expect(domain(graph, image.register_domains_out.a)).toEqual(expected);
      expect(
        casesAt(graph, 0xe00c + instruction.length).map(
          (analysis) => analysis.refinement!.value,
        ),
      ).toEqual(expected);
    },
  );
  it("retains both independent carry choices when the compared carrier is another value", async () => {
    const graph = await discover([
      0x50, 5, 0xa9, 1, 0x4c, 9, 0xe0, 0xa9, 128, 0xae, 2, 0x20, 0xe0, 128,
      0x2a, 0,
    ]);
    const image = graph.analyses.find(
      (analysis) => analysis.node_index === at(graph, 0xe00e).index,
    )!;
    expect(image.flag_predicates_in.c).toMatchObject({ registers: ["x"] });
    expect(domain(graph, image.register_domains_out.a)).toEqual([0, 1, 2, 3]);
  });
});
describe("unresolved writes and domain evidence", () => {
  it.each(rmwCases)(
    "does not retain stale CPU facts after unknown-address $name",
    async ({ opcode, changesA, changesV }) => {
      const graph = await discover([
        0xa9,
        0,
        0xa0,
        0,
        0x38,
        0xb8,
        opcode,
        0x10,
        0xf0,
        1,
        0,
        0,
      ]);
      const analysis = graph.analyses.find(
        (analysis) => analysis.node_index === at(graph, 0xe006).index,
      )!;
      expect(analysis.cpu_out).toMatchObject({
        a: changesA ? null : 0,
        c: null,
        z: null,
        n: null,
        v: changesV ? null : false,
      });
      expect(domain(graph, analysis.register_domains_out.a)).toHaveLength(
        changesA ? 256 : 1,
      );
      expect(
        graph.frontiers.some(
          (frontier) => frontier.reason === "unknown-write-address",
        ),
      ).toBe(true);
      expect(
        graph.edges.filter((edge) => edge.from === at(graph, 0xe008).index),
      ).toHaveLength(2);
    },
  );
  it("keeps CPU and flag facts across an unknown-address STA", async () => {
    const graph = await discover([
      0xa9, 0, 0xa0, 0, 0x38, 0x91, 0x10, 0xf0, 1, 0, 0,
    ]);
    const node = at(graph, 0xe007);
    expect(node.cpu_in).toMatchObject({ a: 0, c: true, z: true, n: false });
    expect(
      graph.edges.filter((edge) => edge.from === node.index),
    ).toMatchObject([{ kind: "branch-taken" }]);
    expect(graph.write_witnesses).toEqual([]);
  });
});
