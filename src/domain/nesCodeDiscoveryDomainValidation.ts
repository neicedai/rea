import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { NesCpuState } from "./nesCodeTrace.js";
import type { NesByteValue } from "./nesByteValue.js";
import { decodeNes6502Opcode } from "./nes6502Opcodes.js";
import {
  nesDiscoveryDomainValues,
  nesDiscoveryDomainEnvelope,
  parseNesDiscoveryDomainBitmap,
  type NesDiscoveryDomainPool,
  type NesDiscoveryDomainSnapshot,
  type NesDiscoveryPredicateSnapshot,
} from "./nesCodeDiscoveryDomainFacts.js";
import type { nesDiscoveryFlagPredicateSourceSchema } from "./nesCodeDiscoveryDomainSchemas.js";

type Source = z.infer<typeof nesDiscoveryFlagPredicateSourceSchema>;
type Analysis = {
  index: number;
  node_index: number;
  cpu_in: NesCpuState;
  cpu_out: NesCpuState;
  register_relations_in: number;
  register_relations_out: number;
  register_domains_in: NesDiscoveryDomainSnapshot;
  register_domains_out: NesDiscoveryDomainSnapshot;
  flag_predicates_in: NesDiscoveryPredicateSnapshot;
  flag_predicates_out: NesDiscoveryPredicateSnapshot;
  refinement: {
    value: number;
    source_value: NesByteValue;
    source_domain_index: number;
  } | null;
};
type Node = { index: number; mnemonic: string; bytes_hex: string };
type Graph = {
  byte_domains: NesDiscoveryDomainPool;
  flag_predicate_sources: Source[];
  nodes: Node[];
  analyses: Analysis[];
  data_references: {
    analysis_index: number;
    kind: string;
    value: NesByteValue;
  }[];
  invocations: {
    cpu_in: NesCpuState;
    register_relations: number;
    register_domains: NesDiscoveryDomainSnapshot;
    flag_predicates: NesDiscoveryPredicateSnapshot;
  }[];
  return_summaries: {
    return_analysis_index: number;
    cpu_out: NesCpuState;
    register_relations: number;
    register_domains: NesDiscoveryDomainSnapshot;
    flag_predicates: NesDiscoveryPredicateSnapshot;
  }[];
  pending_refinements: {
    source_domain_index: number;
    source_value: NesByteValue;
    next_value: number;
  }[];
};
type Issue = (path: (string | number)[], message: string) => void;
type DomainFact = { bitmap: bigint; envelope: NesByteValue };
type Validation = {
  graph: Graph;
  facts: Map<number, DomainFact>;
  issue: Issue;
};
const uniqueOrdered = (values: readonly number[]) =>
  values.every((value, offset) => offset === 0 || value > values[offset - 1]!);
const operandAt = (
  node: Node,
  analysis: number,
  operands: Map<number, NesByteValue>,
) =>
  node.bytes_hex.length === 4 &&
  ["c9", "e0", "c0"].includes(node.bytes_hex.slice(0, 2))
    ? Number.parseInt(node.bytes_hex.slice(2), 16)
    : operands.get(analysis);
const compareRegister = (mnemonic: string) =>
  mnemonic === "CMP"
    ? "a"
    : mnemonic === "CPX"
      ? "x"
      : mnemonic === "CPY"
        ? "y"
        : null;

const resultRegisters = new Map<string, "a" | "x" | "y">([
  ..."LDA PLA ADC SBC AND ORA EOR ANC ALR ARR ISC SLO RLA SRE RRA TXA TYA LAX LAS"
    .split(" ")
    .map((name) => [name, "a"] as const),
  ..."LDX INX DEX AXS TSX TAX".split(" ").map((name) => [name, "x"] as const),
  ..."LDY INY DEY TAY".split(" ").map((name) => [name, "y"] as const),
]);
const validateSourceInstruction = (
  source: Source,
  node: Node,
  path: (string | number)[],
  issue: Issue,
) => {
  const opcode = decodeNes6502Opcode(
      Number.parseInt(node.bytes_hex.slice(0, 2), 16),
    ),
    resultRegister =
      opcode?.mode === "acc" &&
      ["ASL", "LSR", "ROL", "ROR"].includes(opcode.mnemonic)
        ? "a"
        : resultRegisters.get(opcode?.mnemonic ?? "");
  if (
    opcode === undefined ||
    opcode.mnemonic !== node.mnemonic ||
    opcode.length * 2 !== node.bytes_hex.length ||
    (source.kind === "result" && resultRegister !== source.register)
  )
    issue(
      path,
      "A predicate source must retain its original opcode and actual CPU result register.",
    );
};
const validateSources = (graph: Graph, issue: Issue) => {
  const identities = new Set<string>();
  const operands = new Map<number, NesByteValue>();
  for (const reference of graph.data_references)
    if (reference.kind === "read")
      operands.set(reference.analysis_index, reference.value);
  for (const [position, source] of graph.flag_predicate_sources.entries()) {
    const path = ["flag_predicate_sources", position],
      node = graph.nodes[source.node_index],
      identity = JSON.stringify([
        source.node_index,
        source.register,
        source.kind,
        source.operand,
      ]);
    if (source.index !== position || identities.has(identity))
      issue(
        path,
        "Predicate source identities must be unique and equal their pool position.",
      );
    identities.add(identity);
    if (node === undefined || !uniqueOrdered(source.analysis_indices)) {
      issue(
        path,
        "A predicate source requires its original node and unique supporting analyses.",
      );
      continue;
    }
    validateSourceInstruction(source, node, path, issue);
    for (const analysisIndex of source.analysis_indices) {
      const analysis = graph.analyses[analysisIndex];
      if (analysis?.node_index !== source.node_index) {
        issue(
          [...path, "analysis_indices"],
          "Predicate support must belong to its exact source node.",
        );
        continue;
      }
      const matches = (["c", "z", "n"] as const).some((flag) => {
        const predicate = analysis.flag_predicates_out[flag];
        return (
          predicate !== null &&
          predicate.kind === source.kind &&
          predicate.operand === source.operand &&
          predicate.registers.includes(source.register) &&
          predicate.source_witness_indices.includes(position)
        );
      });
      if (!matches)
        issue(
          path,
          "A predicate source must be established by its specific output analysis.",
        );
      if (
        source.kind === "compare" &&
        (compareRegister(node.mnemonic) !== source.register ||
          operandAt(node, analysisIndex, operands) !== source.operand)
      )
        issue(
          path,
          "A comparison predicate requires its original compare register and known operand.",
        );
    }
  }
};

const validateSnapshot = (
  {
    predicates,
  }: {
    snapshot: NesDiscoveryDomainSnapshot;
    predicates: NesDiscoveryPredicateSnapshot;
    cpu: NesCpuState;
    relations: number;
  },
  { graph, issue }: Validation,
  path: (string | number)[],
) => {
  for (const flag of ["c", "z", "n"] as const) {
    const predicate = predicates[flag];
    if (predicate === null) continue;
    if (!uniqueOrdered(predicate.source_witness_indices))
      issue(path, "Predicate source references must be unique and canonical.");
    for (const sourceIndex of predicate.source_witness_indices) {
      const source = graph.flag_predicate_sources[sourceIndex];
      if (
        source === undefined ||
        source.kind !== predicate.kind ||
        source.operand !== predicate.operand
      )
        issue(
          path,
          "A live predicate must preserve its actual source kind and operand.",
        );
    }
  }
};

const validateDomainPool = (
  graph: Graph,
  issue: Issue,
): Map<number, DomainFact> => {
  const identities = new Set<string>();
  const facts = new Map<number, DomainFact>();
  for (const [position, domain] of graph.byte_domains.entries()) {
    const bitmap = parseNesDiscoveryDomainBitmap(domain.bitmap_hex),
      values = bitmap === null ? [] : nesDiscoveryDomainValues(bitmap);
    if (
      domain.index !== position ||
      identities.has(domain.bitmap_hex) ||
      bitmap === null ||
      bitmap === 0n ||
      values.length !== domain.count
    )
      issue(
        ["byte_domains", position],
        "Each nonempty byte domain must have one identity and its exact population count.",
      );
    identities.add(domain.bitmap_hex);
    if (bitmap !== null && bitmap !== 0n)
      facts.set(position, {
        bitmap,
        envelope: nesDiscoveryDomainEnvelope(bitmap),
      });
  }
  return facts;
};
/** Exact candidate sets are checked separately from local JSON Schema shape. */
export const validateNesDiscoveryDomains = (
  graph: Graph,
  ctx: z.RefinementCtx,
): void => {
  const issue: Issue = (path, message) =>
    ctx.addIssue({ code: "custom", path, message });
  const facts = validateDomainPool(graph, issue),
    validation = { graph, facts, issue };
  validateSources(graph, issue);
  for (const analysis of graph.analyses) {
    validateSnapshot(
      {
        snapshot: analysis.register_domains_in,
        predicates: analysis.flag_predicates_in,
        cpu: analysis.cpu_in,
        relations: analysis.register_relations_in,
      },
      validation,
      ["analyses", analysis.index, "register_domains_in"],
    );
    validateSnapshot(
      {
        snapshot: analysis.register_domains_out,
        predicates: analysis.flag_predicates_out,
        cpu: analysis.cpu_out,
        relations: analysis.register_relations_out,
      },
      validation,
      ["analyses", analysis.index, "register_domains_out"],
    );
    if (analysis.refinement !== null) {
      const refinement = analysis.refinement,
        domain = facts.get(refinement.source_domain_index);
      if (
        domain === undefined ||
        (domain.bitmap & (1n << BigInt(refinement.value))) === 0n ||
        !isDeepStrictEqual(domain.envelope, refinement.source_value)
      )
        issue(
          ["analyses", analysis.index, "refinement"],
          "An indexed refinement must select a member of its exact source domain.",
        );
    }
  }
  for (const [position, invocation] of graph.invocations.entries())
    validateSnapshot(
      {
        snapshot: invocation.register_domains,
        predicates: invocation.flag_predicates,
        cpu: invocation.cpu_in,
        relations: invocation.register_relations,
      },
      validation,
      ["invocations", position, "register_domains"],
    );
  for (const [position, summary] of graph.return_summaries.entries()) {
    validateSnapshot(
      {
        snapshot: summary.register_domains,
        predicates: summary.flag_predicates,
        cpu: summary.cpu_out,
        relations: summary.register_relations,
      },
      validation,
      ["return_summaries", position, "register_domains"],
    );
    const analysis = graph.analyses[summary.return_analysis_index];
    if (
      analysis !== undefined &&
      (!isDeepStrictEqual(
        summary.register_domains,
        analysis.register_domains_out,
      ) ||
        !isDeepStrictEqual(
          summary.flag_predicates,
          analysis.flag_predicates_out,
        ))
    )
      issue(
        ["return_summaries", position],
        "A return summary preserves its exact exit domain and live predicates.",
      );
  }
  for (const [position, pending] of graph.pending_refinements.entries()) {
    const domain = facts.get(pending.source_domain_index);
    if (
      domain === undefined ||
      (domain.bitmap & (1n << BigInt(pending.next_value))) === 0n ||
      !isDeepStrictEqual(domain.envelope, pending.source_value)
    )
      issue(
        ["pending_refinements", position],
        "A pending candidate cursor must belong to its retained exact source domain.",
      );
  }
};
