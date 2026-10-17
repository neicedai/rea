import { isDeepStrictEqual } from "node:util";
import {
  nesDiscoveryDomainEnvelope,
  nesDiscoveryDomainValues,
  nesDiscoveryPredicateTruth,
  parseNesDiscoveryDomainBitmap,
} from "./nesCodeDiscoveryDomainFacts.js";
import {
  nesDiscoveryValueFact,
  type NesDiscoveryConditionWitnessFact,
  type NesDiscoveryDecodedValueFacts,
} from "./nesCodeDiscoveryValueFacts.js";
import type { NesDiscoveryValueValidationGraph } from "./nesCodeDiscoveryValueValidation.js";

type Issue = (path: (string | number)[], message: string) => void;
type Input = {
  graph: NesDiscoveryValueValidationGraph;
  decoded: Map<number, NesDiscoveryDecodedValueFacts>;
  issue: Issue;
};
type Validation = Input & {
  edges: Map<number, NesDiscoveryValueValidationGraph["edges"]>;
  reads: Map<number, NesDiscoveryValueValidationGraph["data_references"]>;
};
type Witness = NesDiscoveryConditionWitnessFact;
type Analysis = NesDiscoveryValueValidationGraph["analyses"][number];
const domain = (graph: NesDiscoveryValueValidationGraph, index: number) => {
  const source = graph.byte_domains[index];
  return source === undefined
    ? null
    : parseNesDiscoveryDomainBitmap(source.bitmap_hex);
};
const conditions = (facts: NesDiscoveryDecodedValueFacts, variable: number) =>
  nesDiscoveryValueFact(facts, nesDiscoveryValueFact(facts, variable).leader)
    .conditions;
const ordered = (values: readonly number[]) =>
  values.every((value, offset) => offset === 0 || values[offset - 1]! < value);

const validateIndex = (
  witness: Extract<Witness, { kind: "index" }>,
  analysis: Analysis,
  { before, result }: { before: NesDiscoveryDecodedValueFacts; result: bigint },
) =>
  analysis.refinement !== null &&
  analysis.refinement.register === (witness.variable === 1 ? "x" : "y") &&
  analysis.refinement.value === witness.value &&
  analysis.refinement.source_domain_index === witness.source_domain_index &&
  result === 1n << BigInt(witness.value) &&
  nesDiscoveryValueFact(before, witness.variable).bitmap === result &&
  conditions(before, witness.variable).includes(witness.index);

const validateBranch = (
  witness: Extract<Witness, { kind: "branch" }>,
  analysis: Analysis,
  {
    before,
    source,
    result,
  }: { before: NesDiscoveryDecodedValueFacts; source: bigint; result: bigint },
  { edges, decoded }: Validation,
) => {
  const predicate = analysis.flag_predicates_in[witness.flag];
  if (
    predicate === null ||
    predicate.carrier_variable !== witness.variable ||
    nesDiscoveryValueFact(before, witness.variable).bitmap !== source
  )
    return false;
  let expected = 0n;
  for (const value of nesDiscoveryDomainValues(source))
    if (
      nesDiscoveryPredicateTruth(predicate, witness.flag, value) ===
      witness.value
    )
      expected |= 1n << BigInt(value);
  return (
    expected === result &&
    (edges.get(analysis.index) ?? []).some((edge) => {
      const facts =
        edge.value_snapshot === null
          ? undefined
          : decoded.get(edge.value_snapshot);
      return (
        edge.analysis_index === analysis.index &&
        edge.condition?.flag === witness.flag &&
        edge.condition.value === witness.value &&
        facts !== undefined &&
        nesDiscoveryValueFact(facts, witness.variable).bitmap === result &&
        conditions(facts, witness.variable).includes(witness.index)
      );
    })
  );
};
const validateStack = (
  witness: Extract<Witness, { kind: "stack-alias" }>,
  analysis: Analysis,
  {
    before,
    source,
    result,
  }: { before: NesDiscoveryDecodedValueFacts; source: bigint; result: bigint },
  { reads }: Validation,
) =>
  nesDiscoveryValueFact(before, witness.variable).bitmap === source &&
  (reads.get(analysis.index) ?? []).some(
    (reference) =>
      reference.analysis_index === analysis.index &&
      reference.kind === "read" &&
      reference.address !== null &&
      reference.address < 0x2000 &&
      (reference.address & 2047) + 4 === witness.variable &&
      reference.relative_stack_origins.some(
        (origin) => origin.offset === witness.relative_offset,
      ) &&
      isDeepStrictEqual(reference.value, nesDiscoveryDomainEnvelope(result)),
  );
const validateSupport = (
  witness: Witness,
  analysis: Analysis,
  { source, result }: { source: bigint; result: bigint },
  validation: Validation,
) => {
  const before = validation.decoded.get(analysis.value_snapshot_in);
  if (before === undefined) return;
  const valid =
    witness.kind === "index"
      ? validateIndex(witness, analysis, { before, result })
      : witness.kind === "branch"
        ? validateBranch(
            witness,
            analysis,
            { before, source, result },
            validation,
          )
        : validateStack(
            witness,
            analysis,
            { before, source, result },
            validation,
          );
  if (!valid)
    validation.issue(
      ["condition_witnesses", witness.index],
      "A conditional proof must reproduce its actual indexed selection, predicate-filtered successor or physical read with a relative-coordinate source.",
    );
};

const byAnalysis = <T extends { analysis_index: number }>(
  records: readonly T[],
) => {
  const index = new Map<number, T[]>();
  for (const record of records) {
    const group = index.get(record.analysis_index);
    if (group === undefined) index.set(record.analysis_index, [record]);
    else group.push(record);
  }
  return index;
};
export const validateNesDiscoveryConditions = (input: Input): void => {
  const validation: Validation = {
    ...input,
    edges: byAnalysis(input.graph.edges),
    reads: byAnalysis(input.graph.data_references),
  };
  const { graph, issue } = validation,
    keys = new Set<string>();
  for (const [position, witness] of graph.condition_witnesses.entries()) {
    const { index: _index, analysis_indices: _analyses, ...identity } = witness,
      key = JSON.stringify(identity),
      source = domain(graph, witness.source_domain_index),
      result = domain(graph, witness.result_domain_index),
      path = ["condition_witnesses", position];
    if (
      witness.index !== position ||
      keys.has(key) ||
      !ordered(witness.analysis_indices)
    )
      issue(
        path,
        "A conditional proof requires one stable identity and ordered supporting analyses.",
      );
    keys.add(key);
    if (
      source === null ||
      result === null ||
      result === 0n ||
      (result & source) !== result
    ) {
      issue(
        path,
        "A conditional result must be a nonempty subset of its original exact domain.",
      );
      continue;
    }
    for (const analysisIndex of witness.analysis_indices) {
      const analysis = graph.analyses[analysisIndex];
      if (analysis?.node_index !== witness.node_index)
        issue(
          path,
          "Conditional support must retain its exact source analysis and node.",
        );
      else validateSupport(witness, analysis, { source, result }, validation);
    }
  }
};
