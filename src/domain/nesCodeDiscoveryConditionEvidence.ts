import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import { NesDiscoveryValueBudget } from "./nesCodeDiscoveryValueBudget.js";
type Graph = Extract<NesCodeDiscovery, { status: "derived" }>;
type Witness = Graph["condition_witnesses"][number];
type WithoutIdentity<T> = T extends unknown
  ? Omit<T, "index" | "analysis_indices">
  : never;
type Source = WithoutIdentity<Witness>;
/** A condition constrains a current byte; it never claims that memory was written. */
export class NesDiscoveryConditionEvidence {
  private readonly indices = new Map<string, number>();
  constructor(
    readonly graph: Graph,
    readonly budget: NesDiscoveryValueBudget,
  ) {}
  compatible(index: number, domain: bigint): boolean {
    if (this.budget.failed) return true;
    const witness = this.graph.condition_witnesses[index]!,
      bits = BigInt(
        `0x${this.graph.byte_domains[witness.result_domain_index]!.bitmap_hex}`,
      );
    return (bits & domain) !== 0n;
  }
  condition(source: Source, analysis: number): number {
    const key = JSON.stringify(source),
      prior = this.indices.get(key);
    if (prior !== undefined) {
      const supports = this.graph.condition_witnesses[prior]!.analysis_indices;
      if (!supports.includes(analysis) && this.budget.reserve(1))
        this.budget.append(supports, analysis);
      return prior;
    }
    if (!this.budget.reserve(2)) return 0;
    const index = this.graph.condition_witnesses.length;
    this.budget.append(this.graph.condition_witnesses, {
      ...source,
      index,
      analysis_indices: [analysis],
    });
    this.budget.mapSet(this.indices, key, index);
    return index;
  }
}
