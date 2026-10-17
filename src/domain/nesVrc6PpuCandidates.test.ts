import { expect, it } from "vitest";
import type { NesByteValue } from "./nesByteValue.js";
import { parseNesHeader } from "./nes.js";
import { vrc6Fixture } from "./nesVrc6.fixture.js";
import {
  createVrc6PpuCandidates,
  nesVrc6StateSchema,
  vrc6ChrBanks,
  vrc6NametableCandidates,
  vrc6PatternCandidates,
  vrc6PpuMapping,
  type NesVrc6NametableCandidate,
} from "./nesVrc6.js";

const raw = [0x81, 0x88, 0x90, 0x99, 0xa0, 0xa9, 0xb1, 0xb8];
// Independent concrete chip table, including every low-nibble nametable selector.
const patternRegisters = [
  [0, 1, 2, 3, 4, 5, 6, 7],
  [0, 0, 1, 1, 2, 2, 3, 3],
  [0, 1, 2, 3, 4, 4, 5, 5],
  [0, 1, 2, 3, 4, 4, 5, 5],
];
const nametableRegisters = [
  [6, 6, 7, 7],
  [4, 5, 6, 7],
  [6, 7, 6, 7],
  [6, 7, 6, 7],
  [6, 7, 6, 7],
  [4, 5, 6, 7],
  [6, 6, 7, 7],
  [6, 6, 7, 7],
  [6, 6, 7, 7],
  [4, 5, 6, 7],
  [6, 7, 6, 7],
  [6, 7, 6, 7],
  [6, 7, 6, 7],
  [4, 5, 6, 7],
  [6, 6, 7, 7],
  [6, 6, 7, 7],
];
const nametableForced: Record<number, number[]> = {
  0: [0, 1, 0, 1],
  3: [0, 0, 1, 1],
  4: [0, 0, 1, 1],
  7: [0, 1, 0, 1],
  8: [0, 0, 0, 0],
  11: [1, 1, 1, 1],
  12: [1, 1, 1, 1],
  15: [0, 0, 0, 0],
};
const concreteBytes = (proof: NesByteValue) =>
  Array.from({ length: 256 }, (_, byte) => byte).filter((byte) =>
    typeof proof === "number"
      ? byte === proof
      : proof === null || (byte & proof.mask) === proof.value,
  );
const sortedBanks = (banks: readonly number[]) =>
  [...new Set(banks)].sort((a, b) => a - b);
const sortedSources = (sources: readonly NesVrc6NametableCandidate[]) => {
  const unique = new Map(
    sources.map((source) => [`${source.source}:${source.bank}`, source]),
  );
  return [...unique.values()].sort((a, b) =>
    a.source === b.source ? a.bank - b.bank : a.source === "ciram" ? -1 : 1,
  );
};
const oracle = (
  control: number,
  registers: readonly NesByteValue[],
  capacity: number,
) => {
  const values = registers.map(concreteBytes);
  const mode = control & 3;
  const forced = (control & 32) !== 0;
  const rom = (control & 16) !== 0;
  const override = forced ? nametableForced[control & 15] : undefined;
  return {
    pattern: patternRegisters[mode]!.map((reg, slot) =>
      sortedBanks(
        values[reg]!.map((raw) => {
          const selected =
            forced && (mode === 1 || (mode >= 2 && slot >= 4))
              ? (raw & 254) | (slot & 1)
              : raw;
          return selected & (capacity / 1024 - 1);
        }),
      ),
    ),
    nametable: nametableRegisters[control & 15]!.map((reg, page) =>
      sortedSources(
        values[reg]!.map((raw) => {
          const selected =
            override === undefined ? raw : (raw & 254) | override[page]!;
          return {
            source: rom ? ("chr-rom" as const) : ("ciram" as const),
            bank: selected & (rom ? capacity / 1024 - 1 : 1),
          };
        }),
      ),
    ),
  };
};
const partialProof = (ternary: number, bits: number): NesByteValue => {
  let mask = 0,
    value = 0;
  for (let bit = 0; bit < bits; bit++) {
    const digit = ternary % 3;
    ternary = Math.floor(ternary / 3);
    if (digit !== 0) mask |= 1 << bit;
    if (digit === 2) value |= 1 << bit;
  }
  return mask === 0 ? null : mask === 255 ? value : { mask, value };
};
const header = () => {
  const parsed = parseNesHeader(vrc6Fixture(24).bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

it("retains every physical pattern and nametable candidate in all 64 concrete modes", () => {
  const registers: NesByteValue[] = [
    null,
    { mask: 1, value: 0 },
    { mask: 254, value: 0x90 },
    0x99,
    { mask: 240, value: 0xa0 },
    { mask: 127, value: 0x29 },
    { mask: 254, value: 0xb0 },
    0xb8,
  ];
  for (const capacity of [8192, 262144]) {
    for (let control = 0; control < 64; control++) {
      for (const bytes of [raw, registers]) {
        const state = nesVrc6StateSchema.parse({
          mapper: 24,
          control,
          chr_banks: bytes,
        });
        const packet = createVrc6PpuCandidates(state, capacity);
        const expected = oracle(control, bytes, capacity);
        for (let slot = 0; slot < 8; slot++)
          expect(packet.pattern(slot)).toEqual(expected.pattern[slot]);
        for (let page = 0; page < 4; page++)
          expect(packet.nametable(page)).toEqual(expected.nametable[page]);
        expect(packet.nametableSource()).toBe(
          (control & 16) !== 0 ? "chr-rom" : "ciram",
        );
        expect(vrc6ChrBanks(state, capacity / 1024)).toEqual(
          expected.pattern.map((banks) =>
            banks.length === 1 ? banks[0] : null,
          ),
        );
      }
    }
  }
});

it("joins all 729 partial control proofs while keeping raw bank alternatives correlated with sources", () => {
  const registers: NesByteValue[] = raw.map((byte, index) => ({
    mask: index % 2 === 0 ? 254 : 127,
    value: byte & (index % 2 === 0 ? 254 : 127),
  }));
  for (const capacity of [8192, 262144]) {
    const originalHeader = header();
    const h = {
      ...originalHeader,
      chrRom: { ...originalHeader.chrRom, size: capacity },
    };
    const concrete = Array.from({ length: 64 }, (_, control) =>
      oracle(control, registers, capacity),
    );
    for (let ternary = 0; ternary < 729; ternary++) {
      const proof = partialProof(ternary, 6);
      const compatible = [
        ...new Set(concreteBytes(proof).map((control) => control & 63)),
      ];
      const state = nesVrc6StateSchema.parse({
        mapper: 26,
        control: proof,
        chr_banks: registers,
      });
      const packet = createVrc6PpuCandidates(state, capacity);
      const summary = vrc6PpuMapping(h, state);
      for (let slot = 0; slot < 8; slot++) {
        const expected = sortedBanks(
          compatible.flatMap((control) => concrete[control]!.pattern[slot]!),
        );
        expect(packet.pattern(slot)).toEqual(expected);
        expect(summary.chr[slot]).toBe(
          expected.length === 1 ? expected[0] : null,
        );
      }
      for (let page = 0; page < 4; page++) {
        const expected = sortedSources(
          compatible.flatMap((control) => concrete[control]!.nametable[page]!),
        );
        expect(packet.nametable(page)).toEqual(expected);
        const source = expected.every(
          (candidate) => candidate.source === expected[0]!.source,
        )
          ? expected[0]!.source
          : "unknown";
        const bank = expected.length === 1 ? expected[0]!.bank : null;
        expect(summary.nametables[page]).toMatchObject({
          source,
          bank,
          file_offset:
            source === "chr-rom" && bank !== null
              ? h.chrRom.offset + bank * 1024
              : null,
        });
      }
    }
  }
});

it("projects all 6561 canonical raw byte proofs before masking physical CHR capacity", () => {
  for (let ternary = 0; ternary < 6561; ternary++) {
    const proof = partialProof(ternary, 8);
    const values = concreteBytes(proof);
    for (const capacity of [8192, 262144]) {
      const state = nesVrc6StateSchema.parse({
        mapper: 24,
        control: 0x21,
        chr_banks: [proof, ...raw.slice(1)],
      });
      const packet = createVrc6PpuCandidates(state, capacity);
      for (const slot of [0, 1]) {
        const expected = sortedBanks(
          values.map((byte) => ((byte & 254) | slot) & (capacity / 1024 - 1)),
        );
        expect(packet.pattern(slot)).toEqual(expected);
      }
    }
  }
});

it("distinguishes duplicated halves from forced A10 and retains mixed-source page identities", () => {
  const state = nesVrc6StateSchema.parse({
    mapper: 24,
    control: 1,
    chr_banks: [5, ...raw.slice(1)],
  });
  expect(vrc6PatternCandidates(state, 0, 262144)).toEqual([5]);
  expect(vrc6PatternCandidates(state, 1, 262144)).toEqual([5]);
  state.control = 0x21;
  expect(vrc6PatternCandidates(state, 0, 262144)).toEqual([4]);
  expect(vrc6PatternCandidates(state, 1, 262144)).toEqual([5]);
  state.control = { mask: 47, value: 32 };
  state.chr_banks[6] = 46;
  expect(vrc6NametableCandidates(state, 1, 262144)).toEqual([
    { source: "ciram", bank: 1 },
    { source: "chr-rom", bank: 47 },
  ]);
  expect(vrc6NametableCandidates(state, 1, 8192)).toEqual([
    { source: "ciram", bank: 1 },
    { source: "chr-rom", bank: 7 },
  ]);
  expect(vrc6PpuMapping(header(), state).nametables[1]).toMatchObject({
    source: "unknown",
    bank: null,
    file_offset: null,
  });
});

it("exposes all 258 physical nametable alternatives without adding unused control bits", () => {
  const state = nesVrc6StateSchema.parse({ mapper: 26 });
  const packet = createVrc6PpuCandidates(state, 262144);
  const expected = [
    { source: "ciram" as const, bank: 0 },
    { source: "ciram" as const, bank: 1 },
    ...Array.from({ length: 256 }, (_, bank) => ({
      source: "chr-rom" as const,
      bank,
    })),
  ];
  for (let page = 0; page < 4; page++)
    expect(packet.nametable(page)).toEqual(expected);
  for (let slot = 0; slot < 8; slot++)
    expect(packet.pattern(slot)).toEqual(
      Array.from({ length: 256 }, (_, bank) => bank),
    );
  const selected = nesVrc6StateSchema.parse({
    mapper: 26,
    control: { mask: 63, value: 0x21 },
    chr_banks: raw,
  });
  const before = vrc6PpuMapping(header(), selected);
  selected.control = 0xe1;
  expect(vrc6PpuMapping(header(), selected)).toEqual(before);
});

it("captures immutable PPU facts per operation while subsequent packets observe mapper mutations", () => {
  const state = nesVrc6StateSchema.parse({
    mapper: 24,
    control: { mask: 47, value: 32 },
    chr_banks: raw,
  });
  state.chr_banks[6] = { mask: 254, value: 46 };
  const packet = createVrc6PpuCandidates(state, 262144);
  const control = state.control;
  const bank = state.chr_banks[6];
  if (
    typeof control !== "object" ||
    control === null ||
    typeof bank !== "object" ||
    bank === null
  )
    throw new Error("partial proof required");
  control.mask = 63;
  control.value = 16;
  bank.value = 60;
  state.chr_banks[6] = 70;
  state.control = 16;
  expect(packet.nametable(1)).toEqual([
    { source: "ciram", bank: 1 },
    { source: "chr-rom", bank: 47 },
  ]);
  expect(vrc6NametableCandidates(state, 1, 262144)).toEqual([
    { source: "chr-rom", bank: 70 },
  ]);
  expect(Object.isFrozen(packet.pattern(0))).toBe(true);
  expect(Object.isFrozen(packet.nametable(1))).toBe(true);
  expect(Object.isFrozen(packet.nametable(1)[0])).toBe(true);
});

it("preserves source uncertainty at an unqualified zero-capacity boundary without fabricating ROM banks", () => {
  // Admitted VRC6 byte profiles require positive CHR-ROM; this checks the summary boundary only.
  const state = nesVrc6StateSchema.parse({
    mapper: 24,
    control: null,
    chr_banks: raw,
  });
  const originalHeader = header();
  const h = {
    ...originalHeader,
    chrRom: { ...originalHeader.chrRom, size: 0 },
  };
  const packet = createVrc6PpuCandidates(state, 0);
  expect(packet.nametableSource()).toBe("unknown");
  expect(packet.nametable(0)).toEqual([
    { source: "ciram", bank: 0 },
    { source: "ciram", bank: 1 },
  ]);
  expect(packet.pattern(0)).toEqual([]);
  expect(vrc6PpuMapping(h, state).chr).toEqual(
    Array.from({ length: 8 }, () => null),
  );
  expect(vrc6PpuMapping(h, state).nametables[0]).toMatchObject({
    source: "unknown",
    bank: null,
    file_offset: null,
  });
  state.control = 16;
  expect(vrc6NametableCandidates(state, 0, 0)).toEqual([]);
  expect(vrc6PpuMapping(h, state).nametables[0]).toMatchObject({
    source: "chr-rom",
    bank: null,
    file_offset: null,
  });
  state.control = 0;
  expect(vrc6NametableCandidates(state, 0, 0)).toEqual([
    { source: "ciram", bank: 1 },
  ]);
  expect(vrc6PpuMapping(h, state).nametables[0]).toMatchObject({
    source: "ciram",
    bank: 1,
    file_offset: null,
  });
});
