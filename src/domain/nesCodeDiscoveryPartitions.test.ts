import { describe, expect, it, vi } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
  type DiscoverNesCodeInput,
} from "./nesCodeDiscovery.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";

const initial = { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 0, 1] };
function inputFor(
  fixture: ReturnType<typeof nesCodeFixture>,
  extra: Partial<DiscoverNesCodeInput> = {},
) {
  const parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw new Error("Invalid authored cartridge");
  return {
    header: parsed.value,
    prg: fixture.bytes.subarray(
      parsed.value.prgRom.offset,
      parsed.value.prgRom.offset + parsed.value.prgRom.size,
    ),
    input: discoverNesCodeInputSchema.parse({
      path: "/partitions.nes",
      initial,
      roots: [fixture.entry],
      ...extra,
    }),
  };
}
async function discover(
  fixture: ReturnType<typeof nesCodeFixture>,
  extra: Partial<DiscoverNesCodeInput> = {},
) {
  const { header, prg, input } = inputFor(fixture, extra),
    graph = nesCodeDiscoverySchema.parse(
      await discoverNesCode(header, prg, input),
    );
  if (graph.status !== "derived") throw new Error(graph.reason);
  return graph;
}
function pairedTables(copyY = false) {
  const fixture = nesCodeFixture(4, [
    0xad,
    2,
    0x20,
    0x29,
    1,
    0xaa,
    ...(copyY ? [0xa8] : []),
    0xbd,
    0,
    0xe2,
    0x85,
    0x10,
    copyY ? 0xb9 : 0xbd,
    0x10,
    0xe2,
    0x85,
    0x11,
    0x6c,
    0x10,
    0,
  ]);
  fixture.bytes.set([0x10, 0x20], fixture.programOffset + 0x200);
  fixture.bytes.set([0x80, 0x81], fixture.programOffset + 0x210);
  fixture.bytes[fixture.prgOffset + 0x10] = 0x60;
  fixture.bytes[fixture.prgOffset + 0x120] = 0x60;
  return fixture;
}
function nestedSelections() {
  const fixture = pairedTables();
  fixture.bytes.set([0, 0], fixture.programOffset + 0x200);
  fixture.bytes.set([0xe1, 0xe4], fixture.programOffset + 0x210);
  fixture.bytes.set([0x20, 0x80, 0xe1, 0x60], fixture.programOffset + 0x100);
  fixture.bytes.set(
    [0xad, 2, 0x20, 0x29, 1, 0xa8, 0xb9, 0, 0xe3, 0x60],
    fixture.programOffset + 0x180,
  );
  fixture.bytes.set([0x42, 0x43], fixture.programOffset + 0x300);
  return fixture;
}

describe("conditional index facts and shared-node evidence", () => {
  it("keeps paired table bytes and earlier concrete analyses while node facts become common", async () => {
    const fixture = pairedTables(),
      graph = await discover(fixture),
      node = graph.nodes.find((node) => node.address === 0xe006)!;
    const analyses = graph.analyses.filter(
      (analysis) => analysis.node_index === node.index,
    );
    expect(analyses.map((analysis) => analysis.cpu_in.x)).toEqual([0, 1]);
    expect(analyses.map((analysis) => analysis.refinement?.value)).toEqual([
      0, 1,
    ]);
    expect(node.cpu_in).toMatchObject({
      x: null,
      register_bits: { x: { mask: 254, value: 0 } },
    });
    expect(
      graph.edges
        .filter(
          (edge) => edge.kind === "jump" && edge.resolution === "resolved",
        )
        .map((edge) => edge.target_address)
        .sort(),
    ).toEqual([0x8010, 0x8120]);
    expect(graph.partitions).toHaveLength(3);
    for (const analysis of analyses) {
      const read = graph.data_references.find(
        (reference) =>
          reference.analysis_index === analysis.index &&
          reference.kind === "read",
      )!;
      expect(read.file_offsets).toEqual([
        fixture.programOffset + 0x200 + analysis.cpu_in.x!,
      ]);
    }
  });
  it("refines TAX/TAY copies together and does not fabricate cross-selector pointer pairs", async () => {
    const graph = await discover(pairedTables(true)),
      cases = graph.analyses.filter((analysis) => analysis.refinement !== null);
    expect(cases).toHaveLength(2);
    expect(
      cases.map((analysis) => analysis.refinement!.equal_registers),
    ).toEqual([
      ["a", "x", "y"],
      ["a", "x", "y"],
    ]);
    expect(
      cases.map((analysis) => [analysis.cpu_in.x, analysis.cpu_in.y]),
    ).toEqual([
      [0, 0],
      [1, 1],
    ]);
    expect(
      graph.edges
        .filter(
          (edge) => edge.kind === "jump" && edge.resolution === "resolved",
        )
        .map((edge) => edge.target_address)
        .sort(),
    ).toEqual([0x8010, 0x8120]);
  });
  it("overwrites a static site choice on loop reentry rather than extending path histories", async () => {
    const fixture = nesCodeFixture(
      4,
      [0xad, 2, 0x20, 0x29, 1, 0xaa, 0xbd, 0, 0xe2, 0x4c, 0, 0xe0],
    );
    fixture.bytes.set([0x42, 0x42], fixture.programOffset + 0x200);
    const graph = await discover(fixture, { max_partition_selections: 2 });
    expect(graph.termination).toBe("worklist-exhausted");
    expect(graph.partitions).toHaveLength(3);
    expect(
      graph.partitions.reduce(
        (sum, partition) => sum + partition.selections.length,
        0,
      ),
    ).toBe(2);
    expect(graph.work_items_processed).toBeLessThan(100);
  });
});

describe("lazy selector resources", () => {
  it("does not retain a selector before execution and preserves exact refinement cursors", async () => {
    const fixture = pairedTables(),
      before = await discover(fixture, { max_work_items: 4 });
    expect(before.partitions).toEqual([{ index: 0, selections: [] }]);
    expect(before.pending_refinements).toMatchObject([
      {
        partition_index: 0,
        register: "x",
        source_value: { mask: 254, value: 0 },
        next_value: 0,
      },
    ]);
    const limited = await discover(fixture, { max_partitions: 2 });
    expect(limited.termination).toBe("partition-budget");
    expect(limited.partitions).toHaveLength(2);
    expect(limited.pending_refinements[0]!.next_value).toBe(1);
    const expanded = await discover(fixture, { max_partition_selections: 1 });
    expect(expanded.termination).toBe("partition-selection-budget");
    expect(
      expanded.partitions.reduce(
        (sum, partition) => sum + partition.selections.length,
        0,
      ),
    ).toBe(1);
    expect(expanded.pending_refinements[0]!.next_value).toBe(1);
  });
  it("does not consume a return summary when its caller/callee partition merge cannot be retained", async () => {
    for (const budget of [
      { max_partitions: 5 },
      { max_partition_selections: 4 },
    ]) {
      const graph = await discover(nestedSelections(), budget);
      expect(graph.termination).toBe(
        "max_partitions" in budget
          ? "partition-budget"
          : "partition-selection-budget",
      );
      expect(graph.pending_returns).toEqual([
        { continuation_index: 0, next_summary_offset: 0 },
      ]);
      expect(
        graph.edges.some(
          (edge) => edge.kind === "return" && edge.resolution === "resolved",
        ),
      ).toBe(false);
      expect(graph.partitions).toHaveLength(5);
    }
  });
  it("rejects forged selection, equal-register and cursor identities from a produced graph", async () => {
    const valid = await discover(pairedTables(true));
    const corruptions = [
      (graph: typeof valid) => {
        graph.partitions[1]!.selections[0]!.value = 2;
      },
      (graph: typeof valid) => {
        graph.analyses.find(
          (analysis) => analysis.refinement !== null,
        )!.refinement!.equal_registers = ["x"];
      },
      (graph: typeof valid) => {
        graph.edges.find(
          (edge) => edge.resolution === "resolved",
        )!.target_partition_index = graph.partitions.length;
      },
    ];
    for (const corrupt of corruptions) {
      const broken = structuredClone(valid);
      corrupt(broken);
      expect(nesCodeDiscoverySchema.safeParse(broken).success).toBe(false);
    }
    const pending = await discover(pairedTables(), { max_work_items: 4 });
    pending.pending_refinements[0]!.node_index = pending.nodes.length;
    expect(nesCodeDiscoverySchema.safeParse(pending).success).toBe(false);
  });
});

describe("stack qualification during conditional indexing", () => {
  it("conditions TSX copies without overwriting opaque entry qualification or inventing return bytes", async () => {
    const fixture = nesCodeFixture(4, [0x20, 0, 0xe1, 0x60]);
    fixture.bytes.set(
      [0xba, 0xbd, 0, 0xe2, 0x60],
      fixture.programOffset + 0x100,
    );
    fixture.bytes.fill(
      0xaa,
      fixture.programOffset + 0x200,
      fixture.programOffset + 0x300,
    );
    const graph = await discover(fixture),
      cases = graph.analyses.filter((analysis) => analysis.refinement !== null);
    expect(cases).toHaveLength(256);
    expect(graph.return_summaries).toHaveLength(256);
    for (const summary of graph.return_summaries) {
      expect(summary).toMatchObject({
        stack_target: 0xe003,
        return_proof: "relative-bytes",
        frame: { kind: "opaque", entry_sp: null, relative_sp: 2, intact: true },
      });
    }
    for (const analysis of cases) {
      expect(analysis.refinement!.equal_registers).toEqual(["x", "sp"]);
      expect(analysis.cpu_in.sp).toBe(analysis.cpu_in.x);
    }
    expect(graph.write_witnesses).toEqual([]);
  });
  it("treats LAS as an actual SP assignment rather than selector conditioning", async () => {
    const unknown = nesCodeFixture(4, [0x20, 0, 0xe1, 0x60]);
    unknown.bytes.set(
      [0xa0, 0, 0xbb, 0, 0xe2, 0x60],
      unknown.programOffset + 0x100,
    );
    unknown.bytes[unknown.programOffset + 0x200] = 0xff;
    const stopped = await discover(unknown);
    expect(stopped.return_summaries).toEqual([]);
    expect(
      stopped.frontiers.some(
        (frontier) => frontier.reason === "return-frame-unresolved",
      ),
    ).toBe(true);
    const known = nesCodeFixture(4, [0xa2, 0xfd, 0x9a, 0x20, 0, 0xe1, 0x60]);
    known.bytes.set(
      [
        0xa9, 5, 0x8d, 0xf1, 1, 0xa9, 0xe0, 0x8d, 0xf2, 1, 0xa0, 0, 0xbb, 0,
        0xe2, 0x60,
      ],
      known.programOffset + 0x100,
    );
    known.bytes[known.programOffset + 0x200] = 0xf0;
    const returned = await discover(known);
    expect(returned.return_summaries[0]).toMatchObject({
      stack_target: 0xe006,
      cpu_out: { sp: 0xf2 },
      frame: { kind: "physical", entry_sp: 0xfb, relative_sp: 247 },
    });
  });
  it("cancels between real full-byte refinement batches", async () => {
    const fixture = nesCodeFixture(4, [0x20, 0, 0xe1, 0x60]);
    fixture.bytes.set(
      [0xba, 0xbd, 0, 0xe2, 0x60],
      fixture.programOffset + 0x100,
    );
    const { header, prg, input } = inputFor(fixture),
      controller = new AbortController(),
      checks = vi.spyOn(controller.signal, "throwIfAborted"),
      pending = discoverNesCode(header, prg, input, {
        signal: controller.signal,
      });
    setImmediate(() => setImmediate(() => controller.abort()));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(checks.mock.calls.length).toBeGreaterThan(128);
  });
});
