import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";

const cartridge = (submapper: number, banks = 16) => {
  const bytes = Buffer.alloc(16 + banks * 16384);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    banks,
    0,
    0x80,
    0xe8,
    submapper << 4,
    0,
    0,
    7,
  ]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return { bytes, header: parsed.value };
};

it.each([0, 1])(
  "keeps both Quattro windows in each selected group for submapper %i",
  (submapper) => {
    const { header } = cartridge(submapper);
    const views = Array.from({ length: 16 }, (_, n) => ({
      mapper: 232 as const,
      prg_outer_bank: n >> 2,
      prg_bank: n & 3,
    }));
    const layout = resolveNesMapperLayout(header, views);
    if (!layout.ok) throw new Error(layout.error);
    expect(layout.value.contexts).toHaveLength(16);
    for (const [index, view] of views.entries()) {
      const windows = layout.value.mappings.slice(index * 2, index * 2 + 2);
      expect(windows.map((w) => [w.start, w.bank, w.fileOffset])).toEqual([
        [0x8000, index, 16 + index * 16384],
        [
          0xc000,
          view.prg_outer_bank * 4 + 3,
          16 + (view.prg_outer_bank * 4 + 3) * 16384,
        ],
      ]);
      expect(new Set(windows.map((w) => w.addressSpace)).size).toBe(1);
    }
    const candidates = resolveNesMapperLayout(header);
    if (!candidates.ok) throw new Error(candidates.error);
    expect(candidates.value.contexts).toEqual([]);
    expect(
      candidates.value.mappings.every((w) => w.addressSpace !== "RAM"),
    ).toBe(true);
    expect(resolveNesMapperLayout({ ...header, submapper: 2 }).ok).toBe(false);
  },
);

it.each([0, 1])(
  "decodes every register byte without bus conflicts for submapper %i",
  (submapper) => {
    const { header } = cartridge(submapper);
    for (let byte = 0; byte < 256; byte++) {
      const trace = deriveNesMapperTrace(
        header,
        nesMapperStateSchema.parse({ mapper: 232 }),
        [
          { preceded_by_cpu_write: null, address: 0xbfff, value: byte },
          { preceded_by_cpu_write: null, address: 0xffff, value: byte },
        ],
      );
      if (trace.status !== "derived") throw new Error(trace.reason);
      const group =
        submapper === 0
          ? (byte >> 3) & 3
          : (byte & 8 ? 2 : 0) + (byte & 16 ? 1 : 0);
      expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
        group * 4 + (byte & 3),
        group * 4 + 3,
      ]);
      expect(trace.initial_mapping.prg_windows.map((w) => w.bank)).toEqual([
        null,
        null,
      ]);
      expect(trace.steps[0]?.state).toMatchObject({
        prg_outer_bank: group,
        prg_bank: null,
      });
    }
  },
);

it("preserves partial selectors and restores unknown windows after an unknown outer write", () => {
  const { header } = cartridge(0);
  const trace = deriveNesMapperTrace(
    header,
    nesMapperStateSchema.parse({ mapper: 232 }),
    [
      { preceded_by_cpu_write: null, address: 0x7fff, value: 255 },
      {
        preceded_by_cpu_write: null,
        address: 0x8000,
        value: null,
        known_bits: { mask: 24, value: 16 },
      },
      {
        preceded_by_cpu_write: null,
        address: 0xc000,
        value: null,
        known_bits: { mask: 3, value: 1 },
      },
      { preceded_by_cpu_write: null, address: 0x8000, value: null },
    ],
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.steps[0]?.effect).toBe("outside-mapper");
  expect(trace.nes_prg_views).toEqual([
    { mapper: 232, prg_outer_bank: 2, prg_bank: 1 },
  ]);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    null,
    null,
  ]);
  const small = cartridge(0, 4);
  const fixed = deriveNesMapperTrace(
    small.header,
    nesMapperStateSchema.parse({ mapper: 232 }),
    [],
  );
  if (fixed.status !== "derived") throw new Error(fixed.reason);
  expect(fixed.final_mapping.prg_windows.map((w) => w.bank)).toEqual([null, 3]);
});

it.each([0, 1])(
  "fetches the next opcode from the newly selected upper window for submapper %i",
  async (submapper) => {
    const { header, bytes } = cartridge(submapper);
    bytes.set([0xa9, 8, 0x8d, 0, 0x80], 16 + 3 * 16384);
    const group = submapper === 0 ? 1 : 2;
    const next = 16 + (group * 4 + 3) * 16384 + 5;
    bytes.set([0xa9, 2, 0x8d, 0, 0xc0, 0x4c, 0, 0x80], next);
    const target = 16 + (group * 4 + 2) * 16384;
    bytes.set([0xa9, 0x55, 0x60], target);
    const result = await deriveNesCode(
      header,
      bytes.subarray(16),
      traceNesCodeInputSchema.parse({
        path: "/quattro.nes",
        entry: 0xc000,
        initial: { mapper: 232, prg_outer_bank: 0, prg_bank: 0 },
      }),
    );
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.instructions[2]?.file_offsets).toEqual([next, next + 1]);
    expect(
      result.instructions.find((i) => i.address === 0x8000)?.file_offsets,
    ).toEqual([target, target + 1]);
    expect(result.final_cpu.a).toBe(0x55);
    if (result.mapper_trace.status !== "derived")
      throw new Error(result.mapper_trace.reason);
    expect(result.mapper_trace.final).toEqual({
      mapper: 232,
      prg_outer_bank: group,
      prg_bank: 2,
    });
  },
);

it("joins physical outer-bank aliases without discarding a proven selector bit", () => {
  for (const submapper of [0, 1]) {
    for (const banks of [4, 8, 16]) {
      const { header } = cartridge(submapper, banks);
      for (const mask of [0, 8, 16, 24]) {
        for (const value of [0, 8, 16, 24].filter((v) => (v & ~mask) === 0)) {
          const write =
            mask === 0
              ? { address: 0x8000, value: null, preceded_by_cpu_write: false }
              : {
                  address: 0x8000,
                  value: null,
                  known_bits: { mask, value },
                  preceded_by_cpu_write: false,
                };
          const initial = nesMapperStateSchema.parse({
            mapper: 232,
            prg_bank: 2,
          });
          const trace = deriveNesMapperTrace(header, initial, [write]);
          if (trace.status !== "derived") throw new Error(trace.reason);
          const groups = [0, 8, 16, 24]
            .filter((v) => (v & mask) === value)
            .map((v) =>
              submapper === 0 ? v / 8 : (v & 8 ? 2 : 0) + (v & 16 ? 1 : 0),
            );
          const expected = [2, 3].map((inner) => {
            const candidates = new Set(
              groups.map((group) => (group * 4 + inner) % banks),
            );
            return candidates.size === 1 ? [...candidates][0] : null;
          });
          expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual(
            expected,
          );
          const resumed = deriveNesMapperTrace(
            header,
            nesMapperStateSchema.parse(trace.final),
            [],
          );
          if (resumed.status !== "derived") throw new Error(resumed.reason);
          expect(resumed.final_mapping).toEqual(trace.final_mapping);
          expect(trace.nes_prg_views.length).toBe(mask === 24 ? 1 : 0);
        }
      }
    }
  }
});

it("executes a physically known upper window while retaining a partial logical outer selector", async () => {
  for (const banks of [8, 16]) {
    const { header, bytes } = cartridge(1, banks);
    bytes.set([0xa9, 0x66, 0x60], 16 + 7 * 16384);
    const trace = await deriveNesCode(
      header,
      bytes.subarray(16),
      traceNesCodeInputSchema.parse({
        path: "/quattro-alias.nes",
        entry: 0xc000,
        initial: {
          mapper: 232,
          prg_outer_bank: { mask: 1, value: 1 },
          prg_bank: 2,
        },
      }),
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    if (banks === 8) {
      expect(trace.instructions[0]?.file_offsets).toEqual([
        16 + 7 * 16384,
        17 + 7 * 16384,
      ]);
      expect(trace.final_cpu.a).toBe(0x66);
    } else expect(trace.instructions).toEqual([]);
    expect(trace.mapper_trace).toMatchObject({
      final: { prg_outer_bank: { mask: 1, value: 1 } },
      nes_prg_views: [],
    });
  }
});

it("rejects noncanonical partial logical outer selectors", () => {
  for (const prg_outer_bank of [
    { mask: 1, value: 2 },
    { mask: 2, value: 1 },
    { mask: 3, value: 1 },
    { mask: 0, value: 0 },
    4,
  ]) {
    expect(
      nesMapperStateSchema.safeParse({ mapper: 232, prg_outer_bank }).success,
    ).toBe(false);
  }
});
