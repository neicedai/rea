import { z } from "zod";
import {
  joinNesBytes,
  nesByteBits,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesRomMetadata } from "./nes.js";
import type {
  NesMapperState,
  NesMapperWrite,
  NesMapperTraceStep,
} from "./nesMapperTrace.js";

export const nesFme7VariantSchema = z.enum(["fme7", "5a", "5b"]);
export type NesFme7Variant = z.infer<typeof nesFme7VariantSchema>;
const fields = {
  mapper: z.literal(69),
  prg_ram_enable: z
    .enum(["register-bit7", "ungated"])
    .nullable()
    .default(null)
    .describe(
      "Explicit board gate assumption for cartridge RAM. register-bit7 requires a positive-CE input or equivalent board gate; standard 2/32/512 KiB SRAM lacks that input. ungated ignores D7. Capacity alone does not identify the gate; omission leaves RAM permission unknown.",
    ),
  command: nesByteValueSchema.default(null),
  bank_6000: nesByteValueSchema.default(null),
  prg_banks: z.array(nesByteValueSchema).length(3).default([null, null, null]),
  chr_banks: z
    .array(nesByteValueSchema)
    .length(8)
    .default(Array.from({ length: 8 }, () => null)),
  mirroring: nesByteValueSchema.default(null),
  irq_control: nesByteValueSchema.default(null),
  irq_low: nesByteValueSchema.default(null),
  irq_high: nesByteValueSchema.default(null),
};
export const nesFme7StateSchema = z.union([
  z.strictObject({ ...fields, variant: z.enum(["fme7", "5a"]) }),
  z.strictObject({
    ...fields,
    variant: z.literal("5b"),
    audio_select: nesByteValueSchema.default(null),
    audio_registers: z
      .array(nesByteValueSchema)
      .length(16)
      .default(Array.from({ length: 16 }, () => null)),
  }),
]);
export type NesFme7State = z.infer<typeof nesFme7StateSchema>;
export const isFme7State = (state: NesMapperState): state is NesFme7State =>
  state.mapper === 69;
const view = (max: number) => ({
  mapper: z.literal(69),
  lower_window: z.union([
    z.strictObject({
      source: z.literal("rom"),
      bank: z.number().int().min(0).max(max),
    }),
    z.strictObject({ source: z.literal("ram") }),
  ]),
  prg_bank_0: z.number().int().min(0).max(max),
  prg_bank_1: z.number().int().min(0).max(max),
  prg_bank_2: z.number().int().min(0).max(max),
});
export const nesFme7ViewSchema = z.union([
  z.strictObject({ ...view(63), variant: z.literal("fme7") }),
  z.strictObject({ ...view(31), variant: z.enum(["5a", "5b"]) }),
]);
export type NesFme7View = z.infer<typeof nesFme7ViewSchema>;
export const fme7Mask = (variant: NesFme7Variant) =>
  variant === "fme7" ? 63 : 31;
export const fme7Commands = (command: NesByteValue): number[] =>
  Array.from({ length: 16 }, (_, n) => n).filter((n) =>
    typeof command === "number"
      ? n === (command & 15)
      : command === null || (n & command.mask & 15) === (command.value & 15),
  );

export const fme7PrgView = (state: NesFme7State): NesFme7View | null => {
  const mask = fme7Mask(state.variant),
    banks = state.prg_banks.map((b) => nesByteBits(b, mask)),
    mode = nesByteBits(state.bank_6000, 64),
    low = nesByteBits(state.bank_6000, mask);
  if (
    banks.some((b) => b === null) ||
    mode === null ||
    (mode === 0 && low === null)
  )
    return null;
  return {
    mapper: 69,
    variant: state.variant,
    lower_window:
      mode === 64 ? { source: "ram" } : { source: "rom", bank: low! },
    prg_bank_0: banks[0]!,
    prg_bank_1: banks[1]!,
    prg_bank_2: banks[2]!,
  };
};

export const fme7RamLayout = (
  header: NesRomMetadata,
  variant: NesFme7Variant,
) => {
  const ram = header.prgRamSize ?? 0,
    nvram = header.prgNvramSize ?? 0,
    size = ram + nvram;
  return header.headerVersion === "nes2" &&
    (ram === 0 || nvram === 0) &&
    size >= 2048 &&
    size <= (fme7Mask(variant) + 1) * 8192 &&
    Number.isInteger(Math.log2(size))
    ? {
        start: 0x6000,
        bank_size: Math.min(size, 8192),
        bank_count: Math.max(1, size / 8192),
      }
    : null;
};
export const fme7RamBanks = (state: NesFme7State, count: number) =>
  Array.from({ length: count }, (_, n) => n).filter((n) =>
    typeof state.bank_6000 === "number"
      ? n === (state.bank_6000 & (count - 1))
      : state.bank_6000 === null ||
        (n & state.bank_6000.mask & (count - 1)) ===
          (state.bank_6000.value & (count - 1)),
  );
export const fme7RamPermission = (state: NesFme7State): boolean | null => {
  if (state.prg_ram_enable === "ungated") return true;
  if (state.prg_ram_enable === null) return null;
  const bit = nesByteBits(state.bank_6000, 128);
  return bit === null ? null : bit === 128;
};
export const nesFme7LowerWindowSchema = z.strictObject({
  start: z.literal(24576),
  size: z.literal(8192),
  source: z.enum(["rom", "ram-unobserved", "unknown"]),
  bank: z.number().int().min(0).max(63).nullable(),
  file_offset: z.number().int().nonnegative().nullable(),
  readable: z.boolean().nullable(),
  writable: z.boolean().nullable(),
});
export const fme7LowerWindow = (
  header: NesRomMetadata,
  state: NesFme7State,
): z.infer<typeof nesFme7LowerWindowSchema> => {
  const mode = nesByteBits(state.bank_6000, 64),
    layout = fme7RamLayout(header, state.variant),
    bank =
      mode === 0
        ? nesByteBits(
            state.bank_6000,
            (header.prgRom.size / 8192 - 1) & fme7Mask(state.variant),
          )
        : mode === 64 && layout !== null
          ? nesByteBits(state.bank_6000, layout.bank_count - 1)
          : null;
  const permission = layout === null ? null : fme7RamPermission(state);
  return {
    start: 24576,
    size: 8192,
    source: mode === 0 ? "rom" : mode === 64 ? "ram-unobserved" : "unknown",
    bank,
    file_offset:
      mode === 0 && bank !== null ? header.prgRom.offset + bank * 8192 : null,
    readable:
      mode === 0
        ? true
        : mode === 64
          ? permission
          : permission === true
            ? true
            : null,
    writable:
      mode === 0
        ? false
        : permission === false
          ? false
          : mode === 64
            ? permission
            : null,
  };
};

const parameter = (
  state: NesFme7State,
  command: number,
  byte: NesByteValue,
): NesMapperTraceStep["effect"] => {
  if (command < 8) {
    state.chr_banks[command] = byte;
    return "chr-bank";
  }
  if (command === 8) {
    state.bank_6000 = byte;
    return "prg-ram-control";
  }
  if (command < 12) {
    state.prg_banks[command - 9] = byte;
    return "prg-bank";
  }
  if (command === 12) {
    state.mirroring = byte;
    return "nametable";
  }
  if (command === 13) {
    state.irq_control = byte;
    return "irq-control";
  }
  state[command === 14 ? "irq_low" : "irq_high"] = byte;
  return "irq-latch";
};
export const applyFme7Write = (
  state: NesFme7State,
  write: NesMapperWrite,
): Pick<NesMapperTraceStep, "state" | "effect"> => {
  const byte = write.value ?? ("known_bits" in write ? write.known_bits : null),
    port = write.address & 0xe000;
  if (port === 0x8000) {
    state.command = byte;
    return { state, effect: "bank-select" };
  }
  if (port === 0xa000) {
    const commands = fme7Commands(state.command);
    if (commands.length === 1)
      return { state, effect: parameter(state, commands[0]!, byte) };
    const variants = commands.map((command) => {
      const branch = structuredClone(state);
      parameter(branch, command, byte);
      return branch;
    });
    for (const key of [
      "bank_6000",
      "mirroring",
      "irq_control",
      "irq_low",
      "irq_high",
    ] as const)
      state[key] = variants.reduce<NesByteValue>(
        (v, s) => joinNesBytes(v, s[key]),
        variants[0]![key],
      );
    for (const key of ["prg_banks", "chr_banks"] as const)
      state[key] = state[key].map((_, i) =>
        variants.reduce<NesByteValue>(
          (v, s) => joinNesBytes(v, s[key][i]!),
          variants[0]![key][i]!,
        ),
      );
    return { state, effect: "uncertain-register-write" };
  }
  if (state.variant === "5b" && port === 0xc000) {
    state.audio_select = byte;
    return { state, effect: "audio-register" };
  }
  if (state.variant === "5b" && port === 0xe000) {
    const high = nesByteBits(state.audio_select, 240),
      selected = nesByteBits(state.audio_select, 15);
    if (
      (high !== null && high !== 0) ||
      (state.audio_select !== null &&
        typeof state.audio_select !== "number" &&
        (state.audio_select.value & 240) !== 0)
    )
      return { state, effect: "outside-mapper" };
    const choices = fme7Commands(state.audio_select);
    for (const i of choices)
      state.audio_registers[i] =
        high === 0 && selected !== null
          ? byte
          : joinNesBytes(state.audio_registers[i]!, byte);
    return { state, effect: "audio-register" };
  }
  return { state, effect: "outside-mapper" };
};
export const fme7Limitations =
  "Mapper 69 uses an explicit immutable fme7/5a/5b chip assumption. FME-7 admits six bank bits and up to 512 KiB PRG/RAM; 5A/5B use five and at most 256 KiB. Three independently selected 8 KiB PRG windows and a fixed last bank coexist with a selected 8 KiB ROM/RAM window at 6000–7FFF; partial modes and banks remain unknown. Explicit NES 2.0 single-chip RAM capacities define physical banks and 2 KiB mirrors; register-bit7 versus ungated RAM enable is a separate caller assumption, not inferred from capacity. CHR selectors use eight independent 1 KiB windows. IRQ uses explicit fme7 CPU cycles and a separate count-enable/IRQ-enable control; writes do not imply elapsed time or CPU IRQ acceptance. 5B retains raw audio select/register facts, including disabled high address bits, without waveform simulation or a physical chip identity claim. External IRQ inputs, analog timing, mixed ROM/RAM wiring and power-on state remain unobserved.";
