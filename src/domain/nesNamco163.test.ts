import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import {
  nesMapperStateSchema,
  nesMapperMappingSchema,
} from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { nesPrgRamAccess } from "./nesPrgRam.js";
import { namco163Fixture } from "./nesNamco163.fixture.js";
import { nesNamco163StateSchema, namco163Mapping } from "./nesNamco163.js";
import type { NesByteValue } from "./nesByteValue.js";

const header = () => {
  const parsed = parseNesHeader(namco163Fixture().bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
it("preserves selected complete Namco 163 contexts and raw ignored bits", () => {
  const state = nesNamco163StateSchema.parse({
    mapper: 19,
    variant: "namco163",
    prg_banks: [0xc2, 0xc5, 0x83],
  });
  const mapping = nesMapperMappingSchema.parse(
    namco163Mapping(header(), state),
  );
  expect(mapping.prg_windows.map((w) => w.bank)).toEqual([2, 5, 3, 15]);
  const layout = resolveNesMapperLayout(header(), [mapping.prg_view!]);
  if (!layout.ok) throw new Error(layout.error);
  expect(layout.value.mappings.map((w) => [w.start, w.bank])).toEqual([
    [0x8000, 2],
    [0xa000, 5],
    [0xc000, 3],
    [0xe000, 15],
  ]);
  expect(layout.value.contexts).toMatchObject([
    {
      addressSpace: "NES_M19_P02_Q05_R03",
      selection: "caller-selected",
      state: { variant: "namco163" },
    },
  ]);
});
it("resolves CIRAM and physical ROM aliasing from partial selector bits", () => {
  const state = nesNamco163StateSchema.parse({
    mapper: 19,
    variant: "namco163",
    prg_banks: [{ mask: 15, value: 2 }, { mask: 192, value: 64 }, 3],
    chr_banks: [{ mask: 225, value: 225 }, 225, 255, 7, 225, 224, 7, null],
    nametable_banks: [224, 225, 224, 225],
  });
  const mapping = namco163Mapping(header(), state);
  expect(mapping.prg_windows.map((w) => w.bank)).toEqual([2, null, 3, 15]);
  expect(mapping.prg_view).toBeNull();
  expect(
    mapping.chr_windows.map((w) => ["source" in w ? w.source : null, w.bank]),
  ).toEqual([
    ["chr-rom", null],
    ["chr-rom", 225],
    ["chr-rom", 255],
    ["chr-rom", 7],
    ["ciram", 1],
    ["ciram", 0],
    ["chr-rom", 7],
    ["unknown", null],
  ]);
  expect(mapping.mirroring).toBe("vertical");
  const small = namco163Mapping(
    { ...header(), chrRom: { ...header().chrRom, size: 8192 } },
    {
      ...state,
      chr_banks: [{ mask: 7, value: 5 }, ...state.chr_banks.slice(1)],
    },
  );
  // Disable is proven: unknown upper selector bits cannot change ROM/CIRAM source.
  expect(small.chr_windows[0]).toMatchObject({ source: "chr-rom", bank: 5 });
});
it.each([0x3f, { mask: 63, value: 63 }, null] as const)(
  "leaves debug-mode PPU sources unproven for F000=%j",
  (value) => {
    const mapping = namco163Mapping(
      header(),
      nesNamco163StateSchema.parse({
        mapper: 19,
        variant: "namco163",
        prg_banks: [0, 1, value],
        chr_banks: Array(8).fill(0),
        nametable_banks: Array(4).fill(224),
      }),
    );
    expect(
      mapping.chr_windows.every(
        (w) => w.bank === null && w.file_offset === null,
      ),
    ).toBe(true);
    expect(mapping.mirroring).toBe("unknown");
  },
);
it.each([
  0x40,
  0x4a,
  0x4f,
  0xc0,
  { mask: 240, value: 64 },
  { mask: 64, value: 0 },
  null,
] satisfies NesByteValue[])(
  "derives addressed N163 write protection for %j",
  (control) => {
    const state = nesNamco163StateSchema.parse({
      mapper: 19,
      variant: "namco163",
      ram_control: control,
    });
    const writable = [0x6000, 0x6800, 0x7000, 0x7800].map(
      (address) => nesPrgRamAccess(header(), state, address)?.writable,
    );
    expect(writable).toEqual(
      control === 0x40
        ? [true, true, true, true]
        : control === 0x4a
          ? [true, false, true, false]
          : control === 0x4f ||
              control === 0xc0 ||
              (control !== null &&
                typeof control === "object" &&
                control.mask === 64)
            ? [false, false, false, false]
            : [null, null, null, null],
    );
  },
);
it("rejects mismatched board variants and capacities without rewriting header evidence", () => {
  expect(nesMapperStateSchema.safeParse({ mapper: 19 }).success).toBe(false);
  expect(
    nesMapperStateSchema.safeParse({ mapper: 19, variant: "namco175" }).success,
  ).toBe(false);
  const base = header();
  for (const altered of [
    { ...base, submapper: 6 },
    { ...base, mirroring: "four-screen" as const },
    { ...base, prgRamSize: 16384 },
    { ...base, submapper: 1 },
    { ...base, chrRom: { ...base.chrRom, size: 0 } },
  ])
    expect(resolveNesMapperLayout(altered).ok).toBe(false);
  const trace = deriveNesMapperTrace(
    base,
    nesNamco163StateSchema.parse({ mapper: 19, variant: "namco163" }),
    [
      { address: 0x47ff, value: 7, preceded_by_cpu_write: false },
      { address: 0x4fff, value: 0xab, preceded_by_cpu_write: false },
    ],
  );
  expect(trace).toMatchObject({
    status: "derived",
    steps: [{ effect: "outside-mapper" }, { effect: "audio-register" }],
    final: { audio_data_port: 0xab },
  });
});
