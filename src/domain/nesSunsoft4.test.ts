import { expect, it } from "vitest";
import {
  applySunsoft4Write,
  isSunsoft4State,
  nesSunsoft4StateSchema,
  sunsoft4Register,
} from "./nesSunsoft4.js";
import { nesByteCandidates, type NesByteValue } from "./nesByteValue.js";

const initial = () =>
  nesSunsoft4StateSchema.parse({ mapper: 68, variant: "normal" });
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});
const ports = [0x8000, 0x9000, 0xa000, 0xb000, 0xc000, 0xd000, 0xe000, 0xf000];

it("requires an explicit immutable normal profile and keeps power-on register facts unknown", () => {
  expect(initial()).toEqual({
    mapper: 68,
    variant: "normal",
    prg_bank: null,
    chr_banks: [null, null, null, null],
    nametable_banks: [null, null],
    control: null,
  });
  expect(isSunsoft4State(initial())).toBe(true);
  expect(isSunsoft4State({ mapper: 67 })).toBe(false);
  for (const invalid of [
    { mapper: 68 },
    { mapper: 68, variant: "dual-cart" },
    { mapper: 68, variant: "normal", irq_control: 0 },
    { mapper: 68, variant: "normal", chr_banks: [0, 1, 2] },
    { mapper: 68, variant: "normal", nametable_banks: [0, 1, 2] },
    { mapper: 68, variant: "normal", prg_bank: 256 },
    { mapper: 68, variant: "normal", control: { mask: 16, value: 17 } },
    {
      mapper: 68,
      variant: "normal",
      nametable_banks: [{ mask: 255, value: 0 }, null],
    },
  ])
    expect(nesSunsoft4StateSchema.safeParse(invalid).success).toBe(false);
});

it("decodes every CPU register alias from the upper address nibble and leaves lower ports outside the mapper", () => {
  for (let address = 0; address < 65536; address++)
    expect(sunsoft4Register(address)).toBe(
      address < 32768 ? null : ports[Math.floor((address - 32768) / 4096)],
    );
});

it("retains original full bytes at all eight register ports without forcing NT bit 7 or masking control bits", () => {
  for (const offset of [0, 1, 0x7ff, 0xfff]) {
    const state = initial();
    for (let index = 0; index < ports.length; index++) {
      const result = applySunsoft4Write(
        state,
        write(ports[index]! + offset, 0xf0 + index),
      );
      expect(result.effect).toBe(
        index < 4 ? "chr-bank" : index < 7 ? "nametable" : "prg-bank",
      );
    }
    expect(state).toEqual({
      mapper: 68,
      variant: "normal",
      chr_banks: [0xf0, 0xf1, 0xf2, 0xf3],
      nametable_banks: [0xf4, 0xf5],
      control: 0xf6,
      prg_bank: 0xf7,
    });
    applySunsoft4Write(state, write(0xc000 + offset, 5));
    expect(state.nametable_banks[0]).toBe(5);
  }
});

/** Enumerate unspecified bit assignments independently from the production candidate filter. */
const completions = (mask: number, value: number): number[] =>
  Array.from({ length: 8 }, (_, bit) => 1 << bit)
    .filter((bit) => (mask & bit) === 0)
    .reduce(
      (values, bit) =>
        values.flatMap((candidate) => [candidate, candidate | bit]),
      [value],
    )
    .sort((left, right) => left - right);

it("preserves every complete/partial/unknown byte proof and its candidates across all raw registers", () => {
  for (let mask = 0; mask < 256; mask++)
    for (let value = 0; value < 256; value++) {
      if ((value & ~mask) !== 0) continue;
      const proof: NesByteValue =
          mask === 0 ? null : mask === 255 ? value : { mask, value },
        state = initial();
      for (const address of ports)
        applySunsoft4Write(
          state,
          typeof proof === "number" || proof === null
            ? write(address, proof)
            : {
                ...write(address, null),
                known_bits: proof,
              },
        );
      expect(state).toEqual({
        mapper: 68,
        variant: "normal",
        prg_bank: proof,
        chr_banks: [proof, proof, proof, proof],
        nametable_banks: [proof, proof],
        control: proof,
      });
      const expected = completions(mask, value);
      expect(nesByteCandidates(state.nametable_banks[0]!)).toEqual(expected);
      expect(nesByteCandidates(state.chr_banks[0]!)).toEqual(expected);
      expect(nesSunsoft4StateSchema.safeParse(state).success).toBe(true);
    }
});

it("replaces ordered register writes with their current proof while preserving unrelated facts and excluding licensing writes", () => {
  const state = initial();
  applySunsoft4Write(state, write(0xf000, 31));
  applySunsoft4Write(state, write(0xefff, 19));
  applySunsoft4Write(state, write(0x8000, 127));
  applySunsoft4Write(state, {
    ...write(0xffff, null),
    known_bits: { mask: 15, value: 8 },
  });
  expect(state).toEqual({
    ...initial(),
    prg_bank: { mask: 15, value: 8 },
    control: 19,
    chr_banks: [127, null, null, null],
  });
  applySunsoft4Write(state, write(0xf000, null));
  expect(state.prg_bank).toBeNull();
  const before = structuredClone(state);
  for (const address of [0, 0x2000, 0x4000, 0x5fff, 0x6000, 0x7000, 0x7fff])
    expect(applySunsoft4Write(state, write(address, 255))).toEqual({
      state: before,
      effect: "outside-mapper",
    });
  expect(state).toEqual(before);
});
