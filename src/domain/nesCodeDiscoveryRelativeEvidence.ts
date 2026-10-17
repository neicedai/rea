import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import { nesDiscoveryDomainProof } from "./nesCodeDiscoveryDomains.js";
import {
  nesDiscoveryRelativeCellDomain,
  type NesDiscoveryRelativeStack,
} from "./nesCodeDiscoveryRelativeStack.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import {
  NesDiscoveryValueBudget,
  unlimitedNesDiscoveryValueBudget,
} from "./nesCodeDiscoveryValueBudget.js";
type Graph = Extract<NesCodeDiscovery, { status: "derived" }>;
type EvidenceGraph = Pick<
  Graph,
  "relative_stack_write_witnesses" | "relative_stack_pages"
>;
/** Relative writers retain exact bytes without selecting an absolute stack pointer. */
export class NesDiscoveryRelativeEvidence {
  private readonly writes = new Map<string, number>();
  private readonly pages = new Map<string, number>();
  constructor(
    readonly graph: EvidenceGraph,
    readonly domains: NesDiscoveryDomainEvidence,
    readonly budget: NesDiscoveryValueBudget = unlimitedNesDiscoveryValueBudget(),
  ) {}
  write(source: {
    node_index: number;
    analysis_index: number;
    offset: number;
    domain: bigint;
  }): number {
    const { node_index, analysis_index } = source,
      offset = source.offset & 255,
      domain = source.domain,
      domain_index = this.domains.domain(domain),
      key = JSON.stringify([node_index, offset, domain.toString(16)]),
      prior = this.writes.get(key);
    if (prior !== undefined) {
      const supports =
        this.graph.relative_stack_write_witnesses[prior]!.analysis_indices;
      if (!supports.includes(analysis_index) && this.budget.reserve(1))
        this.budget.append(supports, analysis_index);
      return prior;
    }
    if (!this.budget.reserve(2)) return 0;
    const index = this.graph.relative_stack_write_witnesses.length;
    this.budget.append(this.graph.relative_stack_write_witnesses, {
      index,
      node_index,
      offset,
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
        indices.map(
          (index) =>
            this.graph.relative_stack_write_witnesses[index]!.node_index,
        ),
      ),
    ].sort((a, b) => a - b);
  }
  snapshot(stack: NesDiscoveryRelativeStack): (number | null)[] {
    return stack.map((page) => {
      if (page === undefined) return null;
      let cost = 1,
        key = "[";
      for (const [offset, cell] of page.entries())
        if (cell !== undefined) {
          cost += 1 + cell.writer_witness_indices.length;
          key +=
            JSON.stringify([
              offset,
              nesDiscoveryRelativeCellDomain(cell).toString(16),
              cell.writer_witness_indices,
            ]) + ",";
        }
      key += "]";
      if (cost === 1) return null;
      const prior = this.pages.get(key);
      if (prior !== undefined) return prior;
      if (!this.budget.reserve(cost)) return 0;
      const cells = page.flatMap((cell, offset) =>
        cell === undefined
          ? []
          : [
              {
                offset,
                value: nesDiscoveryDomainProof(
                  nesDiscoveryRelativeCellDomain(cell),
                ),
                domain_index: this.domains.domain(
                  nesDiscoveryRelativeCellDomain(cell),
                ),
                writer_witness_indices: [...cell.writer_witness_indices],
              },
            ],
      );
      const index = this.graph.relative_stack_pages.length;
      this.budget.append(this.graph.relative_stack_pages, { index, cells });
      this.budget.mapSet(this.pages, key, index);
      return index;
    });
  }
}
