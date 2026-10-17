import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoverySchema,
  type DiscoverNesCodeInput,
} from "./nesCodeDiscovery.js";
import { discoverNesCode } from "./nesCodeDiscoveryDerivation.js";
import { initialNesDiscoveryGraph } from "./nesCodeDiscoveryGraph.js";
import { NesDiscoveryValueBudget } from "./nesCodeDiscoveryValueBudget.js";
import { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import { NesDiscoveryEvidence } from "./nesCodeDiscoveryEvidence.js";
import { NesDiscoveryRelativeEvidence } from "./nesCodeDiscoveryRelativeEvidence.js";
import { NesDiscoveryConditionEvidence } from "./nesCodeDiscoveryConditionEvidence.js";
import { NesDiscoveryValueEvidence } from "./nesCodeDiscoveryValueEvidence.js";
import {
  assignNesDiscoveryValue,
  emptyNesDiscoveryValues,
} from "./nesCodeDiscoveryValues.js";
import {
  emptyNesDiscoveryRam,
  writeNesDiscoveryRam,
} from "./nesCodeDiscoveryRam.js";

function registries(maximum: number) {
  const graph = initialNesDiscoveryGraph(),
    budget = new NesDiscoveryValueBudget(graph, maximum),
    domains = new NesDiscoveryDomainEvidence(graph, budget),
    physical = new NesDiscoveryEvidence(graph, domains, budget),
    relative = new NesDiscoveryRelativeEvidence(graph, domains, budget),
    conditions = new NesDiscoveryConditionEvidence(graph, budget),
    values = new NesDiscoveryValueEvidence(graph, domains, physical, budget);
  return { graph, budget, domains, physical, relative, conditions, values };
}
type Registries = ReturnType<typeof registries>;
function seedRegistries(owner: Registries) {
  const { budget, domains, physical, relative, conditions, values } = owner,
    all = domains.domain((1n << 256n) - 1n),
    one = domains.domain(2n),
    writer = physical.write({
      node_index: 0,
      analysis_index: 0,
      address: 16,
      domain: 2n,
    }),
    source = {
      node_index: 0,
      register: "a" as const,
      kind: "result" as const,
      operand: null,
    },
    condition = {
      node_index: 0,
      kind: "index" as const,
      variable: 1 as const,
      value: 1,
      source_domain_index: all,
      result_domain_index: one,
    };
  relative.write({ node_index: 0, analysis_index: 0, offset: 0, domain: 2n });
  domains.source({ ...source, analysis_index: 0 });
  conditions.condition(condition, 0);
  const state = assignNesDiscoveryValue(emptyNesDiscoveryValues(), 20, 2n),
    ram = writeNesDiscoveryRam(emptyNesDiscoveryRam(), 16, {
      writer_witness_indices: [writer],
      initial_unwritten_possible: false,
      unknown_write_possible: false,
    });
  values.snapshot(state, ram);
  assert.equal(budget.failed, false);
  return {
    source,
    condition,
    state,
    ram,
    next: assignNesDiscoveryValue(state, 21, 4n),
  };
}
function extendRegistries(
  owner: Registries,
  seed: ReturnType<typeof seedRegistries>,
) {
  const { physical, relative, domains, conditions, values } = owner;
  physical.write({ node_index: 0, analysis_index: 1, address: 16, domain: 2n });
  relative.write({ node_index: 0, analysis_index: 1, offset: 0, domain: 2n });
  domains.source({ ...seed.source, analysis_index: 1 });
  conditions.condition(seed.condition, 1);
  const writer = physical.write({
    node_index: 0,
    analysis_index: 1,
    address: 17,
    domain: 4n,
  });
  relative.write({ node_index: 0, analysis_index: 1, offset: 1, domain: 4n });
  domains.source({ ...seed.source, register: "x", analysis_index: 1 });
  conditions.condition(
    { ...seed.condition, value: 2, result_domain_index: domains.domain(4n) },
    1,
  );
  return values.snapshot(
    seed.next,
    writeNesDiscoveryRam(seed.ram, 17, {
      writer_witness_indices: [writer],
      initial_unwritten_possible: false,
      unknown_write_possible: false,
    }),
  );
}

async function derive(
  program: readonly number[],
  limits: Partial<DiscoverNesCodeInput>,
  callee?: readonly number[],
) {
  const fixture = nesCodeFixture(4, program);
  if (callee !== undefined)
    fixture.bytes.set(callee, fixture.programOffset + 0x100);
  fixture.bytes.set([0x31, 0x42], fixture.programOffset + 0x300);
  const parsed = parseNesHeader(fixture.bytes);
  assert.ok(parsed.ok);
  const header = parsed.value,
    graph = nesCodeDiscoverySchema.parse(
      await discoverNesCode(
        header,
        fixture.bytes.subarray(
          header.prgRom.offset,
          header.prgRom.offset + header.prgRom.size,
        ),
        discoverNesCodeInputSchema.parse({
          path: "/value-capacity.nes",
          roots: [fixture.entry],
          initial: {
            mapper: 4,
            bank_select: 6,
            banks: [0, 2, 4, 5, 6, 7, 0, 1],
          },
          ...limits,
        }),
      ),
    );
  if (graph.status !== "derived") throw Error(graph.reason);
  return graph;
}
type Graph = Awaited<ReturnType<typeof derive>>;
const evidencePools = (graph: Graph) => ({
  value_state_records: graph.value_state_records,
  byte_domains: graph.byte_domains,
  flag_predicate_sources: graph.flag_predicate_sources,
  value_pages: graph.value_pages,
  value_snapshots: graph.value_snapshots,
  condition_witnesses: graph.condition_witnesses,
  ram_pages: graph.ram_pages,
  write_witnesses: graph.write_witnesses,
  relative_stack_pages: graph.relative_stack_pages,
  relative_stack_write_witnesses: graph.relative_stack_write_witnesses,
});

describe("atomic discovery value-state capacity", () => {
  it("rolls back shared registry supports, maps and snapshot caches, then reuses the same owners", () => {
    const probe = registries(1_000_000),
      seed = seedRegistries(probe);
    assert.ok(probe.budget.run(() => extendRegistries(probe, seed)).ok);
    const owner = registries(probe.graph.value_state_records),
      current = seedRegistries(owner),
      before = structuredClone(owner.graph);
    const rejected = owner.budget.run(() => {
      extendRegistries(owner, current);
      // One further actual domain allocation crosses the measured retained cost.
      owner.domains.domain(8n);
    });
    expect(rejected).toEqual({
      ok: false,
      error: { kind: "value-state-budget" },
    });
    expect(owner.graph).toEqual(before);
    owner.budget.failed = false;
    const retried = owner.budget.run(() => extendRegistries(owner, current));
    assert.ok(retried.ok);
    expect(owner.graph).toEqual(probe.graph);
    expect(owner.graph.value_snapshots[retried.value]).toBeDefined();
    for (const witness of [
      owner.graph.write_witnesses[0],
      owner.graph.relative_stack_write_witnesses[0],
      owner.graph.flag_predicate_sources[0],
      owner.graph.condition_witnesses[0],
    ])
      expect(witness?.analysis_indices).toEqual([0, 1]);
  });

  it("commits both conditioned branch successors together or retains the original work item", async () => {
    const program = [0xa5, 0, 0xc9, 5, 0x90, 2, 0x02, 0x02, 0x02],
      prefix = await derive(program, { max_work_items: 2 }),
      complete = await derive(program, { max_work_items: 3 });
    expect(
      complete.edges.filter((edge) => edge.condition !== null),
    ).toHaveLength(2);
    assert.ok(complete.value_state_records > prefix.value_state_records);
    const limited = await derive(program, {
      max_work_items: 3,
      max_value_state_records: complete.value_state_records - 1,
    });
    expect(limited.termination).toBe("value-state-budget");
    expect(limited.analyses).toEqual(prefix.analyses);
    const branch = limited.nodes.find((node) => node.address === 0xe004);
    assert.ok(branch);
    expect(branch.bytes_hex).toBe("9002");
    // Its original bytes were decoded before capacity admission; an existing
    // incoming edge can name that node without claiming an executed analysis.
    expect(limited.edges).toEqual(
      prefix.edges.map((edge) => ({
        ...edge,
        to: edge.target_address === 0xe004 ? branch.index : edge.to,
      })),
    );
    expect(limited.edges.filter((edge) => edge.from === branch.index)).toEqual(
      [],
    );
    expect(evidencePools(limited)).toEqual(evidencePools(prefix));
    expect(limited.pending).toEqual(prefix.pending);
    expect(limited.pending[0]?.address).toBe(0xe004);
  });

  it("does not advance an indexed cursor or retain a new partition when its analysis cannot fit", async () => {
    const program = [0xa6, 0, 0xbd, 0, 0xe3, 0x02],
      prefix = await derive(program, { max_work_items: 2 }),
      complete = await derive(program, { max_work_items: 3 });
    expect(complete.pending_refinements[0]?.next_value).toBe(1);
    assert.ok(complete.value_state_records > prefix.value_state_records);
    const limited = await derive(program, {
      max_work_items: 3,
      max_value_state_records: complete.value_state_records - 1,
    });
    expect(limited.termination).toBe("value-state-budget");
    expect(limited.pending_refinements).toEqual(prefix.pending_refinements);
    expect(limited.pending_refinements[0]?.next_value).toBe(0);
    expect(limited.partitions).toEqual(prefix.partitions);
    expect(limited.analyses).toEqual(prefix.analyses);
    expect(evidencePools(limited)).toEqual(evidencePools(prefix));
  });

  it("keeps a return delivery pending when joining the caller's RAM provenance cannot fit", async () => {
    // The branch reaches the return site directly before the callee finishes.
    // Its initial RAM alternative must join the callee's actual writer.
    const program = [0x50, 3, 0x20, 0, 0xe1, 0x02],
      callee = [0xa9, 7, 0x85, 0x10, 0x60],
      prefix = await derive(program, { max_work_items: 6 }, callee),
      complete = await derive(program, { max_work_items: 7 }, callee);
    expect(prefix.return_summaries).toHaveLength(1);
    expect(prefix.pending_returns).toEqual([
      { continuation_index: 0, next_summary_offset: 0 },
    ]);
    expect(
      complete.edges.filter((edge) => edge.kind === "return"),
    ).toHaveLength(1);
    assert.ok(complete.value_state_records > prefix.value_state_records);
    const limited = await derive(
      program,
      {
        max_work_items: 7,
        max_value_state_records: complete.value_state_records - 1,
      },
      callee,
    );
    expect(limited.termination).toBe("value-state-budget");
    expect(limited.pending_returns).toEqual(prefix.pending_returns);
    expect(limited.return_summaries).toEqual(prefix.return_summaries);
    expect(limited.edges).toEqual(prefix.edges);
    expect(evidencePools(limited)).toEqual(evidencePools(prefix));
  });
});
