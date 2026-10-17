import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";

const fixture = (submapper = 0, banks = submapper === 1 ? 2 : 8) => {
  const bytes = Buffer.alloc(16 + banks * 16384 + 65536);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, banks, 8, 0xe0, 0xc8, submapper << 4]);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return { bytes, header: parsed.value };
};
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});

it("keeps Namco 108 PRG/CHR modes fixed and ignores MMC3-only control addresses", () => {
  const { header } = fixture();
  const input = nesMapperStateSchema.parse({ mapper: 206 });
  const trace = deriveNesMapperTrace(header, input, [
    write(0x8000, 0xc6),
    write(0x9fff, 0x22),
    write(0x9ffe, 0xff),
    write(0x8001, 0x33),
    write(0x8000, 0xc0),
    write(0x8001, 0xff),
    ...[0xa000, 0xa001, 0xc000, 0xc001, 0xe000, 0xe001].map((address) =>
      write(address, 0),
    ),
  ]);
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    2, 3, 14, 15,
  ]);
  expect(trace.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
    62,
    63,
    null,
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(trace.final_mapping.mirroring).toBe(header.mirroring);
  expect(
    trace.steps.slice(-6).every((step) => step.effect === "outside-mapper"),
  ).toBe(true);
  expect(trace.nes_prg_views).toEqual([{ mapper: 206, r6: 2, r7: 3 }]);
  expect(trace.final).not.toHaveProperty("irq_latch");
  expect(trace.final).not.toHaveProperty("ram_protect");
});

it("retains only possible indirect writes when the Namco selector is partial", () => {
  const { header } = fixture();
  const trace = deriveNesMapperTrace(
    header,
    nesMapperStateSchema.parse({
      mapper: 206,
      banks: [0, 1, 2, 3, 4, 5, 6, 7],
    }),
    [
      { ...write(0x8000, null), known_bits: { mask: 6, value: 6 } },
      write(0x8001, 6),
    ],
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.final).toMatchObject({
    banks: [0, 1, 2, 3, 4, 5, 6, { mask: 254, value: 6 }],
  });
  expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    6,
    null,
    14,
    15,
  ]);
});

it("maps independent selected contexts and rejects unsupported capacity or fixed-board selectors", () => {
  const { header } = fixture();
  const result = resolveNesMapperLayout(header, [
    { mapper: 206, r6: 2, r7: 3 },
  ]);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.mappings.map((w) => [w.start, w.fileOffset])).toEqual([
    [0x8000, 16 + 2 * 8192],
    [0xa000, 16 + 3 * 8192],
    [0xc000, 16 + 14 * 8192],
    [0xe000, 16 + 15 * 8192],
  ]);
  expect(new Set(result.value.mappings.map((w) => w.addressSpace)).size).toBe(
    1,
  );
  expect(resolveNesMapperLayout({ ...header, submapper: 2 }).ok).toBe(false);
  expect(resolveNesMapperLayout(fixture(1, 4).header).ok).toBe(false);
  const fixed = fixture(1).header;
  expect(
    resolveNesMapperLayout(fixed, [{ mapper: 206, r6: 0, r7: 1 }]).ok,
  ).toBe(false);
  const layout = resolveNesMapperLayout(fixed);
  if (!layout.ok) throw new Error(layout.error);
  expect(layout.value.mappings).toHaveLength(1);
  expect(layout.value.mappings[0]).toMatchObject({
    start: 0x8000,
    size: 32768,
    role: "fixed",
    fileOffset: 16,
  });
});

it.each([0, 1])(
  "derives banked or hardwired source fetches for Namco submapper %i",
  async (submapper) => {
    const { header, bytes } = fixture(submapper);
    const high = submapper === 1 ? 3 : 15;
    bytes.set(
      [0xa9, 0xc6, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 1, 0x80, 0x4c, 0, 0x80],
      16 + high * 8192,
    );
    const bank = submapper === 1 ? 0 : 2;
    bytes.set([0xa9, 0x55, 0x60], 16 + bank * 8192);
    const result = await deriveNesCode(
      header,
      bytes.subarray(16, 16 + header.prgRom.size),
      traceNesCodeInputSchema.parse({
        path: "/namco.nes",
        initial: { mapper: 206 },
        entry: 0xe000,
      }),
    );
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.final_cpu.a).toBe(0x55);
    expect(result.instructions.at(-1)?.file_offsets).toEqual([
      16 + bank * 8192,
      17 + bank * 8192,
    ]);
    const trace = result.mapper_trace;
    if (trace.status !== "derived") throw new Error(trace.reason);
    if (submapper === 1)
      expect(trace.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
        0, 1, 2, 3,
      ]);
  },
);
