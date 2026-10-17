import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";

const fixture = (mapper: 23 | 25, submapper = 3, chr = 262144) => {
  const bytes = Buffer.alloc(16 + 131072 + chr);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    8,
    chr / 8192,
    (mapper & 15) << 4,
    0x18,
    submapper << 4,
  ]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return { bytes, header: parsed.value };
};
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});

it.each([23, 25] as const)(
  "uses every CHR bit and board-specific register address for Mapper %i",
  (mapper) => {
    const { header } = fixture(mapper);
    const writes = Array.from({ length: 8 }, (_, index) => {
      const lowPort = mapper === 23 ? (index % 2) * 2 : index % 2;
      const highPort = mapper === 23 ? lowPort + 1 : lowPort + 2;
      const base = 0xbffc + Math.floor(index / 2) * 4096;
      return [
        write(base + lowPort, 0xf0 | (index * 2 + 1)),
        write(base + highPort, 0xf0 | (15 - index)),
      ];
    }).flat();
    const trace = deriveNesMapperTrace(
      header,
      nesMapperStateSchema.parse({ mapper }),
      [
        write(0x8fff, 0xe2),
        write(0xafff, 0xe5),
        write(0x9002, 255),
        ...writes,
        write(0xf000, 0),
      ],
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
      2, 5, 14, 15,
    ]);
    expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
      241, 227, 213, 199, 185, 171, 157, 143,
    ]);
    expect(trace.final_mapping.mirroring).toBe("horizontal");
    expect(trace.steps.at(-1)?.effect).toBe("outside-mapper");
    expect(trace.nes_prg_views).toEqual([
      { mapper, prg_bank_0: 2, prg_bank_1: 5 },
    ]);
  },
);

it.each([23, 25] as const)(
  "requires the low CHR bit for Mapper %i and preserves high-nibble proofs",
  (mapper) => {
    const { header } = fixture(mapper);
    const high = mapper === 23 ? 0xb001 : 0xb002;
    const trace = deriveNesMapperTrace(
      header,
      nesMapperStateSchema.parse({ mapper }),
      [
        write(high, 15),
        { ...write(0xb000, null), known_bits: { mask: 14, value: 6 } },
      ],
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.final_mapping.chr_windows[0]?.bank).toBeNull();
    expect(trace.final).toMatchObject({
      chr_low: [
        { mask: 14, value: 6 },
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ],
      chr_high: [15, null, null, null, null, null, null, null],
    });
  },
);

it.each([23, 25] as const)(
  "rejects ambiguous board identities and mixing VRC2 states with VRC4 for Mapper %i",
  (mapper) => {
    for (const submapper of [0, 4])
      expect(resolveNesMapperLayout(fixture(mapper, submapper).header).ok).toBe(
        false,
      );
    for (const submapper of [1, 2]) {
      const { header } = fixture(mapper, submapper);
      const layout = resolveNesMapperLayout(header);
      if (!layout.ok) throw new Error(layout.error);
      expect(layout.value.board).toContain("VRC4");
      expect(
        deriveNesMapperTrace(header, nesMapperStateSchema.parse({ mapper }), [])
          .status,
      ).toBe("unsupported");
      expect(
        resolveNesMapperLayout(header, [
          { mapper, prg_bank_0: 0, prg_bank_1: 1 },
        ]).ok,
      ).toBe(false);
    }
    const { bytes } = fixture(mapper);
    bytes[7] = 0x10;
    bytes[8] = 0;
    const legacy = parseNesHeader(bytes);
    if (!legacy.ok) throw new Error(legacy.error);
    expect(resolveNesMapperLayout(legacy.value).ok).toBe(false);
    expect(resolveNesMapperLayout(fixture(mapper, 3, 524288).header).ok).toBe(
      false,
    );
    const layout = resolveNesMapperLayout(fixture(mapper).header, [
      { mapper, prg_bank_0: 18, prg_bank_1: 21 },
    ]);
    if (!layout.ok) throw new Error(layout.error);
    expect(layout.value.mappings.map((w) => w.bank)).toEqual([2, 5, 14, 15]);
    expect(new Set(layout.value.mappings.map((w) => w.addressSpace))).toEqual(
      new Set([`NES_M${mapper}_P12_Q15`]),
    );
  },
);
