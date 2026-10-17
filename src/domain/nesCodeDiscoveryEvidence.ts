import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import type {
  NesDiscoveryRam,
  NesDiscoveryRamPage,
} from "./nesCodeDiscoveryRam.js";
import type { NesDiscoveryValues } from "./nesCodeDiscoveryValues.js";
import {
  nesDiscoveryValueDomain,
  type NesDiscoveryValuePage,
} from "./nesCodeDiscoveryValues.js";
import { nesDiscoveryDomainProof } from "./nesCodeDiscoveryDomains.js";
import {
  NesDiscoveryValueBudget,
  unlimitedNesDiscoveryValueBudget,
} from "./nesCodeDiscoveryValueBudget.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
type Graph = Extract<NesCodeDiscovery, { status: "derived" }>;
type EvidenceGraph = Pick<Graph, "write_witnesses" | "ram_pages">;
/** Actual writers remain identifiable even when their written byte has no known bits. */
export class NesDiscoveryEvidence {
  private readonly writes = new Map<string, number>();
  private readonly pages = new Map<string, number>();
  private readonly pageIdentities = new WeakMap<
    NesDiscoveryRamPage,
    Map<
      NesDiscoveryValuePage | undefined,
      Map<NesDiscoveryValuePage | undefined, number | null>
    >
  >();
  constructor(
    readonly graph: EvidenceGraph,
    readonly domains: NesDiscoveryDomainEvidence,
    readonly budget: NesDiscoveryValueBudget = unlimitedNesDiscoveryValueBudget(),
  ) {}
  write(source: {
    node_index: number;
    analysis_index: number;
    address: number;
    domain: bigint;
  }): number {
    const { node_index, analysis_index } = source,
      address = source.address & 2047,
      domain = source.domain,
      domain_index = this.domains.domain(domain),
      key = JSON.stringify([node_index, address, domain.toString(16)]),
      prior = this.writes.get(key);
    if (prior !== undefined) {
      const supports = this.graph.write_witnesses[prior]!.analysis_indices;
      if (!supports.includes(analysis_index) && this.budget.reserve(1))
        this.budget.append(supports, analysis_index);
      return prior;
    }
    if (!this.budget.reserve(2)) return 0;
    const index = this.graph.write_witnesses.length;
    this.budget.append(this.graph.write_witnesses, {
      index,
      node_index,
      address,
      value: nesDiscoveryDomainProof(domain),
      domain_index,
      analysis_indices: [analysis_index],
    });
    this.budget.mapSet(this.writes, key, index);
    return index;
  }
  writerNodes(indices: readonly number[]): number[] {
    return [
      ...new Set(
        indices.map((index) => this.graph.write_witnesses[index]!.node_index),
      ),
    ].sort((a, b) => a - b);
  }
  snapshot(
    ram: NesDiscoveryRam,
    values: NesDiscoveryValues,
  ): (number | null)[] {
    return ram.map((page, pageIndex) => {
      if (page === undefined) return null;
      const first = values[pageIndex],
        second = values[pageIndex + 1],
        byFirst = this.pageIdentities.get(page),
        bySecond = byFirst?.get(first),
        cached = bySecond?.get(second);
      if (cached !== undefined) return cached;
      const remember = (index: number | null) => {
        let a = this.pageIdentities.get(page);
        if (a === undefined) {
          a = new Map();
          this.budget.weakSet(this.pageIdentities, page, a);
        }
        let b = a.get(first);
        if (b === undefined) {
          b = new Map();
          this.budget.mapSet(a, first, b);
        }
        this.budget.mapSet(b, second, index);
        return index;
      };
      let cost = 1,
        key = "[";
      for (const [offset, cell] of page.entries())
        if (cell !== undefined) {
          cost += 1 + cell.writer_witness_indices.length;
          key +=
            JSON.stringify([
              offset,
              nesDiscoveryDomainProof(
                nesDiscoveryValueDomain(values, 4 + pageIndex * 32 + offset),
              ),
              cell.writer_witness_indices,
              cell.initial_unwritten_possible,
              cell.unknown_write_possible,
            ]) + ",";
        }
      key += "]";
      if (cost === 1) return remember(null);
      const prior = this.pages.get(key);
      if (prior !== undefined) return remember(prior);
      if (!this.budget.reserve(cost)) return 0;
      const cells = page.flatMap((cell, offset) =>
        cell === undefined
          ? []
          : [
              {
                offset,
                value: nesDiscoveryDomainProof(
                  nesDiscoveryValueDomain(values, 4 + pageIndex * 32 + offset),
                ),
                writer_witness_indices: [...cell.writer_witness_indices],
                initial_unwritten_possible: cell.initial_unwritten_possible,
                unknown_write_possible: cell.unknown_write_possible,
              },
            ],
      );
      const index = this.graph.ram_pages.length;
      this.budget.append(this.graph.ram_pages, { index, cells });
      this.budget.mapSet(this.pages, key, index);
      return remember(index);
    });
  }
}
