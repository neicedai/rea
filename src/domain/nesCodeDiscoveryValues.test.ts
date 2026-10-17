import { describe, expect, it } from "vitest";
import {
  assignNesDiscoveryValue,
  copyNesDiscoveryValue,
  emptyNesDiscoveryValues,
  equalNesDiscoveryVariables,
  forgetNesDiscoveryValues,
  joinNesDiscoveryValues,
  narrowNesDiscoveryValue,
  nesDiscoveryValueConditions,
  nesDiscoveryValueDomain,
  nesDiscoveryValueLeader,
  nesDiscoveryValuesEvidenceKey,
  nesDiscoveryValuesKey,
  readNesDiscoveryValue,
} from "./nesCodeDiscoveryValues.js";

const ALL = (1n << 256n) - 1n;
const bytes = (...values: number[]) =>
  values.reduce((set, value) => set | (1n << BigInt(value)), 0n);

describe("current CPU/RAM value groups", () => {
  it("distinguishes numeric coincidence from a true copy and narrows only copied values", () => {
    let values = assignNesDiscoveryValue(
      emptyNesDiscoveryValues(),
      0,
      bytes(7),
    );
    values = assignNesDiscoveryValue(values, 36, bytes(7));
    expect(equalNesDiscoveryVariables(values, 0)).toEqual([0]);
    expect(equalNesDiscoveryVariables(values, 36)).toEqual([36]);
    const copied = copyNesDiscoveryValue(values, 1, 36);
    expect(equalNesDiscoveryVariables(copied, 1)).toEqual([1, 36]);
    expect(equalNesDiscoveryVariables(copied, 0)).toEqual([0]);
    const conditioned = narrowNesDiscoveryValue(copied, 36, bytes(7), {
      condition: 11,
    })!;
    expect(nesDiscoveryValueConditions(conditioned, 1)).toEqual([11]);
    expect(nesDiscoveryValueConditions(conditioned, 0)).toEqual([]);
    expect(nesDiscoveryValueConditions(copied, 1)).toEqual([]);
  });

  it("reselects the least surviving leader while keeping its domain and proof after a CPU overwrite", () => {
    let old = assignNesDiscoveryValue(
      emptyNesDiscoveryValues(),
      0,
      bytes(1, 128),
      [7],
    );
    old = copyNesDiscoveryValue(old, 36, 0);
    old = copyNesDiscoveryValue(old, 1, 0);
    const next = assignNesDiscoveryValue(old, 0, bytes(0));
    expect(equalNesDiscoveryVariables(next, 36)).toEqual([1, 36]);
    expect(nesDiscoveryValueLeader(next, 36)).toBe(1);
    expect(nesDiscoveryValueDomain(next, 1)).toBe(bytes(1, 128));
    expect(nesDiscoveryValueConditions(next, 36)).toEqual([7]);
    expect(readNesDiscoveryValue(next, 36)?.condition_witness_indices).toEqual(
      [],
    );
    expect(nesDiscoveryValueConditions(next, 0)).toEqual([]);
    expect(equalNesDiscoveryVariables(old, 0)).toEqual([0, 1, 36]);
    expect(nesDiscoveryValueDomain(old, 0)).toBe(bytes(1, 128));
  });

  it("joins alias equivalence by intersection while unioning nonconvex domains and contributing proofs", () => {
    let left = assignNesDiscoveryValue(
      emptyNesDiscoveryValues(),
      36,
      bytes(1, 128),
      [10],
    );
    left = copyNesDiscoveryValue(left, 0, 36);
    left = copyNesDiscoveryValue(left, 1, 0);
    left = assignNesDiscoveryValue(left, 37, bytes(9));
    let right = assignNesDiscoveryValue(
      emptyNesDiscoveryValues(),
      37,
      bytes(2, 64),
      [20],
    );
    right = copyNesDiscoveryValue(right, 0, 37);
    right = copyNesDiscoveryValue(right, 1, 0);
    right = assignNesDiscoveryValue(right, 36, bytes(7));
    const joined = joinNesDiscoveryValues(left, right);
    expect(equalNesDiscoveryVariables(joined, 0)).toEqual([0, 1]);
    expect(equalNesDiscoveryVariables(joined, 36)).toEqual([36]);
    expect(equalNesDiscoveryVariables(joined, 37)).toEqual([37]);
    expect(nesDiscoveryValueDomain(joined, 0)).toBe(bytes(1, 2, 64, 128));
    expect(nesDiscoveryValueDomain(joined, 36)).toBe(bytes(1, 7, 128));
    expect(nesDiscoveryValueDomain(joined, 37)).toBe(bytes(2, 9, 64));
    expect(nesDiscoveryValueConditions(joined, 1)).toEqual([10, 20]);
    expect(
      nesDiscoveryValuesEvidenceKey(joinNesDiscoveryValues(right, left)),
    ).toBe(nesDiscoveryValuesEvidenceKey(joined));
    expect(joinNesDiscoveryValues(joined, joined)).toBe(joined);
  });

  it("forgets a subset without erasing unaffected RAM, CPU values or surviving group proofs", () => {
    let values = assignNesDiscoveryValue(
      emptyNesDiscoveryValues(),
      0,
      bytes(3, 17),
      [4],
    );
    for (const variable of [1, 36, 2051])
      values = copyNesDiscoveryValue(values, variable, 0);
    values = assignNesDiscoveryValue(values, 2, bytes(99), [8]);
    values = copyNesDiscoveryValue(values, 300, 2);
    const next = forgetNesDiscoveryValues(values, [0, 36]);
    expect(equalNesDiscoveryVariables(next, 2051)).toEqual([1, 2051]);
    expect(nesDiscoveryValueConditions(next, 2051)).toEqual([4]);
    expect(nesDiscoveryValueDomain(next, 2051)).toBe(bytes(3, 17));
    expect(equalNesDiscoveryVariables(next, 300)).toEqual([2, 300]);
    expect(nesDiscoveryValueConditions(next, 300)).toEqual([8]);
    for (const variable of [0, 36]) {
      expect(nesDiscoveryValueDomain(next, variable)).toBe(ALL);
      expect(equalNesDiscoveryVariables(next, variable)).toEqual([variable]);
    }
    expect(equalNesDiscoveryVariables(values, 0)).toEqual([0, 1, 36, 2051]);
    expect(Object.isFrozen(next)).toBe(true);
    expect(Object.isFrozen(next[64])).toBe(true);
    expect(next[64]).toHaveLength(4);
  });
});

describe("current-value identity and finite proofs", () => {
  it("retains proof-only unknown cells without changing the value-only invocation identity", () => {
    const empty = emptyNesDiscoveryValues();
    const proofOnly = assignNesDiscoveryValue(empty, 2051, ALL, [77]);
    expect(nesDiscoveryValueDomain(proofOnly, 2051)).toBe(ALL);
    expect(nesDiscoveryValueConditions(proofOnly, 2051)).toEqual([77]);
    expect(nesDiscoveryValuesKey(proofOnly)).toBe(nesDiscoveryValuesKey(empty));
    expect(nesDiscoveryValuesEvidenceKey(proofOnly)).not.toBe(
      nesDiscoveryValuesEvidenceKey(empty),
    );
    const moreProof = narrowNesDiscoveryValue(proofOnly, 2051, ALL, {
      condition: 88,
    })!;
    expect(nesDiscoveryValueConditions(moreProof, 2051)).toEqual([77, 88]);
    expect(nesDiscoveryValuesKey(moreProof)).toBe(nesDiscoveryValuesKey(empty));
    expect(nesDiscoveryValuesEvidenceKey(moreProof)).not.toBe(
      nesDiscoveryValuesEvidenceKey(proofOnly),
    );
  });

  it("keeps an all-byte copy meaningful, rejects an impossible refinement and leaves prior snapshots immutable", () => {
    const empty = emptyNesDiscoveryValues();
    const copied = copyNesDiscoveryValue(empty, 36, 0);
    expect(equalNesDiscoveryVariables(copied, 0)).toEqual([0, 36]);
    expect(nesDiscoveryValuesKey(copied)).not.toBe(
      nesDiscoveryValuesKey(empty),
    );
    const narrowed = narrowNesDiscoveryValue(copied, 36, bytes(1, 128), {
      condition: 3,
    })!;
    expect(nesDiscoveryValueDomain(narrowed, 0)).toBe(bytes(1, 128));
    expect(narrowNesDiscoveryValue(narrowed, 0, bytes(2, 64))).toBeNull();
    expect(
      narrowNesDiscoveryValue(narrowed, 0, bytes(1, 128), { condition: 3 }),
    ).toBe(narrowed);
    expect(nesDiscoveryValueDomain(copied, 0)).toBe(ALL);
    expect(readNesDiscoveryValue(empty, 0)).toBeUndefined();
  });

  it("reaches the same finite join regardless of grouping and excludes proof growth from semantic keys", () => {
    const one = assignNesDiscoveryValue(
      emptyNesDiscoveryValues(),
      36,
      bytes(1),
      [1],
    );
    const two = assignNesDiscoveryValue(
      emptyNesDiscoveryValues(),
      36,
      bytes(2),
      [2],
    );
    const high = assignNesDiscoveryValue(
      emptyNesDiscoveryValues(),
      36,
      bytes(128),
      [3],
    );
    const left = joinNesDiscoveryValues(joinNesDiscoveryValues(one, two), high);
    const right = joinNesDiscoveryValues(
      one,
      joinNesDiscoveryValues(two, high),
    );
    expect(nesDiscoveryValueDomain(left, 36)).toBe(bytes(1, 2, 128));
    expect(nesDiscoveryValuesEvidenceKey(left)).toBe(
      nesDiscoveryValuesEvidenceKey(right),
    );
    const supported = narrowNesDiscoveryValue(left, 36, bytes(1, 2, 128), {
      condition: 90,
    })!;
    expect(nesDiscoveryValuesKey(supported)).toBe(nesDiscoveryValuesKey(left));
    expect(nesDiscoveryValueConditions(supported, 36)).toEqual([1, 2, 3, 90]);
    expect(nesDiscoveryValueConditions(left, 36)).toEqual([1, 2, 3]);
  });
});
