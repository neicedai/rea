import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { bandaiCases, bandaiFixture } from "./nesBandai.fixture.js";
import {
  nesMapperStateSchema,
  nesMapperWriteSchema,
} from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { resolveNesMapperLayout } from "./nesMapper.js";

it.each(bandaiCases)(
  "traces $mapper/$variant physical ports and immutable bank sources",
  async (board) => {
    for (const version of ["nes2", "ines", "nes2-zero"] as const) {
      const { bytes, initial, writes, chr } = bandaiFixture(board, version);
      const parsed = parseNesHeader(bytes);
      if (!parsed.ok) throw new Error(parsed.error);
      const input = traceNesCodeInputSchema.parse({
        path: "/bandai.nes",
        initial,
      });
      const trace = await deriveNesCode(
        parsed.value,
        bytes.subarray(528, 528 + 65536),
        input,
      );
      if (trace.status !== "derived" || trace.mapper_trace.status !== "derived")
        throw new Error(JSON.stringify(trace));
      expect(trace.stop.reason).toBe("return");
      expect(trace.final_cpu.a).toBe(0x77);
      expect(
        trace.instructions.find((i) => i.address === 0xbfff),
      ).toMatchObject({
        bytes_hex: "a95a",
        file_offsets: [528 + 2 * 16384 - 1, 528 + 3 * 16384],
      });
      expect(
        trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
      ).toEqual([1, 3]);
      expect(
        trace.mapper_trace.final_mapping.chr_windows.map((w) => w.bank),
      ).toEqual(chr);
      expect(trace.mapper_trace.final_mapping.mirroring).toBe("one-screen-b");
      expect(trace.mapper_trace.final).toMatchObject({
        prg_bank: 0xf1,
        irq_low: 0,
        irq_high: 1,
        irq_control: 1,
        eeprom_control: board.variant === "fcg" ? null : 0x60,
      });
      const replay = deriveNesMapperTrace(
        parsed.value,
        input.initial,
        writes.map((w) => nesMapperWriteSchema.parse(w)),
      );
      if (replay.status !== "derived") throw new Error(replay.reason);
      expect(replay.steps[0]?.effect).toBe("outside-mapper");
      expect(replay.steps[0]?.state).toMatchObject({ prg_bank: null });
      expect(replay.final_mapping).toEqual(trace.mapper_trace.final_mapping);
      const layout = resolveNesMapperLayout(
        parsed.value,
        trace.mapper_trace.nes_prg_views,
      );
      if (!layout.ok) throw new Error(layout.error);
      expect(layout.value.mappings.map((w) => w.bank)).toEqual([1, 3]);
      expect(parsed.value.header).toEqual([...bytes.subarray(0, 16)]);
    }
  },
);

it("requires matching immutable chip assumptions without rewriting ambiguous headers", () => {
  const { bytes } = bandaiFixture(bandaiCases[0], "ines");
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(resolveNesMapperLayout(parsed.value).ok).toBe(false);
  expect(
    resolveNesMapperLayout(parsed.value, [
      { mapper: 16, variant: "fcg", prg_bank: 1 },
      { mapper: 16, variant: "lz93d50", prg_bank: 1 },
    ]).ok,
  ).toBe(false);
  const explicit = parseNesHeader(bandaiFixture(bandaiCases[0]).bytes);
  if (!explicit.ok) throw new Error(explicit.error);
  expect(
    deriveNesMapperTrace(
      explicit.value,
      nesMapperStateSchema.parse({ mapper: 16, variant: "lz93d50" }),
      [],
    ).status,
  ).toBe("unsupported");
  expect(nesMapperStateSchema.safeParse({ mapper: 16 }).success).toBe(false);
});

it("retains connected-bit proofs and fixed windows independently of ignored bits", () => {
  const parsed = parseNesHeader(bandaiFixture(bandaiCases[0]).bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const initial = nesMapperStateSchema.parse({
    mapper: 16,
    variant: "fcg",
    prg_bank: { mask: 1, value: 1 },
  });
  const unresolved = deriveNesMapperTrace(parsed.value, initial, []);
  if (unresolved.status !== "derived") throw new Error(unresolved.reason);
  expect(unresolved.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
    null,
    3,
  ]);
  const resolved = deriveNesMapperTrace(parsed.value, initial, [
    nesMapperWriteSchema.parse({
      address: 0x6008,
      value: null,
      known_bits: { mask: 3, value: 1 },
    }),
  ]);
  if (resolved.status !== "derived") throw new Error(resolved.reason);
  expect(resolved.final_mapping.prg_windows.map((w) => w.bank)).toEqual([1, 3]);
  expect(resolved.final_mapping.prg_view).toBeNull();
});

it("admits connected ROM capacity edges and rejects unmodeled storage or nametable wiring", () => {
  for (const board of bandaiCases) {
    const { bytes, initial } = bandaiFixture(board);
    const metadata = (
      prg: number,
      chr: number,
      flags = bytes[6]!,
      storage = bytes[10]!,
    ) => {
      const header = Buffer.from(bytes.subarray(0, 16));
      header[4] = prg;
      header[5] = chr;
      header[6] = flags;
      header[10] = storage;
      const parsed = parseNesHeader(header, 528 + prg * 16384 + chr * 8192);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    };
    const selected =
      board.mapper === 16
        ? [{ mapper: 16 as const, variant: board.variant, prg_bank: 15 }]
        : [{ mapper: 159 as const, prg_bank: 15 }];
    for (const [prg, chr, banks] of [
      [1, 1, [0, 0]],
      [16, 32, [15, 15]],
    ] as const) {
      const result = resolveNesMapperLayout(metadata(prg, chr), selected);
      if (!result.ok) throw new Error(result.error);
      expect(result.value.mappings.map((w) => w.bank)).toEqual(banks);
    }
    for (const [prg, chr] of [
      [32, 32],
      [16, 64],
      [4, 0],
      [3, 1],
    ])
      expect(resolveNesMapperLayout(metadata(prg!, chr!), selected).ok).toBe(
        false,
      );
    for (const storage of [7, 0x70, 0x11])
      expect(
        resolveNesMapperLayout(metadata(4, 32, bytes[6]!, storage), selected)
          .ok,
      ).toBe(false);
    for (const version of ["nes2", "ines", "nes2-zero"] as const) {
      const fixture = bandaiFixture(board, version);
      fixture.bytes[6]! |= 8;
      const parsed = parseNesHeader(fixture.bytes);
      if (!parsed.ok) throw new Error(parsed.error);
      expect(
        deriveNesMapperTrace(
          parsed.value,
          nesMapperStateSchema.parse(initial),
          [],
        ).status,
      ).toBe("unsupported");
    }
  }
});

it.each(bandaiCases)(
  "does not project $mapper EEPROM NVRAM as CPU-addressable RAM",
  async (board) => {
    const parsed = parseNesHeader(bandaiFixture(board).bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const input = traceNesCodeInputSchema.parse({
      path: "/bandai.nes",
      initial:
        board.mapper === 16
          ? { mapper: 16, variant: board.variant }
          : { mapper: 159 },
      entry: 0x6000,
      initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x60 }],
    });
    expect(
      (await deriveNesCode(parsed.value, new Uint8Array(65536), input)).status,
    ).toBe("unsupported");
  },
);
