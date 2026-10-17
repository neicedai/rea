import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";

const fixture = (
  chr = 131072,
  fourScreen = false,
  prg = 131072,
  submapper = 0,
) => {
  const bytes = Buffer.alloc(16 + prg + chr);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    prg / 16384,
    chr / 8192,
    fourScreen ? 0xb8 : 0xb0,
    0x48,
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

it("preserves independent VRC1 selectors and control bits across register writes", () => {
  const trace = deriveNesMapperTrace(
    fixture(),
    nesMapperStateSchema.parse({ mapper: 75 }),
    [
      write(0x8fff, 0xf2),
      write(0xafff, 0xe5),
      write(0xcfff, 0xd7),
      write(0x9fff, 7),
      write(0xefff, 0xf3),
      write(0xffff, 0xe4),
      write(0xb000, 0),
      write(0xdfff, 0),
      write(0x9000, 2),
      write(0xf000, 9),
    ],
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    2, 5, 7, 15,
  ]);
  expect(trace.steps[5]?.state).toMatchObject({
    control: 7,
    chr_banks: [243, 228],
  });
  expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([19, 9]);
  expect(trace.final_mapping.mirroring).toBe("vertical");
  expect(trace.steps.slice(6, 8).map((s) => s.effect)).toEqual([
    "outside-mapper",
    "outside-mapper",
  ]);
  expect(trace.final).toMatchObject({
    control: 2,
    prg_banks: [242, 229, 215],
    chr_banks: [243, 9],
  });
  expect(trace.nes_prg_views).toEqual([
    { mapper: 75, prg_bank_0: 2, prg_bank_1: 5, prg_bank_2: 7 },
  ]);
});

it.each([8192, 16384, 32768, 65536, 131072])(
  "resolves VRC1 partial CHR bits against physical capacity %i",
  (chr) => {
    const trace = deriveNesMapperTrace(
      fixture(chr),
      nesMapperStateSchema.parse({ mapper: 75 }),
      [
        { ...write(0xe000, null), known_bits: { mask: 15, value: 3 } },
        { ...write(0xf000, null), known_bits: { mask: 15, value: 4 } },
        { ...write(0x9000, null), known_bits: { mask: 2, value: 2 } },
      ],
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
      19 & (chr / 4096 - 1),
      chr === 131072 ? null : 4 & (chr / 4096 - 1),
    ]);
    expect(trace.final_mapping.mirroring).toBe("unknown");
    expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
      null,
      null,
      null,
      15,
    ]);
    expect(trace.nes_prg_views).toEqual([]);
  },
);

it("keeps hardwired VRC1 four-screen mirroring under unknown control", () => {
  const trace = deriveNesMapperTrace(
    fixture(131072, true),
    nesMapperStateSchema.parse({ mapper: 75 }),
    [write(0x9000, null)],
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.mirroring).toBe("four-screen");
});

it("keeps three selected VRC1 windows in one static context", () => {
  const layout = resolveNesMapperLayout(fixture(8192, false, 32768), [
    { mapper: 75, prg_bank_0: 10, prg_bank_1: 13, prg_bank_2: 15 },
  ]);
  if (!layout.ok) throw new Error(layout.error);
  expect(
    layout.value.mappings.map((w) => [w.start, w.bank, w.fileOffset]),
  ).toEqual([
    [0x8000, 2, 16 + 2 * 8192],
    [0xa000, 1, 16 + 8192],
    [0xc000, 3, 16 + 3 * 8192],
    [0xe000, 3, 16 + 3 * 8192],
  ]);
  expect(new Set(layout.value.mappings.map((w) => w.addressSpace))).toEqual(
    new Set(["NES_M75_P0a_Q0d_R0f"]),
  );
  expect(resolveNesMapperLayout(fixture(8192, false, 262144)).ok).toBe(false);
  expect(resolveNesMapperLayout(fixture(262144)).ok).toBe(false);
  expect(resolveNesMapperLayout(fixture(8192, false, 32768, 1)).ok).toBe(false);
});

it("retains partial VRC1 PRG proofs when capacity resolves all physical windows", () => {
  const trace = deriveNesMapperTrace(
    fixture(8192, false, 32768),
    nesMapperStateSchema.parse({ mapper: 75 }),
    [2, 1, 3].map((value, index) => ({
      ...write(0x8000 + index * 0x2000, null),
      known_bits: { mask: 3, value },
    })),
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    2, 1, 3, 3,
  ]);
  expect(trace.nes_prg_views).toEqual([]);
  expect(trace.final).toMatchObject({
    prg_banks: [2, 1, 3].map((value) => ({ mask: 3, value })),
  });
});
