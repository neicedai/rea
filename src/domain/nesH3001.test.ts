import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import type { NesByteValue } from "./nesByteValue.js";
import { nesH3001StateSchema } from "./nesH3001.js";
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

const fixture = () => {
  const bytes = Buffer.alloc(16 + 512 + 256 * 1024 + 256 * 1024);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 16, 32, 0x14, 0x48]);
  for (let bank = 0; bank < 32; bank++)
    bytes.fill(bank, 528 + bank * 8192, 528 + (bank + 1) * 8192);
  for (let bank = 0; bank < 256; bank++)
    bytes.fill(
      bank,
      528 + 256 * 1024 + bank * 1024,
      528 + 256 * 1024 + (bank + 1) * 1024,
    );
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  return { bytes, header: header.value };
};

it("traces the two hardware PRG registers, address aliases and mode swap with original offsets", () => {
  const { bytes, header } = fixture(),
    input = traceNesMapperWritesInputSchema.parse({
      path: "/h3001.nes",
      initial: { mapper: 65 },
      writes: [
        { address: 0x8007, value: 0xc5 },
        { address: 0xafff, value: 19 },
        { address: 0x9ff8, value: 0 },
        { address: 0xc000, value: 7 },
        { address: 0x9002, value: 255 },
        { address: 0x9ab0, value: null, known_bits: { mask: 128, value: 128 } },
      ],
    }),
    result = nesMapperTraceSchema.parse(
      deriveNesMapperTrace(header, input.initial, input.writes),
    );
  if (result.status !== "derived") throw new Error(result.reason);
  expect(
    result.initial_mapping.prg_windows.map((window) => window.bank),
  ).toEqual([null, null, null, 31]);
  expect(result.steps.map((step) => step.effect)).toEqual([
    "prg-bank",
    "prg-bank",
    "register-commit",
    "outside-mapper",
    "outside-mapper",
    "register-commit",
  ]);
  expect(
    result.steps[2]!.mapping.prg_windows.map((window) => window.bank),
  ).toEqual([5, 19, 30, 31]);
  expect(result.final_mapping.prg_windows.map((window) => window.bank)).toEqual(
    [30, 19, 5, 31],
  );
  expect(result.final).toMatchObject({
    control: { mask: 128, value: 128 },
    prg_banks: [0xc5, 19],
    mirroring: null,
  });
  for (const [slot, bank] of [30, 19, 5, 31].entries()) {
    const window = result.final_mapping.prg_windows[slot]!;
    expect(window).toEqual({
      start: 0x8000 + slot * 8192,
      size: 8192,
      bank,
      file_offset: 528 + bank * 8192,
    });
    expect(bytes[window.file_offset! + 8191]).toBe(bank);
  }
  expect(result.nes_prg_views).toEqual([
    { mapper: 65, prg_mode: 0, prg_bank_0: 5, prg_bank_1: 19 },
    { mapper: 65, prg_mode: 1, prg_bank_0: 5, prg_bank_1: 19 },
  ]);
  expect(input.initial).toEqual(nesH3001StateSchema.parse({ mapper: 65 }));
});

it("keeps the fixed-bank alias invariant when mode and disconnected selector bits are unknown", () => {
  const { header } = fixture(),
    state = nesH3001StateSchema.parse({
      mapper: 65,
      prg_banks: [
        { mask: 31, value: 30 },
        { mask: 31, value: 19 },
      ],
      chr_banks: [
        { mask: 31, value: 23 },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
    }),
    mapping = mapperMapping(header, state);
  expect(mapping.prg_windows.map((window) => window.bank)).toEqual([
    30, 19, 30, 31,
  ]);
  expect(mapping.prg_view).toBeNull();
  expect(mapping.chr_windows[0]!.bank).toBeNull();
  expect(standardNesChrCandidates(state, 0, 256)).toEqual([
    23, 55, 87, 119, 151, 183, 215, 247,
  ]);
});

it("maps eight independent 1 KiB CHR windows and keeps IRQ latch writes separate from reload", () => {
  const { bytes, header } = fixture(),
    selectors = [211, 5, 137, 44, 252, 90, 17, 126],
    input = traceNesMapperWritesInputSchema.parse({
      path: "/h3001.nes",
      initial: { mapper: 65 },
      writes: [
        ...selectors.map((value, slot) => ({ address: 0xbf80 + slot, value })),
        { address: 0x9b05, value: 0x34 },
        { address: 0x9ff6, value: null, known_bits: { mask: 15, value: 9 } },
        { address: 0x9a03, value: 128 },
        { address: 0x9f04, value: 255 },
      ],
    }),
    result = deriveNesMapperTrace(header, input.initial, input.writes);
  if (result.status !== "derived") throw new Error(result.reason);
  for (const [slot, bank] of selectors.entries()) {
    const window = result.final_mapping.chr_windows[slot]!;
    expect(window).toEqual({
      start: slot * 1024,
      size: 1024,
      bank,
      file_offset: 528 + 256 * 1024 + bank * 1024,
    });
    expect(bytes[window.file_offset! + 1023]).toBe(bank);
  }
  expect(result.final).toMatchObject({
    chr_banks: selectors,
    irq_high: 0x34,
    irq_low: { mask: 15, value: 9 },
    irq_control: 128,
  });
  expect(result.steps.slice(-4).map((step) => step.effect)).toEqual([
    "irq-latch",
    "irq-latch",
    "irq-control",
    "irq-reload",
  ]);
  expect(result.steps.at(-1)!.state).toEqual(result.steps.at(-2)!.state);
  expect(input.initial).toEqual(nesH3001StateSchema.parse({ mapper: 65 }));
});

it("preserves every partial CIRAM proof under the hardware V/A/H/A truth table", () => {
  const { header } = fixture(),
    modes = ["vertical", "one-screen-a", "horizontal", "one-screen-a"] as const,
    proofs: NesByteValue[] = [null];
  for (let mask = 1; mask < 256; mask++)
    for (let value = 0; value < 256; value++)
      if ((value & ~mask) === 0)
        proofs.push(mask === 255 ? value : { mask, value });
  for (const proof of proofs) {
    const candidates = Array.from({ length: 256 }, (_, byte) => byte).filter(
        (byte) =>
          proof === null ||
          (typeof proof === "number"
            ? byte === proof
            : (byte & proof.mask) === proof.value),
      ),
      possibleModes = [...new Set(candidates.map((byte) => modes[byte >> 6]!))],
      state = nesH3001StateSchema.parse({ mapper: 65, mirroring: proof });
    expect(mapperMapping(header, state).mirroring).toBe(
      possibleModes.length === 1 ? possibleModes[0] : "unknown",
    );
    for (let page = 0; page < 4; page++) {
      const expected = [
        ...new Set(
          possibleModes.map((mode) =>
            mode === "vertical"
              ? [0, 1, 0, 1][page]!
              : mode === "horizontal"
                ? [0, 0, 1, 1][page]!
                : 0,
          ),
        ),
      ].sort((a, b) => a - b);
      expect(standardNesNametablePages(header, state, page, 2)).toEqual(
        expected,
      );
    }
  }
});

it("requires exactly the physical register arrays and preserves omitted state as unknown", () => {
  const state = nesMapperStateSchema.parse({ mapper: 65 });
  expect(state).toEqual({
    mapper: 65,
    control: null,
    mirroring: null,
    prg_banks: [null, null],
    chr_banks: [null, null, null, null, null, null, null, null],
    irq_control: null,
    irq_low: null,
    irq_high: null,
  });
  expect(
    nesMapperStateSchema.safeParse({ ...state, prg_banks: [0, 1, 2] }).success,
  ).toBe(false);
  expect(
    nesMapperStateSchema.safeParse({ ...state, chr_banks: [0, 1] }).success,
  ).toBe(false);
  expect(
    nesMapperStateSchema.safeParse({ ...state, variant: "legacy" }).success,
  ).toBe(false);
});
