import { expect, it } from "vitest";
import {
  applyIrem78Write,
  irem78Board,
  irem78Mirroring,
  irem78NametablePages,
  irem78PrgCandidates,
  isIrem78State,
  nesIrem78StateSchema,
  nesIrem78VariantSchema,
  type NesIrem78Variant,
} from "./nesIrem78.js";
import type { NesByteValue } from "./nesByteValue.js";

const initial = (variant: NesIrem78Variant = "cosmo-carrier") =>
  nesIrem78StateSchema.parse({ mapper: 78, variant });
const write = (address: number, value: NesByteValue) =>
  typeof value === "object" && value !== null
    ? {
        address,
        value: null,
        known_bits: value,
        preceded_by_cpu_write: false,
      }
    : { address, value, preceded_by_cpu_write: false };

it("requires a board choice and retains an unknown initial latch without split selectors", () => {
  expect(initial()).toEqual({
    mapper: 78,
    variant: "cosmo-carrier",
    latch: null,
  });
  expect(nesIrem78VariantSchema.options).toEqual([
    "cosmo-carrier",
    "holy-diver",
  ]);
  expect(isIrem78State(initial())).toBe(true);
  expect(isIrem78State({ mapper: 73 })).toBe(false);
  for (const invalid of [
    { mapper: 78 },
    { mapper: 78, variant: "unknown" },
    { mapper: 78, variant: "cosmo-carrier", prg_bank: 0 },
    { mapper: 78, variant: "holy-diver", bus_conflicts: "none" },
    { mapper: 78, variant: "holy-diver", latch: 256 },
    { mapper: 78, variant: "holy-diver", latch: { mask: 8, value: 9 } },
    { mapper: 78, variant: "holy-diver", latch: { mask: 255, value: 0 } },
  ])
    expect(nesIrem78StateSchema.safeParse(invalid).success).toBe(false);
});

it("resolves only explicit board declarations or caller choices without interpreting legacy four-screen flags", () => {
  for (const submapper of [null, 0]) {
    const header = { mapper: 78, submapper, mirroring: "four-screen" },
      before = structuredClone(header);
    expect(irem78Board(header)).toBeNull();
    for (const variant of nesIrem78VariantSchema.options)
      expect(irem78Board(header, variant)).toBe(variant);
    expect(header).toEqual(before);
  }
  for (const [submapper, variant] of [
    [1, "cosmo-carrier"],
    [3, "holy-diver"],
  ] as const) {
    expect(irem78Board({ mapper: 78, submapper })).toBe(variant);
    expect(irem78Board({ mapper: 78, submapper }, variant)).toBe(variant);
    expect(
      irem78Board(
        { mapper: 78, submapper },
        variant === "cosmo-carrier" ? "holy-diver" : "cosmo-carrier",
      ),
    ).toBeNull();
  }
  for (const submapper of [2, 4, 15])
    for (const variant of nesIrem78VariantSchema.options)
      expect(irem78Board({ mapper: 78, submapper }, variant)).toBeNull();
  expect(irem78Board({ mapper: 73, submapper: 1 }, "cosmo-carrier")).toBeNull();
});

it("uses every 8000–FFFF write address for one shared post-conflict latch and leaves lower writes outside", () => {
  for (const variant of nesIrem78VariantSchema.options) {
    const state = initial(variant);
    for (let address = 0; address < 65536; address++) {
      const result = applyIrem78Write(
        state,
        write(address, address % 256),
        247,
      );
      if (address < 32768) {
        if (result.effect !== "outside-mapper" || state.latch !== null)
          throw new Error(`Unexpected lower-port latch at ${address}`);
      } else if (
        result.effect !== "prg-chr-bank" ||
        state.latch !== ((address % 256) & 247) ||
        state.variant !== variant ||
        result.state !== state
      )
        throw new Error(`Incorrect Mapper 78 write at ${address}`);
    }
  }
});

type ByteCase = { proof: NesByteValue; bits: readonly number[] };
const byteCase = (proof: NesByteValue): ByteCase => ({
  proof,
  bits: Array.from({ length: 8 }, (_, bit) =>
    typeof proof === "number"
      ? (proof >> bit) & 1
      : proof !== null && (proof.mask & (1 << bit)) !== 0
        ? (proof.value >> bit) & 1
        : 2,
  ),
});
const canonical = (mask: number, value: number): NesByteValue =>
  mask === 0 ? null : mask === 255 ? value : { mask, value };

/** Every bit is unknown, known-zero or known-one: all 3^8 canonical proofs. */
const proofs: readonly ByteCase[] = Array.from({ length: 6561 }, (_, code) => {
  let mask = 0,
    value = 0,
    remaining = code;
  for (let bit = 0; bit < 8; bit++) {
    const state = remaining % 3;
    remaining = Math.floor(remaining / 3);
    if (state !== 0) mask += 1 << bit;
    if (state === 2) value += 1 << bit;
  }
  return byteCase(canonical(mask, value));
});
const fullBytes = Array.from({ length: 256 }, (_, value) => byteCase(value));

/** Build the independent truth table by enumerating concrete one-bit drivers. */
const domains = [[0], [1], [0, 1]];
const andTruth = domains.map((left) =>
  domains.map((right) => {
    const outputs = new Set(
      left.flatMap((a) => right.map((b) => (a === 1 && b === 1 ? 1 : 0))),
    );
    return outputs.size === 1 ? [...outputs][0]! : 2;
  }),
);
const oracle = (left: ByteCase, right: ByteCase): NesByteValue => {
  let mask = 0,
    value = 0;
  for (let bit = 0; bit < 8; bit++) {
    const result = andTruth[left.bits[bit]!]![right.bits[bit]!]!;
    if (result !== 2) mask += 1 << bit;
    if (result === 1) value += 1 << bit;
  }
  return canonical(mask, value);
};
const sameProof = (left: NesByteValue, right: NesByteValue) =>
  left === right ||
  (typeof left === "object" &&
    left !== null &&
    typeof right === "object" &&
    right !== null &&
    left.mask === right.mask &&
    left.value === right.value);

it("matches every canonical CPU proof against every ROM byte and the symmetric ROM-proof case", () => {
  const state = initial(),
    fullWrites = fullBytes.map((item) => write(0x8000, item.proof));
  for (const cpu of proofs) {
    const request = write(0xffff, cpu.proof);
    for (const [index, rom] of fullBytes.entries()) {
      const expected = oracle(cpu, rom);
      applyIrem78Write(state, request, rom.proof);
      if (!sameProof(state.latch, expected))
        throw new Error(`CPU proof ${JSON.stringify(cpu.proof)}, ROM ${index}`);
      applyIrem78Write(state, fullWrites[index]!, cpu.proof);
      if (!sameProof(state.latch, expected))
        throw new Error(`CPU ${index}, ROM proof ${JSON.stringify(cpu.proof)}`);
    }
  }
});

it("joins both partially known drivers by concrete bit outcomes without retaining old latch facts", () => {
  const state = initial("holy-diver"),
    partialRoms = [
      null,
      { mask: 1, value: 0 },
      { mask: 1, value: 1 },
      { mask: 8, value: 0 },
      { mask: 8, value: 8 },
      { mask: 15, value: 5 },
      { mask: 240, value: 160 },
      { mask: 170, value: 136 },
      { mask: 85, value: 17 },
      { mask: 254, value: 164 },
      { mask: 127, value: 42 },
    ].map(byteCase);
  for (const cpu of proofs) {
    const request = write(0xb123, cpu.proof);
    for (const rom of partialRoms) {
      state.latch = 255;
      applyIrem78Write(state, request, rom.proof);
      if (!sameProof(state.latch, oracle(cpu, rom)))
        throw new Error(
          `Partial drivers ${JSON.stringify([cpu.proof, rom.proof])}`,
        );
    }
  }
  applyIrem78Write(state, write(0x8000, null), null);
  expect(state.latch).toBeNull();
  applyIrem78Write(state, write(0x8000, 255), { mask: 8, value: 8 });
  expect(state.latch).toEqual({ mask: 8, value: 8 });
  applyIrem78Write(state, write(0x8000, 0), null);
  expect(state.latch).toBe(0);
});

it("applies both mirroring polarities and preserves Holy Diver's determined outer pages under unknown M", () => {
  const cosmo = initial(),
    holy = initial("holy-diver");
  for (const latch of [0, { mask: 8, value: 0 }, 255, { mask: 8, value: 8 }]) {
    cosmo.latch = holy.latch = latch;
    const set =
      typeof latch === "number" ? (latch & 8) !== 0 : latch.value !== 0;
    expect(irem78Mirroring(cosmo)).toBe(set ? "one-screen-b" : "one-screen-a");
    expect(irem78Mirroring(holy)).toBe(set ? "vertical" : "horizontal");
    expect(
      [0, 1, 2, 3].map((page) => irem78NametablePages(cosmo, page)),
    ).toEqual(set ? [[1], [1], [1], [1]] : [[0], [0], [0], [0]]);
    expect(
      [0, 1, 2, 3].map((page) => irem78NametablePages(holy, page)),
    ).toEqual(set ? [[0], [1], [0], [1]] : [[0], [0], [1], [1]]);
  }
  for (const latch of [null, { mask: 247, value: 247 }]) {
    cosmo.latch = holy.latch = latch;
    expect(irem78Mirroring(cosmo)).toBe("unknown");
    expect(irem78Mirroring(holy)).toBe("unknown");
    expect(
      [0, 1, 2, 3].map((page) => irem78NametablePages(cosmo, page)),
    ).toEqual([
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
    ]);
    expect(
      [0, 1, 2, 3].map((page) => irem78NametablePages(holy, page)),
    ).toEqual([[0], [0, 1], [0, 1], [1]]);
  }
});

it("preserves every compatible PRG bank across all latch proofs and supported physical capacities", () => {
  const state = initial();
  for (const item of proofs) {
    state.latch = item.proof;
    const concrete = item.bits.reduce<number[]>(
      (values, bit, index) =>
        bit === 2
          ? values.flatMap((value) => [value, value + (1 << index)])
          : bit === 1
            ? values.map((value) => value + (1 << index))
            : values,
      [0],
    );
    for (const count of [1, 2, 4, 8]) {
      const expected = [
        ...new Set(concrete.map((value) => value % count)),
      ].sort((left, right) => left - right);
      expect(irem78PrgCandidates(state, count)).toEqual(expected);
    }
  }
});
