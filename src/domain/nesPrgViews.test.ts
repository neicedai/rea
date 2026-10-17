import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  nesPrgViewSchema,
  nesPrgViewsSchema,
  normalizeNesPrgViews,
  type NesPrgView,
} from "./nesPrgViews.js";

describe("NES PRG view input contract", () => {
  it.each([
    { mapper: 1, prg_mode: 4, prg_bank: 0 },
    { mapper: 1, prg_mode: 3, prg_bank: 0, prg_outer_bank: 2 },
    { mapper: 1, prg_mode: 3, prg_bank: 0, prg_outer_bank: null },
    { mapper: 1, prg_mode: 3, prg_bank: 16 },
    { mapper: 1, prg_mode: 3, prg_bank: -1 },
    { mapper: 4, prg_mode: 2, r6: 0, r7: 1 },
    { mapper: 4, prg_mode: 0, r6: 64, r7: 1 },
    { mapper: 4, prg_mode: 0, r6: 0.5, r7: 1 },
    { mapper: 4, prg_mode: 0, r6: 0 },
    { mapper: 4, prg_mode: 0, r6: 0, r7: 1, prg_bank: 0 },
    { mapper: 2, prg_mode: 0, prg_bank: 0 },
    { mapper: 9, prg_bank: 16 },
    { mapper: 10, prg_bank: -1 },
    { mapper: 9, prg_bank: 0, prg_mode: 0 },
    { mapper: 10 },
    { mapper: 67, prg_bank: 16 },
    { mapper: 67, prg_bank: 1, prg_mode: 0 },
  ])(
    "rejects incomplete, out-of-register-range or extraneous state %j",
    (value) => {
      expect(nesPrgViewSchema.safeParse(value).success).toBe(false);
    },
  );

  it("rejects empty or duplicate sets while retaining distinct raw states that may alias on a ROM", () => {
    const state = { mapper: 1, prg_mode: 0, prg_bank: 0 } as const;
    expect(nesPrgViewsSchema.safeParse([]).success).toBe(false);
    expect(
      nesPrgViewsSchema.safeParse([
        state,
        { prg_bank: 0, prg_mode: 0, mapper: 1 },
      ]).success,
    ).toBe(false);
    expect(
      nesPrgViewsSchema.parse([state, { ...state, prg_bank: 1 }]),
    ).toHaveLength(2);
  });

  it("normalizes an independent state set numerically without changing caller input", () => {
    const input: readonly NesPrgView[] = [
      { mapper: 4, prg_mode: 1, r6: 0, r7: 0 },
      { mapper: 4, prg_mode: 0, r6: 10, r7: 0 },
      { mapper: 4, prg_mode: 0, r6: 2, r7: 10 },
      { mapper: 4, prg_mode: 0, r6: 2, r7: 2 },
    ];
    const original = structuredClone(input);
    expect(nesPrgViewsSchema.parse(input)).toEqual([...input].reverse());
    expect(input).toEqual(original);
  });

  it("orders MMC2/MMC4 raw selectors numerically and rejects duplicates", () => {
    const states = [
      { mapper: 10, prg_bank: 15 },
      { mapper: 10, prg_bank: 2 },
      { mapper: 9, prg_bank: 15 },
      { mapper: 9, prg_bank: 2 },
    ];
    expect(nesPrgViewsSchema.parse(states)).toEqual([...states].reverse());
    expect(nesPrgViewsSchema.safeParse([states[0], states[0]]).success).toBe(
      false,
    );
  });

  it("admits the complete MMC3 hardware state space and advertises its precise JSON constraints", () => {
    const states: NesPrgView[] = Array.from({ length: 8192 }, (_, index) => ({
      mapper: 4,
      prg_mode: index < 4096 ? 0 : 1,
      r6: Math.floor(index / 64) % 64,
      r7: index % 64,
    }));
    expect(nesPrgViewsSchema.parse(states)).toHaveLength(8192);
    expect(
      nesPrgViewsSchema.safeParse([
        ...states,
        { mapper: 1, prg_mode: 0, prg_bank: 0 },
      ]).success,
    ).toBe(false);
    expect(z.toJSONSchema(nesPrgViewsSchema)).toMatchObject({
      type: "array",
      minItems: 1,
      maxItems: 8192,
      uniqueItems: true,
      items: { anyOf: expect.any(Array) },
    });
  });
});

it("normalizes produced view collections without losing distinct raw aliases", () => {
  const original: NesPrgView[] = [
    { mapper: 4, prg_mode: 0, r6: 10, r7: 2 },
    { mapper: 4, prg_mode: 0, r6: 2, r7: 2 },
    { mapper: 4, prg_mode: 0, r6: 10, r7: 2 },
  ];
  const snapshot = structuredClone(original);
  expect(normalizeNesPrgViews([])).toEqual([]);
  expect(normalizeNesPrgViews(original.values())).toEqual([
    original[1],
    original[0],
  ]);
  expect(original).toEqual(snapshot);
});
