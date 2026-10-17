import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { nesBoardSelection } from "./nesBoardSelection.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import { applyMappedNesMapperWrite } from "./nesMapperTraceDerivation.js";
import { nesPrgViewsSchema, nesPrgViewSchema } from "./nesPrgViews.js";
import { nesPrgRamLayout } from "./nesPrgRamLayout.js";
import { nesPrgRamAccess } from "./nesPrgRam.js";
import { nesPpuAdmission, readNesPpuMemory } from "./nesPpuMemory.js";
import { nesPpuStateSchema } from "./nesPpuState.js";
import { nesIrem78StateSchema, nesIrem78VariantSchema } from "./nesIrem78.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";

const cartridge = (
  prgSize = 131072,
  chrSize = 131072,
  {
    legacy = false,
    trainer = false,
    flags = 0,
    submapper = 1,
    prgStorage = 0,
    chrStorage = 0,
    legacyRam = 0,
  }: {
    legacy?: boolean;
    trainer?: boolean;
    flags?: number;
    submapper?: number;
    prgStorage?: number;
    chrStorage?: number;
    legacyRam?: number;
  } = {},
) => {
  const bytes = Buffer.alloc(16);
  bytes.set([78, 69, 83, 26, prgSize / 16384, chrSize / 8192]);
  bytes[6] = 0xe0 | (trainer ? 4 : 0) | flags;
  bytes[7] = 0x40 | (legacy ? 0 : 8);
  bytes[8] = legacy ? legacyRam : submapper << 4;
  bytes[10] = prgStorage;
  bytes[11] = chrStorage;
  const parsed = parseNesHeader(
    bytes,
    16 + (trainer ? 512 : 0) + prgSize + chrSize,
  );
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
};
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});

it.each([
  [1, "cosmo-carrier", "COSMO_CARRIER"],
  [3, "holy-diver", "HOLY_DIVER"],
] as const)(
  "qualifies submapper %i defaults and selected contexts without claiming a power-on latch",
  (submapper, variant, context) => {
    const metadata = cartridge(131072, 131072, { submapper }),
      defaults = resolveNesMapperLayout(metadata);
    if (!defaults.ok) throw new Error(defaults.error);
    expect(defaults.value.contexts).toEqual([
      {
        addressSpace: `NES_M78_${context}_P00`,
        state: { mapper: 78, variant, prg_bank: 0 },
        selection: "default-assumption",
      },
    ]);
    const selected = resolveNesMapperLayout(metadata, [
      { mapper: 78, variant, prg_bank: 6 },
    ]);
    if (!selected.ok) throw new Error(selected.error);
    expect(selected.value.contexts).toEqual([
      {
        addressSpace: `NES_M78_${context}_P06`,
        state: { mapper: 78, variant, prg_bank: 6 },
        selection: "caller-selected",
      },
    ]);
    for (const invalid of [
      { mapper: 78, prg_bank: 0 },
      { mapper: 78, variant, prg_bank: 8 },
      { mapper: 78, variant, prg_bank: 0, latch: 0 },
    ])
      expect(nesPrgViewSchema.safeParse(invalid).success).toBe(false);
  },
);

it("keeps distinct raw views for 16 KiB aliases and maps final PRG/CHR bytes at maximum capacity", () => {
  const views = nesPrgViewsSchema.parse([
      { mapper: 78, variant: "holy-diver", prg_bank: 7 },
      { mapper: 78, variant: "holy-diver", prg_bank: 0 },
    ]),
    result = resolveNesMapperLayout(
      cartridge(16384, 8192, { trainer: true, submapper: 3 }),
      views,
    );
  if (!result.ok) throw new Error(result.error);
  expect(result.value.contexts.map((context) => context.state)).toEqual(views);
  expect(
    result.value.mappings.map(({ start, bank, fileOffset, role }) => [
      start,
      bank,
      fileOffset,
      role,
    ]),
  ).toEqual([
    [0x8000, 0, 528, "switchable"],
    [0xc000, 0, 528, "fixed"],
    [0x8000, 0, 528, "switchable"],
    [0xc000, 0, 528, "fixed"],
  ]);
  const metadata = cartridge(131072, 131072, { trainer: true, submapper: 3 }),
    state = nesIrem78StateSchema.parse({
      mapper: 78,
      variant: "holy-diver",
      latch: 255,
    }),
    mapping = mapperMapping(metadata, state);
  expect(mapping.prg_windows).toEqual([
    { start: 0x8000, size: 16384, bank: 7, file_offset: 115216 },
    { start: 0xc000, size: 16384, bank: 7, file_offset: 115216 },
  ]);
  expect(mapping.chr_windows).toEqual([
    { start: 0, size: 8192, bank: 15, file_offset: 254480 },
  ]);
  expect(mapping.chr_windows[0]!.file_offset! + 8191).toBe(262671);
});

it("does not invent complete low-three-bit view identity from a known small-ROM physical bank", () => {
  const metadata = cartridge(32768, 8192),
    state = nesIrem78StateSchema.parse({
      mapper: 78,
      variant: "cosmo-carrier",
      latch: { mask: 1, value: 1 },
    }),
    physical = mapperMapping(metadata, state);
  expect(physical.prg_windows.map((window) => window.bank)).toEqual([1, 1]);
  expect(physical.chr_windows).toEqual([
    { start: 0, size: 8192, bank: 0, file_offset: 32784 },
  ]);
  expect(physical.prg_view).toBeNull();
  const complete = mapperMapping(
    metadata,
    nesIrem78StateSchema.parse({ ...state, latch: { mask: 7, value: 7 } }),
  );
  expect(complete.prg_windows).toEqual(physical.prg_windows);
  expect(complete.prg_view).toEqual({
    mapper: 78,
    variant: "cosmo-carrier",
    prg_bank: 7,
  });
});

it.each([false, true])(
  "requires an immutable choice for unspecified headers and preserves legacy observations (legacy %s)",
  (legacy) => {
    const metadata = cartridge(131072, 131072, {
        legacy,
        trainer: true,
        submapper: 0,
        flags: legacy ? 10 : 0,
        legacyRam: 3,
      }),
      before = structuredClone(metadata);
    expect(resolveNesMapperLayout(metadata).ok).toBe(false);
    for (const variant of nesIrem78VariantSchema.options) {
      const state = nesIrem78StateSchema.parse({ mapper: 78, variant }),
        chosen = resolveNesMapperLayout(
          metadata,
          undefined,
          nesBoardSelection(state),
        ),
        view = resolveNesMapperLayout(metadata, [
          { mapper: 78, variant, prg_bank: 5 },
        ]);
      if (!chosen.ok) throw new Error(chosen.error);
      if (!view.ok) throw new Error(view.error);
      expect(chosen.value.contexts[0]?.state).toEqual({
        mapper: 78,
        variant,
        prg_bank: 0,
      });
      expect(view.value.contexts[0]?.state).toEqual({
        mapper: 78,
        variant,
        prg_bank: 5,
      });
      expect(nesPrgRamLayout(metadata, state)).toBeNull();
      expect(nesPrgRamAccess(metadata, state, 0x6000)).toBeNull();
    }
    expect(metadata).toEqual(before);
    if (legacy) {
      expect(metadata).toMatchObject({
        headerVersion: "ines",
        submapper: null,
        mirroring: "four-screen",
        battery: true,
        prgRamSize: null,
        prgNvramSize: null,
        chrRamSize: null,
        chrNvramSize: null,
      });
      expect(metadata.header[8]).toBe(3);
    }
  },
);

it("uses two-page CIRAM for explicitly qualified legacy boards without turning the historical flag into 4 KiB storage", () => {
  const metadata = cartridge(131072, 131072, { legacy: true, flags: 8 }),
    before = structuredClone(metadata),
    ppu = nesPpuStateSchema.parse({
      model: "ppu-memory",
      dma_reads: "absent",
      chr_ram_size: null,
      nametable_layout: "ciram-2k",
      nametable: { "0": 18, "1024": 52 },
    });
  for (const variant of nesIrem78VariantSchema.options) {
    const state = nesIrem78StateSchema.parse({ mapper: 78, variant, latch: 8 });
    expect(nesPpuAdmission(metadata, state, ppu)).toBeNull();
    const read = readNesPpuMemory(metadata, state, ppu, 0x2000);
    expect(read.value).toBe(variant === "cosmo-carrier" ? 52 : 18);
    expect(read.sources).toEqual([
      {
        kind: "memory",
        space: "nametable",
        address: variant === "cosmo-carrier" ? 1024 : 0,
        mask: 255,
        value: variant === "cosmo-carrier" ? 52 : 18,
        origin: {
          kind: "initial-memory",
          space: "nametable",
          address: variant === "cosmo-carrier" ? 1024 : 0,
        },
      },
    ]);
    expect(
      nesPpuAdmission(metadata, state, {
        ...ppu,
        nametable_layout: "four-screen-4k",
      }),
    ).not.toBeNull();
  }
  expect(metadata).toEqual(before);
});

it("rejects conflicting immutable views and choices even when physical banks alias", () => {
  const cosmo = { family: "irem78", variant: "cosmo-carrier" } as const,
    holy = { family: "irem78", variant: "holy-diver" } as const;
  expect(
    resolveNesMapperLayout(
      cartridge(16384, 8192, { submapper: 3 }),
      undefined,
      cosmo,
    ).ok,
  ).toBe(false);
  expect(
    resolveNesMapperLayout(cartridge(16384, 8192), undefined, holy).ok,
  ).toBe(false);
  expect(
    resolveNesMapperLayout(cartridge(16384, 8192, { submapper: 0 }), [
      { mapper: 78, variant: "cosmo-carrier", prg_bank: 0 },
      { mapper: 78, variant: "holy-diver", prg_bank: 0 },
    ]).ok,
  ).toBe(false);
});

it("admits only connected ROM capacities and rejects explicit storage, four-screen and unsupported submappers", () => {
  for (const prgSize of [16384, 32768, 65536, 131072])
    expect(resolveNesMapperLayout(cartridge(prgSize)).ok).toBe(true);
  for (const chrSize of [8192, 16384, 32768, 65536, 131072])
    expect(resolveNesMapperLayout(cartridge(131072, chrSize)).ok).toBe(true);
  for (const metadata of [
    cartridge(262144),
    cartridge(49152),
    cartridge(131072, 0),
    cartridge(131072, 262144),
    cartridge(131072, 131072, { prgStorage: 7 }),
    cartridge(131072, 131072, { prgStorage: 0x70 }),
    cartridge(131072, 131072, { chrStorage: 7 }),
    cartridge(131072, 131072, { chrStorage: 0x70 }),
    cartridge(131072, 131072, { flags: 8 }),
    cartridge(131072, 131072, { submapper: 2 }),
    cartridge(131072, 131072, { submapper: 15 }),
  ]) {
    const before = structuredClone(metadata);
    expect(
      resolveNesMapperLayout(metadata, undefined, {
        family: "irem78",
        variant: "cosmo-carrier",
      }).ok,
    ).toBe(false);
    expect(metadata).toEqual(before);
  }
});

it("reads the addressed ROM byte through the old selected bank before applying the new shared latch", () => {
  const metadata = cartridge(),
    prg = Buffer.alloc(131072, 255),
    state = nesIrem78StateSchema.parse({
      mapper: 78,
      variant: "cosmo-carrier",
      latch: 2,
    });
  prg[2 * 16384 + 3] = 0xad;
  prg[5 * 16384 + 3] = 0x12;
  const result = applyMappedNesMapperWrite(
    metadata,
    state,
    write(0x8003, 255),
    { prg },
  );
  expect(result.effect).toBe("prg-chr-bank");
  expect(result.state).toEqual({ ...state, latch: 0xad });
  expect(state.latch).toBe(2);
  prg[7 * 16384 + 3] = 0x96;
  expect(
    applyMappedNesMapperWrite(metadata, state, write(0xc003, 255), { prg })
      .state,
  ).toEqual({ ...state, latch: 0x96 });
});

it("joins only compatible pre-write lower banks and preserves common ROM/CPU conflict facts", () => {
  const metadata = cartridge(),
    prg = Buffer.alloc(131072, 255),
    state = nesIrem78StateSchema.parse({
      mapper: 78,
      variant: "holy-diver",
      latch: { mask: 1, value: 1 },
    }),
    before = structuredClone(state);
  for (const [index, bank] of [1, 3, 5, 7].entries())
    prg[bank * 16384 + 5] = [0xa9, 0xab, 0xe9, 0xeb][index]!;
  const joined = applyMappedNesMapperWrite(
    metadata,
    state,
    write(0x8005, 255),
    { prg },
  );
  expect(joined.state).toEqual({ ...state, latch: { mask: 189, value: 169 } });
  expect(
    applyMappedNesMapperWrite(metadata, state, write(0x8005, 189), { prg })
      .state,
  ).toEqual({ ...state, latch: 169 });
  expect(
    applyMappedNesMapperWrite(metadata, state, write(0x8005, 240), {
      prg: undefined,
    }).state,
  ).toEqual({ ...state, latch: { mask: 15, value: 0 } });
  expect(state).toEqual(before);
});

it.each([false, true])(
  "preserves unknown-bank conflict proofs through source prefixes, replay and subsequent bank execution (RAM code %s)",
  async (ramCode) => {
    const header = cartridge(131072, 131072, { submapper: 3 }),
      prg = Buffer.alloc(131072, 255),
      chr = Buffer.alloc(131072),
      program = [0xa9, 0xbd, 0x8d, 5, 0x80, 0x4c, 0, 0x81],
      entry = ramCode ? 0x200 : 0xc100;
    for (const [index, bank] of [1, 3, 5, 7].entries())
      prg[bank * 16384 + 5] = [0xa9, 0xab, 0xe9, 0xeb][index]!;
    if (!ramCode) prg.set(program, 7 * 16384 + 0x100);
    prg.set([0xa9, 0x66, 0x60], 16384 + 0x100);
    const input = traceNesCodeInputSchema.parse({
        path: "/mapper78-source-conflict.nes",
        entry,
        initial: {
          mapper: 78,
          variant: "holy-diver",
          latch: { mask: 1, value: 1 },
        },
        initial_ppu: { model: "ppu-memory", dma_reads: "absent" },
        initial_ram: ramCode
          ? program.map((value, index) => ({ address: entry + index, value }))
          : [],
      }),
      before = structuredClone(input),
      source = await deriveNesCode(header, prg, input, { chr });
    if (source.status !== "derived") throw new Error(source.reason);
    // Both unknown ROM bits are forced low by CPU BD, establishing latch A9/bank 1.
    expect(source.stop.reason).toBe("return");
    expect(source.stop.address).toBe(0x8102);
    expect(source.final_cpu.a).toBe(0x66);
    expect(
      source.instructions.find((instruction) => instruction.address === 0x8100)
        ?.file_offsets,
    ).toEqual([16656, 16657]);
    const prefix = await deriveNesCode(
      header,
      prg,
      { ...input, max_instructions: 2 },
      { chr },
    );
    if (prefix.status !== "derived") throw new Error(prefix.reason);
    expect(prefix.stop.reason).toBe("instruction-budget");
    expect(prefix.stop.address).toBe(entry + 5);
    const mapped = prefix.mapper_trace;
    if (mapped.status !== "derived" || !("ppu_trace" in mapped))
      throw new Error("Missing source prefix event trace");
    expect(mapped.final).toEqual({
      mapper: 78,
      variant: "holy-diver",
      latch: 169,
    });
    expect(mapped.steps.map((step) => step.event)).toEqual([
      {
        kind: "cpu-write",
        address: 0x8005,
        value: 189,
        preceded_by_cpu_write: false,
      },
    ]);
    const replay = await deriveNesMapperEvents(
      header,
      input.initial,
      mapped.steps.map((step) => step.event),
      { prg, chr, initialPpu: input.initial_ppu },
    );
    expect(replay).toEqual(mapped);
    const resumed = await deriveNesCode(
      header,
      prg,
      {
        ...input,
        entry: entry + 5,
        initial: mapped.final,
        initial_ppu: mapped.ppu_trace.final,
        cpu: prefix.final_cpu,
      },
      { chr },
    );
    if (resumed.status !== "derived") throw new Error(resumed.reason);
    expect(resumed.stop.reason).toBe("return");
    expect(resumed.stop.address).toBe(0x8102);
    expect(resumed.final_cpu.a).toBe(0x66);
    expect(resumed.mapper_trace).toMatchObject({ final: mapped.final });
    expect(input).toEqual(before);
  },
);
