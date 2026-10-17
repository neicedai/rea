import { expect, it } from "vitest";
import type { NesByteValue } from "./nesByteValue.js";
import { parseNesHeader } from "./nes.js";
import { namco163Fixture } from "./nesNamco163.fixture.js";
import {
  createNamco163PpuCandidates,
  namco163Mapping,
  namco163NametableCandidates,
  namco163PatternCandidates,
  nesNamco163StateSchema,
  type NesNamco163PpuCandidate,
} from "./nesNamco163.js";

const unknown = {
  source: "unknown" as const,
  reason: "namco163-audio-debug" as const,
};
const bytesFor = (proof: NesByteValue) =>
  Array.from({ length: 256 }, (_, byte) => byte).filter((byte) =>
    typeof proof === "number"
      ? byte === proof
      : proof === null || (byte & proof.mask) === proof.value,
  );
const proofFor = (ternary: number): NesByteValue => {
  let mask = 0,
    value = 0;
  for (let bit = 0; bit < 8; bit++) {
    const digit = ternary % 3;
    ternary = Math.floor(ternary / 3);
    if (digit !== 0) mask |= 1 << bit;
    if (digit === 2) value |= 1 << bit;
  }
  return mask === 0 ? null : mask === 255 ? value : { mask, value };
};
const oracle = (
  raw: NesByteValue,
  disables: readonly boolean[],
  capacity: number,
) => {
  const candidates = new Map<
    string,
    { source: "ciram" | "chr-rom"; bank: number }
  >();
  for (const byte of bytesFor(raw)) {
    for (const disabled of disables) {
      const source = byte >= 224 && !disabled ? "ciram" : "chr-rom";
      const bank = source === "ciram" ? byte % 2 : byte % (capacity / 1024);
      candidates.set(`${source}:${bank}`, { source, bank });
    }
  }
  return [...candidates.values()].sort((a, b) =>
    a.source === b.source ? a.bank - b.bank : a.source === "ciram" ? -1 : 1,
  );
};
const stateFor = (
  raw: NesByteValue,
  control: NesByteValue = 0,
  debug: NesByteValue = 0,
) =>
  nesNamco163StateSchema.parse({
    mapper: 19,
    variant: "namco163",
    prg_banks: [0, control, debug],
    chr_banks: Array.from({ length: 8 }, () => raw),
    nametable_banks: Array.from({ length: 4 }, () => raw),
  });
const header = () => {
  const parsed = parseNesHeader(namco163Fixture().bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const mappingFor = (...args: Parameters<typeof namco163Mapping>) => {
  const mapping = namco163Mapping(...args);
  if (!("nametable_windows" in mapping))
    throw new Error("Namco 163 nametable windows required");
  return mapping;
};

it("matches all raw selectors and independent lower/upper CIRAM-disable combinations", () => {
  for (const capacity of [8192, 262144]) {
    for (const control of [0, 64, 128, 192]) {
      for (let raw = 0; raw < 256; raw++) {
        const state = stateFor(raw, control);
        const packet = createNamco163PpuCandidates(state, capacity);
        const lower = oracle(raw, [(control & 64) !== 0], capacity);
        const upper = oracle(raw, [(control & 128) !== 0], capacity);
        const nametable = oracle(raw, [false], capacity);
        for (const slot of [0, 3]) expect(packet.pattern(slot)).toEqual(lower);
        for (const slot of [4, 7]) expect(packet.pattern(slot)).toEqual(upper);
        for (const page of [0, 3])
          expect(packet.nametable(page)).toEqual(nametable);
        expect(packet.debug()).toBe(false);
      }
    }
  }
});

it("retains every candidate for all 6561 raw byte proofs before ROM aliasing", () => {
  for (let ternary = 0; ternary < 6561; ternary++) {
    const raw = proofFor(ternary);
    for (const capacity of [8192, 262144]) {
      for (const control of [0, 192, null]) {
        const packet = createNamco163PpuCandidates(
          stateFor(raw, control),
          capacity,
        );
        const pattern = oracle(
          raw,
          control === null ? [false, true] : [control !== 0],
          capacity,
        );
        expect(packet.pattern(0)).toEqual(pattern);
        expect(packet.pattern(7)).toEqual(pattern);
        expect(packet.nametable(2)).toEqual(oracle(raw, [false], capacity));
      }
    }
  }
});

it("uses each E800 disable bit independently and ignores its PRG-selector bits for PPU sources", () => {
  const state = stateFor(0xe1, { mask: 64, value: 64 });
  expect(namco163PatternCandidates(state, 0, 262144)).toEqual([
    { source: "chr-rom", bank: 225 },
  ]);
  expect(namco163PatternCandidates(state, 4, 262144)).toEqual([
    { source: "ciram", bank: 1 },
    { source: "chr-rom", bank: 225 },
  ]);
  expect(namco163NametableCandidates(state, 1, 262144)).toEqual([
    { source: "ciram", bank: 1 },
  ]);
  state.prg_banks[1] = { mask: 128, value: 0 };
  expect(namco163PatternCandidates(state, 0, 8192)).toEqual([
    { source: "ciram", bank: 1 },
    { source: "chr-rom", bank: 1 },
  ]);
  expect(namco163PatternCandidates(state, 4, 8192)).toEqual([
    { source: "ciram", bank: 1 },
  ]);
  state.prg_banks[1] = 0x3f;
  expect(namco163PatternCandidates(state, 0, 262144)).toEqual([
    { source: "ciram", bank: 1 },
  ]);
});

it("classifies all F000 byte proofs and preserves the normal branch when debug is only possible", () => {
  for (let ternary = 0; ternary < 6561; ternary++) {
    const proof = proofFor(ternary);
    const modes = new Set(bytesFor(proof).map((byte) => byte === 63));
    const expectedDebug = modes.size === 1 ? modes.values().next().value : null;
    const state = stateFor(0xe1, 0, proof);
    const packet = createNamco163PpuCandidates(state, 262144);
    const expected: NesNamco163PpuCandidate[] =
      expectedDebug === true
        ? [unknown]
        : expectedDebug === false
          ? [{ source: "ciram", bank: 1 }]
          : [{ source: "ciram", bank: 1 }, unknown];
    expect(packet.debug()).toBe(expectedDebug);
    expect(packet.pattern(0)).toEqual(expected);
    expect(packet.nametable(0)).toEqual(expected);
    expect(packet.patternSource(0)).toBe(
      expectedDebug === false ? "ciram" : "unknown",
    );
  }
  for (const value of [0x7f, 0xbf, 0xff]) {
    const packet = createNamco163PpuCandidates(
      stateFor(0xe0, 0, value),
      262144,
    );
    expect(packet.debug()).toBe(false);
    expect(packet.pattern(0)).toEqual([{ source: "ciram", bank: 0 }]);
  }
});

it("reports physical identity separately from source uncertainty and partial bank summaries", () => {
  const h = header();
  const state = stateFor({ mask: 225, value: 225 }, 192);
  const mapping = mappingFor(h, state);
  expect(mapping.chr_windows[0]).toMatchObject({
    source: "chr-rom",
    bank: null,
    file_offset: null,
  });
  expect(mapping.nametable_windows?.[0]).toMatchObject({
    source: "ciram",
    bank: 1,
    file_offset: null,
  });
  state.chr_banks[0] = { mask: 7, value: 5 };
  const small = { ...h, chrRom: { ...h.chrRom, size: 8192 } };
  expect(mappingFor(small, state).chr_windows[0]).toMatchObject({
    source: "chr-rom",
    bank: 5,
    file_offset: h.chrRom.offset + 5120,
  });
  state.prg_banks[1] = null;
  state.chr_banks[0] = 0xe1;
  const candidates = namco163PatternCandidates(state, 0, 8192);
  expect(candidates).toEqual([
    { source: "ciram", bank: 1 },
    { source: "chr-rom", bank: 1 },
  ]);
  expect(mappingFor(small, state).chr_windows[0]).toMatchObject({
    source: "unknown",
    bank: null,
    file_offset: null,
  });
  state.nametable_banks = [0xe0, { mask: 254, value: 224 }, 0xe0, 0xe1];
  expect(mappingFor(h, state).nametable_windows[1]).toMatchObject({
    source: "ciram",
    bank: null,
  });
  expect(mappingFor(h, state).mirroring).toBe("unknown");
});

it("derives all CIRAM mirroring arrangements only from concrete retained pages", () => {
  const h = header();
  const state = stateFor(0);
  for (const [banks, mirroring] of [
    [[0xe0, 0xe1, 0xe0, 0xe1], "vertical"],
    [[0xe0, 0xe0, 0xe1, 0xe1], "horizontal"],
    [[0xe0, 0xe0, 0xe0, 0xe0], "one-screen-a"],
    [[0xe1, 0xe1, 0xe1, 0xe1], "one-screen-b"],
    [[0xe0, 0xe1, 0xe1, 0xe0], "custom"],
  ] as const) {
    state.nametable_banks = [...banks];
    expect(mappingFor(h, state).mirroring).toBe(mirroring);
  }
  state.nametable_banks[0] = 7;
  expect(mappingFor(h, state).mirroring).toBe("custom");
  state.prg_banks[2] = { mask: 63, value: 63 };
  expect(mappingFor(h, state).mirroring).toBe("unknown");
});

it("retains the maximum normal and debug-possible pattern and nametable source sets", () => {
  const state = stateFor(null, null);
  const packet = createNamco163PpuCandidates(state, 262144);
  const ciram = [
    { source: "ciram" as const, bank: 0 },
    { source: "ciram" as const, bank: 1 },
  ];
  const rom = Array.from({ length: 256 }, (_, bank) => ({
    source: "chr-rom" as const,
    bank,
  }));
  expect(packet.pattern(0)).toEqual([...ciram, ...rom]);
  expect(packet.nametable(0)).toEqual([...ciram, ...rom.slice(0, 224)]);
  state.prg_banks[2] = null;
  const possible = createNamco163PpuCandidates(state, 262144);
  expect(possible.pattern(0)).toEqual([...ciram, ...rom, unknown]);
  expect(possible.nametable(0)).toEqual([
    ...ciram,
    ...rom.slice(0, 224),
    unknown,
  ]);
  state.prg_banks[1] = 0;
  expect(namco163PatternCandidates(state, 0, 262144)).toEqual([
    ...ciram,
    ...rom.slice(0, 224),
    unknown,
  ]);
});

it("captures raw proofs and controls before mapper writes mutate the original state", () => {
  const state = stateFor(
    { mask: 225, value: 225 },
    { mask: 192, value: 0 },
    { mask: 63, value: 1 },
  );
  const packet = createNamco163PpuCandidates(state, 262144);
  const raw = state.chr_banks[0],
    control = state.prg_banks[1],
    debug = state.prg_banks[2];
  if (
    typeof raw !== "object" ||
    raw === null ||
    typeof control !== "object" ||
    control === null ||
    typeof debug !== "object" ||
    debug === null
  )
    throw new Error("partial proofs required");
  raw.mask = 254;
  raw.value = 0;
  control.value = 192;
  debug.value = 63;
  state.chr_banks[0] = 7;
  state.nametable_banks[0] = 8;
  expect(packet.debug()).toBe(false);
  expect(packet.pattern(0)).toEqual([{ source: "ciram", bank: 1 }]);
  expect(packet.nametable(0)).toEqual([{ source: "ciram", bank: 1 }]);
  const updated = createNamco163PpuCandidates(state, 262144);
  expect(updated.debug()).toBeNull();
  expect(updated.pattern(0)).toEqual([{ source: "chr-rom", bank: 7 }, unknown]);
  expect(Object.isFrozen(packet.pattern(0))).toBe(true);
  expect(Object.isFrozen(packet.pattern(0)[0])).toBe(true);
});

it("preserves electrical source facts at an unqualified zero-capacity boundary without fake ROM banks", () => {
  // Admitted conventional Namco 163 profiles require positive CHR-ROM.
  const h = header();
  const empty = { ...h, chrRom: { ...h.chrRom, size: 0 } };
  const state = stateFor(0xe1, null);
  const packet = createNamco163PpuCandidates(state, 0);
  expect(packet.pattern(0)).toEqual([{ source: "ciram", bank: 1 }]);
  expect(packet.patternSource(0)).toBe("unknown");
  expect(packet.nametable(0)).toEqual([{ source: "ciram", bank: 1 }]);
  expect(packet.nametableSource(0)).toBe("ciram");
  expect(mappingFor(empty, state).chr_windows[0]).toMatchObject({
    source: "unknown",
    bank: null,
    file_offset: null,
  });
  state.prg_banks[1] = 192;
  expect(namco163PatternCandidates(state, 0, 0)).toEqual([]);
  expect(mappingFor(empty, state).chr_windows[0]).toMatchObject({
    source: "chr-rom",
    bank: null,
    file_offset: null,
  });
});
