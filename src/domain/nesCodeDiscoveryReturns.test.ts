import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
  type DiscoverNesCodeInput,
} from "./nesCodeDiscovery.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";

const initial = { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 0, 1] };
async function discover(
  fixture: ReturnType<typeof nesCodeFixture>,
  extra: Partial<DiscoverNesCodeInput> = {},
) {
  const parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw new Error("Invalid authored cartridge");
  const header = parsed.value,
    input = discoverNesCodeInputSchema.parse({
      path: "/returns.nes",
      initial,
      roots: [fixture.entry],
      ...extra,
    });
  const graph = nesCodeDiscoverySchema.parse(
    await discoverNesCode(
      header,
      fixture.bytes.subarray(
        header.prgRom.offset,
        header.prgRom.offset + header.prgRom.size,
      ),
      input,
    ),
  );
  if (graph.status !== "derived") throw new Error(graph.reason);
  return graph;
}

describe("invocation-matched returned state", () => {
  it("propagates nested callee mapper, CPU and RAM effects into the caller", async () => {
    const fixture = nesCodeFixture(
      4,
      [0x20, 0, 0xe1, 0x85, 0x11, 0xa5, 0x10, 0x4c, 0, 0x80],
    );
    fixture.bytes.set([0x20, 0x80, 0xe1, 0x60], fixture.programOffset + 0x100);
    fixture.bytes.set(
      [0xa9, 3, 0x8d, 1, 0x80, 0xa9, 0x44, 0x85, 0x10, 0x60],
      fixture.programOffset + 0x180,
    );
    fixture.bytes[fixture.prgOffset + 3 * 8192] = 0x60;
    const graph = await discover(fixture);
    const callerStore = graph.nodes.find((node) => node.address === 0xe003)!;
    expect(callerStore.cpu_in.a).toBe(0x44);
    expect(
      graph.data_references.find(
        (ref) => ref.node_index === callerStore.index && ref.kind === "write",
      ),
    ).toMatchObject({ address: 0x11, value: 0x44 });
    const source = graph.data_references.find(
      (ref) => ref.address === 0x10 && ref.kind === "read",
    )!;
    expect(source.value).toBe(0x44);
    expect(
      source.ram_origins[0]!.writer_nodes.map(
        (index) => graph.nodes[index]!.address,
      ),
    ).toEqual([0xe187]);
    expect(
      graph.nodes.find((node) => node.address === 0x8000)!.file_offsets,
    ).toEqual([fixture.prgOffset + 3 * 8192]);
    expect(graph.invocations).toHaveLength(3);
    expect(
      graph.edges.filter(
        (edge) => edge.kind === "return" && edge.resolution === "resolved",
      ),
    ).toHaveLength(2);
  });

  it("keeps different callers' input values and returned RAM facts separate", async () => {
    const fixture = nesCodeFixture(4, [0xd0, 0x1e]);
    fixture.bytes.set(
      [0xa9, 1, 0x20, 0, 0xe1, 0xa5, 0x10, 0x60],
      fixture.programOffset + 2,
    );
    fixture.bytes.set(
      [0xa9, 2, 0x20, 0, 0xe1, 0xa5, 0x10, 0x60],
      fixture.programOffset + 0x20,
    );
    fixture.bytes.set([0x85, 0x10, 0x60], fixture.programOffset + 0x100);
    const graph = await discover(fixture);
    expect(graph.nodes.filter((node) => node.address === 0xe100)).toHaveLength(
      2,
    );
    expect(graph.nodes.find((node) => node.address === 0xe007)!.cpu_out.a).toBe(
      1,
    );
    expect(graph.nodes.find((node) => node.address === 0xe025)!.cpu_out.a).toBe(
      2,
    );
    for (const edge of graph.edges.filter(
      (edge) => edge.kind === "return" && edge.resolution === "resolved",
    )) {
      const binding = graph.continuations[edge.continuation_index!]!,
        summary = graph.return_summaries[edge.summary_index!]!;
      expect(summary.invocation_index).toBe(binding.callee_invocation_index);
      expect(edge.target_invocation_index).toBe(
        binding.caller_invocation_index,
      );
      expect(edge.target_address).toBe(binding.return_address);
    }
  });

  it("preserves conditional returned bank states rather than joining bank registers independently", async () => {
    const fixture = nesCodeFixture(4, [0x20, 0, 0xe1, 0x4c, 0, 0x80]);
    fixture.bytes.set(
      [0xd0, 6, 0xa9, 2, 0x8d, 1, 0x80, 0x60, 0xa9, 3, 0x8d, 1, 0x80, 0x60],
      fixture.programOffset + 0x100,
    );
    fixture.bytes[fixture.prgOffset + 2 * 8192] = 0x60;
    fixture.bytes[fixture.prgOffset + 3 * 8192] = 0x60;
    const graph = await discover(fixture);
    expect(
      graph.nodes
        .filter((node) => node.address === 0x8000)
        .map((node) => node.file_offsets[0])
        .sort((a, b) => a! - b!),
    ).toEqual([fixture.prgOffset + 2 * 8192, fixture.prgOffset + 3 * 8192]);
    expect(
      graph.return_summaries
        .map((summary) => graph.contexts[summary.context_index]!.state)
        .filter((state) => state.mapper === 4)
        .map((state) => state.banks[6])
        .sort(),
    ).toEqual([2, 3]);
  });
});

describe("physical and opaque return integrity", () => {
  it("records actual known-SP JSR pushes and RTS reads with stable write witnesses", async () => {
    const fixture = nesCodeFixture(
      4,
      [0xa2, 0xfd, 0x9a, 0x20, 0, 0xe1, 0xa5, 0x10, 0x60],
    );
    fixture.bytes.set(
      [0xa9, 0x66, 0x85, 0x10, 0x60],
      fixture.programOffset + 0x100,
    );
    const graph = await discover(fixture),
      summary = graph.return_summaries[0]!;
    expect(summary).toMatchObject({
      stack_target: 0xe006,
      return_proof: "physical-bytes",
      cpu_out: { sp: 0xfd },
      frame: { kind: "physical", entry_sp: 0xfb },
    });
    const call = graph.nodes.find((node) => node.address === 0xe003)!;
    expect(
      graph.data_references
        .filter((ref) => ref.node_index === call.index && ref.kind === "write")
        .map((ref) => [ref.address, ref.value]),
    ).toEqual([
      [0x1fd, 0xe0],
      [0x1fc, 5],
    ]);
    const reads = graph.data_references.filter(
      (ref) =>
        ref.node_index === summary.return_node_index && ref.kind === "read",
    );
    expect(reads.map((ref) => [ref.address, ref.value])).toEqual([
      [0x1fc, 5],
      [0x1fd, 0xe0],
    ]);
    for (const ref of reads) {
      expect(ref.ram_origins[0]!.writer_nodes).toEqual([call.index]);
      expect(ref.ram_origins[0]!.writer_witness_indices).toHaveLength(1);
    }
  });

  it("follows a rewritten physical target within its callee and rejects an unqualified opaque frame write", async () => {
    const physical = nesCodeFixture(4, [0xa2, 0xfd, 0x9a, 0x20, 0, 0xe1, 0x60]);
    physical.bytes.set(
      [0xa9, 0x22, 0x8d, 0xfc, 1, 0x60],
      physical.programOffset + 0x100,
    );
    const known = await discover(physical);
    const jump = known.edges.find(
      (edge) => edge.kind === "stack-jump" && edge.target_address === 0xe023,
    )!;
    expect(jump).toMatchObject({
      resolution: "resolved",
      continuation_index: null,
      summary_index: null,
    });
    expect(jump.target_invocation_index).toBe(
      known.nodes[jump.from]!.invocation_index,
    );
    expect(
      known.frontiers.some(
        (frontier) =>
          frontier.address === 0xe023 &&
          frontier.reason === "unsupported-opcode",
      ),
    ).toBe(true);
    expect(known.nodes.some((node) => node.address === 0xe006)).toBe(false);
    const opaque = nesCodeFixture(4, [0x20, 0, 0xe1, 0x60]);
    opaque.bytes.set(
      [0xa9, 0x22, 0x8d, 0, 1, 0x60],
      opaque.programOffset + 0x100,
    );
    const unknown = await discover(opaque);
    expect(unknown.return_summaries).toEqual([]);
    expect(
      unknown.frontiers.some(
        (frontier) => frontier.reason === "return-frame-unresolved",
      ),
    ).toBe(true);
    expect(unknown.nodes.some((node) => node.address === 0xe003)).toBe(false);
  });

  it("conditions recursive flags so only the original feasible base case returns", async () => {
    const fixture = nesCodeFixture(4, [0x20, 0, 0xe1, 0x60]);
    fixture.bytes.set(
      [0xd0, 4, 0x20, 0, 0xe1, 0x60, 0x60],
      fixture.programOffset + 0x100,
    );
    const graph = await discover(fixture, { max_work_items: 2000 });
    expect(graph.termination).toBe("worklist-exhausted");
    expect(graph.invocations.length).toBeGreaterThan(2);
    expect(graph.invocations.length).toBeLessThanOrEqual(130);
    expect(graph.continuations.length).toBeGreaterThan(2);
    expect(graph.nodes.some((node) => node.address === 0xe003)).toBe(true);
    expect(
      graph.frontiers.some(
        (frontier) => frontier.reason === "return-frame-unresolved",
      ),
    ).toBe(true);
    expect(graph.write_witnesses).toEqual([]);
    expect(graph.work_items_processed).toBeLessThan(2000);
    expect(graph.pending).toEqual([]);
    expect(graph.pending_returns).toEqual([]);
    expect(graph.return_summaries).toHaveLength(1);
    expect(graph.nodes.filter((node) => node.address === 0xe106)).toHaveLength(
      1,
    );
    expect(graph.nodes.some((node) => node.address === 0xe105)).toBe(false);
    for (const invocation of graph.invocations.filter(
      (invocation) =>
        invocation.entry_address === 0xe100 && invocation.cpu_in.z !== null,
    ))
      expect(invocation.cpu_in.z).toBe(true);
    for (const edge of graph.edges.filter(
      (edge) => edge.kind === "return" && edge.resolution === "resolved",
    )) {
      const binding = graph.continuations[edge.continuation_index!]!;
      expect(edge.target_address).toBe(binding.return_address);
      expect(edge.target_invocation_index).toBe(
        binding.caller_invocation_index,
      );
    }
  });
});

describe("relative stack and evidence boundaries", () => {
  it("preserves balanced opaque nested stack bytes without inventing physical addresses", async () => {
    const fixture = nesCodeFixture(4, [0xa9, 0x55, 0x20, 0, 0xe1, 0x60]);
    fixture.bytes.set(
      [0x48, 0x20, 0x80, 0xe1, 0x68, 0x60],
      fixture.programOffset + 0x100,
    );
    fixture.bytes[fixture.programOffset + 0x180] = 0x60;
    const balanced = await discover(fixture);
    expect(
      balanced.nodes.find((node) => node.address === 0xe005)!.cpu_in.a,
    ).toBe(0x55);
    expect(
      balanced.edges.filter(
        (edge) => edge.kind === "return" && edge.resolution === "resolved",
      ),
    ).toHaveLength(2);
    expect(balanced.write_witnesses).toEqual([]);
    fixture.bytes.set([0x48, 0x60], fixture.programOffset + 0x100);
    const unbalanced = await discover(fixture);
    expect(unbalanced.nodes.some((node) => node.address === 0xe005)).toBe(
      false,
    );
    expect(
      unbalanced.frontiers.some(
        (frontier) =>
          frontier.reason === "ram-code-unmodeled" &&
          frontier.address === 0x0456,
      ),
    ).toBe(true);
  });

  it("follows a root's physically proven stack jump without claiming a matched caller", async () => {
    const fixture = nesCodeFixture(
      4,
      [
        0xa2, 0xfd, 0x9a, 0xa9, 0x1f, 0x8d, 0xfe, 1, 0xa9, 0xe0, 0x8d, 0xff, 1,
        0x60,
      ],
    );
    fixture.bytes.set([0xea, 0x60], fixture.programOffset + 0x20);
    const graph = await discover(fixture);
    expect(
      graph.edges.find((edge) => edge.kind === "stack-jump"),
    ).toMatchObject({
      resolution: "resolved",
      target_address: 0xe020,
      continuation_index: null,
      summary_index: null,
    });
    expect(graph.return_summaries).toEqual([]);
    expect(graph.nodes.find((node) => node.address === 0xe020)!.cpu_in.sp).toBe(
      0xff,
    );
  });

  it("uses actual restored SP and RAM bytes while retaining opaque entry qualification", async () => {
    const fixture = nesCodeFixture(4, [0x20, 0, 0xe1, 0x60]);
    fixture.bytes.set(
      [
        0xa2, 0xfd, 0x9a, 0xa9, 2, 0x8d, 0xfe, 1, 0xa9, 0xe0, 0x8d, 0xff, 1,
        0x60,
      ],
      fixture.programOffset + 0x100,
    );
    const graph = await discover(fixture);
    const summary = graph.return_summaries[0]!;
    expect(graph.invocations[summary.invocation_index]!.frame.kind).toBe(
      "opaque",
    );
    expect(summary).toMatchObject({
      stack_target: 0xe003,
      return_proof: "physical-bytes",
      cpu_out: { sp: 0xff },
      frame: { kind: "opaque", intact: false, relative_sp: null },
    });
    const reads = graph.data_references.filter(
      (reference) =>
        reference.analysis_index === summary.return_analysis_index &&
        reference.kind === "read",
    );
    expect(
      reads.map((reference) => [reference.address, reference.value]),
    ).toEqual([
      [0x1fe, 2],
      [0x1ff, 0xe0],
    ]);
    expect(
      graph.edges.find((edge) => edge.summary_index === summary.index),
    ).toMatchObject({
      kind: "return",
      resolution: "resolved",
      target_address: 0xe003,
    });
  });

  it("derives the callee's post-JSR SP domain from each actual input byte", async () => {
    const fixture = nesCodeFixture(
      4,
      [0xd0, 5, 0xa2, 0, 0x4c, 9, 0xe0, 0xa2, 2, 0x9a, 0x20, 0, 0xe1, 0x60],
    );
    fixture.bytes[fixture.programOffset + 0x100] = 0x60;
    const graph = await discover(fixture);
    const calls = graph.analyses.filter(
      (analysis) => graph.nodes[analysis.node_index]!.address === 0xe00a,
    );
    expect(
      calls.some(
        (analysis) =>
          "register_bits" in analysis.cpu_in &&
          analysis.cpu_in.register_bits.sp !== undefined,
      ),
    ).toBe(true);
    const values = (index: number) => {
      const bitmap = BigInt(`0x${graph.byte_domains[index]!.bitmap_hex}`);
      return Array.from({ length: 256 }, (_, value) => value).filter(
        (value) => (bitmap & (1n << BigInt(value))) !== 0n,
      );
    };
    for (const analysis of calls)
      expect(values(analysis.register_domains_out.sp)).toEqual(
        values(analysis.register_domains_in.sp)
          .map((value) => (value - 2) & 255)
          .sort((a, b) => a - b),
      );
    expect(
      calls.find((analysis) => analysis.cpu_out.sp === null)?.cpu_out,
    ).toMatchObject({ register_bits: { sp: { mask: 1, value: 0 } } });
  });
});

describe("returned-state evidence ownership", () => {
  it("rejects forged matching, snapshot and write-witness identities in an actual returned graph", async () => {
    const fixture = nesCodeFixture(
      4,
      [0xa2, 0xfd, 0x9a, 0x20, 0, 0xe1, 0xa5, 0x10, 0x60],
    );
    fixture.bytes.set(
      [0xa9, 0x66, 0x85, 0x10, 0x60],
      fixture.programOffset + 0x100,
    );
    const valid = await discover(fixture);
    const corruptions = [
      (value: typeof valid) => {
        value.continuations[0]!.callee_invocation_index =
          value.invocations.length;
      },
      (value: typeof valid) => {
        value.return_summaries[0]!.ram_out[0] = value.ram_pages.length;
      },
      (value: typeof valid) => {
        value.ram_pages[0]!.cells[0]!.writer_witness_indices = [
          value.write_witnesses.length,
        ];
      },
      (value: typeof valid) => {
        value.write_witnesses[0]!.analysis_indices = [value.analyses.length];
      },
      (value: typeof valid) => {
        value.edges.find(
          (edge) => edge.kind === "return" && edge.resolution === "resolved",
        )!.summary_index = null;
      },
    ];
    for (const corrupt of corruptions) {
      const broken = structuredClone(valid);
      corrupt(broken);
      expect(nesCodeDiscoverySchema.safeParse(broken).success).toBe(false);
    }
  });
});

describe("tabulation resource frontiers", () => {
  it("retains invocation, continuation and lazy return-delivery budget frontiers", async () => {
    const fixture = nesCodeFixture(4, [0x20, 0, 0xe1, 0x60]);
    fixture.bytes.set([0x20, 0x80, 0xe1, 0x60], fixture.programOffset + 0x100);
    fixture.bytes[fixture.programOffset + 0x180] = 0x60;
    const invocations = await discover(fixture, { max_invocations: 1 });
    expect(invocations.termination).toBe("invocation-budget");
    expect(
      invocations.frontiers.some(
        (frontier) => frontier.reason === "invocation-budget",
      ),
    ).toBe(true);
    const continuations = await discover(fixture, { max_continuations: 1 });
    expect(continuations.termination).toBe("continuation-budget");
    expect(continuations.continuations).toHaveLength(1);
    expect(continuations.nodes.some((node) => node.address === 0xe003)).toBe(
      false,
    );
    const pending = await discover(fixture, { max_work_items: 3 });
    expect(pending.termination).toBe("work-item-budget");
    expect(pending.pending_returns).toEqual([
      { continuation_index: 1, next_summary_offset: 0 },
    ]);
    expect(pending.pending).toEqual([]);
    expect(pending.nodes.some((node) => node.address === 0xe103)).toBe(false);
  });
});
