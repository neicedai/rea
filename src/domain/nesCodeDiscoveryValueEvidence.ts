import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import type { NesDiscoveryRam } from "./nesCodeDiscoveryRam.js";
import type { NesDiscoveryEvidence } from "./nesCodeDiscoveryEvidence.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import type {
  NesDiscoveryValues,
  NesDiscoveryValuePage,
} from "./nesCodeDiscoveryValues.js";
import { NesDiscoveryValueBudget } from "./nesCodeDiscoveryValueBudget.js";
type Graph = Extract<NesCodeDiscovery, { status: "derived" }>;
/** Sparse immutable value pages and paired RAM provenance are interned once per evidence. */
export class NesDiscoveryValueEvidence {
  private readonly pages = new Map<string, number>();
  private readonly identities = new WeakMap<NesDiscoveryValuePage, number>();
  private readonly snapshots = new Map<string, number>();
  constructor(
    readonly graph: Graph,
    readonly domains: NesDiscoveryDomainEvidence,
    readonly physical: NesDiscoveryEvidence,
    readonly budget: NesDiscoveryValueBudget,
  ) {}
  snapshot(values: NesDiscoveryValues, ram: NesDiscoveryRam): number {
    const pages = values.map((page) => {
      if (page === undefined) return null;
      const known = this.identities.get(page);
      if (known !== undefined) return known;
      let cost = 1,
        key = "[";
      for (const [offset, entry] of page.entries())
        if (entry !== undefined) {
          cost += 1 + entry.condition_witness_indices.length;
          key +=
            JSON.stringify([
              offset,
              entry.leader,
              this.domains.domain(entry.domain),
              entry.condition_witness_indices,
            ]) + ",";
        }
      key += "]";
      const prior = this.pages.get(key);
      if (prior !== undefined) {
        this.budget.weakSet(this.identities, page, prior);
        return prior;
      }
      if (!this.budget.reserve(cost)) return 0;
      const entries = page.flatMap((entry, offset) =>
        entry === undefined
          ? []
          : [
              {
                offset,
                leader: entry.leader,
                domain_index: this.domains.domain(entry.domain),
                condition_witness_indices: [...entry.condition_witness_indices],
              },
            ],
      );
      const index = this.graph.value_pages.length;
      this.budget.append(this.graph.value_pages, { index, entries });
      this.budget.mapSet(this.pages, key, index);
      this.budget.weakSet(this.identities, page, index);
      return index;
    });
    const ram_pages = this.physical.snapshot(ram, values),
      key = JSON.stringify([pages, ram_pages]),
      prior = this.snapshots.get(key);
    if (prior !== undefined) return prior;
    if (!this.budget.reserve(130)) return 0;
    const index = this.graph.value_snapshots.length;
    this.budget.append(this.graph.value_snapshots, { index, pages, ram_pages });
    this.budget.mapSet(this.snapshots, key, index);
    return index;
  }
}
