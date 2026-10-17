import type { z } from "zod";
import type {
  nesDiscoveryValuePageSchema,
  nesDiscoveryValueSnapshotSchema,
  nesDiscoveryConditionWitnessSchema,
} from "./nesCodeDiscoveryValueSchemas.js";
import {
  nesDiscoveryDomainValues,
  nesDiscoveryPredicateTruth,
  parseNesDiscoveryDomainBitmap,
  type NesDiscoveryDomainPool,
  type NesDiscoveryPredicateSnapshot,
} from "./nesCodeDiscoveryDomainFacts.js";

export type NesDiscoveryValuePageFact = z.infer<
  typeof nesDiscoveryValuePageSchema
>;
export type NesDiscoveryValueSnapshotFact = z.infer<
  typeof nesDiscoveryValueSnapshotSchema
>;
export type NesDiscoveryConditionWitnessFact = z.infer<
  typeof nesDiscoveryConditionWitnessSchema
>;
export type NesDiscoveryValueFact = {
  leader: number;
  bitmap: bigint;
  conditions: readonly number[];
};
export interface NesDiscoveryDecodedValueFacts {
  get(variable: number): NesDiscoveryValueFact | undefined;
  keys(): IterableIterator<number>;
  [Symbol.iterator](): IterableIterator<[number, NesDiscoveryValueFact]>;
}
export type NesDiscoveryValueFactPools = {
  byte_domains: NesDiscoveryDomainPool;
  value_pages: readonly NesDiscoveryValuePageFact[];
  value_snapshots: readonly NesDiscoveryValueSnapshotFact[];
};
const allBytes = (1n << 256n) - 1n;

export const nesDiscoveryValueFact = (
  facts: NesDiscoveryDecodedValueFacts,
  variable: number,
): NesDiscoveryValueFact =>
  facts.get(variable) ?? {
    leader: variable,
    bitmap: allBytes,
    conditions: [],
  };

/** One validation owns pooled parsing; snapshots share their decoded pages. */
class ValueFactDecoder {
  private readonly pages = new Map<
    number,
    readonly (NesDiscoveryValueFact | undefined)[] | null
  >();
  private readonly domains = new Map<number, bigint | null>();
  constructor(readonly pools: NesDiscoveryValueFactPools) {}
  private domain(index: number): bigint | null {
    if (!this.domains.has(index)) {
      const source = this.pools.byte_domains[index];
      this.domains.set(
        index,
        source === undefined
          ? null
          : parseNesDiscoveryDomainBitmap(source.bitmap_hex),
      );
    }
    return this.domains.get(index)!;
  }
  private page(
    index: number,
  ): readonly (NesDiscoveryValueFact | undefined)[] | null {
    if (this.pages.has(index)) return this.pages.get(index)!;
    const source = this.pools.value_pages[index];
    if (source === undefined) {
      this.pages.set(index, null);
      return null;
    }
    const slots = Array<NesDiscoveryValueFact | undefined>(32).fill(undefined);
    for (const entry of source.entries) {
      const bitmap = this.domain(entry.domain_index);
      if (
        !Number.isInteger(entry.offset) ||
        entry.offset < 0 ||
        entry.offset >= 32 ||
        slots[entry.offset] !== undefined ||
        bitmap === null ||
        bitmap === 0n
      ) {
        this.pages.set(index, null);
        return null;
      }
      slots[entry.offset] = {
        leader: entry.leader,
        bitmap,
        conditions: entry.condition_witness_indices,
      };
    }
    this.pages.set(index, slots);
    return slots;
  }
  readonly decode = (
    snapshotIndex: number,
  ): NesDiscoveryDecodedValueFacts | null => {
    const snapshot = this.pools.value_snapshots[snapshotIndex];
    if (snapshot === undefined || snapshot.pages.length !== 65) return null;
    for (const [pageNumber, pageIndex] of snapshot.pages.entries()) {
      if (pageIndex === null) continue;
      const page = this.page(pageIndex);
      if (
        page === null ||
        (pageNumber === 64 &&
          page.slice(4).some((entry) => entry !== undefined))
      )
        return null;
    }
    const pageAt = (number: number) => {
      const index = snapshot.pages[number];
      return index == null ? undefined : this.page(index)!;
    };
    return {
      get(variable) {
        return pageAt(variable >> 5)?.[variable & 31];
      },
      *keys() {
        for (let number = 0; number < 65; number++) {
          const page = pageAt(number);
          if (page === undefined) continue;
          for (let offset = 0; offset < 32; offset++)
            if (page[offset] !== undefined) yield number * 32 + offset;
        }
      },
      *[Symbol.iterator]() {
        for (let number = 0; number < 65; number++) {
          const page = pageAt(number);
          if (page === undefined) continue;
          for (let offset = 0; offset < 32; offset++) {
            const fact = page[offset];
            if (fact !== undefined) yield [number * 32 + offset, fact];
          }
        }
      },
    };
  };
}
/** Decode wire facts independently of producer transfers, once per owning pool. */
export const createNesDiscoveryValueFactDecoder = (
  pools: NesDiscoveryValueFactPools,
) => new ValueFactDecoder(pools).decode;

export const nesDiscoveryValueCpuMembers = (
  facts: NesDiscoveryDecodedValueFacts,
  variable: number,
): ("a" | "x" | "y" | "sp")[] => {
  const leader = nesDiscoveryValueFact(facts, variable).leader;
  return (["a", "x", "y", "sp"] as const).filter(
    (_register, index) => nesDiscoveryValueFact(facts, index).leader === leader,
  );
};

/** Conditional choices filter the subject's whole copy group, including RAM. */
export const conditionNesDiscoveryValueFacts = (
  source: NesDiscoveryDecodedValueFacts,
  predicates: NesDiscoveryPredicateSnapshot,
  flag: "c" | "z" | "n" | "v",
  expected: boolean,
): NesDiscoveryDecodedValueFacts | null => {
  const predicate = flag === "v" ? null : predicates[flag];
  if (predicate === null || flag === "v") return source;
  const subject = nesDiscoveryValueFact(source, predicate.carrier_variable);
  let bitmap = 0n;
  for (const value of nesDiscoveryDomainValues(subject.bitmap))
    if (nesDiscoveryPredicateTruth(predicate, flag, value) === expected)
      bitmap |= 1n << BigInt(value);
  if (bitmap === 0n) return null;
  const result = new Map(source);
  for (const [variable, fact] of source)
    if (fact.leader === subject.leader)
      result.set(variable, { ...fact, bitmap });
  if (!result.has(subject.leader))
    result.set(subject.leader, { ...subject, bitmap });
  return result;
};

/** Proof support may grow without changing current value identities. */
export const equalNesDiscoveryValueFacts = (
  left: NesDiscoveryDecodedValueFacts,
  right: NesDiscoveryDecodedValueFacts,
): boolean => {
  for (const variable of new Set([...left.keys(), ...right.keys()])) {
    const a = nesDiscoveryValueFact(left, variable),
      b = nesDiscoveryValueFact(right, variable);
    if (a.leader !== b.leader || a.bitmap !== b.bitmap) return false;
  }
  return true;
};
