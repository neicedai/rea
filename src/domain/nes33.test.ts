import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";

const fixture = (prg = 524288, chr = 524288, submapper = 0) => {
  const bytes = Buffer.alloc(16 + prg + chr);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    prg / 16384,
    chr / 8192,
    0x10,
    0x28,
    submapper << 4,
  ]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});

it("resolves Taito paired CHR banks as 2 KiB indices including the high bit", () => {
  const trace = deriveNesMapperTrace(
    fixture(),
    nesMapperStateSchema.parse({ mapper: 33 }),
    [
      write(0x9ffc, 0xfe),
      write(0x9ffd, 0xff),
      write(0x9ffe, 0xff),
      write(0x9fff, 3),
      ...[255, 128, 2, 9].map((bank, index) => write(0xbffc + index, bank)),
      write(0xc000, 0),
      write(0xe000, 0),
    ],
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    62, 63, 62, 63,
  ]);
  expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
    510, 511, 6, 7, 255, 128, 2, 9,
  ]);
  expect(trace.final_mapping.mirroring).toBe("horizontal");
  expect(trace.final).toMatchObject({
    prg_banks: [254, 255],
    chr_banks: [255, 3, 255, 128, 2, 9],
  });
  expect(trace.steps.slice(-2).map((s) => s.effect)).toEqual([
    "outside-mapper",
    "outside-mapper",
  ]);
});

it("does not discard an unknown paired selector low bit as MMC3 would", () => {
  const trace = deriveNesMapperTrace(
    fixture(),
    nesMapperStateSchema.parse({ mapper: 33 }),
    [
      { ...write(0x8002, null), known_bits: { mask: 254, value: 2 } },
      { ...write(0x8000, null), known_bits: { mask: 64, value: 0 } },
    ],
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(
    trace.final_mapping.chr_windows.slice(0, 2).map((w) => w.bank),
  ).toEqual([null, null]);
  expect(trace.final_mapping.mirroring).toBe("vertical");
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    null,
    null,
    62,
    63,
  ]);
  expect(trace.nes_prg_views).toEqual([]);
});

it("resolves only physically required address bits without inventing mirroring or logical views", () => {
  const trace = deriveNesMapperTrace(
    fixture(32768, 8192),
    nesMapperStateSchema.parse({ mapper: 33 }),
    [
      { ...write(0x8000, null), known_bits: { mask: 3, value: 2 } },
      { ...write(0x8001, null), known_bits: { mask: 3, value: 1 } },
      { ...write(0x8002, null), known_bits: { mask: 3, value: 3 } },
      { ...write(0xa000, null), known_bits: { mask: 7, value: 5 } },
    ],
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    2, 1, 2, 3,
  ]);
  expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
    6,
    7,
    null,
    null,
    5,
    null,
    null,
    null,
  ]);
  expect(trace.final_mapping.mirroring).toBe("unknown");
  expect(trace.nes_prg_views).toEqual([]);
});

it("preserves all four static Taito CPU windows and raw aliased selectors", () => {
  const layout = resolveNesMapperLayout(fixture(131072), [
    { mapper: 33, prg_bank_0: 34, prg_bank_1: 53 },
  ]);
  if (!layout.ok) throw new Error(layout.error);
  expect(layout.value.contexts[0]?.state).toEqual({
    mapper: 33,
    prg_bank_0: 34,
    prg_bank_1: 53,
  });
  expect(
    layout.value.mappings.map((w) => [w.start, w.bank, w.fileOffset]),
  ).toEqual([
    [0x8000, 2, 16 + 2 * 8192],
    [0xa000, 5, 16 + 5 * 8192],
    [0xc000, 14, 16 + 14 * 8192],
    [0xe000, 15, 16 + 15 * 8192],
  ]);
  expect(new Set(layout.value.mappings.map((w) => w.addressSpace))).toEqual(
    new Set(["NES_M33_P22_Q35"]),
  );
  expect(resolveNesMapperLayout(fixture(524288, 524288, 1)).ok).toBe(false);
  expect(resolveNesMapperLayout(fixture(1048576)).ok).toBe(false);
});
