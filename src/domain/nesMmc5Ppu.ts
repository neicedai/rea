import { z } from "zod";
import {
  joinNesBytes,
  nesByteBits,
  nesByteProof,
  nesKnownBitsSchema,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesMmc5State } from "./nesMmc5.js";
import { nesMmc5RenderingReadSchema } from "./nesMmc5RenderingState.js";
import {
  readMmc5ExramCell,
  updateMmc5ExramCell,
  type NesMmc5ExramCell,
} from "./nesMmc5Exram.js";

export const nesMmc5FetchSchema = z.enum([
  "sprite",
  "background",
  "ppudata",
  "dummy",
]);
export type NesMmc5Fetch = z.infer<typeof nesMmc5FetchSchema>;
type ChrSet = "a" | "b";
const sourceSchema = z.enum(["ciram", "exram", "fill", "zero", "unknown"]);
export const nesMmc5NametableWindowSchema = z.strictObject({
  start: z.number().int().min(0x2000).max(0x2c00),
  size: z.literal(1024),
  source: sourceSchema,
  bank: z.number().int().min(0).max(1).nullable(),
  file_offset: z.null(),
});
const detail = z.strictObject({
  fetch: nesMmc5FetchSchema.nullable(),
  chr_sets: z.array(z.enum(["a", "b"])).max(2),
  registers: z.array(z.number().int().min(0).max(11)).max(12),
  nametable_sources: z.array(sourceSchema).max(4),
  cell_address: z.number().int().min(0).max(1023).nullable(),
  cell_value: nesByteValueSchema,
  limitation: z.enum(["vertical-split", "extended-attributes"]).nullable(),
});
export const nesMmc5PpuContextSchema = z.union([
  detail,
  detail.extend({ rendering: nesMmc5RenderingReadSchema }),
]);
export type NesMmc5PpuContext = z.infer<typeof nesMmc5PpuContextSchema>;
const romSources = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("examined"),
    file_offsets: z
      .array(z.number().int().nonnegative())
      .min(1)
      .max(2816)
      .describe(
        "Every source consistent with retained register/context bit facts, sorted and deduplicated. The 1 MiB CHR ceiling admits 1024 ordinary offsets; split fine-Y alternatives add at most 2048 offsets, with at least 256 overlaps, giving 2816. A common byte does not identify one offset or bank.",
      ),
  }),
  z.strictObject({
    status: z.literal("unresolved"),
    reason: z.enum([
      "rendering-context",
      "chr-ram",
      "inconsistent-snapshot",
      "missing-snapshot",
    ]),
    file_offsets: z.array(z.number().int().nonnegative()).max(2816),
  }),
]);
const read = z.strictObject({
  status: z.enum([
    "chr-rom",
    "unknown-chr-bank",
    "unknown-chr-offset",
    "unknown-nametable-bank",
    "ciram-unobserved",
    "exram",
    "fill-mode",
    "constant-zero",
    "outside-pattern-tables",
  ]),
  bank: z.number().int().min(0).max(1023).nullable(),
  file_offset: z.number().int().nonnegative().nullable(),
  value: z.null(),
  mmc5: z.union([
    detail,
    detail.extend({ rom_sources: romSources }),
    detail.extend({ rendering: nesMmc5RenderingReadSchema }),
    detail.extend({
      rom_sources: romSources,
      rendering: nesMmc5RenderingReadSchema,
    }),
  ]),
});
export const nesMmc5PpuReadSchema = z.union([
  read,
  read.extend({ value: z.number().int().min(0).max(255) }),
  read.extend({ known_bits: nesKnownBitsSchema }),
]);
export type NesMmc5PpuRead = z.infer<typeof nesMmc5PpuReadSchema>;

const bits = (value: NesByteValue) =>
  typeof value === "number"
    ? { mask: 255, value }
    : (value ?? { mask: 0, value: 0 });
const modes = (value: NesByteValue) => {
  const proof = bits(value);
  return [0, 1, 2, 3].filter((n) => (n & proof.mask & 3) === (proof.value & 3));
};
const register = (set: ChrSet, mode: number, slot: number) => {
  const width = 1 << (3 - mode);
  return set === "a"
    ? Math.floor(slot / width) * width + width - 1
    : mode === 0
      ? 11
      : 8 + (Math.floor((slot & 3) / width) * width + width - 1);
};

/** Write-time mode produces a physical ten-bit latch; changing mode cannot rescale the raw byte. */
function* chrBankProofs(
  state: NesMmc5State,
  set: ChrSet,
  slot: number,
  count: number,
) {
  const physical = count - 1;
  for (const mode of modes(state.chr_mode)) {
    const index = register(set, mode, slot),
      low = (1 << (3 - mode)) - 1;
    const byte = bits(state.chr_banks[index] ?? null);
    const upper = bits(state.chr_bank_upper[index] ?? null);
    for (const written of modes(state.chr_bank_modes[index] ?? null)) {
      const shift = 3 - written;
      // In larger modes D0 is duplicated into latch bit 0. Bits 1/2 that
      // hardware research leaves unspecified remain unknown after a mode change.
      const mask =
        ((byte.mask << shift) | (byte.mask & 1) | (upper.mask << (8 + shift))) &
        1023;
      const value =
        ((byte.value << shift) |
          (byte.value & 1) |
          (upper.value << (8 + shift))) &
        1023;
      yield {
        mask: (mask | low) & physical,
        value: ((value & ~low) | (slot & low)) & physical,
      };
    }
  }
}
const chrBank = (
  state: NesMmc5State,
  set: ChrSet,
  slot: number,
  count: number,
): number | null => {
  const found = new Set<number | null>();
  for (const proof of chrBankProofs(state, set, slot, count))
    found.add(proof.mask === count - 1 ? proof.value : null);
  return found.size === 1 ? [...found][0]! : null;
};
export const mmc5ChrWindows = (
  header: NesRomMetadata,
  state: NesMmc5State,
  set: ChrSet,
) =>
  Array.from({ length: 8 }, (_, slot) => {
    const bank =
      header.chrRom.size === 0
        ? null
        : chrBank(state, set, slot, header.chrRom.size / 1024);
    return {
      start: slot * 1024,
      size: 1024,
      bank,
      file_offset: bank === null ? null : header.chrRom.offset + bank * 1024,
    };
  });

/** The role is a supplied qualification, never inferred from a pattern address. */
const substitutions = (state: NesMmc5State): boolean | null =>
  nesByteBits(state.ppu_mask, 8) === 8 || nesByteBits(state.ppu_mask, 16) === 16
    ? true
    : nesByteBits(state.ppu_mask, 24) === 0
      ? false
      : null;
const chrSets = (state: NesMmc5State, fetch?: NesMmc5Fetch): ChrSet[] => {
  if (nesByteBits(state.ppu_control, 32) === 0) return ["a"];
  if (
    (fetch === "sprite" || fetch === "background") &&
    substitutions(state) !== true
  )
    return ["a", "b"];
  if (fetch === "sprite") return ["a"];
  const large = nesByteBits(state.ppu_control, 32);
  const selected: ChrSet[] =
    fetch === "background"
      ? ["b"]
      : fetch === "ppudata" && state.last_chr_set !== null
        ? [state.last_chr_set === "sprite" ? "a" : "b"]
        : ["a", "b"];
  return large === 32 ? selected : [...new Set<ChrSet>(["a", ...selected])];
};
const renderingOverride = (
  state: NesMmc5State,
  attributes: boolean,
  fetch?: NesMmc5Fetch,
): "vertical-split" | "extended-attributes" | null => {
  if (
    fetch === "sprite" ||
    fetch === "ppudata" ||
    fetch === "dummy" ||
    substitutions(state) === false
  )
    return null;
  const possible = modes(state.exram_mode);
  return possible.some((m) => m < 2) && nesByteBits(state.split[0], 128) !== 0
    ? "vertical-split"
    : attributes && possible.includes(1)
      ? "extended-attributes"
      : null;
};
export const mmc5PpuMapping = (header: NesRomMetadata, state: NesMmc5State) => {
  const a = mmc5ChrWindows(header, state, "a"),
    b = mmc5ChrWindows(header, state, "b");
  const sets = chrSets(state);
  const nametables = Array.from({ length: 4 }, (_, quadrant) => {
    const selected = nesByteBits(state.nametable_control, 3 << (quadrant * 2));
    const page = selected === null ? null : selected >> (quadrant * 2);
    const enabled = nesByteBits(state.exram_mode, 2);
    const source: z.infer<typeof sourceSchema> =
      page === null
        ? "unknown"
        : page < 2
          ? "ciram"
          : page === 3
            ? "fill"
            : enabled === 0
              ? "exram"
              : enabled === 2
                ? "zero"
                : "unknown";
    return {
      start: 0x2000 + quadrant * 1024,
      size: 1024 as const,
      source,
      bank: page !== null && page < 2 ? page : null,
      file_offset: null,
    };
  });
  const pages = nametables.map((w) => (w.source === "ciram" ? w.bank : null));
  const mirroring = nametables.some((w) => w.source === "unknown")
    ? ("unknown" as const)
    : pages.every((p) => p === 0)
      ? ("one-screen-a" as const)
      : pages.every((p) => p === 1)
        ? ("one-screen-b" as const)
        : pages.join() === "0,1,0,1"
          ? ("vertical" as const)
          : pages.join() === "0,0,1,1"
            ? ("horizontal" as const)
            : ("custom" as const);
  return {
    chr_windows: a.map((window, slot) =>
      renderingOverride(state, true) === null &&
      sets.every((s) => (s === "a" ? a : b)[slot]!.bank === window.bank)
        ? window
        : { ...window, bank: null, file_offset: null },
    ),
    chr_windows_a: a,
    chr_windows_b: b,
    nametable_windows: nametables,
    mirroring,
  };
};

const palette = (value: NesByteValue): NesByteValue => {
  const proof = bits(value);
  return nesByteProof((proof.mask & 3) * 85, (proof.value & 3) * 85);
};
export type NesMmc5NametableChoice = {
  selector: number;
  source: z.infer<typeof sourceSchema>;
  bank: number | null;
  value: NesByteValue;
  cell?: NesMmc5ExramCell;
};
/** Ordinary mux candidates retain selector/source/bank correlation; this does not classify a rendering fetch. */
export const mmc5NametableChoices = (
  state: NesMmc5State,
  address: number,
): NesMmc5NametableChoice[] => {
  const quadrant = (address >> 10) & 3,
    offset = address & 1023;
  const control = bits(state.nametable_control),
    shift = quadrant * 2;
  const selectors = [0, 1, 2, 3].filter(
    (n) => (n & (control.mask >> shift)) === ((control.value >> shift) & 3),
  );
  return selectors.flatMap((selector): NesMmc5NametableChoice[] =>
    selector < 2
      ? [{ selector, source: "ciram", bank: selector, value: null }]
      : selector === 3
        ? [
            {
              selector,
              source: "fill",
              bank: null,
              value:
                offset < 960 ? state.fill_tile : palette(state.fill_attribute),
            },
          ]
        : [...new Set(modes(state.exram_mode).map((mode) => mode < 2))].map(
            (enabled) => ({
              selector,
              source: enabled ? "exram" : "zero",
              bank: null,
              ...(enabled ? { cell: readMmc5ExramCell(state, offset) } : {}),
              value: enabled
                ? state.exram_written === false
                  ? null
                  : readMmc5ExramCell(state, offset).value
                : 0,
            }),
          ),
  );
};

/** Qualified ordinary PPU reads; unresolved rendering overrides invalidate the result, never the stored bytes. */
export const readMmc5Ppu = (
  header: NesRomMetadata,
  state: NesMmc5State,
  address: number,
  {
    fetch,
    chr,
    ordinary = false,
  }: {
    fetch?: NesMmc5Fetch | undefined;
    chr?: Uint8Array | undefined;
    /** Request the ordinary mux as one joined rendering alternative. */
    ordinary?: boolean;
  } = {},
): NesMmc5PpuRead => {
  const normalized =
    address >= 0x3000 && address < 0x3f00 ? address - 0x1000 : address;
  const pattern = address < 8192,
    nametable = normalized >= 0x2000 && normalized < 0x3000;
  const limitation =
    !ordinary && (pattern || nametable)
      ? renderingOverride(state, pattern || (normalized & 1023) >= 960, fetch)
      : null;
  const sets = pattern ? chrSets(state, fetch) : [];
  const registers = pattern
    ? [
        ...new Set(
          sets.flatMap((set) =>
            modes(state.chr_mode).map((mode) =>
              register(set, mode, address >> 10),
            ),
          ),
        ),
      ]
    : [];
  const choices = nametable ? mmc5NametableChoices(state, normalized) : [];
  const mmc5: z.infer<typeof detail> = {
    fetch: fetch ?? null,
    chr_sets: sets,
    registers,
    nametable_sources: [...new Set(choices.map((c) => c.source))],
    cell_address: choices.some((c) => c.source === "exram")
      ? normalized & 1023
      : null,
    cell_value: choices.some((c) => c.source === "exram")
      ? readMmc5ExramCell(state, normalized & 1023).value
      : null,
    limitation,
  };
  let bank: number | null = null,
    file_offset: number | null = null,
    value: NesByteValue = null;
  let status: NesMmc5PpuRead["status"] = nametable
    ? "unknown-nametable-bank"
    : pattern
      ? "unknown-chr-bank"
      : "outside-pattern-tables";
  if (limitation === null && pattern) {
    const banks = sets.map((set) =>
      header.chrRom.size === 0
        ? null
        : chrBank(state, set, address >> 10, header.chrRom.size / 1024),
    );
    if (banks.every((b) => b === banks[0]) && banks[0] !== null) {
      bank = banks[0]!;
      file_offset = header.chrRom.offset + bank * 1024 + (address & 1023);
      status = "chr-rom";
    }
  } else if (limitation === null && nametable) {
    value = choices.map((c) => c.value).reduce(joinNesBytes);
    if (choices.every((c) => c.source === choices[0]!.source)) {
      const source = choices[0]!.source;
      status =
        source === "ciram"
          ? "ciram-unobserved"
          : source === "exram"
            ? "exram"
            : source === "fill"
              ? "fill-mode"
              : "constant-zero";
      if (choices.every((c) => c.bank === choices[0]!.bank))
        bank = choices[0]!.bank;
    }
  }
  const base = { status, bank, file_offset, mmc5 };
  const result: NesMmc5PpuRead =
    typeof value === "number"
      ? { ...base, value }
      : value === null
        ? { ...base, value: null }
        : { ...base, value: null, known_bits: value };
  return chr === undefined || !pattern
    ? result
    : readChrBytes(result, { header, state, address, fetch, chr });
};

/** Finite physical address candidates retain complete provenance for common-byte proofs. */
const readChrBytes = (
  source: NesMmc5PpuRead,
  {
    header,
    state,
    address,
    fetch,
    chr,
  }: {
    header: NesRomMetadata;
    state: NesMmc5State;
    address: number;
    fetch: NesMmc5Fetch | undefined;
    chr: Uint8Array;
  },
): NesMmc5PpuRead => {
  const reason =
    source.mmc5.limitation !== null
      ? "rendering-context"
      : header.chrRom.size === 0
        ? "chr-ram"
        : chr.length !== header.chrRom.size
          ? "inconsistent-snapshot"
          : null;
  if (reason !== null)
    return {
      ...source,
      mmc5: {
        ...source.mmc5,
        rom_sources: { status: "unresolved", reason, file_offsets: [] },
      },
    };
  const offsets = mmc5ChrOffsets(header, state, address, fetch);
  const { value, rom_sources } = mmc5ChrByteProof(header, chr, offsets);
  const base = {
    status: source.status,
    bank: source.bank,
    file_offset: source.file_offset,
    mmc5: {
      ...source.mmc5,
      rom_sources,
    },
  };
  return typeof value === "number"
    ? { ...base, value }
    : value === null
      ? { ...base, value: null }
      : { ...base, value: null, known_bits: value };
};

export const mmc5ChrOffsets = (
  header: NesRomMetadata,
  state: NesMmc5State,
  address: number,
  fetch?: NesMmc5Fetch,
): number[] => {
  const count = header.chrRom.size / 1024,
    banks = new Set<number>();
  if (count === 0) return [];
  for (const set of chrSets(state, fetch))
    for (const proof of chrBankProofs(state, set, address >> 10, count))
      for (let bank = 0; bank < count; bank++)
        if ((bank & proof.mask) === (proof.value & proof.mask)) banks.add(bank);
  return [...banks]
    .sort((a, b) => a - b)
    .map((bank) => header.chrRom.offset + bank * 1024 + (address & 1023));
};

/** Shared ordinary/rendering byte proof, with original offsets retained independently of byte agreement. */
export const mmc5ChrByteProof = (
  header: NesRomMetadata,
  chr: Uint8Array | undefined,
  offsets: readonly number[],
): {
  value: NesByteValue;
  rom_sources: z.infer<typeof romSources>;
} => {
  const reason =
    header.chrRom.size === 0
      ? "chr-ram"
      : chr === undefined
        ? "missing-snapshot"
        : chr.length !== header.chrRom.size
          ? "inconsistent-snapshot"
          : offsets.length === 0
            ? "rendering-context"
            : null;
  const file_offsets = [...new Set(offsets)].sort((a, b) => a - b);
  if (reason !== null)
    return {
      value: null,
      rom_sources: { status: "unresolved", reason, file_offsets },
    };
  const value = file_offsets
    .map<NesByteValue>((offset) => chr![offset - header.chrRom.offset]!)
    .reduce(joinNesBytes);
  return { value, rom_sources: { status: "examined", file_offsets } };
};

/** PPU nametable writes reach ExRAM only under the selected page and mode; uncertain access joins old/new facts. */
export const writeMmc5Ppu = (
  state: NesMmc5State,
  address: number,
  value: NesByteValue,
  eventIndex?: number,
):
  | "exram-write"
  | "exram-write-ignored"
  | "uncertain-exram-write"
  | "outside-mapper" => {
  const normalized =
    address >= 0x3000 && address < 0x3f00 ? address - 0x1000 : address;
  if (normalized < 0x2000 || normalized >= 0x3000) return "outside-mapper";
  const choices = mmc5NametableChoices(state, normalized),
    reaches = choices.map((c) => c.source === "exram");
  if (!reaches.some(Boolean)) return "exram-write-ignored";
  const definite = reaches.every(Boolean);
  updateMmc5ExramCell(state, normalized & 1023, value, {
    access:
      state.exram_written === false
        ? "invalidate"
        : definite
          ? "write"
          : "conditional-write",
    eventIndex,
  });
  return definite && state.exram_written !== false
    ? "exram-write"
    : "uncertain-exram-write";
};
