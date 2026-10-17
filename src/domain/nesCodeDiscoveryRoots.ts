import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import type { DiscoverNesCodeInput } from "./nesCodeDiscovery.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesDiscoveryGraph as Graph } from "./nesCodeDiscoveryGraph.js";
import { appendNesDiscoveryFrontier } from "./nesCodeDiscoveryGraph.js";
import { nesDiscoveryRoots } from "./nesCodeDiscoveryAdmission.js";
import { emptyNesDiscoveryState } from "./nesCodeDiscoveryState.js";
import { readNesDiscoveryVector } from "./nesCodeDiscoveryMemory.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import type { NesDiscoveryTabulation } from "./nesCodeDiscoveryTabulation.js";
import type { NesDiscoveryValueBudget } from "./nesCodeDiscoveryValueBudget.js";
export const seedNesDiscoveryRoots = async (
  header: NesRomMetadata,
  prg: Uint8Array,
  input: DiscoverNesCodeInput,
  owner: {
    graph: Graph;
    signal: AbortSignal | undefined;
    context: (state: NesMapperState) => number | null;
    calls: Pick<NesDiscoveryTabulation, "invocation">;
    budget: NesDiscoveryValueBudget;
  },
): Promise<void> => {
  for (const root of nesDiscoveryRoots(input)) {
    owner.signal?.throwIfAborted();
    if (owner.graph.roots.length > 0 && owner.graph.roots.length % 128 === 0) {
      await scheduler.yield();
      owner.signal?.throwIfAborted();
    }
    const context_index = owner.context(root.initial),
      index = owner.graph.roots.length;
    if (context_index === null) {
      owner.graph.roots.push({
        index,
        entry: root.entry,
        context_index: null,
        invocation_index: null,
        partition_index: null,
        target_address: null,
        node_index: null,
        vector: null,
        reason: "context-budget",
      });
      continue;
    }
    const vector =
        typeof root.entry === "number"
          ? null
          : readNesDiscoveryVector(
              header,
              prg,
              mapperMapping(header, root.initial),
              root.entry,
            ),
      address = typeof root.entry === "number" ? root.entry : vector!.target;
    const invocation_index =
      address === null
        ? null
        : owner.calls.invocation(
            context_index,
            address,
            emptyNesDiscoveryState(),
          );
    owner.graph.roots.push({
      index,
      entry: root.entry,
      context_index,
      invocation_index,
      partition_index: invocation_index === null ? null : 0,
      target_address: address,
      node_index: null,
      vector: vector?.reads ?? null,
      reason:
        address === null
          ? "unresolved-vector"
          : invocation_index === null
            ? owner.budget.failed
              ? "value-state-budget"
              : "invocation-budget"
            : null,
    });
    if (address === null)
      appendNesDiscoveryFrontier(
        owner.graph,
        { context_index, address: null, from: null },
        "unresolved-vector",
      );
    else if (invocation_index === null)
      appendNesDiscoveryFrontier(
        owner.graph,
        { context_index, invocation_index: null, address, from: null },
        owner.budget.failed ? "value-state-budget" : "invocation-budget",
      );
  }
};
