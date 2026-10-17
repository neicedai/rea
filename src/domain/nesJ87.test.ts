import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import type { NesByteValue } from "./nesByteValue.js";
import { nesJ87StateSchema } from "./nesJ87.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import {
  mapperMapping,
  standardNesChrCandidates,
} from "./nesMapperTraceMapping.js";
import {
  nesMapperStateSchema,
  nesMapperTraceSchema,
  traceNesMapperWritesInputSchema,
} from "./nesMapperTrace.js";
import { nesPpuStateSchema } from "./nesPpuState.js";
import { initializeNesPpu } from "./nesPpuRegisters.js";
import { readNesPpuMemory } from "./nesPpuMemory.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { nesCodeTraceSchema, traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";

const fixture = (prgSize = 16384, chrSize = 32768) => {
  const bytes = Buffer.alloc(528 + prgSize + chrSize);
  bytes.set([78, 69, 83, 26, prgSize / 16384, chrSize / 8192, 0x74, 0x58]);
  for (let bank = 0; bank < chrSize / 8192; bank++)
    bytes.fill(
      0xa0 + bank,
      528 + prgSize + bank * 8192,
      528 + prgSize + (bank + 1) * 8192,
    );
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  return { bytes, header: header.value };
};

it("matches every partial raw latch proof against the swapped-bit CHR truth table at each capacity", () => {
  const truths = [0, 2, 1, 3],
    proofs: NesByteValue[] = [null];
  for (let mask = 1; mask < 256; mask++)
    for (let value = 0; value < 256; value++)
      if ((value & ~mask) === 0)
        proofs.push(mask === 255 ? value : { mask, value });
  for (const count of [1, 2, 4]) {
    const { header } = fixture(16384, count * 8192);
    for (const proof of proofs) {
      const values = Array.from({ length: 256 }, (_, byte) => byte).filter(
          (byte) =>
            proof === null ||
            (typeof proof === "number"
              ? byte === proof
              : (byte & proof.mask) === proof.value),
        ),
        banks = [
          ...new Set(values.map((byte) => truths[byte % 4]! & (count - 1))),
        ].sort((a, b) => a - b),
        state = nesJ87StateSchema.parse({ mapper: 87, chr_bank: proof }),
        mapping = mapperMapping(header, state),
        bank = banks.length === 1 ? banks[0]! : null;
      expect(mapping.chr_windows).toEqual([
        {
          start: 0,
          size: 8192,
          bank,
          file_offset:
            bank === null ? null : header.chrRom.offset + bank * 8192,
        },
      ]);
      expect(standardNesChrCandidates(state, 0, count)).toEqual(banks);
      expect(mapping.prg_view).toBeNull();
    }
  }
});

it("retains lower-port raw writes without ROM conflicts and preserves common CHR source bytes", () => {
  const { bytes, header } = fixture(),
    input = traceNesMapperWritesInputSchema.parse({
      path: "/j87.nes",
      initial: { mapper: 87 },
      writes: [
        { address: 0x6000, value: 0xf1 },
        { address: 0x7fff, value: null, known_bits: { mask: 1, value: 0 } },
        { address: 0x5fff, value: 3 },
        { address: 0x8000, value: 3 },
      ],
    }),
    trace = nesMapperTraceSchema.parse(
      deriveNesMapperTrace(
        header,
        input.initial,
        input.writes,
        bytes.subarray(528, 528 + 16384),
      ),
    );
  if (trace.status !== "derived") throw new Error(trace.reason);
  expect(trace.steps.map((step) => step.effect)).toEqual([
    "chr-bank",
    "chr-bank",
    "outside-mapper",
    "outside-mapper",
  ]);
  expect(trace.steps[0]!.state).toEqual({ mapper: 87, chr_bank: 0xf1 });
  expect(trace.steps[0]!.mapping.chr_windows[0]!.bank).toBe(2);
  expect(trace.final).toEqual({ mapper: 87, chr_bank: { mask: 1, value: 0 } });
  expect(trace.initial_mapping.prg_windows).toEqual([
    { start: 0x8000, size: 16384, bank: 0, file_offset: 528 },
    { start: 0xc000, size: 16384, bank: 0, file_offset: 528 },
  ]);
  const ppu = initializeNesPpu(
      nesPpuStateSchema.parse({ model: "ppu-memory" }),
    ),
    read = readNesPpuMemory(
      header,
      trace.final,
      ppu,
      8191,
      bytes.subarray(header.chrRom.offset),
    );
  expect(read.value).toEqual({ mask: 254, value: 160 });
  expect(read.sources).toEqual(
    [0, 1].map((bank) => ({
      kind: "rom",
      file_offset: header.chrRom.offset + bank * 8192 + 8191,
      value: 0xa0 + bank,
      mask: 255,
    })),
  );
  expect(input.initial).toEqual({ mapper: 87, chr_bank: null });
  expect(
    nesMapperStateSchema.safeParse({ mapper: 87, chr_bank: null, prg_bank: 0 })
      .success,
  ).toBe(false);
});

it("replays source lower-port switching and CPU 2007 buffer reads without treating the latch as RAM", async () => {
  const { bytes, header } = fixture();
  bytes.set(
    [
      0xa9, 1, 0x8d, 0xff, 0x7f, 0xa9, 0, 0x8d, 6, 0x20, 0x8d, 6, 0x20, 0xad, 7,
      0x20, 0xad, 7, 0x20, 2,
    ],
    528,
  );
  const prg = bytes.subarray(header.prgRom.offset, header.chrRom.offset),
    chr = bytes.subarray(header.chrRom.offset),
    input = traceNesCodeInputSchema.parse({
      path: "/j87-source.nes",
      entry: 0x8000,
      initial: { mapper: 87 },
      initial_ppu: {
        model: "ppu-memory",
        register_writes_enabled: true,
        access_phase: "non-rendering",
        dma_reads: "absent",
        control: 0,
        mask: 0,
        write_toggle: 0,
      },
      max_instructions: 20,
    }),
    source = nesCodeTraceSchema.parse(
      await deriveNesCode(header, prg, input, { chr }),
    );
  if (source.status !== "derived") throw new Error(source.reason);
  expect(source.instructions).toHaveLength(7);
  expect(source.final_cpu.a).toBe(0xa2);
  if (
    source.mapper_trace.status !== "derived" ||
    !("mapper_snapshots" in source.mapper_trace)
  )
    throw new Error("Expected source device event trace");
  expect(source.mapper_trace.final).toEqual({ mapper: 87, chr_bank: 1 });
  expect(source.mapper_trace.steps[0]!.event).toMatchObject({
    kind: "cpu-write",
    address: 0x7fff,
    value: 1,
  });
  const replay = await deriveNesMapperEvents(
    header,
    input.initial,
    source.mapper_trace.steps.map((step) => step.event),
    { prg, chr, initialPpu: input.initial_ppu },
  );
  expect(replay).toEqual(source.mapper_trace);
});
