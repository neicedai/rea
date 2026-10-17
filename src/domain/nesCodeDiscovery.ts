import { z } from "zod";
import {
  inspectNesCartridgeInputSchema,
  nesCartridgeSchema,
} from "./nesCartridge.js";
import {
  nesMapperStateSchema,
  nesMapperMappingSchema,
} from "./nesMapperTrace.js";
import { nesCodeVectorSchema, nesCpuStateSchema } from "./nesCodeTrace.js";
import { nesByteValueSchema } from "./nesByteValue.js";
import { nesPrgViewSchema } from "./nesPrgViews.js";
import {
  nesDiscoveryByteDomainSchema,
  nesDiscoveryRegisterDomainsSchema,
  nesDiscoveryFlagPredicatesSchema,
  nesDiscoveryFlagPredicateSourceSchema,
} from "./nesCodeDiscoveryDomainSchemas.js";
import { validateNesDiscoveryCalls } from "./nesCodeDiscoveryCallValidation.js";
import { validateNesDiscoveryBranches } from "./nesCodeDiscoveryBranchValidation.js";
import { validateNesDiscoveryDomains } from "./nesCodeDiscoveryDomainValidation.js";
import {
  nesDiscoveryValuePageSchema,
  nesDiscoveryValueSnapshotSchema,
  nesDiscoveryConditionWitnessSchema,
} from "./nesCodeDiscoveryValueSchemas.js";
import { validateNesDiscoveryValues } from "./nesCodeDiscoveryValueValidation.js";
import { validateNesDiscoveryValueRecords } from "./nesCodeDiscoveryValueRecordValidation.js";
import {
  nesDiscoveryBranchConditionSchema,
  nesDiscoveryBranchEdgeMetadata,
} from "./nesCodeDiscoveryBranchSchemas.js";
import { validateNesDiscoveryRelativeStack } from "./nesCodeDiscoveryRelativeValidation.js";
import {
  nesDiscoveryRelativeSnapshotSchema,
  nesDiscoveryRelativeOriginSchema,
  nesDiscoveryRelativeWriteWitnessSchema,
  nesDiscoveryRelativePageSchema,
} from "./nesCodeDiscoveryRelativeSchemas.js";
import { validateNesDiscoveryPartitions } from "./nesCodeDiscoveryPartitionValidation.js";
import {
  nesDiscoveryPartitionSchema,
  nesDiscoveryRefinementSchema,
  nesDiscoveryPendingRefinementSchema,
  nesDiscoveryRegisterRelationsSchema,
} from "./nesCodeDiscoveryPartitionSchemas.js";
import {
  nesDiscoveryInvocationSchema,
  nesDiscoveryContinuationSchema,
  nesDiscoveryReturnSummarySchema,
  nesDiscoveryWriteWitnessSchema,
  nesDiscoveryRamPageSchema,
  nesDiscoveryFrameSchema,
} from "./nesCodeDiscoveryCalls.js";

const address = z.number().int().min(0).max(65535);
const budget = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const entry = z.union([z.enum(["reset", "nmi", "irq"]), address]);

/** Static discovery owns a worklist, rather than replayed CPU execution paths. */
export const discoverNesCodeInputSchema = z.strictObject({
  path: inspectNesCartridgeInputSchema.shape.path,
  max_file_bytes: inspectNesCartridgeInputSchema.shape.max_file_bytes,
  initial: nesMapperStateSchema,
  roots: z.array(entry).default(["reset", "nmi", "irq"]),
  additional_roots: z
    .array(z.strictObject({ entry, initial: nesMapperStateSchema }))
    .default([]),
  max_nodes: budget
    .default(4096)
    .describe("Maximum retained decoded instruction nodes."),
  max_work_items: budget
    .default(16384)
    .describe(
      "Maximum examined instruction states, lazy index refinements and matched-return deliveries, including reanalysis after abstract facts change.",
    ),
  max_contexts: budget
    .default(512)
    .describe(
      "Maximum retained distinct raw mapper states, including serial and selected-register facts needed by subsequent writes.",
    ),
  max_invocations: budget
    .default(512)
    .describe(
      "Maximum retained function invocation identities, keyed by entry, raw mapper, CPU/RAM/relative-stack value facts and frame qualification; not a guessed call depth.",
    ),
  max_continuations: budget
    .default(16384)
    .describe(
      "Maximum retained matched-call subscriptions; return fanout is processed lazily within max_work_items.",
    ),
  max_partitions: budget
    .default(4096)
    .describe(
      "Maximum retained canonical index-selection partitions, including the empty initial partition. Index candidates and return combinations are admitted lazily without preallocating their product.",
    ),
  max_partition_selections: budget
    .default(65536)
    .describe(
      "Maximum total retained selector assignments across canonical partition maps. Reused maps are counted once; a new expanded map is admitted only when its full assignment count fits.",
    ),
  max_value_state_records: budget
    .default(2_097_152)
    .describe(
      "Maximum retained value and provenance records, including expanded snapshot references, page entries, byte domains, witness support memberships and data origins. Interned records are charged once; an instruction, branch family or matched-return delivery is admitted atomically.",
    ),
});
export type DiscoverNesCodeInput = z.infer<typeof discoverNesCodeInputSchema>;

const index = z.number().int().nonnegative();
const offsets = z.array(index.nullable()).max(3);
const hex = z.string().regex(/^(?:[a-f0-9]{2}){0,3}$/u);
const edgeFields = {
  index,
  from: index,
  analysis_index: index,
  condition: nesDiscoveryBranchConditionSchema.nullable(),
  value_snapshot: index.nullable(),
  register_domains: nesDiscoveryRegisterDomainsSchema.nullable(),
  flag_predicates: nesDiscoveryFlagPredicatesSchema.nullable(),
  target_invocation_index: index.nullable(),
  target_partition_index: index.nullable(),
  continuation_index: index.nullable(),
  summary_index: index.nullable(),
  kind: z.enum([
    "fallthrough",
    "branch-taken",
    "branch-not-taken",
    "jump",
    "stack-jump",
    "call",
    "return",
  ]),
};
const edge = z.discriminatedUnion("resolution", [
  z
    .strictObject({
      ...edgeFields,
      resolution: z.literal("resolved"),
      target_address: address,
      target_context_index: index,
      target_invocation_index: index,
      target_partition_index: index,
      to: index.nullable(),
      reason: z.null(),
    })
    .meta({
      allOf: [
        nesDiscoveryBranchEdgeMetadata,
        {
          if: { properties: { kind: { const: "return" } }, required: ["kind"] },
          then: {
            properties: {
              continuation_index: { type: "integer", minimum: 0 },
              summary_index: { type: "integer", minimum: 0 },
            },
            required: ["continuation_index", "summary_index"],
          },
          else: {
            properties: {
              continuation_index: { type: "null" },
              summary_index: { type: "null" },
            },
          },
        },
      ],
    }),
  z
    .strictObject({
      ...edgeFields,
      resolution: z.literal("unresolved"),
      target_address: address.nullable(),
      target_context_index: index.nullable(),
      continuation_index: z.null(),
      summary_index: z.null(),
      to: z.null(),
      reason: z.string().min(1),
    })
    .meta({ allOf: [nesDiscoveryBranchEdgeMetadata] }),
]);
const graph = z
  .strictObject({
    status: z.literal("derived"),
    termination: z.enum([
      "worklist-exhausted",
      "node-budget",
      "work-item-budget",
      "context-budget",
      "invocation-budget",
      "continuation-budget",
      "partition-budget",
      "partition-selection-budget",
      "value-state-budget",
    ]),
    contexts: z.array(
      z.strictObject({
        index,
        state: nesMapperStateSchema,
        mapping: nesMapperMappingSchema,
      }),
    ),
    partitions: z.array(nesDiscoveryPartitionSchema).min(1),
    byte_domains: z.array(nesDiscoveryByteDomainSchema),
    flag_predicate_sources: z.array(nesDiscoveryFlagPredicateSourceSchema),
    value_pages: z.array(nesDiscoveryValuePageSchema),
    value_snapshots: z.array(nesDiscoveryValueSnapshotSchema),
    condition_witnesses: z.array(nesDiscoveryConditionWitnessSchema),
    invocations: z.array(nesDiscoveryInvocationSchema),
    continuations: z.array(nesDiscoveryContinuationSchema),
    return_summaries: z.array(nesDiscoveryReturnSummarySchema),
    write_witnesses: z.array(nesDiscoveryWriteWitnessSchema),
    ram_pages: z.array(nesDiscoveryRamPageSchema),
    relative_stack_write_witnesses: z.array(
      nesDiscoveryRelativeWriteWitnessSchema,
    ),
    relative_stack_pages: z.array(nesDiscoveryRelativePageSchema),
    roots: z.array(
      z.strictObject({
        index,
        entry,
        context_index: index.nullable(),
        invocation_index: index.nullable(),
        partition_index: index.nullable(),
        target_address: address.nullable(),
        node_index: index.nullable(),
        vector: nesCodeVectorSchema,
        reason: z.string().min(1).nullable(),
      }),
    ),
    nodes: z.array(
      z.strictObject({
        index,
        context_index: index,
        invocation_index: index,
        address,
        bytes_hex: z.string().regex(/^(?:[a-f0-9]{2}){1,3}$/u),
        file_offsets: offsets,
        mnemonic: z.string().min(1),
        encoding: z.enum(["official", "unofficial"]),
        addressing_mode: z.enum([
          "imp",
          "acc",
          "imm",
          "zp",
          "zpx",
          "zpy",
          "izx",
          "izy",
          "rel",
          "abs",
          "abx",
          "aby",
          "ind",
        ]),
        cpu_in: nesCpuStateSchema,
        cpu_out: nesCpuStateSchema,
      }),
    ),
    analyses: z.array(
      z.strictObject({
        index,
        node_index: index,
        invocation_index: index,
        partition_index: index,
        cpu_in: nesCpuStateSchema,
        cpu_out: nesCpuStateSchema,
        frame_in: nesDiscoveryFrameSchema,
        value_snapshot_in: index,
        value_snapshot_out: index,
        frame_out: nesDiscoveryFrameSchema,
        relative_stack_in: nesDiscoveryRelativeSnapshotSchema,
        relative_stack_out: nesDiscoveryRelativeSnapshotSchema,
        register_relations_in: nesDiscoveryRegisterRelationsSchema,
        register_relations_out: nesDiscoveryRegisterRelationsSchema,
        register_domains_in: nesDiscoveryRegisterDomainsSchema,
        register_domains_out: nesDiscoveryRegisterDomainsSchema,
        flag_predicates_in: nesDiscoveryFlagPredicatesSchema,
        flag_predicates_out: nesDiscoveryFlagPredicatesSchema,
        refinement: nesDiscoveryRefinementSchema.nullable(),
      }),
    ),
    edges: z.array(edge),
    data_references: z.array(
      z.strictObject({
        index,
        node_index: index,
        analysis_index: index,
        kind: z.enum([
          "read",
          "write",
          "pointer",
          "mapper-write",
          "mapper-bus",
        ]),
        address: address.nullable(),
        value: nesByteValueSchema,
        file_offsets: z.array(index),
        relative_stack_origins: z.array(nesDiscoveryRelativeOriginSchema),
        ram_origins: z.array(
          z.strictObject({
            ram_address: z.number().int().min(0).max(2047),
            writer_nodes: z.array(index),
            writer_witness_indices: z.array(index),
            domain_index: index,
            initial_unwritten_possible: z.boolean(),
            unknown_write_possible: z.boolean(),
            condition_witness_indices: z.array(index),
          }),
        ),
      }),
    ),
    frontiers: z.array(
      z.strictObject({
        context_index: index,
        invocation_index: index.nullable(),
        partition_index: index.nullable(),
        address: address.nullable(),
        from: index.nullable(),
        reason: z.string().min(1),
        bytes_hex: hex,
        file_offsets: offsets,
      }),
    ),
    pending: z.array(
      z.strictObject({
        invocation_index: index,
        partition_index: index,
        context_index: index,
        address,
      }),
    ),
    pending_returns: z.array(
      z.strictObject({ continuation_index: index, next_summary_offset: index }),
    ),
    pending_refinements: z.array(nesDiscoveryPendingRefinementSchema),
    coverage: z.strictObject({
      prg_bytes: index,
      decoded_bytes: index,
      referenced_bytes: index,
      overlap_bytes: index,
      unclassified_bytes: index,
      intervals: z.array(
        z.strictObject({
          file_offset: index,
          size: z.number().int().positive(),
          classification: z.enum([
            "decoded",
            "referenced",
            "overlap",
            "unclassified",
          ]),
        }),
      ),
    }),
    work_items_processed: index,
    value_state_records: index,
    nes_prg_views: z.array(nesPrgViewSchema),
  })
  .superRefine((result, ctx) => {
    validateNesDiscoveryCalls(result, ctx);
    validateNesDiscoveryDomains(result, ctx);
    validateNesDiscoveryValues(result, ctx);
    validateNesDiscoveryValueRecords(result, ctx);
    validateNesDiscoveryBranches(result, ctx);
    validateNesDiscoveryRelativeStack(result, ctx);
    validateNesDiscoveryPartitions(result, ctx);
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const ref = (
      value: number | null,
      length: number,
      path: (string | number)[],
    ) => {
      if (value !== null && value >= length)
        issue(path, "Reference is outside its owning pool.");
    };
    for (const [pool, items] of [
      ["contexts", result.contexts],
      ["roots", result.roots],
      ["nodes", result.nodes],
      ["analyses", result.analyses],
      ["edges", result.edges],
      ["data_references", result.data_references],
    ] as const)
      for (const [position, item] of items.entries())
        if (item.index !== position)
          issue(
            [pool, position, "index"],
            "Pool identity must equal its array position.",
          );
    for (const [position, node] of result.nodes.entries()) {
      ref(node.context_index, result.contexts.length, [
        "nodes",
        position,
        "context_index",
      ]);
      if (node.file_offsets.length * 2 !== node.bytes_hex.length)
        issue(
          ["nodes", position, "file_offsets"],
          "Every decoded byte requires its corresponding source location.",
        );
    }
    for (const [position, analysis] of result.analyses.entries())
      ref(analysis.node_index, result.nodes.length, [
        "analyses",
        position,
        "node_index",
      ]);
    for (const [position, root] of result.roots.entries()) {
      ref(root.context_index, result.contexts.length, [
        "roots",
        position,
        "context_index",
      ]);
      ref(root.node_index, result.nodes.length, [
        "roots",
        position,
        "node_index",
      ]);
      if (root.node_index !== null) {
        const node = result.nodes[root.node_index];
        if (
          node !== undefined &&
          (node.context_index !== root.context_index ||
            node.address !== root.target_address)
        )
          issue(
            ["roots", position, "node_index"],
            "Root node must retain the root context and address.",
          );
      }
    }
    for (const [position, edge] of result.edges.entries()) {
      ref(edge.from, result.nodes.length, ["edges", position, "from"]);
      ref(edge.to, result.nodes.length, ["edges", position, "to"]);
      ref(edge.target_context_index, result.contexts.length, [
        "edges",
        position,
        "target_context_index",
      ]);
      ref(edge.analysis_index, result.analyses.length, [
        "edges",
        position,
        "analysis_index",
      ]);
      if (result.analyses[edge.analysis_index]?.node_index !== edge.from)
        issue(
          ["edges", position, "analysis_index"],
          "Edge analysis must belong to its source node.",
        );
      if (edge.to !== null) {
        const node = result.nodes[edge.to];
        if (
          node !== undefined &&
          (node.context_index !== edge.target_context_index ||
            node.address !== edge.target_address)
        )
          issue(
            ["edges", position, "to"],
            "Edge target must retain its context and address.",
          );
      }
    }
    for (const [position, reference] of result.data_references.entries()) {
      ref(reference.node_index, result.nodes.length, [
        "data_references",
        position,
        "node_index",
      ]);
      ref(reference.analysis_index, result.analyses.length, [
        "data_references",
        position,
        "analysis_index",
      ]);
      if (
        result.analyses[reference.analysis_index]?.node_index !==
        reference.node_index
      )
        issue(
          ["data_references", position, "analysis_index"],
          "Read/write analysis must belong to its source node.",
        );
      for (const [originIndex, origin] of reference.ram_origins.entries())
        for (const [writerIndex, writer] of origin.writer_nodes.entries())
          ref(writer, result.nodes.length, [
            "data_references",
            position,
            "ram_origins",
            originIndex,
            "writer_nodes",
            writerIndex,
          ]);
    }
    for (const [pool, items] of [
      ["frontiers", result.frontiers],
      ["pending", result.pending],
    ] as const)
      for (const [position, item] of items.entries())
        ref(item.context_index, result.contexts.length, [
          pool,
          position,
          "context_index",
        ]);
    for (const [position, frontier] of result.frontiers.entries()) {
      ref(frontier.from, result.nodes.length, ["frontiers", position, "from"]);
      if (frontier.file_offsets.length * 2 !== frontier.bytes_hex.length)
        issue(
          ["frontiers", position, "file_offsets"],
          "Every retained frontier byte requires its corresponding source location.",
        );
    }
    const counts = { decoded: 0, referenced: 0, overlap: 0, unclassified: 0 };
    let end: number | null = null;
    for (const [position, interval] of result.coverage.intervals.entries()) {
      if (end !== null && interval.file_offset !== end)
        issue(
          ["coverage", "intervals", position, "file_offset"],
          "Coverage intervals must partition a contiguous physical PRG range.",
        );
      end = interval.file_offset + interval.size;
      counts[interval.classification] += interval.size;
    }
    const expected = {
      prg_bytes:
        counts.decoded +
        counts.referenced +
        counts.overlap +
        counts.unclassified,
      decoded_bytes: counts.decoded + counts.overlap,
      referenced_bytes: counts.referenced + counts.overlap,
      overlap_bytes: counts.overlap,
      unclassified_bytes: counts.unclassified,
    };
    for (const key of Object.keys(expected) as (keyof typeof expected)[])
      if (result.coverage[key] !== expected[key])
        issue(
          ["coverage", key],
          "Coverage summary must agree with its physical interval partition.",
        );
  });

export const nesCodeDiscoverySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("unsupported"),
    reason: z.string().min(1),
  }),
  graph,
]);
export type NesCodeDiscovery = z.infer<typeof nesCodeDiscoverySchema>;
export const nesCodeDiscoveryReportSchema = z
  .strictObject({
    artifact: nesCartridgeSchema.shape.artifact,
    header: nesCartridgeSchema.shape.header,
    code_discovery: nesCodeDiscoverySchema,
    limitations: z.array(z.string().min(1)),
  })
  .superRefine((report, ctx) => {
    if (report.code_discovery.status !== "derived") return;
    const coverage = report.code_discovery.coverage;
    if (
      coverage.prg_bytes !== report.header.prgRom.size ||
      (coverage.intervals[0]?.file_offset ?? report.header.prgRom.offset) !==
        report.header.prgRom.offset
    )
      ctx.addIssue({
        code: "custom",
        path: ["code_discovery", "coverage"],
        message:
          "Coverage must partition exactly the original cartridge PRG range.",
      });
  });
export const nesCodeDiscoveryLimitations =
  "Static rooted NES code and data discovery over an immutable ROM snapshot. Caller-selected mapper assumptions and roots do not establish gameplay or path feasibility. Raw mapper-state identity retains serial and selected-register history even when visible PRG windows agree. A worklist joins abstract CPU/RAM/relative-stack/frame facts within each invocation, raw mapper context, conditional index partition and address and reports instruction nodes, candidate control-flow edges, physical ROM references and explicit unknown frontiers. Branch edges retain their own condition flag/value, exact successor register domains and live predicate witnesses. A known source flag admits only its compatible successor; an unknown flag conditions separate successor copies, including both outcomes when the relative targets coincide. Analysis CPU, domain and predicate fields remain unconditioned instruction effects; later joins can lose branch-local precision. Indexed addressing lazily conditions compatible X/Y byte candidates, including all 256 values when unconstrained. Finite site-selection maps preserve paired table bytes, RAM writes and bank effects; semantic CPU copies retain must-equal register constraints. Exact 256-bit current-value domains unify A/X/Y/SP with the 2048 physical internal-RAM bytes, preserve CPU RAM mirrors and retain non-power-of-two and nonconvex candidate sets. Live comparison and result predicates constrain current C/Z/N carriers on compatible branches. Semantic copies, internal-RAM stores and reloads propagate carriers; a comparison can survive in RAM after its CPU register is overwritten. Actual overwrites detach the affected carrier, and flag writes invalidate their own relations. Domain joins retain unions rather than expanding common-bit envelopes. Predicate sources cite particular original instructions and supporting analyses outside invocation value identity. Complex binary operations may widen to their modeled bit envelope; I/O, ROM and cartridge PRG-RAM reads do not enter internal-RAM alias groups, and arbitrary arithmetic relations remain unknown. These conditional candidates do not establish general path feasibility. Node CPU fields join all executed analysis witnesses. Known mapper writes affect subsequent fetches; unknown selectors preserve unmapped boundaries. Calls register matched continuations. Derived RTS exit summaries carry paired mapper, CPU, RAM and frame facts back only to their corresponding callers. Physical stack bytes and a separate finite 256-slot ring relative to current SP preserve actual pushes, pops and writer provenance. Unknown SP does not invent physical RAM addresses. Exit summaries expose stack_target and physical-bytes, relative-bytes or opaque-token return_proof. Qualified opaque tokens remain a fallback when byte contents are unknown. A byte-proven RTS target that differs from a caller return address continues as a stack-jump within the callee; a later matching RTS can return normally. Missing stack-byte or token proofs retain frontiers; unmodeled value relations and unproven stack contents remain unknown. Recursive invocation tables and lazy return delivery consume explicit resource budgets; pending_returns retains undelivered summary cursors. Callee partitions start locally and exit selections compose with the caller partition. Partition-count and expanded-selector-record budgets bound retained maps; pending_refinements retains lazy candidate cursors without allocating a candidate product. Stable write witnesses retain their original byte domains and particular supporting analyses outside semantic value identity. Initial bytes, possible unlocated writes and conditional support remain separate from actual writers. Sparse pooled snapshots and expanded-record capacity accounting preserve complete provenance; value-state-budget admission rolls back a whole instruction, branch family or matched return and retains its pending cursor. These are conditional static derivations, not observed execution or a proof that every call returns. Original per-byte offsets preserve cross-window instructions. Data references never automatically seed code. Coverage partitions physical PRG bytes into decoded-only, referenced-only, overlapping uses and unclassified bytes; decoded_bytes and referenced_bytes each include overlap. Worklist exhaustion covers only the examined roots and modeled transfers, not all ROM entry points, indirect dispatch tables, game structures, graphics decompression or all feasible behaviors. Caller budgets retain pending frontiers; no CPU, PPU, audio or DMA timing is inferred.";
