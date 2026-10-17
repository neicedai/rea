import type { NesRomMetadata } from "./nes.js";
import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
type Graph = Extract<NesCodeDiscovery, { status: "derived" }>;
/** Count immutable physical bytes once, regardless of CPU mirrors or mapper contexts. */
export const nesCodeDiscoveryCoverage = (
  header: NesRomMetadata,
  graph: Pick<Graph, "nodes" | "data_references" | "roots">,
): Graph["coverage"] => {
  const flags = new Uint8Array(header.prgRom.size),
    base = header.prgRom.offset;
  const mark = (offset: number | null, flag: number) => {
    if (offset !== null && offset >= base && offset < base + flags.length)
      flags[offset - base]! |= flag;
  };
  for (const node of graph.nodes)
    for (const offset of node.file_offsets) mark(offset, 1);
  for (const reference of graph.data_references)
    for (const offset of reference.file_offsets) mark(offset, 2);
  for (const root of graph.roots)
    for (const read of root.vector ?? []) mark(read.file_offset, 2);
  const classification = (flag: number) =>
    flag === 1
      ? "decoded"
      : flag === 2
        ? "referenced"
        : flag === 3
          ? "overlap"
          : "unclassified";
  const intervals: Graph["coverage"]["intervals"] = [];
  let decoded_bytes = 0,
    referenced_bytes = 0,
    overlap_bytes = 0,
    unclassified_bytes = 0,
    start = 0;
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index]!;
    if (flag & 1) decoded_bytes++;
    if (flag & 2) referenced_bytes++;
    if (flag === 3) overlap_bytes++;
    if (flag === 0) unclassified_bytes++;
    if (index + 1 === flags.length || flag !== flags[index + 1]) {
      intervals.push({
        file_offset: base + start,
        size: index - start + 1,
        classification: classification(flag),
      });
      start = index + 1;
    }
  }
  return {
    prg_bytes: flags.length,
    decoded_bytes,
    referenced_bytes,
    overlap_bytes,
    unclassified_bytes,
    intervals,
  };
};
