import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { nesOamTraceReadBytes } from "./nesCpuDmaBudget.js";
import type {
  ExploreNesCodeInput,
  NesCodeExploration,
} from "./nesCodeExploration.js";

/** Breadth-first conditional paths, each replayed from the same immutable snapshot. */
export const exploreNesCode = async (
  header: NesRomMetadata,
  prg: Uint8Array,
  input: ExploreNesCodeInput,
  {
    signal,
    chr,
  }: {
    signal?: AbortSignal | undefined;
    chr?: Uint8Array | null | undefined;
  } = {},
): Promise<NesCodeExploration> => {
  type Exploration = Extract<NesCodeExploration, { status: "derived" }>;
  const pending: Exploration["pending_paths"] = [
    { parent_index: null, branch_choices: input.branch_choices },
  ];
  const paths: Exploration["paths"] = [];
  const views: Exploration["nes_prg_views"] = [];
  const viewKeys = new Set<string>();
  let examined = 0;
  let oamSourceBytes = 0;
  let dmcSourceBytes = 0;
  let head = 0;
  let termination: Exploration["termination"] = "queue-exhausted";
  while (head < pending.length) {
    signal?.throwIfAborted();
    if (paths.length >= input.max_paths) {
      termination = "path-budget";
      break;
    }
    const remaining = input.max_total_instructions - examined;
    if (remaining === 0) {
      termination = "instruction-budget";
      break;
    }
    // Even paths that stop before applying an instruction must yield to cancellation.
    await scheduler.yield();
    signal?.throwIfAborted();
    const next = pending[head++]!;
    const trace = await deriveNesCode(
      header,
      prg,
      {
        ...input,
        branch_choices: next.branch_choices,
        max_instructions: Math.min(input.max_instructions, remaining),
        max_oam_dma_source_bytes:
          input.max_oam_dma_source_bytes - oamSourceBytes,
        max_dmc_dma_source_bytes:
          input.max_dmc_dma_source_bytes - dmcSourceBytes,
      },
      { signal, chr },
    );
    if (trace.status === "unsupported") return trace;
    oamSourceBytes += nesOamTraceReadBytes(trace);
    dmcSourceBytes +=
      trace.cpu_bus !== null && "dmc" in trace.cpu_bus
        ? trace.cpu_bus.dmc.retained_source_bytes
        : 0;
    if (trace.stop.reason === "oam-dma-source-budget")
      termination = "oam-dma-source-budget";
    if (trace.stop.reason === "dmc-dma-source-budget")
      termination = "dmc-dma-source-budget";
    const index = paths.length;
    paths.push({ index, ...next, trace });
    examined += trace.instructions.length;
    if (trace.mapper_trace.status === "derived") {
      for (const view of trace.mapper_trace.nes_prg_views) {
        const key = JSON.stringify(view);
        if (!viewKeys.has(key)) {
          views.push(view);
          viewKeys.add(key);
        }
      }
    }
    if (
      termination === "oam-dma-source-budget" ||
      termination === "dmc-dma-source-budget"
    )
      break;
    if (
      trace.stop.reason === "instruction-budget" &&
      examined === input.max_total_instructions
    ) {
      termination = "instruction-budget";
      break;
    }
    if (trace.stop.reason === "unknown-branch" && trace.stop.address !== null) {
      for (const taken of [false, true])
        pending.push({
          parent_index: index,
          branch_choices: [
            ...next.branch_choices,
            { address: trace.stop.address, taken },
          ],
        });
    }
  }
  signal?.throwIfAborted();
  return {
    status: "derived",
    termination,
    instructions_applied: examined,
    paths,
    pending_paths: pending.slice(head),
    nes_prg_views: views,
  };
};
