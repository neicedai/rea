import { describe, expect, it } from "vitest";
import {
  emptyNesDiscoveryRelativeStack,
  joinNesDiscoveryRelativeStack,
  readNesDiscoveryRelativeStack,
  relativeStackValueKey,
  shiftNesDiscoveryRelativeStack,
  writeNesDiscoveryRelativeStack,
} from "./nesCodeDiscoveryRelativeStack.js";
const ALL = (1n << 256n) - 1n;
const byte = (value: number) => 1n << BigInt(value);
const fullStack = () => {
  let stack = emptyNesDiscoveryRelativeStack();
  for (let offset = 0; offset < 256; offset++)
    stack = writeNesDiscoveryRelativeStack(stack, offset, {
      domain: byte(offset),
      writer_witness_indices: [offset],
    });
  return stack;
};

describe("current-SP-relative stack cells", () => {
  it("owns exact nonconvex domains and canonical origins without choosing SP", () => {
    const domain = byte(1) | byte(128);
    const cell = { domain, writer_witness_indices: [3, 1, 3] };
    const empty = emptyNesDiscoveryRelativeStack(),
      stack = writeNesDiscoveryRelativeStack(empty, 0, cell);
    cell.domain = byte(48);
    cell.writer_witness_indices.push(9);
    expect(readNesDiscoveryRelativeStack(empty, 0)).toBeUndefined();
    expect(readNesDiscoveryRelativeStack(stack, 0)).toEqual({
      domain,
      value: { mask: 126, value: 0 },
      writer_witness_indices: [1, 3],
    });
    expect(Object.isFrozen(readNesDiscoveryRelativeStack(stack, 0))).toBe(true);
    expect(stack).toHaveLength(8);
  });
  it("rotates every byte-domain displacement and reverses it exactly", () => {
    const stack = fullStack();
    for (let delta = 0; delta < 256; delta++) {
      const shifted = shiftNesDiscoveryRelativeStack(stack, delta);
      expect(
        Array.from(
          { length: 256 },
          (_, offset) => readNesDiscoveryRelativeStack(shifted, offset)?.domain,
        ),
      ).toEqual(
        Array.from({ length: 256 }, (_, offset) =>
          byte((offset + delta) & 255),
        ),
      );
      expect(
        relativeStackValueKey(shiftNesDiscoveryRelativeStack(shifted, -delta)),
      ).toBe(relativeStackValueKey(stack));
    }
    expect(shiftNesDiscoveryRelativeStack(stack, 32)[0]).toBe(stack[1]);
    expect(shiftNesDiscoveryRelativeStack(stack, 256)).toBe(stack);
  });
  it("keeps push/pop order through wrap and replaces only the overwritten slot", () => {
    let stack = emptyNesDiscoveryRelativeStack();
    for (const value of [0xc0, 0x25])
      stack = shiftNesDiscoveryRelativeStack(
        writeNesDiscoveryRelativeStack(stack, 0, {
          domain: byte(value),
          writer_witness_indices: [value],
        }),
        -1,
      );
    expect(readNesDiscoveryRelativeStack(stack, 1)?.value).toBe(0x25);
    expect(readNesDiscoveryRelativeStack(stack, 2)?.value).toBe(0xc0);
    stack = shiftNesDiscoveryRelativeStack(stack, 1);
    expect(readNesDiscoveryRelativeStack(stack, 0)?.value).toBe(0x25);
    stack = shiftNesDiscoveryRelativeStack(stack, 1);
    expect(readNesDiscoveryRelativeStack(stack, 0)?.value).toBe(0xc0);
    stack = shiftNesDiscoveryRelativeStack(
      writeNesDiscoveryRelativeStack(fullStack(), 0, {
        domain: byte(99),
        writer_witness_indices: [300],
      }),
      -1,
    );
    expect(readNesDiscoveryRelativeStack(stack, 1)?.value).toBe(99);
    expect(readNesDiscoveryRelativeStack(stack, 0)?.value).toBe(255);
    expect(readNesDiscoveryRelativeStack(stack, 2)?.value).toBe(1);
  });
  it("joins nonconvex domains and finite writer identities at the same logical slot", () => {
    const a = writeNesDiscoveryRelativeStack(
      emptyNesDiscoveryRelativeStack(),
      255,
      { domain: byte(1), writer_witness_indices: [2] },
    );
    const b = writeNesDiscoveryRelativeStack(
      emptyNesDiscoveryRelativeStack(),
      255,
      { domain: byte(128), writer_witness_indices: [1] },
    );
    const common = joinNesDiscoveryRelativeStack(a, b);
    expect(readNesDiscoveryRelativeStack(common, 255)).toEqual({
      domain: byte(1) | byte(128),
      value: { mask: 126, value: 0 },
      writer_witness_indices: [1, 2],
    });
    expect(joinNesDiscoveryRelativeStack(common, common)).toBe(common);
    expect(joinNesDiscoveryRelativeStack(common, a)).toBe(common);
  });
  it("keeps missing slots unknown and forgets unsupported known values at a join", () => {
    const empty = emptyNesDiscoveryRelativeStack();
    const known = writeNesDiscoveryRelativeStack(empty, 31, {
      domain: byte(7),
      writer_witness_indices: [0],
    });
    expect(readNesDiscoveryRelativeStack(empty, 31)).toBeUndefined();
    expect(
      readNesDiscoveryRelativeStack(
        joinNesDiscoveryRelativeStack(known, empty),
        31,
      ),
    ).toBeUndefined();
    expect(joinNesDiscoveryRelativeStack(empty, known)).toBe(empty);
    expect(
      relativeStackValueKey(
        writeNesDiscoveryRelativeStack(known, 31, undefined),
      ),
    ).toBe(relativeStackValueKey(empty));
    expect(
      relativeStackValueKey(shiftNesDiscoveryRelativeStack(empty, 1)),
    ).toBe(relativeStackValueKey(empty));
  });
  it("keeps actual unknown writers and provenance growth outside logical-value identity", () => {
    const empty = emptyNesDiscoveryRelativeStack();
    const a = writeNesDiscoveryRelativeStack(empty, 32, {
      domain: ALL,
      writer_witness_indices: [1],
    });
    const b = writeNesDiscoveryRelativeStack(empty, 32, {
      domain: ALL,
      writer_witness_indices: [2],
    });
    const joined = joinNesDiscoveryRelativeStack(a, b);
    expect(relativeStackValueKey(joined)).toBe(relativeStackValueKey(empty));
    expect(
      readNesDiscoveryRelativeStack(joined, 32)?.writer_witness_indices,
    ).toEqual([1, 2]);
    const known = writeNesDiscoveryRelativeStack(empty, 32, {
      domain: byte(9),
      writer_witness_indices: [1],
    });
    expect(
      relativeStackValueKey(shiftNesDiscoveryRelativeStack(known, 1)),
    ).not.toBe(relativeStackValueKey(known));
  });
});
