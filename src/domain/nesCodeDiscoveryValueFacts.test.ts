import { describe, expect, it } from "vitest";
import {
  conditionNesDiscoveryValueFacts,
  createNesDiscoveryValueFactDecoder,
  nesDiscoveryValueFact,
  type NesDiscoveryValueFactPools,
} from "./nesCodeDiscoveryValueFacts.js";
import type { NesDiscoveryPredicateSnapshot } from "./nesCodeDiscoveryDomainFacts.js";

const domain = (index: number, values: number[]) => ({
  index,
  bitmap_hex: values
    .reduce((bits, value) => bits | (1n << BigInt(value)), 0n)
    .toString(16)
    .padStart(64, "0"),
  count: values.length,
});
const pools = (): NesDiscoveryValueFactPools => ({
  byte_domains: [domain(0, [1, 128])],
  value_pages: [
    {
      index: 0,
      entries: [
        {
          offset: 4,
          leader: 4,
          domain_index: 0,
          condition_witness_indices: [],
        },
        {
          offset: 5,
          leader: 5,
          domain_index: 0,
          condition_witness_indices: [],
        },
        {
          offset: 6,
          leader: 4,
          domain_index: 0,
          condition_witness_indices: [],
        },
      ],
    },
  ],
  value_snapshots: [
    {
      index: 0,
      pages: [0, ...Array<null>(64).fill(null)],
      ram_pages: Array<null>(64).fill(null),
    },
  ],
});
const predicates: NesDiscoveryPredicateSnapshot = {
  c: null,
  z: null,
  n: {
    kind: "result",
    operand: null,
    carrier_variable: 4,
    registers: [],
    source_witness_indices: [0],
  },
};

describe("independent current-value wire interpretation", () => {
  it("filters RAM-only subjects and their copies without conflating equal domains", () => {
    const source = createNesDiscoveryValueFactDecoder(pools())(0)!;
    const selected = conditionNesDiscoveryValueFacts(
      source,
      predicates,
      "n",
      true,
    )!;
    expect(nesDiscoveryValueFact(selected, 4).bitmap).toBe(1n << 128n);
    expect(nesDiscoveryValueFact(selected, 6).bitmap).toBe(1n << 128n);
    expect(nesDiscoveryValueFact(selected, 5).bitmap).toBe(
      (1n << 1n) | (1n << 128n),
    );
    expect(nesDiscoveryValueFact(selected, 0).bitmap).toBe((1n << 256n) - 1n);
    expect(
      conditionNesDiscoveryValueFacts(selected, predicates, "n", false),
    ).toBeNull();
  });

  it("rejects malformed pool references and final-page expansion", () => {
    const invalid = pools();
    invalid.value_snapshots[0]!.pages[64] = 0;
    expect(createNesDiscoveryValueFactDecoder(invalid)(0)).toBeNull();
    const missing = pools();
    missing.value_snapshots[0]!.pages[0] = 1;
    expect(createNesDiscoveryValueFactDecoder(missing)(0)).toBeNull();
    const duplicate = pools();
    duplicate.value_pages[0]!.entries.push({
      ...duplicate.value_pages[0]!.entries[0]!,
    });
    expect(createNesDiscoveryValueFactDecoder(duplicate)(0)).toBeNull();
  });
});
