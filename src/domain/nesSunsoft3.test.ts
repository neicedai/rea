import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import type { NesByteValue } from "./nesByteValue.js";
import { nesSunsoft3StateSchema, sunsoft3Register } from "./nesSunsoft3.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import {
  mapperMapping,
  standardNesChrCandidates,
  standardNesNametablePages,
} from "./nesMapperTraceMapping.js";
import {
  nesMapperStateSchema,
  nesMapperTraceSchema,
  traceNesMapperWritesInputSchema,
} from "./nesMapperTrace.js";

const fixture = (prgSize = 262144, chrSize = 131072) => {
  const bytes = Buffer.alloc(528 + prgSize + chrSize);
  bytes.set([78, 69, 83, 26, prgSize / 16384, chrSize / 8192, 0x34, 0x48]);
  for (let bank = 0; bank < prgSize / 16384; bank++)
    bytes.fill(bank, 528 + bank * 16384, 528 + (bank + 1) * 16384);
  for (let bank = 0; bank < chrSize / 2048; bank++)
    bytes.fill(
      bank,
      528 + prgSize + bank * 2048,
      528 + prgSize + (bank + 1) * 2048,
    );
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  return { bytes, header: header.value };
};

it("traces full raw bytes, independent 2 KiB CHR windows and modern IRQ aliases with original offsets", () => {
  const { bytes, header } = fixture(),
    input = traceNesMapperWritesInputSchema.parse({
      path: "/sunsoft3.nes",
      initial: { mapper: 67 },
      writes: [
        { address: 0xfabc, value: 0xf5 },
        { address: 0x8fff, value: 255 },
        { address: 0x9ffd, value: 128 },
        { address: 0xaffe, value: 197 },
        { address: 0xbfff, value: 63 },
        { address: 0xeff7, value: 254 },
        { address: 0xcfff, value: 0x12 },
        { address: 0xc800, value: null, known_bits: { mask: 15, value: 9 } },
        { address: 0xdfff, value: 16 },
        { address: 0x87ff, value: 255 },
        { address: 0xf7ff, value: 0 },
      ],
    }),
    trace = nesMapperTraceSchema.parse(
      deriveNesMapperTrace(header, input.initial, input.writes),
    );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(
    trace.initial_mapping.prg_windows.map((window) => window.bank),
  ).toEqual([null, 15]);
  expect(trace.final_mapping.prg_windows).toEqual([
    { start: 0x8000, size: 16384, bank: 5, file_offset: 528 + 5 * 16384 },
    { start: 0xc000, size: 16384, bank: 15, file_offset: 528 + 15 * 16384 },
  ]);
  expect(trace.final_mapping.prg_view).toEqual({ mapper: 67, prg_bank: 5 });
  expect(trace.final_mapping.mirroring).toBe("one-screen-a");
  for (const [slot, bank] of [63, 0, 5, 63].entries()) {
    const window = trace.final_mapping.chr_windows[slot]!;
    expect(window).toEqual({
      start: slot * 2048,
      size: 2048,
      bank,
      file_offset: 528 + 262144 + bank * 2048,
    });
    expect(bytes[window.file_offset! + 2047]).toBe(bank);
  }
  expect(trace.final).toEqual({
    mapper: 67,
    prg_bank: 0xf5,
    chr_banks: [255, 128, 197, 63],
    mirroring: 254,
    irq_control: 16,
    irq_data: { mask: 15, value: 9 },
  });
  expect(trace.steps.map((step) => step.effect)).toEqual([
    "prg-bank",
    "chr-bank",
    "chr-bank",
    "chr-bank",
    "chr-bank",
    "nametable",
    "irq-latch",
    "irq-latch",
    "irq-control",
    "irq-acknowledge",
    "irq-acknowledge",
  ]);
  expect(trace.steps[9]!.state).toEqual(trace.steps[8]!.state);
  expect(trace.steps[10]!.state).toEqual(trace.steps[8]!.state);
  expect(input.initial).toEqual(nesSunsoft3StateSchema.parse({ mapper: 67 }));
});

it("resolves only connected selector bits and aliases both PRG windows for a single 16 KiB ROM", () => {
  const { header } = fixture(131072, 65536),
    state = nesSunsoft3StateSchema.parse({
      mapper: 67,
      prg_bank: { mask: 7, value: 5 },
      chr_banks: [{ mask: 31, value: 25 }, null, 255, 128],
    }),
    mapping = mapperMapping(header, state);
  expect(mapping.prg_windows.map((window) => window.bank)).toEqual([5, 7]);
  expect(mapping.prg_view).toBeNull();
  expect(mapping.chr_windows.map((window) => window.bank)).toEqual([
    25,
    null,
    31,
    0,
  ]);
  expect(standardNesChrCandidates(state, 0, 32)).toEqual([25]);
  expect(standardNesChrCandidates(state, 0, 64)).toEqual([25, 57]);
  const { header: smallest } = fixture(16384, 8192),
    unknown = nesSunsoft3StateSchema.parse({ mapper: 67 }),
    trace = deriveNesMapperTrace(smallest, unknown, []);
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.prg_windows).toEqual([
    { start: 0x8000, size: 16384, bank: 0, file_offset: 528 },
    { start: 0xc000, size: 16384, bank: 0, file_offset: 528 },
  ]);
  expect(trace.final_mapping.prg_view).toBeNull();
});

it("preserves every partial CIRAM proof against an independent V/H/A/B page table", () => {
  const { header } = fixture(),
    modes = ["vertical", "horizontal", "one-screen-a", "one-screen-b"] as const,
    pages = [
      [0, 1, 0, 1],
      [0, 0, 1, 1],
      [0, 0, 0, 0],
      [1, 1, 1, 1],
    ],
    proofs: NesByteValue[] = [null];
  for (let mask = 1; mask < 256; mask++)
    for (let value = 0; value < 256; value++)
      if ((value & ~mask) === 0)
        proofs.push(mask === 255 ? value : { mask, value });
  for (const proof of proofs) {
    const compatible = Array.from({ length: 256 }, (_, value) => value).filter(
        (value) =>
          proof === null ||
          (typeof proof === "number"
            ? value === proof
            : (value & proof.mask) === proof.value),
      ),
      selections = [...new Set(compatible.map((value) => value % 4))],
      state = nesSunsoft3StateSchema.parse({ mapper: 67, mirroring: proof });
    expect(mapperMapping(header, state).mirroring).toBe(
      selections.length === 1 ? modes[selections[0]!] : "unknown",
    );
    for (let page = 0; page < 4; page++)
      expect(standardNesNametablePages(header, state, page, 2)).toEqual(
        [
          ...new Set(selections.map((selection) => pages[selection]![page]!)),
        ].sort((a, b) => a - b),
      );
  }
});

it("decodes every CPU address with ACK priority and eight distinct A11-set registers", () => {
  const decode = [
    0x8000, 0x8800, 0x8000, 0x9800, 0x8000, 0xa800, 0x8000, 0xb800, 0x8000,
    0xc800, 0x8000, 0xd800, 0x8000, 0xe800, 0x8000, 0xf800,
  ];
  for (let address = 0; address < 65536; address++)
    expect(sunsoft3Register(address)).toBe(
      address < 32768 ? null : decode[Math.floor((address - 32768) / 2048)],
    );
});

it("retains omitted state as unknown and rejects invented phase, latch and array fields", () => {
  const state = nesMapperStateSchema.parse({ mapper: 67 });
  expect(state).toEqual({
    mapper: 67,
    prg_bank: null,
    chr_banks: [null, null, null, null],
    mirroring: null,
    irq_control: null,
    irq_data: null,
  });
  for (const extra of [
    { variant: "sunsoft3" },
    { next_write: "high" },
    { irq_latch: 0 },
    { chr_banks: [0, 1] },
  ])
    expect(nesMapperStateSchema.safeParse({ ...state, ...extra }).success).toBe(
      false,
    );
});
