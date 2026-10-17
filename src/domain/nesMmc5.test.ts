import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mmc5Fixture } from "./nesMmc5.fixture.js";
import {
  nesMmc5StateSchema,
  mmc5CpuCandidates,
  mmc5RamPermission,
  mmc5Mapping,
} from "./nesMmc5.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { readMmc5MixedWindow } from "./nesMmc5MemoryRead.js";

const header = (shift = 9, banks = 8) => {
  const parsed = parseNesHeader(mmc5Fixture(shift, banks).bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};

it("agrees with the PRG mux table for every raw byte in all four modes", () => {
  const h = header();
  const registers = [
    [4, 4, 4, 4],
    [2, 2, 4, 4],
    [2, 2, 3, 4],
    [1, 2, 3, 4],
  ];
  const state = nesMmc5StateSchema.parse({ mapper: 5, ram_wiring: "ewrom" });
  for (let mode = 0; mode < 4; mode++)
    for (let raw = 0; raw < 256; raw++) {
      state.prg_mode = mode;
      state.prg_banks.fill(raw);
      for (let window = 0; window < 4; window++) {
        const reg = registers[mode]![window]!;
        const width =
          mode === 0 ? 4 : mode === 1 || (mode === 2 && window < 2) ? 2 : 1;
        const bank = Math.floor((raw & 127) / width) * width + (window % width);
        const expected =
          reg === 4 || raw >= 128
            ? { source: "rom", bank: bank % 8 }
            : (bank & 4) !== 0
              ? { source: "unmapped" }
              : { source: "ram", bank: bank % 4 };
        expect(
          mmc5CpuCandidates(h, state, 0x8000 + window * 8192),
          `${mode}/${raw}/${window}`,
        ).toEqual([expected]);
      }
      expect(mmc5CpuCandidates(h, state, 0x6000)).toEqual(
        (raw & 4) !== 0
          ? [{ source: "unmapped" }]
          : [{ source: "ram", bank: raw & 3 }],
      );
    }
});

it("retains explicit chip aliases, missing sockets and unknown wiring", () => {
  for (const [wiring, shift, expected] of [
    ["ekrom", 7, [0, 0, 0, 0, null, null, null, null]],
    ["etrom", 8, [0, 0, 0, 0, 1, 1, 1, 1]],
    ["ewrom", 9, [0, 1, 2, 3, null, null, null, null]],
    ["linear-64k", 10, [0, 1, 2, 3, 4, 5, 6, 7]],
  ] as const) {
    const state = nesMmc5StateSchema.parse({ mapper: 5, ram_wiring: wiring });
    for (let selector = 0; selector < 16; selector++) {
      state.prg_banks[0] = selector;
      const bank = expected[selector % 8];
      expect(mmc5CpuCandidates(header(shift), state, 0x6000)).toEqual(
        bank === null ? [{ source: "unmapped" }] : [{ source: "ram", bank }],
      );
    }
  }
  expect(
    mmc5CpuCandidates(
      header(),
      nesMmc5StateSchema.parse({ mapper: 5 }),
      0x6000,
    ),
  ).toEqual([{ source: "unknown" }]);
});

it("uses partial protection bits to prove both denied and permitted stores", () => {
  const state = nesMmc5StateSchema.parse({ mapper: 5 });
  for (const [protect, expected] of [
    [[{ mask: 1, value: 1 }, null], false],
    [[null, { mask: 2, value: 2 }], false],
    [
      [
        { mask: 3, value: 2 },
        { mask: 3, value: 1 },
      ],
      true,
    ],
    [
      [
        { mask: 2, value: 2 },
        { mask: 1, value: 1 },
      ],
      null,
    ],
  ] as const) {
    state.ram_protect = [...protect];
    expect(mmc5RamPermission(state)).toBe(expected);
  }
});

it("resolves ignored pair bits and an all-mode common ROM source without inventing selectors", () => {
  const state = nesMmc5StateSchema.parse({
    mapper: 5,
    prg_mode: 1,
    prg_banks: [
      null,
      null,
      { mask: 254, value: 130 },
      null,
      { mask: 126, value: 6 },
    ],
  });
  expect(mmc5Mapping(header(), state).prg_windows.map((w) => w.bank)).toEqual([
    2, 3, 6, 7,
  ]);
  state.prg_mode = null;
  state.prg_banks = [0, 128, 129, 130, 3];
  expect(mmc5Mapping(header(), state).prg_windows.map((w) => w.bank)).toEqual([
    0, 1, 2, 3,
  ]);
});

it("preserves captured CHR upper writes while missing write-time mode leaves windows unresolved", () => {
  const initial = nesMapperStateSchema.parse({ mapper: 5 });
  const result = deriveNesMapperTrace(header(), initial, [
    { address: 0x5130, value: 1, preceded_by_cpu_write: null },
    { address: 0x5120, value: 4, preceded_by_cpu_write: null },
    { address: 0x5130, value: 2, preceded_by_cpu_write: null },
    { address: 0x5128, value: 5, preceded_by_cpu_write: null },
    { address: 0x5108, value: 7, preceded_by_cpu_write: null },
  ]);
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.final).toMatchObject({
    chr_upper: 2,
    last_chr_set: "background",
    chr_bank_upper: [
      1,
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      2,
      null,
      null,
      null,
    ],
  });
  expect(result.steps.at(-1)!.effect).toBe("outside-mapper");
  expect(result.final_mapping.chr_windows).toHaveLength(8);
  expect(result.final_mapping.chr_windows.every((w) => w.bank === null)).toBe(
    true,
  );
});

it("imports only ROM windows and rejects mismatched explicit RAM declarations", () => {
  const layout = resolveNesMapperLayout(header(), [
    {
      mapper: 5,
      prg_mode: 3,
      bank_8000: 0,
      bank_a000: 129,
      bank_c000: 2,
      bank_e000: 7,
    },
  ]);
  if (!layout.ok) throw new Error(layout.error);
  expect(layout.value.mappings.map((w) => [w.start, w.bank])).toEqual([
    [0xa000, 1],
    [0xe000, 7],
  ]);
  const result = deriveNesMapperTrace(
    header(),
    nesMapperStateSchema.parse({ mapper: 5, ram_wiring: "ekrom" }),
    [],
  );
  expect(result).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("capacity"),
  });
});

it.each([1, 128])(
  "admits %i physical PRG banks using only connected ROM address lines",
  (count) => {
    const layout = resolveNesMapperLayout(header(9, count));
    if (!layout.ok) throw new Error(layout.error);
    expect(layout.value.mappings.map((w) => w.bank)).toEqual(
      count === 1 ? [0, 0, 0, 0] : [0, 1, 2, 127],
    );
  },
);

it("accounts for all 144 ROM/RAM candidates and removes proofs for missing bytes or sockets", () => {
  const h = header(11, 128);
  const state = nesMmc5StateSchema.parse({
    mapper: 5,
    prg_mode: 3,
    ram_wiring: "linear-128k",
  });
  const prg = new Uint8Array(h.prgRom.size).fill(0xa9);
  const read = (bank: number) => ({
    value: 0xa9,
    source: { kind: "initial-prg-ram" as const, index: bank },
  });
  const proof = readMmc5MixedWindow(h, prg, state, 0x8100, read);
  expect(proof?.value).toBe(0xa9);
  expect(proof?.mapper_origins[0]!.source_candidates).toHaveLength(144);
  expect(
    readMmc5MixedWindow(h, prg, state, 0x8100, (bank) =>
      bank === 15 ? undefined : read(bank),
    ),
  ).toBeNull();
  state.ram_wiring = "ewrom";
  expect(readMmc5MixedWindow(h, prg, state, 0x8100, read)).toBeNull();
});
