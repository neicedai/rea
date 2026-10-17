import type { NesByteValue } from "./nesByteValue.js";
import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import type { NesDiscoveryState } from "./nesCodeDiscoveryState.js";
import type { NesDiscoveryEvidence } from "./nesCodeDiscoveryEvidence.js";
import type { NesDiscoveryRelativeEvidence } from "./nesCodeDiscoveryRelativeEvidence.js";
import {
  emptyNesDiscoveryRelativeStack,
  readNesDiscoveryRelativeStack,
  shiftNesDiscoveryRelativeStack,
  writeNesDiscoveryRelativeStack,
  nesDiscoveryRelativeCellDomain,
} from "./nesCodeDiscoveryRelativeStack.js";

import {
  nesDiscoveryByteDomain,
  nesDiscoveryDomainProof,
  nesDiscoveryDomainCount,
} from "./nesCodeDiscoveryDomains.js";
import {
  narrowNesDiscoveryValue,
  nesDiscoveryValueDomain,
} from "./nesCodeDiscoveryValues.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import type { NesDiscoveryConditionEvidence } from "./nesCodeDiscoveryConditionEvidence.js";
type Reference = Extract<
  NesCodeDiscovery,
  { status: "derived" }
>["data_references"][number];
export type NesDiscoveryStackByteProof =
  | "physical-bytes"
  | "relative-bytes"
  | null;
/** Current-SP coordinates follow stack moves without inventing a physical stack address. */
export class NesDiscoveryStackMemory {
  constructor(
    readonly state: NesDiscoveryState,
    readonly source: {
      physicalEvidence: NesDiscoveryEvidence;
      relativeEvidence: NesDiscoveryRelativeEvidence;
      nodeIndex: number;
      analysisIndex: number;
      domains: NesDiscoveryDomainEvidence;
      conditions: NesDiscoveryConditionEvidence;
      physicalOrigin: (
        address: number,
        domain: bigint,
      ) => Reference["ram_origins"][number];
    },
  ) {}
  write(
    physical: number | null,
    value: NesByteValue,
    domain = nesDiscoveryByteDomain(value),
  ): Reference["relative_stack_origins"] {
    if (physical !== null && this.state.cpu.sp === null) {
      this.clear();
      return [];
    }
    const offset =
        physical === null ? 0 : (physical - 256 - this.state.cpu.sp!) & 255,
      witness = this.source.relativeEvidence.write({
        node_index: this.source.nodeIndex,
        analysis_index: this.source.analysisIndex,
        offset,
        domain,
      });
    this.state.relative_stack = writeNesDiscoveryRelativeStack(
      this.state.relative_stack,
      offset,
      {
        domain,
        writer_witness_indices: [witness],
      },
    );
    return [
      {
        offset,
        writer_nodes: [this.source.nodeIndex],
        writer_witness_indices: [witness],
      },
    ];
  }
  read(physical: number | null) {
    const offset =
        physical === null ? 0 : (physical - 256 - this.state.cpu.sp!) & 255,
      relative = readNesDiscoveryRelativeStack(
        this.state.relative_stack,
        offset,
      ),
      physicalDomain =
        physical === null
          ? nesDiscoveryByteDomain(null)
          : nesDiscoveryValueDomain(this.state.values, 4 + physical),
      relativeDomain = nesDiscoveryRelativeCellDomain(relative),
      domain = physicalDomain & relativeDomain,
      combined = {
        conflict: domain === 0n,
        value: nesDiscoveryDomainProof(domain),
      };
    if (
      physical !== null &&
      relative !== undefined &&
      domain !== 0n &&
      domain !== physicalDomain
    ) {
      const condition = this.source.conditions.condition(
        {
          node_index: this.source.nodeIndex,
          kind: "stack-alias",
          variable: 4 + physical,
          relative_offset: offset,
          source_domain_index: this.source.domains.domain(physicalDomain),
          result_domain_index: this.source.domains.domain(domain),
        },
        this.source.analysisIndex,
      );
      this.state.values = narrowNesDiscoveryValue(
        this.state.values,
        4 + physical,
        domain,
        {
          condition,
          compatible: (id, selected) =>
            this.source.conditions.compatible(id, selected),
        },
      )!;
    }
    const ram_origins: Reference["ram_origins"] = [],
      relative_stack_origins: Reference["relative_stack_origins"] = [];
    if (!combined.conflict) {
      if (physical !== null)
        ram_origins.push(this.source.physicalOrigin(physical, domain));
      if (relative !== undefined)
        relative_stack_origins.push({
          offset,
          writer_nodes: this.source.relativeEvidence.writerNodes(
            relative.writer_witness_indices,
          ),
          writer_witness_indices: [...relative.writer_witness_indices],
        });
    }
    const proof: NesDiscoveryStackByteProof =
      physical !== null && nesDiscoveryDomainCount(physicalDomain) === 1
        ? "physical-bytes"
        : relative !== undefined && nesDiscoveryDomainCount(domain) === 1
          ? "relative-bytes"
          : null;
    return { ...combined, domain, ram_origins, relative_stack_origins, proof };
  }
  shift(deltaSp: number): void {
    this.state.relative_stack = shiftNesDiscoveryRelativeStack(
      this.state.relative_stack,
      deltaSp,
    );
  }
  assignSp(before: number | null, after: number | null): void {
    if (before !== null && after !== null) this.shift(after - before);
    else this.clear();
  }
  clear(): void {
    this.state.relative_stack = emptyNesDiscoveryRelativeStack();
  }
}
