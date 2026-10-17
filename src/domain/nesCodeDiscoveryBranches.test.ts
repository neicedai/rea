import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
} from "./nesCodeDiscovery.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";

async function discover(
  program: readonly number[],
  customize?: (fixture: ReturnType<typeof nesCodeFixture>) => void,
  entry = 0xe000,
) {
  const fixture = nesCodeFixture(4, program);
  customize?.(fixture);
  const parsed = parseNesHeader(fixture.bytes);
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
        path: "/branches.nes",
        initial: { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 0, 1] },
        roots: [entry],
      }),
    ),
  );
  if (graph.status !== "derived") throw new Error(graph.reason);
  return graph;
}
const cases = [
  { mnemonic: "BCC", opcode: 0x90, flag: "c", taken: false },
  { mnemonic: "BCS", opcode: 0xb0, flag: "c", taken: true },
  { mnemonic: "BEQ", opcode: 0xf0, flag: "z", taken: true },
  { mnemonic: "BNE", opcode: 0xd0, flag: "z", taken: false },
  { mnemonic: "BMI", opcode: 0x30, flag: "n", taken: true },
  { mnemonic: "BPL", opcode: 0x10, flag: "n", taken: false },
  { mnemonic: "BVC", opcode: 0x50, flag: "v", taken: false },
  { mnemonic: "BVS", opcode: 0x70, flag: "v", taken: true },
] as const;
function establish(flag: "c" | "z" | "n" | "v", value: boolean): number[] {
  switch (flag) {
    case "c":
      return [value ? 0x38 : 0x18];
    case "z":
      return [0xa9, value ? 0 : 1];
    case "n":
      return [0xa9, value ? 0x80 : 0];
    case "v":
      return value ? [0x2c, 0, 0xe3] : [0xb8];
  }
}

describe("all conditional branch polarities", () => {
  it.each(cases)(
    "$mnemonic retains exactly its compatible flag edges",
    async ({ opcode, flag, taken }) => {
      for (const source of [false, true, null]) {
        const setup = source === null ? [] : establish(flag, source);
        const graph = await discover(
          [...setup, opcode, 3, 0xa9, 0x11, 0x60, 0xa9, 0x22, 0x60],
          (fixture) => {
            fixture.bytes[fixture.programOffset + 0x300] = 0x40;
          },
        );
        const address = 0xe000 + setup.length,
          node = graph.nodes.find((node) => node.address === address)!;
        const analyses = graph.analyses.filter(
          (analysis) => analysis.node_index === node.index,
        );
        expect(analyses).toHaveLength(1);
        expect(analyses[0]!.cpu_in[flag]).toBe(source);
        expect(analyses[0]!.cpu_out[flag]).toBe(source);
        expect(node.cpu_out[flag]).toBe(source);
        const edges = graph.edges.filter((edge) => edge.from === node.index);
        expect(
          edges.map((edge) => [edge.kind, edge.target_address, edge.condition]),
        ).toEqual(
          source === null
            ? [
                ["branch-not-taken", address + 2, { flag, value: !taken }],
                ["branch-taken", address + 5, { flag, value: taken }],
              ]
            : [
                [
                  source === taken ? "branch-taken" : "branch-not-taken",
                  address + (source === taken ? 5 : 2),
                  { flag, value: source },
                ],
              ],
        );
        for (const edge of edges) {
          const target = graph.nodes[edge.to!]!;
          expect(target.cpu_in[flag]).toBe(edge.condition!.value);
        }
        if (source !== null)
          expect(
            graph.nodes.some(
              (node) => node.address === address + (source === taken ? 2 : 5),
            ),
          ).toBe(false);
        expect(
          graph.edges
            .filter((edge) => !edge.kind.startsWith("branch-"))
            .every((edge) => edge.condition === null),
        ).toBe(true);
      }
    },
  );
});

describe("edge-local flag ownership", () => {
  it("joins distinct branch conditions without mutating their analysis witnesses", async () => {
    const graph = await discover([
      0x90, 3, 0x4c, 8, 0xe0, 0x4c, 8, 0xe0, 0x90, 3, 0, 0x02, 0x02, 0,
    ]);
    const first = graph.nodes.find((node) => node.address === 0xe000)!,
      joined = graph.nodes.find((node) => node.address === 0xe008)!;
    expect(graph.nodes.find((node) => node.address === 0xe002)!.cpu_in.c).toBe(
      true,
    );
    expect(graph.nodes.find((node) => node.address === 0xe005)!.cpu_in.c).toBe(
      false,
    );
    expect(joined.cpu_in.c).toBeNull();
    expect(
      graph.edges
        .filter((edge) => edge.from === joined.index)
        .map((edge) => edge.condition),
    ).toEqual([
      { flag: "c", value: true },
      { flag: "c", value: false },
    ]);
    expect(
      graph.analyses.find((analysis) => analysis.node_index === first.index)!
        .cpu_out.c,
    ).toBeNull();
  });
  it("carries conditions through matched callees and honors a callee's actual flag overwrite", async () => {
    const graph = await discover(
      [
        0x90, 0x0a, 0x20, 0, 0xe1, 0x90, 3, 0, 0x02, 0x02, 0x02, 0x02, 0x20, 0,
        0xe1, 0x90, 3, 0x02, 0x02, 0x02, 0,
      ],
      (fixture) => {
        fixture.bytes.set([0xea, 0x60], fixture.programOffset + 0x100);
      },
    );
    for (const [address, kind, value] of [
      [0xe005, "branch-not-taken", true],
      [0xe00f, "branch-taken", false],
    ] as const) {
      const node = graph.nodes.find((node) => node.address === address)!;
      expect(
        graph.edges.filter((edge) => edge.from === node.index),
      ).toMatchObject([{ kind, condition: { flag: "c", value } }]);
    }
    expect(graph.nodes.filter((node) => node.address === 0xe100)).toHaveLength(
      2,
    );
    expect(
      graph.edges
        .filter(
          (edge) => edge.kind === "return" && edge.resolution === "resolved",
        )
        .every((edge) => edge.condition === null),
    ).toBe(true);
    const changed = await discover(
      [0x18, 0x20, 0, 0xe1, 0x90, 3, 0, 0x02, 0x02, 0x02],
      (fixture) => {
        fixture.bytes.set([0x38, 0x60], fixture.programOffset + 0x100);
      },
    );
    const branch = changed.nodes.find((node) => node.address === 0xe004)!;
    expect(branch.cpu_in.c).toBe(true);
    expect(
      changed.edges.filter((edge) => edge.from === branch.index),
    ).toMatchObject([
      { kind: "branch-not-taken", condition: { flag: "c", value: true } },
    ]);
  });
  it("retains both zero-offset conditions and rejoins their common target truthfully", async () => {
    const graph = await discover([0x90, 0, 0x08, 0x60]);
    const edges = graph.edges.filter(
      (edge) =>
        edge.from ===
        graph.nodes.find((node) => node.address === 0xe000)!.index,
    );
    expect(
      edges.map((edge) => [edge.kind, edge.target_address, edge.condition]),
    ).toEqual([
      ["branch-not-taken", 0xe002, { flag: "c", value: true }],
      ["branch-taken", 0xe002, { flag: "c", value: false }],
    ]);
    expect(edges[0]!.to).toBe(edges[1]!.to);
    expect(
      graph.nodes.find((node) => node.address === 0xe002)!.cpu_in.c,
    ).toBeNull();
    const write = graph.data_references.find(
      (ref) =>
        ref.node_index ===
          graph.nodes.find((node) => node.address === 0xe002)!.index &&
        ref.kind === "write",
    )!;
    expect(
      typeof write.value === "object" && write.value !== null
        ? write.value.mask & 1
        : write.value,
    ).toBe(0);
  });
});

describe("branch target arithmetic and evidence guards", () => {
  it("uses signed displacement and wraps the next PC before deriving branch targets", async () => {
    const negative = await discover([0x18, 0x90, 0x80]);
    const branch = negative.nodes.find((node) => node.address === 0xe001)!;
    expect(
      negative.edges.filter((edge) => edge.from === branch.index),
    ).toMatchObject([
      {
        kind: "branch-taken",
        target_address: 0xdf83,
        condition: { flag: "c", value: false },
      },
    ]);
    const wrapped = await discover(
      [],
      (fixture) => {
        fixture.bytes.set([0xd0, 1], fixture.prgOffset + fixture.prgSize - 2);
      },
      0xfffe,
    );
    expect(
      wrapped.edges.map((edge) => [
        edge.kind,
        edge.target_address,
        edge.condition,
      ]),
    ).toEqual([
      ["branch-not-taken", 0, { flag: "z", value: true }],
      ["branch-taken", 1, { flag: "z", value: false }],
    ]);
    expect(wrapped.frontiers.map((frontier) => frontier.reason)).toEqual([
      "ram-code-unmodeled",
      "ram-code-unmodeled",
    ]);
  });
  it("rejects forged branch predicates and conditions on ordinary edges", async () => {
    const valid = await discover([0x18, 0x90, 0, 0xea, 0x60]);
    for (const corrupt of [
      (graph: typeof valid) => {
        graph.edges.find((edge) => edge.kind === "branch-taken")!.condition = {
          flag: "c",
          value: true,
        };
      },
      (graph: typeof valid) => {
        graph.edges.find((edge) => edge.kind === "branch-taken")!.condition =
          null;
      },
      (graph: typeof valid) => {
        graph.edges.find((edge) => edge.kind === "fallthrough")!.condition = {
          flag: "z",
          value: true,
        };
      },
    ]) {
      const graph = structuredClone(valid);
      corrupt(graph);
      expect(nesCodeDiscoverySchema.safeParse(graph).success).toBe(false);
    }
  });
});
