import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
  type DiscoverNesCodeInput,
} from "./nesCodeDiscovery.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";

async function discover(
  fixture: ReturnType<typeof nesCodeFixture>,
  extra: Partial<DiscoverNesCodeInput> = {},
) {
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
        path: "/relative-stack.nes",
        initial: { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 0, 1] },
        roots: [fixture.entry],
        ...extra,
      }),
    ),
  );
  if (graph.status !== "derived") throw new Error(graph.reason);
  return graph;
}
function dispatchFixture() {
  const fixture = nesCodeFixture(4, [0x20, 0, 0xe1, 0x85, 0x10, 0x60]);
  fixture.bytes.set(
    [0xa9, 0xe1, 0x48, 0xa9, 0x7f, 0x48, 0x60],
    fixture.programOffset + 0x100,
  );
  fixture.bytes.set([0xa9, 0x55, 0x60], fixture.programOffset + 0x180);
  return fixture;
}

describe("unknown physical SP and actual relative stack bytes", () => {
  it("follows PHA/PHA/RTS into a handler and matches the handler's later caller return", async () => {
    const graph = await discover(dispatchFixture());
    const summaries = graph.return_summaries;
    expect(
      summaries.map((summary) => [
        graph.nodes[summary.return_node_index]!.address,
        summary.stack_target,
        summary.return_proof,
      ]),
    ).toEqual([
      [0xe106, 0xe180, "relative-bytes"],
      [0xe182, 0xe003, "relative-bytes"],
    ]);
    const computed = graph.edges.find((edge) => edge.kind === "stack-jump")!;
    expect(computed).toMatchObject({
      target_address: 0xe180,
      continuation_index: null,
      summary_index: null,
    });
    expect(computed.target_invocation_index).toBe(
      graph.nodes[computed.from]!.invocation_index,
    );
    const returned = graph.edges.find(
      (edge) => edge.kind === "return" && edge.resolution === "resolved",
    )!;
    expect(returned).toMatchObject({
      target_address: 0xe003,
      continuation_index: 0,
      summary_index: 1,
    });
    expect(
      graph.nodes.find((node) => node.address === 0xe003)!.cpu_in,
    ).toMatchObject({ a: 0x55, sp: null });
    const reads = graph.data_references.filter(
      (ref) =>
        ref.analysis_index === summaries[0]!.return_analysis_index &&
        ref.kind === "read",
    );
    expect(
      reads.map((ref) => [ref.address, ref.value, ref.ram_origins]),
    ).toEqual([
      [null, 0x7f, []],
      [null, 0xe1, []],
    ]);
    expect(
      reads.map((ref) =>
        ref.relative_stack_origins[0]!.writer_nodes.map(
          (index) => graph.nodes[index]!.address,
        ),
      ),
    ).toEqual([[0xe105], [0xe102]]);
    expect(
      reads.every((ref) => ref.relative_stack_origins[0]!.offset === 0),
    ).toBe(true);
    expect(
      graph.write_witnesses.map((witness) => [witness.address, witness.value]),
    ).toEqual([[0x10, 0x55]]);
    expect(graph.relative_stack_write_witnesses).toHaveLength(4);
  });
  it("restores partial PHP/PLP flags and PHA/PLA bytes through an unknown-SP ring", async () => {
    const fixture = nesCodeFixture(
      4,
      [
        0x38, 0xa9, 0x80, 0x08, 0x18, 0xa9, 0, 0x28, 0x48, 0xa9, 0x44, 0x68,
        0x60,
      ],
    );
    const graph = await discover(fixture);
    expect(
      graph.nodes.find((node) => node.address === 0xe008)!.cpu_in,
    ).toMatchObject({ c: true, n: true, z: false });
    expect(graph.nodes.find((node) => node.address === 0xe00c)!.cpu_in.a).toBe(
      0,
    );
    const status = graph.data_references.find(
      (ref) =>
        ref.node_index ===
        graph.nodes.find((node) => node.address === 0xe007)!.index,
    )!;
    expect(status.value).toMatchObject({ value: 0xb1 });
    expect(status.address).toBeNull();
    expect(
      status.relative_stack_origins[0]!.writer_nodes.map(
        (index) => graph.nodes[index]!.address,
      ),
    ).toEqual([0xe003]);
  });
  it("clears relative facts on unlocated SP assignments and unknown absolute writes", async () => {
    for (const program of [
      [0xa9, 0x55, 0x48, 0xa2, 0x80, 0x9a, 0x68, 0x60],
      [0xa9, 0x55, 0x48, 0xa0, 0, 0xbb, 0, 0xe2, 0x68, 0x60],
      [0xa9, 0x55, 0x48, 0xa9, 0x22, 0x8d, 0, 9, 0x68, 0x60],
      [0xa9, 0x55, 0x48, 0xa0, 0, 0x91, 0x10, 0x68, 0x60],
    ]) {
      const fixture = nesCodeFixture(4, program);
      fixture.bytes[fixture.programOffset + 0x200] = 0xff;
      const graph = await discover(fixture);
      const pop = graph.nodes.find((node) => node.mnemonic === "PLA")!;
      expect(pop.cpu_out.a).toBeNull();
      const read = graph.data_references.find(
        (ref) => ref.node_index === pop.index && ref.kind === "read",
      )!;
      expect(read.relative_stack_origins).toEqual([]);
    }
  });
  it("reaches a recursive value fixed point after the finite stack ring wraps", async () => {
    const fixture = nesCodeFixture(4, [0x20, 0, 0xe1, 0x60]);
    fixture.bytes.set([0x20, 0, 0xe1, 0x60], fixture.programOffset + 0x100);
    const graph = await discover(fixture, { max_work_items: 1000 });
    expect(graph.termination).toBe("worklist-exhausted");
    expect(graph.invocations.length).toBeGreaterThan(128);
    expect(graph.invocations.length).toBeLessThanOrEqual(130);
    expect(graph.work_items_processed).toBeLessThan(300);
    expect(graph.return_summaries).toEqual([]);
    expect(graph.nodes.some((node) => node.address === 0xe003)).toBe(false);
    expect(graph.relative_stack_write_witnesses.length).toBeLessThan(300);
    const limited = await discover(fixture, { max_invocations: 8 });
    expect(limited.termination).toBe("invocation-budget");
    expect(limited.invocations).toHaveLength(8);
  });
});

describe("relative stack aliases and retained evidence", () => {
  it("uses known-SP RAM mirrors coherently after the unknown-SP owner is reset", async () => {
    const fixture = nesCodeFixture(
      4,
      [
        0xa9, 0x55, 0x48, 0xa2, 0xfd, 0x9a, 0xa9, 0x66, 0x8d, 0xfe, 9, 0x68,
        0x60,
      ],
    );
    const graph = await discover(fixture);
    expect(graph.nodes.find((node) => node.address === 0xe00b)!.cpu_out.a).toBe(
      0x66,
    );
    const read = graph.data_references.find(
      (ref) =>
        ref.node_index ===
          graph.nodes.find((node) => node.address === 0xe00b)!.index &&
        ref.kind === "read",
    )!;
    expect(read).toMatchObject({
      address: 0x1fe,
      value: 0x66,
      ram_origins: [{ ram_address: 0x1fe }],
      relative_stack_origins: [{ offset: 0 }],
    });
    expect(
      read.relative_stack_origins[0]!.writer_nodes.map(
        (index) => graph.nodes[index]!.address,
      ),
    ).toEqual([0xe008]);
  });
  it("rejects forged relative writer, snapshot and computed-target proofs from a produced graph", async () => {
    const valid = await discover(dispatchFixture());
    const corruptions = [
      (graph: typeof valid) => {
        graph.relative_stack_pages[0]!.cells[0]!.writer_witness_indices = [
          graph.relative_stack_write_witnesses.length,
        ];
      },
      (graph: typeof valid) => {
        graph.analyses[0]!.relative_stack_out[0] =
          graph.relative_stack_pages.length;
      },
      (graph: typeof valid) => {
        graph.return_summaries[0]!.stack_target = 0xe181;
      },
      (graph: typeof valid) => {
        graph.data_references.find(
          (ref) => ref.relative_stack_origins.length > 0,
        )!.relative_stack_origins[0]!.writer_witness_indices = [
          graph.relative_stack_write_witnesses.length,
        ];
      },
    ];
    for (const corrupt of corruptions) {
      const graph = structuredClone(valid);
      corrupt(graph);
      expect(nesCodeDiscoverySchema.safeParse(graph).success).toBe(false);
    }
  });
});
