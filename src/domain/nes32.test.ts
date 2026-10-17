import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";

const fixture = (submapper = 0) => {
  const bytes = Buffer.alloc(16 + 131072 + 262144);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 32, 0, 0x28, submapper << 4]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return { bytes, header: parsed.value };
};
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});

it.each([0, 1])(
  "resolves G-101 mode exchange and hardwired submapper %i",
  (submapper) => {
    const { header } = fixture(submapper);
    const trace = deriveNesMapperTrace(
      header,
      nesMapperStateSchema.parse({ mapper: 32 }),
      [
        write(0x8fff, 0xe2),
        write(0xafff, 0xf5),
        write(0x9fff, 3),
        ...[255, 1, 194, 63, 170, 21, 17, 0].map((bank, index) =>
          write(0xbff8 + index, bank),
        ),
        write(0xc000, 0),
        write(0xffff, 0),
      ],
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual(
      submapper === 0 ? [14, 5, 2, 15] : [2, 5, 14, 15],
    );
    expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
      255, 1, 194, 63, 170, 21, 17, 0,
    ]);
    expect(trace.final_mapping.mirroring).toBe(
      submapper === 0 ? "horizontal" : "one-screen-b",
    );
    expect(trace.steps.slice(-2).map((s) => s.effect)).toEqual([
      "outside-mapper",
      "outside-mapper",
    ]);
    expect(trace.nes_prg_views.at(-1)).toEqual({
      mapper: 32,
      prg_mode: submapper === 0 ? 1 : 0,
      prg_bank_0: 2,
      prg_bank_1: 21,
    });
  },
);

it("retains physical aliases under unknown G-101 mode without inventing a complete view", () => {
  const { header } = fixture();
  const trace = deriveNesMapperTrace(
    header,
    nesMapperStateSchema.parse({ mapper: 32 }),
    [
      { ...write(0x8000, null), known_bits: { mask: 15, value: 14 } },
      { ...write(0xa000, null), known_bits: { mask: 15, value: 3 } },
      { ...write(0x9000, null), known_bits: { mask: 1, value: 0 } },
    ],
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    14, 3, 14, 15,
  ]);
  expect(trace.final_mapping.mirroring).toBe("vertical");
  expect(trace.nes_prg_views).toEqual([]);
  expect(trace.final).toMatchObject({
    prg_banks: [
      { mask: 15, value: 14 },
      { mask: 15, value: 3 },
    ],
  });
});

it("keeps four G-101 windows in a selected context and rejects impossible board modes", () => {
  const { header } = fixture();
  const layout = resolveNesMapperLayout(header, [
    { mapper: 32, prg_mode: 1, prg_bank_0: 18, prg_bank_1: 21 },
  ]);
  if (!layout.ok) throw new Error(layout.error);
  expect(
    layout.value.mappings.map((w) => [w.start, w.bank, w.fileOffset]),
  ).toEqual([
    [0x8000, 14, 16 + 14 * 8192],
    [0xa000, 5, 16 + 5 * 8192],
    [0xc000, 2, 16 + 2 * 8192],
    [0xe000, 15, 16 + 15 * 8192],
  ]);
  expect(new Set(layout.value.mappings.map((w) => w.addressSpace)).size).toBe(
    1,
  );
  expect(
    resolveNesMapperLayout(fixture(1).header, [
      { mapper: 32, prg_mode: 1, prg_bank_0: 0, prg_bank_1: 0 },
    ]).ok,
  ).toBe(false);
  expect(resolveNesMapperLayout(fixture(2).header).ok).toBe(false);
});

it.each([0, 1])(
  "follows source code across G-101 mode writes for submapper %i",
  async (submapper) => {
    const { bytes, header } = fixture(submapper);
    bytes.set(
      [0xa9, 2, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 0, 0x90, 0x4c, 0, 0xc0],
      16 + 15 * 8192,
    );
    const bank = submapper === 0 ? 2 : 14;
    bytes.set([0xa9, 0x55, 0x60], 16 + bank * 8192);
    const trace = await deriveNesCode(
      header,
      bytes.subarray(16, 16 + 131072),
      traceNesCodeInputSchema.parse({
        path: "/g101.nes",
        initial: { mapper: 32 },
        entry: 0xe000,
      }),
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.final_cpu.a).toBe(0x55);
    expect(trace.instructions.at(-1)?.file_offsets).toEqual([
      16 + bank * 8192,
      17 + bank * 8192,
    ]);
  },
);

it.each([
  { declaration: 0, nes2: true, submapper: 0 },
  { declaration: 8, nes2: true, submapper: 0 },
  { declaration: 0x66, nes2: true, submapper: 0 },
  { declaration: 7, nes2: true, submapper: 1 },
  { declaration: 7, nes2: false, submapper: 0 },
])(
  "does not infer G-101 RAM for $declaration, NES2=$nes2, submapper=$submapper",
  async ({ declaration, nes2, submapper }) => {
    const { bytes } = fixture(submapper);
    bytes[10] = declaration;
    if (!nes2) bytes[7] = 0x20;
    bytes.set([0xa9, 0x55, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60], 16 + 15 * 8192);
    const parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const trace = await deriveNesCode(
      parsed.value,
      bytes.subarray(16, 16 + 131072),
      traceNesCodeInputSchema.parse({
        path: "/g101.nes",
        initial: { mapper: 32 },
        entry: 0xe000,
      }),
    );
    if (trace.status !== "derived") throw new Error(trace.reason);
    expect(trace.final_cpu.a).toBeNull();
  },
);

it("retains G-101 initial RAM provenance without filling unwritten bytes", async () => {
  const { bytes } = fixture();
  bytes[10] = 7;
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const routine = [0xad, 0, 0x70, 0x60];
  const trace = await deriveNesCode(
    parsed.value,
    bytes.subarray(16, 16 + 131072),
    traceNesCodeInputSchema.parse({
      path: "/g101.nes",
      initial: { mapper: 32 },
      entry: 0x6000,
      initial_prg_ram: routine.map((value, index) => ({
        bank: 0,
        address: 0x6000 + index,
        value,
      })),
    }),
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_cpu.a).toBeNull();
  expect(trace.instructions[0]).toMatchObject({
    bytes_hex: "ad0070",
    file_offsets: [null, null, null],
    ram_origins: [0, 1, 2].map((index) => ({
      region: "prg-ram",
      bank: 0,
      ram_address: 0x6000 + index,
      initial_prg_ram_index: index,
    })),
  });
});
