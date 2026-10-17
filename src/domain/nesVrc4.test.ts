import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import {
  nesMapperStateSchema,
  nesMapperWriteSchema,
} from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";

const wiring = [
  [21, 1, 1, 2],
  [21, 2, 6, 7],
  [23, 1, 0, 1],
  [23, 2, 2, 3],
  [25, 1, 1, 0],
  [25, 2, 3, 2],
] as const;
const fixture = (mapper: number, submapper: number, chr = 524288) => {
  const bytes = Buffer.alloc(528 + 131072 + chr);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    8,
    chr / 8192,
    ((mapper & 15) << 4) | 4,
    0x18,
    submapper << 4,
  ]);
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  return header.value;
};
const trace = (
  mapper: number,
  submapper: number,
  initial: unknown,
  writes: unknown[],
  chr?: number,
) => {
  const result = deriveNesMapperTrace(
    fixture(mapper, submapper, chr),
    nesMapperStateSchema.parse(initial),
    writes.map((w) => nesMapperWriteSchema.parse(w)),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  return result;
};

it.each(wiring)(
  "decodes Mapper %i submapper %i CPU A%i/A%i into nine-bit CHR and swapped PRG windows",
  (mapper, submapper, a0, a1) => {
    const ignored = 0xfff & ~((1 << a0) | (1 << a1));
    const port = (base: number, p: number) =>
      base | ignored | ((p & 1) << a0) | ((p >> 1) << a1);
    const chr = [511, 257, 145, 33, 15, 400, 112, 270];
    const writes = [
      { address: 0x8fff, value: 0xe2 },
      { address: 0xafff, value: 0xe5 },
      { address: port(0x9000, 0), value: 3 },
      { address: port(0x9000, 2), value: 2 },
      { address: port(0x9000, 1), value: 0 },
      { address: port(0x9000, 3), value: 0 },
      ...chr.flatMap((bank, index) => {
        const base = 0xb000 + (index >> 1) * 4096;
        return [
          { address: port(base, (index & 1) * 2), value: 0xf0 | (bank & 15) },
          {
            address: port(base, (index & 1) * 2 + 1),
            value: 0xe0 | (bank >> 4),
          },
        ];
      }),
      { address: port(0xf000, 0), value: 0xfe },
      { address: port(0xf000, 1), value: 0xff },
      { address: port(0xf000, 2), value: 2 },
      { address: port(0xf000, 3), value: 255 },
    ];
    const result = trace(
      mapper,
      submapper,
      { mapper, variant: "vrc4" },
      writes,
    );
    expect(result.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
      14, 5, 2, 15,
    ]);
    expect(result.final_mapping.chr_windows.map((w) => w.bank)).toEqual(chr);
    expect(result.final_mapping.chr_windows.at(-1)?.file_offset).toBe(
      528 + 131072 + 270 * 1024,
    );
    expect(result.final_mapping.mirroring).toBe("one-screen-b");
    expect(result.steps.slice(4, 6).map((s) => s.effect)).toEqual([
      "outside-mapper",
      "external-select",
    ]);
    expect(result.final).toMatchObject({
      prg_banks: [0xe2, 0xe5],
      irq_latch_low: 0xfe,
      irq_latch_high: 0xff,
      irq_control: 2,
      irq_enabled: false,
      last_irq_command: "acknowledge",
    });
    const view = {
      mapper,
      variant: "vrc4" as const,
      prg_mode: 1 as const,
      prg_bank_0: 2,
      prg_bank_1: 5,
    };
    expect(result.nes_prg_views).toEqual([view]);
    const layout = resolveNesMapperLayout(
      fixture(mapper, submapper),
      result.nes_prg_views,
    );
    if (!layout.ok) throw new Error(layout.error);
    expect(layout.value.mappings.map((w) => w.bank)).toEqual([14, 5, 2, 15]);
    expect(layout.value.mappings.map((w) => w.role)).toEqual([
      "fixed",
      "switchable",
      "switchable",
      "fixed",
    ]);
    expect(layout.value.contexts[0]?.addressSpace).toBe(
      `NES_M${mapper}_V4_M1_P02_Q05`,
    );
    expect(trace(mapper, submapper, result.final, []).final_mapping).toEqual(
      result.final_mapping,
    );
  },
);

it.each([262144, 524288])(
  "requires the ninth CHR bit only for a %i-byte ROM",
  (chr) => {
    const partial = trace(
      23,
      1,
      { mapper: 23, variant: "vrc4" },
      [
        { address: 0xb000, value: 15 },
        { address: 0xb001, value: null, known_bits: { mask: 15, value: 15 } },
      ],
      chr,
    );
    expect(partial.final_mapping.chr_windows[0]?.bank).toBe(
      chr === 262144 ? 255 : null,
    );
    const resolved = trace(
      23,
      1,
      partial.final,
      [{ address: 0xb001, value: null, known_bits: { mask: 31, value: 31 } }],
      chr,
    );
    expect(resolved.final_mapping.chr_windows[0]?.bank).toBe(
      chr === 262144 ? 255 : 511,
    );
  },
);

it("retains only PRG aliases common to both modes and decodes IRQ enable bits independently", () => {
  const result = trace(
    23,
    1,
    { mapper: 23, variant: "vrc4", prg_banks: [30, 5] },
    [
      { address: 0xf002, value: null, known_bits: { mask: 2, value: 2 } },
      { address: 0xf003, value: 0 },
    ],
  );
  expect(result.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    14, 5, 14, 15,
  ]);
  expect(result.final_mapping.prg_view).toBeNull();
  expect(result.steps[0]?.state).toMatchObject({ irq_enabled: true });
  expect(result.final).toMatchObject({
    irq_enabled: null,
    irq_control: { mask: 2, value: 2 },
  });
  const lost = trace(23, 1, result.final, [{ address: 0x8000, value: null }]);
  expect(lost.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    null,
    5,
    null,
    15,
  ]);
});

it("rejects VRC2/VRC4 state and view mismatches, legacy identities and unsupported capacities", () => {
  for (const [mapper, submapper] of wiring) {
    const header = fixture(mapper, submapper);
    const wrong = nesMapperStateSchema.parse({
      mapper: mapper === 21 ? 23 : mapper,
    });
    expect(deriveNesMapperTrace(header, wrong, []).status).toBe("unsupported");
    expect(resolveNesMapperLayout({ ...header, submapper: 0 }).ok).toBe(false);
    expect(
      resolveNesMapperLayout({
        ...header,
        submapper: null,
        headerVersion: "ines",
      }).ok,
    ).toBe(false);
    expect(
      resolveNesMapperLayout({
        ...header,
        prgRom: { ...header.prgRom, size: 524288 },
      }).ok,
    ).toBe(false);
  }
  expect(nesMapperStateSchema.safeParse({ mapper: 21 }).success).toBe(false);
  const vrc2 = fixture(23, 3, 262144);
  expect(
    deriveNesMapperTrace(
      vrc2,
      nesMapperStateSchema.parse({ mapper: 23, variant: "vrc4" }),
      [],
    ).status,
  ).toBe("unsupported");
});

it.each([
  [0, "vertical"],
  [1, "horizontal"],
  [2, "one-screen-a"],
  [3, "one-screen-b"],
] as const)(
  "decodes VRC4 mirroring %i as %s without guessing an unproven mode bit",
  (value, expected) => {
    const result = trace(23, 1, { mapper: 23, variant: "vrc4" }, [
      { address: 0x9000, value: value | 252 },
    ]);
    expect(result.final_mapping.mirroring).toBe(expected);
    const unknown = trace(23, 1, result.final, [
      {
        address: 0x9000,
        value: null,
        known_bits: { mask: 1, value: value & 1 },
      },
    ]);
    expect(unknown.final_mapping.mirroring).toBe("unknown");
  },
);

it.each([
  [0, false, false],
  [1, false, true],
  [2, true, false],
  [3, true, true],
] as const)(
  "uses VRC4 control %i enable %s and acknowledge enable %s",
  (value, enabled, acknowledged) => {
    const result = trace(23, 1, { mapper: 23, variant: "vrc4" }, [
      { address: 0xf002, value },
      { address: 0xf003, value: null },
    ]);
    expect(result.steps[0]?.state).toMatchObject({
      irq_control: value,
      irq_enabled: enabled,
    });
    expect(result.final).toMatchObject({
      irq_control: value,
      irq_enabled: acknowledged,
      last_irq_command: "acknowledge",
    });
  },
);
