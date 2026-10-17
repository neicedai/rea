import { nesKnownBitsSchema } from "./nesByteValue.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { mapperTraceFixture } from "./nesMapperTrace.fixture.js";
import {
  deriveNesMapperTrace,
  deriveNesMapperTraceWithCancellation,
} from "./nesMapperTraceDerivation.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import {
  traceNesMapperWritesInputSchema,
  nesMapperTraceSchema,
} from "./nesMapperTrace.js";

const trace = (initial: unknown, writes: unknown[], chrRam = false) => {
  const input = traceNesMapperWritesInputSchema.parse({
    path: "/game.nes",
    initial,
    writes,
  });
  const header = parseNesHeader(
    mapperTraceFixture(input.initial.mapper, chrRam),
  );
  if (!header.ok) throw new Error(header.error);
  const result = nesMapperTraceSchema.parse(
    deriveNesMapperTrace(header.value, input.initial, input.writes),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  return result;
};

const serial = (address: number, value: number) =>
  Array.from({ length: 5 }, (_, bit) => ({
    address,
    value: (value >> bit) & 1,
    preceded_by_cpu_write: false,
  }));

it("honors a pre-cancelled empty mapper replay", async () => {
  const input = traceNesMapperWritesInputSchema.parse({
    path: "/game.nes",
    initial: { mapper: 4 },
    writes: [],
  });
  const header = parseNesHeader(mapperTraceFixture(4));
  if (!header.ok) throw new Error(header.error);
  const reason = new Error("Replay cancelled");
  await expect(
    deriveNesMapperTraceWithCancellation(
      header.value,
      input.initial,
      input.writes,
      undefined,
      { signal: AbortSignal.abort(reason) },
    ),
  ).rejects.toBe(reason);
});

describe("MMC1 write-state derivation", () => {
  it("uses only the fifth address, LSB first, and keeps full source window offsets", () => {
    const writes = serial(0xe000, 18);
    for (let i = 0; i < 4; i++)
      writes[i]!.address = [0x8765, 0xa002, 0xcfff, 0xface][i]!;
    const result = trace({ mapper: 1 }, [
      { address: 0x8000, value: 128 },
      ...writes,
    ]);
    expect(result.steps.map((step) => step.effect)).toEqual([
      "serial-reset",
      "serial-shift",
      "serial-shift",
      "serial-shift",
      "serial-shift",
      "register-commit",
    ]);
    expect(result.final).toMatchObject({
      prg_mode: 3,
      prg_bank: 2,
      prg_ram_disable_bit: 1,
      chr_mode: null,
      shift_bits: [],
    });
    expect(result.final_mapping.prg_windows).toEqual([
      { start: 32768, size: 16384, bank: 2, file_offset: 33296 },
      { start: 49152, size: 16384, bank: 3, file_offset: 49680 },
    ]);
    expect(
      result.steps.map((step) =>
        step.mapping.prg_windows.map((window) => window.bank),
      ),
    ).toEqual([
      [null, 3],
      [null, 3],
      [null, 3],
      [null, 3],
      [null, 3],
      [2, 3],
    ]);
    expect(result.nes_prg_views).toEqual([
      { mapper: 1, prg_mode: 3, prg_bank: 2 },
    ]);
  });

  it("filters consecutive data writes but never suppresses a reset and recovers unknown alignment", () => {
    const result = trace(
      { mapper: 1, prg_bank: 3, prg_mode: 2, chr_mode: 1, mirroring: 2 },
      [
        { address: 0xe000, value: 0, preceded_by_cpu_write: false },
        { address: 0xe000, value: 128, preceded_by_cpu_write: true },
        { address: 0xe000, value: 1, preceded_by_cpu_write: true },
        ...serial(0xe000, 1),
      ],
    );
    expect(result.steps[1]?.state).toMatchObject({
      prg_mode: 3,
      chr_mode: 1,
      mirroring: 2,
      shift_bits: [],
    });
    expect(result.steps[2]?.effect).toBe("ignored-consecutive-write");
    expect(result.final).toMatchObject({ prg_bank: 1, shift_bits: [] });
  });

  it("does not guess timing, values or power-on selectors", () => {
    const result = trace(
      { mapper: 1, shift_bits: [], prg_bank: 2, prg_mode: 3, chr_bank_1: 4 },
      [
        { address: 0xe000, value: 1 },
        { address: 0xe000, value: 0, preceded_by_cpu_write: false },
        { address: 0xa000, value: null, preceded_by_cpu_write: true },
      ],
    );
    expect(result.steps[0]?.state).toMatchObject({
      shift_bits: null,
      prg_bank: 2,
    });
    expect(result.final).toMatchObject({
      prg_mode: 3,
      prg_bank: null,
      chr_bank_1: 4,
    });
    expect(result.final_mapping.prg_windows[1]).toMatchObject({
      bank: 3,
      file_offset: 49680,
    });
    expect(result.final_mapping.prg_view).toBeNull();
    expect(trace({ mapper: 1 }, []).initial_mapping.prg_view).toBeNull();
  });

  it("commits an unknown serial bit without inventing its value", () => {
    const result = trace(
      { mapper: 1, shift_bits: [1, null, 0, 0], prg_mode: 3 },
      [{ address: 0xe000, value: 0, preceded_by_cpu_write: false }],
    );
    expect(result.final).toMatchObject({
      shift_bits: [],
      prg_bank: { mask: 13, value: 1 },
    });
    expect(result.steps[0]?.effect).toBe("register-commit");
  });

  it("derives 4 KiB and 8 KiB CHR maps and control mirroring", () => {
    const initial = {
      mapper: 1,
      shift_bits: [],
      chr_bank_0: 3,
      chr_bank_1: 6,
      prg_bank: 3,
    };
    const eight = trace(initial, serial(0x8000, 2));
    expect(
      eight.final_mapping.chr_windows.map((window) => window.bank),
    ).toEqual([2, 3]);
    expect(
      eight.final_mapping.prg_windows.map((window) => window.bank),
    ).toEqual([2, 3]);
    expect(eight.final_mapping.mirroring).toBe("vertical");
    const four = trace(initial, serial(0x8000, 31));
    expect(four.final_mapping.chr_windows).toEqual([
      { start: 0, size: 4096, bank: 3, file_offset: 78352 },
      { start: 4096, size: 4096, bank: 6, file_offset: 90640 },
    ]);
    expect(four.final_mapping.mirroring).toBe("horizontal");
  });
});

describe("MMC3 write-state derivation", () => {
  it("honors hardwired four-screen mapping and rejects ambiguous mixed CHR sources", () => {
    const bytes = mapperTraceFixture(4);
    bytes[6] = (bytes[6] ?? 0) | 8;
    const header = parseNesHeader(bytes);
    if (!header.ok) throw new Error(header.error);
    const input = traceNesMapperWritesInputSchema.parse({
      path: "/game.nes",
      initial: { mapper: 4 },
      writes: [{ address: 0xa000, value: 1 }],
    });
    const four = deriveNesMapperTrace(
      header.value,
      input.initial,
      input.writes,
    );
    expect(four).toMatchObject({
      status: "derived",
      final_mapping: { mirroring: "four-screen" },
    });
    bytes[7] = 8;
    bytes[11] = 7;
    const mixed = parseNesHeader(bytes);
    if (!mixed.ok) throw new Error(mixed.error);
    expect(
      deriveNesMapperTrace(mixed.value, input.initial, input.writes),
    ).toMatchObject({
      status: "unsupported",
      reason: expect.stringContaining("Combined CHR ROM and RAM"),
    });
  });

  it("decodes aliases, masks PRG selectors and swaps PRG and CHR windows", () => {
    const result = trace(
      { mapper: 4, banks: [3, 7, 9, 10, 11, 12, null, null] },
      [
        { address: 0x9ffe, value: 6 },
        { address: 0x9fff, value: 250 },
        { address: 0x8000, value: 7 },
        { address: 0x8001, value: 253 },
        { address: 0x8000, value: 0xc7 },
      ],
    );
    expect(result.final_mapping.prg_view).toEqual({
      mapper: 4,
      prg_mode: 1,
      r6: 58,
      r7: 61,
    });
    expect(
      result.final_mapping.prg_windows.map((window) => window.bank),
    ).toEqual([6, 5, 2, 7]);
    expect(
      result.final_mapping.chr_windows.map((window) => window.bank),
    ).toEqual([9, 10, 11, 12, 2, 3, 6, 7]);
    expect(result.final_mapping.chr_windows[0]?.file_offset).toBe(75280);
    expect(result.steps[1]?.write.value).toBe(250);
    expect(
      result.steps.map((step) =>
        step.mapping.prg_windows.map((window) => window.bank),
      ),
    ).toEqual([
      [null, null, 6, 7],
      [2, null, 6, 7],
      [2, null, 6, 7],
      [2, 5, 6, 7],
      [6, 5, 2, 7],
    ]);
    expect(
      result.steps.map((step) =>
        step.mapping.chr_windows.map((window) => window.bank),
      ),
    ).toEqual([
      [2, 3, 6, 7, 9, 10, 11, 12],
      [2, 3, 6, 7, 9, 10, 11, 12],
      [2, 3, 6, 7, 9, 10, 11, 12],
      [2, 3, 6, 7, 9, 10, 11, 12],
      [9, 10, 11, 12, 2, 3, 6, 7],
    ]);
    expect(result.coverage.unknown_prg_steps).toBe(3);
    expect(result.nes_prg_views).toHaveLength(2);
  });

  it("retains a fixed window and invalidates an unknown bank destination", () => {
    const result = trace({ mapper: 4, banks: [0, 1, 2, 3, 4, 5, 6, 7] }, [
      { address: 0x8001, value: 20 },
    ]);
    expect(result.final).toMatchObject({
      banks: [
        { mask: 235, value: 0 },
        { mask: 234, value: 0 },
        { mask: 233, value: 0 },
        { mask: 232, value: 0 },
        { mask: 239, value: 4 },
        { mask: 238, value: 4 },
        { mask: 237, value: 4 },
        { mask: 236, value: 4 },
      ],
    });
    expect(result.final_mapping.prg_windows).toEqual([
      { start: 32768, size: 8192, bank: null, file_offset: null },
      { start: 40960, size: 8192, bank: null, file_offset: null },
      { start: 49152, size: 8192, bank: null, file_offset: null },
      { start: 57344, size: 8192, bank: 7, file_offset: 57872 },
    ]);
  });

  it("records IRQ commands and protection without inventing counters or CHR RAM contents", () => {
    const result = trace(
      { mapper: 4 },
      [
        { address: 0xbffe, value: 1 },
        { address: 0xbfff, value: 0xc0 },
        { address: 0xdffe, value: 42 },
        { address: 0xdfff, value: null },
        { address: 0xfffe, value: 0 },
        { address: 0xffff, value: null },
        { address: 0x2007, value: 3 },
      ],
      true,
    );
    expect(result.steps.map((step) => step.effect)).toEqual([
      "nametable",
      "ram-control",
      "irq-latch",
      "irq-reload",
      "irq-disable",
      "irq-enable",
      "outside-mapper",
    ]);
    expect(result.final).toMatchObject({
      ram_protect: 192,
      irq_latch: 42,
      last_irq_command: "enable",
    });
    expect(result.final_mapping).toMatchObject({
      chr_source: "ram-unobserved",
      mirroring: "horizontal",
    });
    expect(
      result.final_mapping.chr_windows.every(
        (window) => window.file_offset === null && window.bank === null,
      ),
    ).toBe(true);
  });
});

describe("mapping facts with unknown mode registers", () => {
  it("preserves MMC1 windows shared by every mode without inventing a view", () => {
    const upper = trace(
      { mapper: 1, prg_bank: 15, chr_bank_0: 10, chr_bank_1: 11 },
      [],
    );
    expect(upper.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
      null,
      3,
    ]);
    expect(upper.final_mapping.chr_windows.map((w) => w.bank)).toEqual([2, 3]);
    expect(upper.final_mapping.prg_view).toBeNull();
    expect(upper.final).toMatchObject({
      prg_mode: null,
      chr_mode: null,
      prg_bank: 15,
    });
    expect(upper.nes_prg_views).toEqual([]);
    const lower = trace(
      { mapper: 1, prg_bank: 12, chr_bank_0: 3, chr_bank_1: 4 },
      [],
    );
    expect(lower.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
      0,
      null,
    ]);
    expect(lower.final_mapping.chr_windows.map((w) => w.bank)).toEqual([
      null,
      null,
    ]);
  });

  it("retains MMC3 physical aliases across PRG/CHR inversion and loses them on an unknown write", () => {
    const result = trace({ mapper: 4, banks: [3, 7, 34, 35, 38, 39, 62, 9] }, [
      { address: 0x8001, value: null },
    ]);
    expect(result.initial_mapping.prg_windows.map((w) => w.bank)).toEqual([
      6, 1, 6, 7,
    ]);
    expect(result.initial_mapping.chr_windows.map((w) => w.bank)).toEqual([
      2, 3, 6, 7, 2, 3, 6, 7,
    ]);
    expect(result.initial_mapping.prg_view).toBeNull();
    expect(result.initial).toMatchObject({ bank_select: null });
    expect(result.nes_prg_views).toEqual([]);
    expect(result.final_mapping.prg_windows.map((w) => w.bank)).toEqual([
      null,
      null,
      null,
      7,
    ]);
    expect(result.final_mapping.chr_windows.map((w) => w.bank)).toEqual(
      Array(8).fill(null),
    );
  });
});

it.each([1, 3, 66] as const)(
  "retains one physical CHR bank without inventing Mapper %i selectors",
  (mapper) => {
    for (const chrBanks of [1, 2]) {
      const headerBytes = Buffer.alloc(16);
      headerBytes.set([
        0x4e,
        0x45,
        0x53,
        0x1a,
        2,
        chrBanks,
        (mapper & 15) << 4,
        mapper & 0xf0,
      ]);
      const header = parseNesHeader(headerBytes, 16 + 32768 + chrBanks * 8192);
      if (!header.ok) throw new Error(header.error);
      const input = traceNesMapperWritesInputSchema.parse({
        path: "/single-chr.nes",
        initial: mapper === 1 ? { mapper, chr_mode: 0 } : { mapper },
        writes: [],
      });
      const result = deriveNesMapperTrace(header.value, input.initial, []);
      if (result.status !== "derived") throw new Error(result.reason);
      expect(
        result.final_mapping.chr_windows.map((window) => window.bank),
      ).toEqual(chrBanks === 1 ? [0, 1] : [null, null]);
      expect(
        result.final_mapping.chr_windows.map((window) => window.file_offset),
      ).toEqual(chrBanks === 1 ? [32784, 36880] : [null, null]);
      expect(result.final).toMatchObject(
        mapper === 1 ? { chr_bank_0: null } : { chr_bank: null },
      );
      if (mapper === 1) {
        const fourKiB = traceNesMapperWritesInputSchema.parse({
          path: "/single-chr.nes",
          initial: { mapper, chr_mode: 1 },
          writes: [],
        });
        expect(
          deriveNesMapperTrace(header.value, fourKiB.initial, []),
        ).toMatchObject({
          final_mapping: { chr_windows: [{ bank: null }, { bank: null }] },
        });
      }
    }
  },
);

it.each([
  [0, "horizontal"],
  [1, "vertical"],
  [8, "four-screen"],
] as const)(
  "retains MMC3 submapper 2 header mirroring %s through known and unknown writes",
  (flag, expected) => {
    const bytes = mapperTraceFixture(4);
    bytes[6] = (bytes[6]! & ~9) | flag;
    bytes[7] = 8;
    bytes[8] = 0x20;
    const header = parseNesHeader(bytes);
    if (!header.ok) throw new Error(header.error);
    const input = traceNesMapperWritesInputSchema.parse({
      path: "/fixed-mirroring.nes",
      initial: { mapper: 4 },
      writes: [
        { address: 0xa000, value: 1 },
        { address: 0xbffe, value: 0 },
        { address: 0xa000, value: null },
        { address: 0x8000, value: 6 },
        { address: 0x8001, value: 2 },
      ],
    });
    const result = deriveNesMapperTrace(
      header.value,
      input.initial,
      input.writes,
    );
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.initial_mapping.mirroring).toBe(expected);
    expect(result.final_mapping.mirroring).toBe(expected);
    expect(result.final).toMatchObject({ mapper: 4, mirroring: null });
    expect(result.final_mapping.prg_windows[0]!.bank).toBe(2);
    expect(result.steps.map((step) => step.write)).toEqual(input.writes);
  },
);

it("preserves partial CPU write evidence without treating its bits as a complete mapper value", () => {
  const writes = [
    {
      address: 0x01ff,
      value: null,
      known_bits: { mask: 0xf0, value: 0x70 },
      preceded_by_cpu_write: false,
    },
    {
      address: 0x8001,
      value: null,
      known_bits: { mask: 0xf0, value: 0x70 },
      preceded_by_cpu_write: false,
    },
  ];
  const result = trace(
    { mapper: 4, bank_select: 6, banks: [0, 2, 4, 5, 6, 7, 2, 1] },
    writes,
  );
  expect(result.steps.map((step) => step.write)).toEqual(writes);
  expect(result.steps[0]!.effect).toBe("outside-mapper");
  expect(result.steps[0]!.state).toMatchObject({
    banks: [0, 2, 4, 5, 6, 7, 2, 1],
  });
  expect(result.final).toMatchObject({
    banks: [0, 2, 4, 5, 6, 7, { mask: 240, value: 112 }, 1],
  });
  expect(
    traceNesMapperWritesInputSchema.safeParse({
      path: "/game.nes",
      initial: { mapper: 4 },
      writes: [{ ...writes[0], value: 0x70 }],
    }).success,
  ).toBe(false);
});

it("agrees with the advertised schema for every partial byte mask/value pair", () => {
  const json = z.toJSONSchema(nesKnownBitsSchema, {
    target: "draft-2020-12",
    io: "input",
  });
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(json);
  for (let mask = 0; mask <= 255; mask++) {
    for (let value = 0; value <= 255; value++) {
      const expected = mask > 0 && mask < 255 && (mask & value) === value;
      const input = { mask, value };
      const accepted = nesKnownBitsSchema.safeParse(input).success;
      if (accepted !== expected || validate(input) !== expected)
        throw new Error(
          `Partial byte schema disagreement at mask=${mask}, value=${value}`,
        );
    }
  }
  for (const input of [
    { mask: 1.5, value: 0 },
    { mask: 1, value: -1 },
    { mask: 1, value: 256 },
    { mask: 1, value: 0, extra: true },
  ]) {
    expect(nesKnownBitsSchema.safeParse(input).success).toBe(false);
    expect(validate(input)).toBe(false);
  }
});

it("commits independent MMC1 fields when another serial field is unknown", () => {
  const control = trace(
    { mapper: 1, shift_bits: [null, 0, 1, 1], prg_bank: 2 },
    [{ address: 0x8000, value: 1, preceded_by_cpu_write: false }],
  );
  expect(control.final).toMatchObject({
    shift_bits: [],
    mirroring: null,
    prg_mode: 3,
    chr_mode: 1,
    prg_bank: 2,
  });
  expect(
    control.final_mapping.prg_windows.map((window) => window.bank),
  ).toEqual([2, 3]);
  const bank = trace({ mapper: 1, shift_bits: [1, null, 0, 0], prg_mode: 3 }, [
    { address: 0xe000, value: 1, preceded_by_cpu_write: false },
  ]);
  expect(bank.final).toMatchObject({
    shift_bits: [],
    prg_bank: { mask: 13, value: 1 },
    prg_ram_disable_bit: 1,
  });
});

it("retains CHR serial bits and their common facts after uncertain MMC1 write timing", () => {
  const result = trace(
    { mapper: 1, chr_mode: 0, shift_bits: [null, 1, 0, null] },
    [{ address: 0xa000, value: 1, preceded_by_cpu_write: false }],
  );
  expect(result.final).toMatchObject({ chr_bank_0: { mask: 22, value: 18 } });
  expect(result.final_mapping.chr_windows.map((w) => w.bank)).toEqual([2, 3]);
  const joined = trace(
    {
      mapper: 1,
      chr_mode: 0,
      chr_bank_0: { mask: 22, value: 18 },
      shift_bits: [1, 1, 0, 0],
    },
    [{ address: 0xa000, value: 1 }],
  );
  expect(joined.final).toMatchObject({ chr_bank_0: { mask: 22, value: 18 } });
  expect(joined.final_mapping.chr_windows.map((w) => w.bank)).toEqual([2, 3]);
  expect(trace(joined.final, []).final_mapping).toEqual(joined.final_mapping);
});

it("joins MMC1 CHR windows against every concrete five-bit register completion", () => {
  const parsed = parseNesHeader(mapperTraceFixture(1));
  if (!parsed.ok) throw new Error(parsed.error);
  for (const count of [2, 8, 32]) {
    const header = {
      ...parsed.value,
      chrRom: { ...parsed.value.chrRom, size: count * 4096 },
    };
    for (let mask = 0; mask < 32; mask++) {
      for (let value = 0; value < 32; value++) {
        if ((value & ~mask) !== 0) continue;
        const first = mask === 0 ? null : mask === 31 ? value : { mask, value };
        // Independent second-register facts exercise both mux inputs and physical aliases.
        const second = { mask: 3, value: 3 };
        for (const mode of [0, 1, null]) {
          const state = traceNesMapperWritesInputSchema.parse({
            path: "/partial-chr.nes",
            initial: {
              mapper: 1,
              chr_mode: mode,
              chr_bank_0: first,
              chr_bank_1: second,
            },
            writes: [],
          }).initial;
          const candidates = [new Set<number>(), new Set<number>()];
          for (let bank = 0; bank < 32; bank++) {
            if ((bank & mask) === value) {
              if (mode !== 1) {
                candidates[0]!.add((bank & 30) % count);
                candidates[1]!.add(((bank & 30) + 1) % count);
              }
              if (mode !== 0) candidates[0]!.add(bank % count);
            }
            if (mode !== 0 && (bank & second.mask) === second.value)
              candidates[1]!.add(bank % count);
          }
          expect(
            mapperMapping(header, state).chr_windows.map((w) => w.bank),
          ).toEqual(
            candidates.map((banks) =>
              banks.size === 1 ? [...banks][0] : null,
            ),
          );
        }
      }
    }
  }
});

it("uses only proven MMC1 reset/data bits while preserving partial writes", () => {
  const writes = [
    {
      address: 0x8000,
      value: null,
      known_bits: { mask: 128, value: 128 },
      preceded_by_cpu_write: true,
    },
    ...[0, 1, 0, 0, 0].map((value) => ({
      address: 0xe000,
      value: null,
      known_bits: { mask: 129, value },
      preceded_by_cpu_write: false,
    })),
  ];
  const result = trace({ mapper: 1, chr_mode: 1, mirroring: 2 }, writes);
  expect(result.steps.map((step) => step.write)).toEqual(writes);
  expect(result.steps[0]).toMatchObject({
    effect: "serial-reset",
    state: { shift_bits: [], prg_mode: 3, chr_mode: 1, mirroring: 2 },
  });
  expect(result.final).toMatchObject({
    shift_bits: [],
    prg_mode: 3,
    prg_bank: 2,
    prg_ram_disable_bit: 0,
  });
  expect(result.final_mapping.prg_windows.map((window) => window.bank)).toEqual(
    [2, 3],
  );
});

it.each([
  { mode: 0, bits: [null, 1, null, null], banks: [2, 3] },
  { mode: 1, bits: [null, 1, null, null], banks: [2, 3] },
  { mode: 2, bits: [1, 0, null, null], banks: [0, 1] },
  { mode: 3, bits: [1, 0, null, null], banks: [1, 3] },
  { mode: 2, bits: [null, 1, null, null], banks: [0, null] },
  { mode: 3, bits: [null, 1, null, null], banks: [null, 3] },
])(
  "resolves only the physical MMC1 bits needed by PRG mode $mode: $bits",
  ({ mode, bits, banks }) => {
    const result = trace({ mapper: 1, prg_mode: mode, shift_bits: bits }, [
      { address: 0xe000, value: 0, preceded_by_cpu_write: false },
    ]);
    expect(
      result.final_mapping.prg_windows.map((window) => window.bank),
    ).toEqual(banks);
    expect(result.final_mapping.prg_view).toBeNull();
    expect(result.nes_prg_views).toEqual([]);
    const resumed = trace(result.final, []);
    expect(resumed.final).toEqual(result.final);
    expect(resumed.final_mapping).toEqual(result.final_mapping);
  },
);

it("maps a 32 KiB MMC1 pair with an entirely unknown selector on a 32 KiB cartridge", () => {
  const bytes = mapperTraceFixture(1, true).subarray(0, 528 + 32768);
  bytes[4] = 2;
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  const initial = traceNesMapperWritesInputSchema.parse({
    path: "/pair.nes",
    initial: { mapper: 1, prg_mode: 0 },
    writes: [],
  }).initial;
  const result = deriveNesMapperTrace(header.value, initial, []);
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.final_mapping.prg_windows.map((window) => window.bank)).toEqual(
    [0, 1],
  );
  expect(result.final_mapping.prg_view).toBeNull();
});

it.each([
  {
    preceding: false,
    bits: [],
    expectedBits: [null],
    effect: "serial-shift",
    bank: 2,
  },
  {
    preceding: true,
    bits: [],
    expectedBits: [],
    effect: "ignored-consecutive-write",
    bank: 2,
  },
  {
    preceding: false,
    bits: [1, 0, 1, 0],
    expectedBits: [],
    effect: "register-commit",
    bank: 5,
  },
])(
  "does not invent an MMC1 reset when D7 is proven clear: %j",
  ({ preceding, bits, expectedBits, effect, bank }) => {
    const result = trace(
      { mapper: 1, shift_bits: bits, prg_mode: 2, prg_bank: 2 },
      [
        {
          address: 0xe000,
          value: null,
          known_bits: { mask: 128, value: 0 },
          preceded_by_cpu_write: preceding,
        },
      ],
    );
    expect(result.steps[0]!.effect).toBe(effect);
    expect(result.final).toMatchObject({
      shift_bits: expectedBits,
      prg_mode: 2,
      prg_bank: bank,
    });
    if (bits.length === 4)
      expect(result.final).toMatchObject({ prg_ram_disable_bit: null });
  },
);

it("retains uncertainty when MMC1 reset or write timing is not proven", () => {
  const initial = { mapper: 1, shift_bits: [], prg_mode: 2, prg_bank: 2 };
  const reset = trace(initial, [
    {
      address: 0xe000,
      value: null,
      known_bits: { mask: 1, value: 1 },
      preceded_by_cpu_write: false,
    },
  ]);
  expect(reset.final).toMatchObject({
    shift_bits: null,
    prg_mode: null,
    prg_bank: 2,
  });
  const timing = trace(initial, [
    {
      address: 0xe000,
      value: null,
      known_bits: { mask: 129, value: 1 },
      preceded_by_cpu_write: null,
    },
  ]);
  expect(timing.final).toMatchObject({
    shift_bits: null,
    prg_mode: 2,
    prg_bank: 2,
  });
  expect(timing.steps[0]!.effect).toBe("uncertain-serial-write");
});

it("resolves MMC3 PRG windows from only the cartridge address bits and retains original partial registers", () => {
  const initial = {
    mapper: 4,
    bank_select: 6,
    banks: [0, 2, 4, 5, 6, 7, 2, 1],
  };
  const result = trace(initial, [
    { address: 0x8001, value: null, known_bits: { mask: 7, value: 3 } },
  ]);
  expect(result.final).toMatchObject({
    banks: [0, 2, 4, 5, 6, 7, { mask: 7, value: 3 }, 1],
  });
  expect(result.final_mapping.prg_windows.map((window) => window.bank)).toEqual(
    [3, 1, 6, 7],
  );
  expect(result.final_mapping.prg_view).toBeNull();
  expect(result.nes_prg_views).toEqual([
    {
      mapper: 4,
      prg_mode: 0,
      r6: 2,
      r7: 1,
    },
  ]);
  const complete = trace(initial, [
    { address: 0x8001, value: null, known_bits: { mask: 63, value: 3 } },
  ]);
  expect(complete.final_mapping.prg_view).toEqual({
    mapper: 4,
    prg_mode: 0,
    r6: 3,
    r7: 1,
  });
  const missing = trace(initial, [
    { address: 0x8001, value: null, known_bits: { mask: 6, value: 2 } },
  ]);
  expect(
    missing.final_mapping.prg_windows.map((window) => window.bank),
  ).toEqual([null, 1, 6, 7]);
});

it("resolves MMC3 paired and single CHR windows without requiring ignored bits", () => {
  const result = trace(
    { mapper: 4, bank_select: 0, banks: [0, 2, 4, 5, 6, 7, 2, 1] },
    [
      { address: 0x8001, value: null, known_bits: { mask: 30, value: 4 } },
      { address: 0x8000, value: 2 },
      { address: 0x8001, value: null, known_bits: { mask: 31, value: 9 } },
    ],
  );
  expect(result.final_mapping.chr_windows.map((window) => window.bank)).toEqual(
    [4, 5, 2, 3, 9, 5, 6, 7],
  );
});

it("joins shared MMC3 register bits under an unknown destination and resumes the resulting snapshot", () => {
  const result = trace({ mapper: 4, banks: [2, 2, 2, 2, 2, 2, 2, 2] }, [
    { address: 0x8001, value: 130 },
  ]);
  expect(result.final).toMatchObject({
    bank_select: null,
    banks: Array.from({ length: 8 }, () => ({ mask: 127, value: 2 })),
  });
  expect(result.final_mapping.prg_windows.map((window) => window.bank)).toEqual(
    [null, 2, null, 7],
  );
  const resumed = trace(result.final, [{ address: 0x8000, value: 6 }]);
  expect(
    resumed.final_mapping.prg_windows.map((window) => window.bank),
  ).toEqual([2, 2, 6, 7]);
  expect(resumed.nes_prg_views).toContainEqual({
    mapper: 4,
    prg_mode: 0,
    r6: 2,
    r7: 2,
  });
});

it("decodes known MMC3 selector fields independently", () => {
  const initial = {
    mapper: 4,
    bank_select: 0,
    banks: [0, 2, 4, 5, 6, 7, 2, 1],
  };
  const result = trace(initial, [
    { address: 0x8000, value: null, known_bits: { mask: 0xc7, value: 0x46 } },
    { address: 0x8001, value: 3 },
    { address: 0xa000, value: null, known_bits: { mask: 1, value: 1 } },
  ]);
  expect(result.final).toMatchObject({
    bank_select: { mask: 0xc7, value: 0x46 },
    banks: [0, 2, 4, 5, 6, 7, 3, 1],
    mirroring: 1,
  });
  expect(result.final_mapping.prg_windows.map((window) => window.bank)).toEqual(
    [6, 1, 3, 7],
  );
  expect(result.nes_prg_views).toContainEqual({
    mapper: 4,
    prg_mode: 1,
    r6: 3,
    r7: 1,
  });
  const chr = trace({ ...initial, bank_select: { mask: 128, value: 128 } }, []);
  expect(chr.final_mapping.chr_windows.map((window) => window.bank)).toEqual([
    4, 5, 6, 7, 0, 1, 2, 3,
  ]);
  expect(chr.final_mapping.prg_windows.map((window) => window.bank)).toEqual([
    null,
    1,
    null,
    7,
  ]);
});

it("limits uncertain MMC3 destinations to selectors consistent with proven bits", () => {
  const result = trace(
    {
      mapper: 4,
      bank_select: { mask: 0xc6, value: 0x46 },
      banks: [0, 2, 4, 5, 6, 7, 2, 1],
    },
    [{ address: 0x8001, value: 3 }],
  );
  expect(result.final).toMatchObject({
    banks: [0, 2, 4, 5, 6, 7, { mask: 254, value: 2 }, { mask: 253, value: 1 }],
  });
  expect(result.final_mapping.prg_windows.map((window) => window.bank)).toEqual(
    [6, null, null, 7],
  );
});

it.each([
  { bus_conflicts: "none", mask: 3, value: 2, prg: 2, chr: null },
  { bus_conflicts: "none", mask: 240, value: 112, prg: null, chr: 7 },
  { bus_conflicts: "and", mask: 3, value: 0, prg: 0, chr: null },
  { bus_conflicts: "and", mask: 3, value: 2, prg: null, chr: null },
  { bus_conflicts: "unknown", mask: 3, value: 0, prg: 0, chr: null },
])(
  "uses independent Color Dreams bank bits under conflict policy %j",
  ({ bus_conflicts, mask, value, prg, chr }) => {
    const writes = [
      { address: 0x8000, value: null, known_bits: { mask, value } },
    ];
    const result = trace({ mapper: 11, bus_conflicts }, writes);
    expect(result.final).toMatchObject({ prg_bank: prg, chr_bank: chr });
    expect(result.steps[0]?.write).toEqual({
      ...writes[0],
      preceded_by_cpu_write: null,
    });
  },
);

it.each([9, 10, 71] as const)(
  "resolves Mapper %i bank writes only when all selector bits are proven",
  (mapper) => {
    const address = mapper === 71 ? 0xc000 : 0xa000;
    const result = trace({ mapper }, [
      { address, value: null, known_bits: { mask: 15, value: 2 } },
      { address, value: null, known_bits: { mask: 14, value: 2 } },
    ]);
    expect(result.steps[0]?.state).toMatchObject({ prg_bank: 2 });
    expect(result.steps[1]?.state).toMatchObject({ prg_bank: null });
  },
);

it.each([9, 10] as const)(
  "retains independent Mapper %i CHR and mirroring facts",
  (mapper) => {
    const result = trace({ mapper }, [
      { address: 0xb000, value: null, known_bits: { mask: 31, value: 3 } },
      { address: 0xc000, value: null, known_bits: { mask: 30, value: 2 } },
      { address: 0xf000, value: null, known_bits: { mask: 1, value: 1 } },
    ]);
    expect(result.final).toMatchObject({
      chr_fd_0: 3,
      chr_fe_0: null,
      mirroring: 1,
    });
  },
);
