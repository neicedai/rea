import { isDeepStrictEqual } from "node:util";
import { validateNesDiscoveryConditions } from "./nesCodeDiscoveryConditionValidation.js";
import type { z } from "zod";
import type { NesCpuState } from "./nesCodeTrace.js";
import { nesCpuByte } from "./nesCpuRegister.js";
import { nesRegisterEquals } from "./nesCodeDiscoveryRegisterRelations.js";
import {
  nesDiscoveryDomainEnvelope,
  nesDiscoveryDomainRegisters,
  nesDiscoveryDomainValues,
  nesDiscoveryPredicateTruth,
  parseNesDiscoveryDomainBitmap,
  type NesDiscoveryDomainSnapshot,
  type NesDiscoveryPredicateSnapshot,
} from "./nesCodeDiscoveryDomainFacts.js";
import {
  createNesDiscoveryValueFactDecoder,
  nesDiscoveryValueFact,
  nesDiscoveryValueCpuMembers,
  type NesDiscoveryConditionWitnessFact,
  type NesDiscoveryDecodedValueFacts,
  type NesDiscoveryValueFactPools,
} from "./nesCodeDiscoveryValueFacts.js";

type SnapshotBinding = {
  snapshot: number;
  domains: NesDiscoveryDomainSnapshot;
  relations: number;
  cpu: NesCpuState;
  predicates: NesDiscoveryPredicateSnapshot;
};
type Analysis = {
  index: number;
  node_index: number;
  value_snapshot_in: number;
  value_snapshot_out: number;
  register_domains_in: NesDiscoveryDomainSnapshot;
  register_domains_out: NesDiscoveryDomainSnapshot;
  register_relations_in: number;
  register_relations_out: number;
  flag_predicates_in: NesDiscoveryPredicateSnapshot;
  flag_predicates_out: NesDiscoveryPredicateSnapshot;
  cpu_in: NesCpuState;
  cpu_out: NesCpuState;
  refinement: {
    register: "x" | "y";
    value: number;
    source_domain_index: number;
  } | null;
};
type Graph = NesDiscoveryValueFactPools & {
  condition_witnesses: NesDiscoveryConditionWitnessFact[];
  analyses: Analysis[];
  invocations: {
    value_snapshot: number;
    register_domains: NesDiscoveryDomainSnapshot;
    register_relations: number;
    flag_predicates: NesDiscoveryPredicateSnapshot;
    cpu_in: NesCpuState;
    ram_in: (number | null)[];
  }[];
  return_summaries: {
    value_snapshot: number;
    register_domains: NesDiscoveryDomainSnapshot;
    register_relations: number;
    flag_predicates: NesDiscoveryPredicateSnapshot;
    cpu_out: NesCpuState;
    ram_out: (number | null)[];
    return_analysis_index: number;
  }[];
  edges: {
    from: number;
    analysis_index: number;
    value_snapshot: number | null;
    register_domains: NesDiscoveryDomainSnapshot | null;
    flag_predicates: NesDiscoveryPredicateSnapshot | null;
    condition: { flag: "c" | "z" | "n" | "v"; value: boolean } | null;
  }[];
  ram_pages: {
    cells: {
      offset: number;
      value: ReturnType<typeof nesDiscoveryDomainEnvelope>;
      writer_witness_indices: number[];
      initial_unwritten_possible: boolean;
    }[];
  }[];
  data_references: {
    node_index: number;
    analysis_index: number;
    kind: string;
    address: number | null;
    value: ReturnType<typeof nesDiscoveryDomainEnvelope>;
    relative_stack_origins: { offset: number }[];
  }[];
};
export type NesDiscoveryValueValidationGraph = Graph;

type Issue = (path: (string | number)[], message: string) => void;
type Validation = {
  graph: Graph;
  issue: Issue;
  envelope: typeof nesDiscoveryDomainEnvelope;
};
const ordered = (values: readonly number[]) =>
  values.every(
    (value, position) => position === 0 || values[position - 1]! < value,
  );
const allBytes = (1n << 256n) - 1n;
const bitmap = (graph: Graph, index: number) => {
  const value = graph.byte_domains[index];
  return value === undefined
    ? null
    : parseNesDiscoveryDomainBitmap(value.bitmap_hex);
};

const validatePools = (graph: Graph, issue: Issue) => {
  const pageKeys = new Set<string>(),
    snapshotKeys = new Set<string>();
  for (const [position, page] of graph.value_pages.entries()) {
    const key = JSON.stringify(page.entries);
    if (
      page.index !== position ||
      pageKeys.has(key) ||
      !ordered(page.entries.map((entry) => entry.offset))
    )
      issue(
        ["value_pages", position],
        "Value pages require one canonical identity and ordered unique slots.",
      );
    pageKeys.add(key);
    for (const [offset, entry] of page.entries.entries()) {
      if (bitmap(graph, entry.domain_index) === null)
        issue(
          ["value_pages", position, "entries", offset, "domain_index"],
          "A value entry must reference its exact domain pool.",
        );
      if (!ordered(entry.condition_witness_indices))
        issue(
          [
            "value_pages",
            position,
            "entries",
            offset,
            "condition_witness_indices",
          ],
          "Conditional proof references must be ordered and unique.",
        );
      for (const witness of entry.condition_witness_indices)
        if (graph.condition_witnesses[witness] === undefined)
          issue(
            ["value_pages", position, "entries", offset],
            "A value condition must reference its owning proof pool.",
          );
    }
  }
  for (const [position, snapshot] of graph.value_snapshots.entries()) {
    const key = JSON.stringify([snapshot.pages, snapshot.ram_pages]);
    if (snapshot.index !== position || snapshotKeys.has(key))
      issue(
        ["value_snapshots", position],
        "Value snapshots require one identity for their complete value and RAM provenance facts.",
      );
    snapshotKeys.add(key);
  }
};

const validateSnapshot = (
  validation: Validation,
  position: number,
  facts: NesDiscoveryDecodedValueFacts,
) => {
  const { graph, issue } = validation;
  const path = ["value_snapshots", position];
  const members = new Map<number, number>();
  for (const [variable, fact] of facts)
    if (variable !== fact.leader)
      members.set(fact.leader, (members.get(fact.leader) ?? 0) + 1);
  for (const [variable, fact] of facts) {
    const leader = nesDiscoveryValueFact(facts, fact.leader);
    if (
      fact.leader > variable ||
      leader.leader !== fact.leader ||
      leader.bitmap !== fact.bitmap ||
      (variable !== fact.leader && fact.conditions.length !== 0)
    )
      issue(
        path,
        "Current copy groups require their least variable as leader, one exact domain, and proof support only on that leader.",
      );
    if (
      variable === fact.leader &&
      fact.bitmap === allBytes &&
      fact.conditions.length === 0
    )
      if (!members.has(variable))
        issue(path, "Unconstrained singleton values use an omitted entry.");
    for (const witnessIndex of fact.conditions) {
      const witness = graph.condition_witnesses[witnessIndex],
        result =
          witness === undefined
            ? null
            : bitmap(graph, witness.result_domain_index);
      if (result === null || (fact.bitmap & result) === 0n)
        issue(
          path,
          "Conditional support must remain compatible with the current group value.",
        );
    }
  }
  validateRamProjection(validation, position, facts);
};
const validateRamProjection = (
  { graph, issue, envelope }: Validation,
  position: number,
  facts: NesDiscoveryDecodedValueFacts,
) => {
  const path = ["value_snapshots", position],
    snapshot = graph.value_snapshots[position]!;
  for (const [physicalPage, pageIndex] of snapshot.ram_pages.entries()) {
    if (pageIndex === null) continue;
    const page = graph.ram_pages[pageIndex];
    if (page === undefined) {
      issue(
        [...path, "ram_pages", physicalPage],
        "RAM provenance must reference its owning page pool.",
      );
      continue;
    }
    for (const cell of page.cells) {
      const variable = 4 + physicalPage * 32 + cell.offset;
      if (
        !isDeepStrictEqual(
          cell.value,
          envelope(nesDiscoveryValueFact(facts, variable).bitmap),
        )
      )
        issue(
          [...path, "ram_pages", physicalPage],
          "RAM byte fields are projections of their current exact value, independent of historical writer values.",
        );
    }
  }
};

const validateBinding = (
  { graph, issue, envelope }: Validation,
  binding: SnapshotBinding,
  facts: NesDiscoveryDecodedValueFacts,
  path: (string | number)[],
) => {
  for (const [variable, register] of nesDiscoveryDomainRegisters.entries()) {
    const value = nesDiscoveryValueFact(facts, variable);
    if (
      bitmap(graph, binding.domains[register]) !== value.bitmap ||
      !isDeepStrictEqual(
        nesCpuByte(binding.cpu, register),
        envelope(value.bitmap),
      )
    )
      issue(
        path,
        "CPU byte and exact-domain fields must project the same current value snapshot.",
      );
    const members = nesDiscoveryValueCpuMembers(facts, variable);
    if (
      !isDeepStrictEqual(
        nesRegisterEquals(binding.relations, register),
        members,
      )
    )
      issue(path, "CPU equality bits must project actual current copy groups.");
  }
  for (const flag of ["c", "z", "n"] as const) {
    const predicate = binding.predicates[flag];
    if (predicate === null) continue;
    const subject = nesDiscoveryValueFact(facts, predicate.carrier_variable);
    if (
      subject.leader !== predicate.carrier_variable ||
      !isDeepStrictEqual(
        predicate.registers,
        nesDiscoveryValueCpuMembers(facts, predicate.carrier_variable),
      )
    )
      issue(
        path,
        "A live flag predicate must name its current group's canonical leader and exact CPU member projection.",
      );
    if (
      binding.cpu[flag] !== null &&
      nesDiscoveryDomainValues(subject.bitmap).some(
        (value) =>
          nesDiscoveryPredicateTruth(predicate, flag, value) !==
          binding.cpu[flag],
      )
    )
      issue(
        path,
        "A known flag must agree with every current CPU/RAM subject value.",
      );
  }
};

/** Validate copy ownership and conditional provenance without calling producer code. */
export const validateNesDiscoveryValues = (
  graph: Graph,
  ctx: z.RefinementCtx,
): void => {
  const issue: Issue = (path, message) =>
      ctx.addIssue({ code: "custom", path, message }),
    decoded = new Map<number, NesDiscoveryDecodedValueFacts>(),
    envelopes = new Map<
      bigint,
      ReturnType<typeof nesDiscoveryDomainEnvelope>
    >();
  const validation: Validation = {
    graph,
    issue,
    envelope(value) {
      if (!envelopes.has(value))
        envelopes.set(value, nesDiscoveryDomainEnvelope(value));
      return envelopes.get(value)!;
    },
  };
  const decode = createNesDiscoveryValueFactDecoder(graph);
  validatePools(graph, issue);
  for (const [position] of graph.value_snapshots.entries()) {
    const facts = decode(position);
    if (facts === null)
      issue(
        ["value_snapshots", position],
        "A value snapshot must preserve valid, unique variable slots and owning pool references.",
      );
    else {
      decoded.set(position, facts);
      validateSnapshot(validation, position, facts);
    }
  }
  const binding = (value: SnapshotBinding, path: (string | number)[]) => {
    const facts = decoded.get(value.snapshot);
    if (facts === undefined)
      issue(path, "Current values must reference their owning snapshot pool.");
    else validateBinding(validation, value, facts, path);
  };
  for (const analysis of graph.analyses)
    for (const side of ["in", "out"] as const)
      binding(
        {
          snapshot: analysis[`value_snapshot_${side}`],
          domains: analysis[`register_domains_${side}`],
          relations: analysis[`register_relations_${side}`],
          predicates: analysis[`flag_predicates_${side}`],
          cpu: analysis[`cpu_${side}`],
        },
        ["analyses", analysis.index, `value_snapshot_${side}`],
      );
  for (const [position, invocation] of graph.invocations.entries()) {
    binding(
      {
        snapshot: invocation.value_snapshot,
        domains: invocation.register_domains,
        relations: invocation.register_relations,
        predicates: invocation.flag_predicates,
        cpu: invocation.cpu_in,
      },
      ["invocations", position, "value_snapshot"],
    );
    if (
      !isDeepStrictEqual(
        graph.value_snapshots[invocation.value_snapshot]?.ram_pages,
        invocation.ram_in,
      )
    )
      issue(
        ["invocations", position],
        "Invocation RAM fields must project their same current value snapshot.",
      );
  }
  for (const [position, summary] of graph.return_summaries.entries()) {
    binding(
      {
        snapshot: summary.value_snapshot,
        domains: summary.register_domains,
        relations: summary.register_relations,
        predicates: summary.flag_predicates,
        cpu: summary.cpu_out,
      },
      ["return_summaries", position, "value_snapshot"],
    );
    if (
      graph.analyses[summary.return_analysis_index]?.value_snapshot_out !==
        summary.value_snapshot ||
      !isDeepStrictEqual(
        graph.value_snapshots[summary.value_snapshot]?.ram_pages,
        summary.ram_out,
      )
    )
      issue(
        ["return_summaries", position],
        "A return summary retains its actual exit value snapshot and RAM provenance.",
      );
  }
  validateNesDiscoveryConditions({ graph, decoded, issue });
};
