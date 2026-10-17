import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";

const fixture = (prg = 262144, chr = 131072, submapper = 0) => {
  const bytes = Buffer.alloc(16 + prg + chr);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    prg / 16384,
    chr / 8192,
    0x60,
    0x18,
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
const initial = () => nesMapperStateSchema.parse({ mapper: 22 });

it("decodes swapped VRC2a address lines and retains raw nibble writes", () => {
  const writes = Array.from({ length: 8 }, (_, index) => {
    const base = 0xbffc + Math.floor(index / 2) * 4096 + (index % 2);
    return [
      write(base, 0xf0 | (index * 2 + 1)),
      write(base + 2, 0xf0 | (15 - index)),
    ];
  }).flat();
  const trace = deriveNesMapperTrace(fixture(), initial(), [
    write(0x8fff, 0xe2),
    write(0xafff, 0xff),
    write(0x9003, 0xff),
    ...writes,
    write(0xf000, 0),
    write(0xffff, 0),
  ]);
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    2, 31, 30, 31,
  ]);
  expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
    120, 113, 106, 99, 92, 85, 78, 71,
  ]);
  expect(trace.final_mapping.mirroring).toBe("horizontal");
  expect(trace.final).toMatchObject({
    chr_low: [241, 243, 245, 247, 249, 251, 253, 255],
    chr_high: [255, 254, 253, 252, 251, 250, 249, 248],
  });
  expect(trace.steps.slice(-2).map((step) => step.effect)).toEqual([
    "outside-mapper",
    "outside-mapper",
  ]);
});

it("keeps the untouched VRC2a half and ignores unknown discarded bits", () => {
  const trace = deriveNesMapperTrace(fixture(), initial(), [
    write(0xb002, 4),
    { ...write(0xb000, null), known_bits: { mask: 14, value: 6 } },
  ]);
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
    35,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(trace.final).toMatchObject({
    chr_low: [{ mask: 14, value: 6 }, null, null, null, null, null, null, null],
    chr_high: [4, null, null, null, null, null, null, null],
  });
});

it("resolves small VRC2a ROM aliases without inventing unknown high nibble or logical selectors", () => {
  const trace = deriveNesMapperTrace(fixture(32768, 8192), initial(), [
    { ...write(0xb000, null), known_bits: { mask: 14, value: 14 } },
    { ...write(0x8000, null), known_bits: { mask: 3, value: 2 } },
    { ...write(0xa000, null), known_bits: { mask: 3, value: 1 } },
    { ...write(0x9002, null), known_bits: { mask: 1, value: 0 } },
  ]);
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.chr_windows[0]?.bank).toBe(7);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    2, 1, 2, 3,
  ]);
  expect(trace.final_mapping.mirroring).toBe("vertical");
  expect(trace.nes_prg_views).toEqual([]);
});

it("uses every VRC2a CHR selector value with either half written first", () => {
  const header = fixture();
  for (let index = 0; index < 8; index++) {
    const base = 0xb000 + Math.floor(index / 2) * 4096 + (index % 2);
    for (let value = 0; value < 256; value++) {
      const halves = [
        write(base, (value & 15) | 240),
        write(base + 2, (value >> 4) | 240),
      ];
      if (value & 1) halves.reverse();
      const trace = deriveNesMapperTrace(header, initial(), halves);
      if (trace.status !== "derived") throw new Error(trace.reason);
      expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual(
        Array.from({ length: 8 }, (_, window) =>
          window === index ? Math.floor(value / 2) : null,
        ),
      );
    }
  }
});

it("keeps a complete static VRC2a context and rejects unsupported board capacities", () => {
  const layout = resolveNesMapperLayout(fixture(65536), [
    { mapper: 22, prg_bank_0: 18, prg_bank_1: 29 },
  ]);
  if (!layout.ok) throw new Error(layout.error);
  expect(
    layout.value.mappings.map((w) => [w.start, w.bank, w.fileOffset]),
  ).toEqual([
    [0x8000, 2, 16 + 2 * 8192],
    [0xa000, 5, 16 + 5 * 8192],
    [0xc000, 6, 16 + 6 * 8192],
    [0xe000, 7, 16 + 7 * 8192],
  ]);
  expect(new Set(layout.value.mappings.map((w) => w.addressSpace))).toEqual(
    new Set(["NES_M22_P12_Q1d"]),
  );
  expect(resolveNesMapperLayout(fixture(524288)).ok).toBe(false);
  expect(resolveNesMapperLayout(fixture(65536, 262144)).ok).toBe(false);
  expect(resolveNesMapperLayout(fixture(65536, 131072, 1)).ok).toBe(false);
});
