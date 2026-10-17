import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mapperTraceFixture } from "./nesMapperTrace.fixture.js";
import {
  traceNesMapperWritesInputSchema,
  nesLatchMapperStateSchema,
} from "./nesMapperTrace.js";
import {
  traceNesMapperEventsInputSchema,
  nesMapperEventsTraceSchema,
} from "./nesMapperEvents.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { latchAfterPpuRead } from "./nesLatchMapper.js";
import { nesCodeFixture } from "./nesCode.fixture.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";

const headerFor = (bytes: Buffer) => {
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const input = (mapper: 9 | 10, events: unknown[] = []) => {
  const request = traceNesMapperEventsInputSchema.parse({
    path: "/latches.nes",
    initial: {
      mapper,
      chr_fd_0: 1,
      chr_fe_0: 2,
      chr_fd_1: 3,
      chr_fe_1: 4,
      latch_0: "fd",
      latch_1: "fe",
    },
    events,
  });
  return {
    ...request,
    initial: nesLatchMapperStateSchema.parse(request.initial),
  };
};

describe("MMC2/MMC4 CPU register derivation", () => {
  it.each([9, 10] as const)(
    "decodes address aliases and data masks without inventing a power-on bank: %i",
    (mapper) => {
      const request = traceNesMapperWritesInputSchema.parse({
        path: "/a.nes",
        initial: { mapper },
        writes: [
          { address: 0x9fff, value: 3 },
          { address: 0xafff, value: 0xf2 },
          { address: 0xb123, value: 0xe1 },
          { address: 0xcfff, value: 0xe2 },
          { address: 0xd000, value: 0xe3 },
          { address: 0xefff, value: 0xe4 },
          { address: 0xffff, value: 0xff },
          { address: 0xafff, value: null },
        ],
      });
      const result = deriveNesMapperTrace(
        headerFor(mapperTraceFixture(mapper)),
        request.initial,
        request.writes,
      );
      if (result.status !== "derived") throw new Error(result.reason);

      expect(result.initial_mapping.prg_windows.map((w) => w.bank)).toEqual(
        mapper === 9 ? [null, 5, 6, 7] : [null, 3],
      );
      expect(result.steps.map((s) => s.effect)).toEqual([
        "outside-mapper",
        "prg-bank",
        "chr-bank",
        "chr-bank",
        "chr-bank",
        "chr-bank",
        "nametable",
        "prg-bank",
      ]);
      expect(result.final).toMatchObject({
        prg_bank: null,
        chr_fd_0: 1,
        chr_fe_0: 2,
        chr_fd_1: 3,
        chr_fe_1: 4,
        latch_0: null,
        latch_1: null,
        mirroring: 1,
      });
      expect(result.nes_prg_views).toEqual([{ mapper, prg_bank: 2 }]);
      expect(result.final_mapping.mirroring).toBe("horizontal");
      expect(
        result.final_mapping.chr_windows.map((w) => w.file_offset),
      ).toEqual([null, null]);
      expect(result.steps[1]?.write.value).toBe(0xf2);
    },
  );
  it.each([9, 10] as const)(
    "continues source fetching from the selected Mapper %i bank",
    async (mapper) => {
      const fixture = nesCodeFixture(
        mapper,
        [0xa9, 2, 0x8d, 0xff, 0xaf, 0x4c, 0, 0x80],
      );
      const bankOffset = fixture.prgOffset + 2 * (mapper === 9 ? 8192 : 16384);
      fixture.bytes.set([0xa9, 0x55, 0x60], bankOffset);
      const result = await deriveNesCode(
        headerFor(fixture.bytes),
        fixture.bytes.subarray(
          fixture.prgOffset,
          fixture.prgOffset + fixture.prgSize,
        ),
        traceNesCodeInputSchema.parse({
          path: "/code.nes",
          initial: { mapper },
        }),
      );
      if (result.status !== "derived") throw new Error(result.reason);

      expect(result.stop.reason).toBe("return");
      expect(result.final_cpu.a).toBe(0x55);
      expect(result.instructions.at(-1)).toMatchObject({
        address: 0x8000,
        file_offsets: [bankOffset, bankOffset + 1],
        prg_view: { mapper, prg_bank: 2 },
      });
    },
  );
});

describe("PPU latch read ordering and decode", () => {
  it.each([9, 10] as const)(
    "resolves the triggering read before changing Mapper %i latches",
    async (mapper) => {
      const request = input(mapper, [
        { kind: "ppu-read", address: 0x0fe8 },
        { kind: "ppu-read", address: 0 },
        { kind: "cpu-write", address: 0xc123, value: 0xff },
        { kind: "ppu-read", address: 0x20 },
        { kind: "ppu-read", address: 0x1fdf },
        { kind: "ppu-read", address: 0x1000 },
      ]);
      const header = headerFor(mapperTraceFixture(mapper));
      const result = nesMapperEventsTraceSchema.parse(
        await deriveNesMapperEvents(header, request.initial, request.events),
      );
      if (result.status !== "derived") throw new Error(result.reason);
      if ("mapper_snapshots" in result)
        throw new Error(
          "Unexpected PPU profile in this legacy mapper workflow",
        );
      expect(result.steps.map((s) => s.read_source?.bank ?? null)).toEqual([
        1,
        2,
        null,
        7,
        4,
        3,
      ]);
      expect(result.steps[0]).toMatchObject({
        read_source: { file_offset: header.chrRom.offset + 4096 + 0xfe8 },
        state: { latch_0: "fe", latch_1: "fe" },
      });
      expect(result.steps[1]?.read_source?.file_offset).toBe(
        header.chrRom.offset + 2 * 4096,
      );
      expect(result.steps[2]?.state).toMatchObject({ chr_fe_0: 31 });
      expect(result.steps[4]?.state).toMatchObject({
        latch_0: "fe",
        latch_1: "fd",
      });
      expect(request.initial.latch_0).toBe("fd");
      expect(result.coverage).toEqual({
        supplied_events: 6,
        processed_events: 6,
        unknown_pattern_reads: 0,
      });
    },
  );
  it.each([9, 10] as const)(
    "exhaustively decodes all 14-bit PPU addresses for Mapper %i",
    (mapper) => {
      const initial = input(mapper).initial;
      for (let address = 0; address < 16384; address++) {
        const result = latchAfterPpuRead(initial, address);
        const lowerFe =
          mapper === 9
            ? address === 0xfe8
            : address >= 0xfe8 && address <= 0xfef;
        const upperFd = address >= 0x1fd8 && address <= 0x1fdf;
        expect(result.latch_0).toBe(lowerFe ? "fe" : "fd");
        expect(result.latch_1).toBe(upperFd ? "fd" : "fe");
        const reversed = latchAfterPpuRead(
          { ...initial, latch_0: "fe", latch_1: "fd" },
          address,
        );
        const lowerFd =
          mapper === 9
            ? address === 0xfd8
            : address >= 0xfd8 && address <= 0xfdf;
        const upperFe = address >= 0x1fe8 && address <= 0x1fef;
        expect(reversed.latch_0).toBe(lowerFd ? "fd" : "fe");
        expect(reversed.latch_1).toBe(upperFe ? "fe" : "fd");
      }
    },
  );
  it("retains an unknown triggering source while learning its subsequent latch and honors cancellation", async () => {
    const request = traceNesMapperEventsInputSchema.parse({
      path: "/a.nes",
      initial: { mapper: 9, chr_fe_0: 2 },
      events: [
        { kind: "ppu-read", address: 0xfe8 },
        { kind: "ppu-read", address: 0 },
        { kind: "ppu-read", address: 0x2fe8 },
      ],
    });
    const header = headerFor(mapperTraceFixture(9));
    const result = await deriveNesMapperEvents(
      header,
      request.initial,
      request.events,
    );
    expect(result).toMatchObject({
      status: "derived",
      steps: [
        {
          read_source: { status: "unknown-chr-bank", file_offset: null },
          state: { latch_0: "fe" },
        },
        { read_source: { status: "chr-rom", bank: 2 } },
        {
          read_source: { status: "outside-pattern-tables", file_offset: null },
        },
      ],
      coverage: { unknown_pattern_reads: 1 },
    });
    const controller = new AbortController();
    const pending = deriveNesMapperEvents(
      header,
      request.initial,
      Array.from({ length: 100000 }, () => request.events[0]!),
      { signal: controller.signal },
    );
    setImmediate(() => controller.abort());
    await expect(pending).rejects.toThrow();
  });
});

it("preserves known CHR sources when unknown latch alternatives alias after ROM masking", async () => {
  const request = traceNesMapperEventsInputSchema.parse({
    path: "/a.nes",
    initial: { mapper: 9, chr_fd_0: 1, chr_fe_0: 9 },
    events: [{ kind: "ppu-read", address: 0 }],
  });
  const header = headerFor(mapperTraceFixture(9));
  const result = await deriveNesMapperEvents(
    header,
    request.initial,
    request.events,
  );
  expect(result).toMatchObject({
    status: "derived",
    steps: [
      {
        read_source: {
          status: "chr-rom",
          bank: 1,
          file_offset: header.chrRom.offset + 4096,
        },
        state: { latch_0: null, chr_fd_0: 1, chr_fe_0: 9 },
      },
    ],
    coverage: { unknown_pattern_reads: 0 },
  });
});
