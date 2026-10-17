import { expect, it } from "vitest";
import { nesApuStateSchema } from "./nesApu.js";
import {
  clockNesDmcOutput,
  clockNesDmcTimer,
  nesDmcStateSchema,
} from "./nesDmc.js";
import { advanceNesApu, admitNesApu } from "./nesApuDerivation.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { nesMapperEventsTraceSchema } from "./nesMapperEvents.js";
import { parseNesHeader } from "./nes.js";
import { nesPpuFixture } from "./nesPpu.fixture.js";

const origin = { kind: "initial-state" as const };
const initial = () =>
  nesApuStateSchema.parse({
    model: "apu-registers",
    frame_clocks: "explicit",
    dmc_reads: "explicit",
    registers: Object.fromEntries(
      [
        [0x4010, 128],
        [0x4012, 2],
        [0x4013, 1],
        [0x4015, 16],
      ].map(([address, value]) => [address, { value, origin }]),
    ),
    dmc_remaining: { value: { min: 2, max: 2 }, origin },
    dmc_irq: { value: false, origin },
    frame_irq: { value: false, origin },
    dmc: {
      model: "dmc-reader-output",
      region: "ntsc",
      clocks: "explicit",
      current_address: 65535,
      buffer: { status: "empty" },
      shift: 0,
      bits_remaining: 1,
      silence: true,
      level: 64,
      timer_remaining: 1,
    },
  });
const fixture = () => {
  const rom = nesPpuFixture([0x2c]);
  rom.bytes[rom.chrOffset - 1] = 0x81;
  rom.bytes[rom.prgOffset] = 0x2c;
  const header = parseNesHeader(rom.bytes);
  if (!header.ok) throw new Error(header.error);
  return {
    header: header.value,
    prg: rom.bytes.subarray(rom.prgOffset, rom.chrOffset),
    rom,
  };
};

it("matches every DAC level, saturation direction, silence and output-cycle boundary", () => {
  for (let level = 0; level < 128; level++)
    for (const bit of [0, 1])
      for (const silence of [false, true])
        for (const remaining of [1, 2, 8]) {
          const dmc = nesDmcStateSchema.parse({
            model: "dmc-reader-output",
            region: "ntsc",
            clocks: "explicit",
            level,
            shift: 0x80 | bit,
            silence,
            bits_remaining: remaining,
            buffer: { status: "full", value: 0x96, origin },
          });
          clockNesDmcOutput(dmc, 7);
          const expected = silence
            ? level
            : bit === 1
              ? level < 126
                ? level + 2
                : level
              : level > 1
                ? level - 2
                : level;
          expect(dmc.level).toBe(expected);
          expect(dmc.bits_remaining).toBe(remaining === 1 ? 8 : remaining - 1);
          expect(dmc.shift).toBe(remaining === 1 ? 0x96 : (0x80 | bit) >> 1);
          expect(dmc.buffer.status).toBe(remaining === 1 ? "empty" : "full");
          expect(dmc.silence).toBe(remaining === 1 ? false : silence);
        }
});

it("preserves common level parity and loaded-byte origins under unknown output bits", () => {
  const dmc = initial().dmc!;
  dmc.silence = false;
  dmc.bits_remaining = 8;
  dmc.shift = null;
  clockNesDmcOutput(dmc, 1);
  expect(dmc.level).toEqual({ mask: 3, value: 2 });
  dmc.bits_remaining = 1;
  dmc.buffer = {
    status: "full",
    value: { mask: 3, value: 2 },
    origin: { kind: "dmc-read", index: 5 },
  };
  clockNesDmcOutput(dmc, 6);
  expect(dmc.shift).toEqual({ mask: 3, value: 2 });
  expect(dmc.shift_origin).toEqual({ kind: "dmc-read", index: 5 });
  const unknownPhase = initial();
  Object.assign(unknownPhase.dmc!, {
    silence: false,
    shift: null,
    bits_remaining: 8,
    timer_remaining: null,
  });
  clockNesDmcTimer(unknownPhase);
  expect(unknownPhase.dmc!.level).toEqual({ mask: 1, value: 0 });
});

it("uses every independent NTSC/PAL divider period and does not reset a running timer on rate writes", () => {
  const periods = {
    ntsc: [
      428, 380, 340, 320, 286, 254, 226, 214, 190, 160, 142, 128, 106, 84, 72,
      54,
    ],
    pal: [
      398, 354, 316, 298, 276, 236, 210, 198, 176, 148, 132, 118, 98, 78, 66,
      50,
    ],
  };
  for (const region of ["ntsc", "pal"] as const)
    for (const [rate, period] of periods[region].entries()) {
      const state = initial();
      state.registers[0x4010] = { value: rate, origin };
      const dmc = state.dmc!;
      Object.assign(dmc, {
        region,
        level: 64,
        shift: 255,
        silence: false,
        bits_remaining: 8,
        timer_remaining: 1,
      });
      clockNesDmcTimer(state);
      expect(dmc.level).toBe(66);
      expect(dmc.timer_remaining).toBe(period);
      for (let edge = 1; edge < period; edge++) clockNesDmcTimer(state);
      expect(dmc.level).toBe(66);
      clockNesDmcTimer(state);
      expect(dmc.level).toBe(68);
      const before = dmc.timer_remaining;
      const written = advanceNesApu(state, {
        kind: "cpu-write",
        address: 0x4010,
        value: 15,
        preceded_by_cpu_write: null,
      });
      if (!written.ok) throw new Error(written.error.reason);
      expect(dmc.timer_remaining).toBe(before);
    }
});

it("reads mapped sample bytes, wraps FFFF to 8000, ends the reader before the output and retains read origins", async () => {
  const { header, prg } = fixture();
  const events = [
    { kind: "apu-dmc-read" },
    { kind: "apu-dmc-clock" },
    { kind: "apu-dmc-read" },
    ...Array.from({ length: 8 }, () => ({ kind: "apu-dmc-clock" as const })),
    { kind: "cpu-read", address: 0x4015 },
  ] as const;
  const trace = nesMapperEventsTraceSchema.parse(
    await deriveNesMapperEvents(
      header,
      { mapper: 0, prg_ram_write_enabled: null },
      events,
      {
        prg,
        initialApu: initial(),
      },
    ),
  );
  if (
    trace.status !== "derived" ||
    !("apu_trace" in trace) ||
    trace.apu_trace === null
  )
    throw new Error(JSON.stringify(trace));
  expect(
    "dmc_read" in trace.steps[0]! ? trace.steps[0]!.dmc_read : null,
  ).toMatchObject({
    address: 65535,
    value: 129,
    file_offset: header.prgRom.offset + header.prgRom.size - 1,
  });
  expect(
    "dmc_read" in trace.steps[2]! ? trace.steps[2]!.dmc_read : null,
  ).toMatchObject({
    address: 32768,
    value: 44,
    file_offset: header.prgRom.offset,
  });
  expect(trace.apu_trace.final.dmc_remaining.value).toEqual({ min: 0, max: 0 });
  expect(trace.apu_trace.final.dmc_irq.value).toBe(true);
  expect(trace.apu_trace.final.dmc).toMatchObject({
    level: 56,
    shift: 44,
    shift_origin: { kind: "dmc-read", index: 2 },
    buffer: { status: "empty" },
    silence: false,
  });
  expect(trace.apu_trace.dmc_read_ready).toBe(false);
});

it("rejects contradictory DMA grants and mixed output clocks without mutating the admitted state", () => {
  const state = initial();
  const before = structuredClone(state);
  const missing = advanceNesApu(state, { kind: "apu-dmc-read" });
  expect(missing).toMatchObject({ ok: false });
  expect(state).toEqual(before);
  state.dmc!.clocks = "cpu-ordered";
  expect(admitNesApu(state)).toMatchObject({ ok: false });
  expect(advanceNesApu(state, { kind: "apu-dmc-clock" })).toMatchObject({
    ok: false,
  });
});
