import type {
  NesDataRead,
  NesCodeTrace,
  NesDmaIoRead,
} from "./nesCodeTrace.js";

/** Leaves room for both MCP Evidence projections and ordinary instruction/state records. */
export const NES_CPU_DMA_SOURCE_BYTES = 2 * 1024 * 1024;

/** UTF-8 JSON element bytes plus separators; array brackets and other metadata are excluded. */
export const nesCpuReadProofBytes = (
  reads: readonly (NesDataRead | { read: NesDataRead; dma_io: NesDmaIoRead })[],
): number =>
  reads.length === 0
    ? 0
    : new TextEncoder().encode(JSON.stringify(reads)).length - 2;

/** Replayed prefixes consume the shared exploration budget just like applied paths. */
export const nesOamTraceReadBytes = (trace: NesCodeTrace): number => {
  if (trace.status !== "derived") return 0;
  if ("cpu_dma" in trace) return trace.cpu_dma.retained_source_bytes;
  let bytes = 0;
  for (const instruction of trace.instructions)
    if ("oam_dma_reads" in instruction)
      bytes += nesCpuReadProofBytes(instruction.oam_dma_reads);
  if ("oam_dma_reads" in trace.stop)
    bytes += nesCpuReadProofBytes(trace.stop.oam_dma_reads);
  if ("oam_dma_frontier" in trace.stop)
    bytes += nesCpuReadProofBytes(trace.stop.oam_dma_frontier.reads);
  return bytes;
};
