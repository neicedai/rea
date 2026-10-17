import { z } from "zod";
import {
  nesNamco163ChipRamSchema,
  invalidateNamco163Phase,
  writeNamco163ChipRam,
} from "./nesNamco163Ram.js";
import {
  nesByteBits,
  nesByteCandidates,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesRomMetadata } from "./nes.js";
import type {
  NesMapperState,
  NesMapperWrite,
  NesMapperTraceStep,
  NesMapperMapping,
} from "./nesMapperTrace.js";

const fields = {
  mapper: z.literal(19),
  variant: z
    .literal("namco163")
    .describe(
      "Explicit Namco 129/163 interpretation; mislabeled Namco 175/340 images require a separate Mapper 210 model.",
    ),
  prg_banks: z
    .array(nesByteValueSchema)
    .length(3)
    .default([null, null, null])
    .describe(
      "Raw E000/E800/F000 bytes; E800 high bits independently disable pattern-table CIRAM, E000 D6 controls audio, F000 high bits remain pin-output evidence.",
    ),
  chr_banks: z
    .array(nesByteValueSchema)
    .length(8)
    .default(Array.from({ length: 8 }, () => null)),
  nametable_banks: z
    .array(nesByteValueSchema)
    .length(4)
    .default([null, null, null, null]),
  ram_control: nesByteValueSchema
    .default(null)
    .describe(
      "Last raw F800–FFFF write: external RAM protection latch, independent of optional chip_ram.address_port advancement. External writes require high nibble 4 and a clear addressed 2 KiB protection bit.",
    ),
  audio_data_port: nesByteValueSchema
    .default(null)
    .describe(
      "Last raw 4800–4FFF data-port write. Optional chip_ram additionally models indexed cells; no audio waveform is inferred.",
    ),
  irq_low: nesByteValueSchema.default(null),
  irq_high: nesByteValueSchema.default(null),
};
export const nesNamco163StateSchema = z.union([
  z.strictObject(fields),
  z.strictObject({ ...fields, chip_ram: nesNamco163ChipRamSchema }),
]);
export type NesNamco163State = z.infer<typeof nesNamco163StateSchema>;
export const isNamco163State = (
  state: NesMapperState,
): state is NesNamco163State => state.mapper === 19;
export const hasNamco163ChipRam = (
  state: NesMapperState,
): state is Extract<NesNamco163State, { chip_ram: unknown }> =>
  isNamco163State(state) && "chip_ram" in state;
const selector = z.number().int().min(0).max(63);
export const nesNamco163ViewSchema = z.strictObject({
  mapper: z.literal(19),
  variant: z.literal("namco163"),
  prg_bank_0: selector,
  prg_bank_1: selector,
  prg_bank_2: selector,
});
export const namco163PrgView = (state: NesNamco163State) => {
  const banks = state.prg_banks.map((b) => nesByteBits(b, 63));
  return banks.some((b) => b === null)
    ? null
    : {
        mapper: 19 as const,
        variant: "namco163" as const,
        prg_bank_0: banks[0]!,
        prg_bank_1: banks[1]!,
        prg_bank_2: banks[2]!,
      };
};
export const applyNamco163Write = (
  state: NesNamco163State,
  write: NesMapperWrite,
): Pick<NesMapperTraceStep, "state" | "effect"> => {
  const byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  const port = write.address & 0xf800;
  if ("chip_ram" in state)
    invalidateNamco163Phase(state.chip_ram, state.prg_banks[0] ?? null);
  if (write.address === 0x4014 && "chip_ram" in state) {
    state.chip_ram.oam_dma_pending = byte;
    return { state, effect: "oam-dma-request" };
  }
  if (port >= 0x8000 && port <= 0xb800) {
    state.chr_banks[(port - 0x8000) >> 11] = byte;
    return { state, effect: "chr-bank" };
  }
  if (port >= 0xc000 && port <= 0xd800) {
    state.nametable_banks[(port - 0xc000) >> 11] = byte;
    return { state, effect: "nametable" };
  }
  if (port >= 0xe000 && port <= 0xf000) {
    state.prg_banks[(port - 0xe000) >> 11] = byte;
    if ("chip_ram" in state)
      invalidateNamco163Phase(state.chip_ram, state.prg_banks[0] ?? null);
    return { state, effect: port === 0xe800 ? "prg-chr-bank" : "prg-bank" };
  }
  if (port === 0xf800) {
    state.ram_control = byte;
    if ("chip_ram" in state) state.chip_ram.address_port = byte;
    return { state, effect: "ram-control" };
  }
  if (port === 0x4800) {
    state.audio_data_port = byte;
    if ("chip_ram" in state) {
      writeNamco163ChipRam(state.chip_ram, byte);
      invalidateNamco163Phase(state.chip_ram, state.prg_banks[0] ?? null);
    }
    return { state, effect: "audio-register" };
  }
  if (port === 0x5000 || port === 0x5800) {
    state[port === 0x5000 ? "irq_low" : "irq_high"] = byte;
    return { state, effect: "irq-control" };
  }
  return { state, effect: "outside-mapper" };
};

export const namco163RamWritable = (
  state: NesNamco163State,
  address?: number,
): boolean | null => {
  const windows =
    address === undefined ? [0, 1, 2, 3] : [(address - 0x6000) >> 11];
  const permissions = nesByteCandidates(state.ram_control).flatMap((v) =>
    windows.map((i) => (v & 0xf0) === 0x40 && (v & (1 << i)) === 0),
  );
  return permissions.every((v) => v === permissions[0])
    ? permissions[0]!
    : null;
};

export const nesNamco163PpuWindowSchema = z.strictObject({
  start: z.number().int().min(0).max(0x2c00),
  size: z.literal(1024),
  source: z.enum(["chr-rom", "ciram", "unknown"]),
  bank: z.number().int().min(0).max(255).nullable(),
  file_offset: z.number().int().nonnegative().nullable(),
});
type PpuWindow = z.infer<typeof nesNamco163PpuWindowSchema>;

export type NesNamco163PpuCandidate =
  | { readonly source: "chr-rom" | "ciram"; readonly bank: number }
  | { readonly source: "unknown"; readonly reason: "namco163-audio-debug" };
type Namco163PpuProjection = {
  readonly candidates: readonly NesNamco163PpuCandidate[];
  readonly source: PpuWindow["source"];
};
export type NesNamco163PpuCandidates = {
  pattern(slot: number): readonly NesNamco163PpuCandidate[];
  nametable(page: number): readonly NesNamco163PpuCandidate[];
  patternSource(slot: number): PpuWindow["source"];
  nametableSource(page: number): PpuWindow["source"];
  debug(): boolean | null;
};

/** Electrical source selection precedes the conventional board's physical ROM aliasing. */
const projectPpuRegister = (
  raw: NesByteValue,
  disable: boolean | null,
  chrCapacityBytes: number,
): Namco163PpuProjection => {
  const candidates = new Map<string, NesNamco163PpuCandidate>();
  const sources = new Set<"ciram" | "chr-rom">();
  const mask = chrCapacityBytes / 1024 - 1;
  for (const byte of nesByteCandidates(raw)) {
    if (byte >= 0xe0 && disable !== true) {
      sources.add("ciram");
      const bank = byte & 1;
      candidates.set(`ciram:${bank}`, Object.freeze({ source: "ciram", bank }));
    }
    if (byte < 0xe0 || disable !== false) {
      sources.add("chr-rom");
      if (chrCapacityBytes > 0) {
        const bank = byte & mask;
        candidates.set(
          `rom:${bank}`,
          Object.freeze({ source: "chr-rom", bank }),
        );
      }
    }
  }
  return Object.freeze({
    candidates: Object.freeze(
      [...candidates.values()].sort((a, b) =>
        a.source === "unknown" || b.source === "unknown"
          ? 0
          : a.source === b.source
            ? a.bank - b.bank
            : a.source === "ciram"
              ? -1
              : 1,
      ),
    ),
    source: sources.size === 1 ? sources.values().next().value! : "unknown",
  });
};

/** A lazy operation-local snapshot; later raw writes cannot alter retained candidates. */
export const createNamco163PpuCandidates = (
  state: NesNamco163State,
  chrCapacityBytes: number,
): NesNamco163PpuCandidates => {
  const registers = [...state.chr_banks, ...state.nametable_banks].map(
    (byte) => (typeof byte === "object" && byte !== null ? { ...byte } : byte),
  );
  const disableBits = [
    nesByteBits(state.prg_banks[1], 64),
    nesByteBits(state.prg_banks[1], 128),
  ].map((bit) => (bit === null ? null : bit !== 0));
  const modes = nesByteCandidates(state.prg_banks[2] ?? null).map(
    (byte) => byte === 0x3f,
  );
  const debug = modes.every((mode) => mode === modes[0]) ? modes[0]! : null;
  const unknown = Object.freeze({
    source: "unknown" as const,
    reason: "namco163-audio-debug" as const,
  });
  const cache = new Map<number, Namco163PpuProjection>();
  const projection = (index: number): Namco163PpuProjection => {
    const previous = cache.get(index);
    if (previous !== undefined) return previous;
    const normal =
      debug === true
        ? null
        : projectPpuRegister(
            registers[index]!,
            index < 8 ? disableBits[index < 4 ? 0 : 1]! : false,
            chrCapacityBytes,
          );
    const result =
      debug === false
        ? normal!
        : Object.freeze({
            source: "unknown" as const,
            candidates: Object.freeze([...(normal?.candidates ?? []), unknown]),
          });
    cache.set(index, result);
    return result;
  };
  return Object.freeze({
    pattern: (slot: number) => projection(slot).candidates,
    nametable: (page: number) => projection(8 + page).candidates,
    patternSource: (slot: number) => projection(slot).source,
    nametableSource: (page: number) => projection(8 + page).source,
    debug: () => debug,
  });
};

export const namco163PatternCandidates = (
  state: NesNamco163State,
  slot: number,
  chrCapacityBytes: number,
): NesNamco163PpuCandidate[] => [
  ...createNamco163PpuCandidates(state, chrCapacityBytes).pattern(slot),
];

export const namco163NametableCandidates = (
  state: NesNamco163State,
  page: number,
  chrCapacityBytes: number,
): NesNamco163PpuCandidate[] => [
  ...createNamco163PpuCandidates(state, chrCapacityBytes).nametable(page),
];

const ppuWindow = (
  header: NesRomMetadata,
  candidates: readonly NesNamco163PpuCandidate[],
  source: PpuWindow["source"],
  start: number,
): PpuWindow => {
  const first = candidates[0];
  const bank =
    source !== "unknown" &&
    candidates.length === 1 &&
    first?.source !== "unknown"
      ? (first?.bank ?? null)
      : null;
  return {
    start,
    size: 1024,
    source,
    bank,
    file_offset:
      source === "chr-rom" && bank !== null
        ? header.chrRom.offset + bank * 1024
        : null,
  };
};
export const namco163Mapping = (
  header: NesRomMetadata,
  state: NesNamco163State,
): NesMapperMapping => {
  const packet = createNamco163PpuCandidates(state, header.chrRom.size);
  const nametables = Array.from({ length: 4 }, (_, page) =>
    ppuWindow(
      header,
      packet.nametable(page),
      packet.nametableSource(page),
      0x2000 + page * 1024,
    ),
  );
  const pages = nametables.map((w) => (w.source === "ciram" ? w.bank : null));
  const arrangement = pages.every((p) => p !== null) ? pages.join("") : null;
  const mirroring =
    arrangement === "0101"
      ? "vertical"
      : arrangement === "0011"
        ? "horizontal"
        : arrangement === "0000"
          ? "one-screen-a"
          : arrangement === "1111"
            ? "one-screen-b"
            : nametables.some((w) => w.source === "unknown" || w.bank === null)
              ? "unknown"
              : "custom";
  const count = header.prgRom.size / 8192;
  const banks = [
    ...state.prg_banks.map((b) => nesByteBits(b, (count - 1) & 63)),
    count - 1,
  ];
  return {
    prg_view: namco163PrgView(state),
    prg_windows: banks.map((bank, i) => ({
      start: 0x8000 + i * 8192,
      size: 8192,
      bank,
      file_offset: bank === null ? null : header.prgRom.offset + bank * 8192,
    })),
    chr_source: "rom-ciram",
    chr_windows: Array.from({ length: 8 }, (_, slot) =>
      ppuWindow(
        header,
        packet.pattern(slot),
        packet.patternSource(slot),
        slot * 1024,
      ),
    ),
    nametable_windows: nametables,
    mirroring,
  };
};
export const namco163Limitations =
  "Namco 129/163 conventional Mapper 19 PRG/CHR-ROM/CIRAM mapping, declared external 8 KiB RAM protection and explicit 15-bit saturating IRQ clocks are conditional models. Normal pattern and nametable candidates retain their shared physical CIRAM identity; selected initial_ppu facts can qualify CIRAM and palette bytes, while unprovided contents remain unknown. Optional chip_ram models 128 physical cells and ordered port read/write effects; increment_model selects saturate or wrap, while omission joins both. Unobserved repeated DMA reads may prevent pointer/data proofs. Visible 4014 writes queue a page until the next supplied CPU read; a replacement request supersedes the earlier page. Source opcode fetches drain pending requests before the next applied instruction. Source initial_irq with qualified initial_cpu_bus emits nominal IRQ CPU edges; plain writes and untimed instructions supply no clocks. With initial_irq model namco163, counter ports return current count bits and the live high-port enable bit without acknowledgement. No physical IRQ delivery is derived. Active audio phase bytes are unknown unless sound is disabled or their channel is known inactive. Source traces with chip_ram use mapper event replay and instruction event ranges, including relevant NMOS indexed/NOP reads; unapplied frontiers commit no events. Without chip_ram, audio RAM ports retain raw writes only; explicit IRQ counter reads remain separate. Native PRG views do not import chip RAM. Possible F000=$3F audio-debug graphics retain an explicit unknown source branch. Debug outputs, pin-44 effects, waveform execution, battery/save-file behavior, mislabeled Namco 175/340 boards and physical timing remain unverified.";
