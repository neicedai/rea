import { z } from "zod";
import {
  traceNesCodeInputSchema,
  nesCodeTraceSchema,
  nesCodeTraceReportSchema,
} from "./nesCodeTrace.js";
import { nesPrgViewSchema } from "./nesPrgViews.js";

const budget = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const exploreNesCodeInputSchema = traceNesCodeInputSchema.extend({
  max_paths: budget
    .default(16)
    .describe(
      "Maximum retained path attempts, including prefixes stopped at unknown branches",
    ),
  max_total_instructions: budget
    .default(4096)
    .describe(
      "Total retained/applied instructions across all path attempts, counting replayed prefixes; each path also obeys max_instructions",
    ),
});
export type ExploreNesCodeInput = z.infer<typeof exploreNesCodeInputSchema>;
const pendingPath = z.strictObject({
  parent_index: z.number().int().nonnegative().nullable(),
  branch_choices: traceNesCodeInputSchema.shape.branch_choices,
});
export const nesCodeExplorationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("unsupported"),
    reason: z.string().min(1),
  }),
  z.strictObject({
    status: z.literal("derived"),
    termination: z.enum([
      "queue-exhausted",
      "path-budget",
      "instruction-budget",
      "oam-dma-source-budget",
      "dmc-dma-source-budget",
    ]),
    instructions_applied: z.number().int().nonnegative(),
    paths: z.array(
      pendingPath.extend({
        index: z.number().int().nonnegative(),
        trace: nesCodeTraceSchema,
      }),
    ),
    pending_paths: z.array(pendingPath),
    nes_prg_views: z.array(nesPrgViewSchema),
  }),
]);
export type NesCodeExploration = z.infer<typeof nesCodeExplorationSchema>;
export const nesCodeExplorationReportSchema = nesCodeTraceReportSchema
  .omit({ code_trace: true })
  .extend({ code_exploration: nesCodeExplorationSchema });
