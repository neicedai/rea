import { z } from "zod";
import { writeMmc5Exram } from "./nesMmc5Cpu.js";
import { nesMmc5ExramSchema } from "./nesMmc5Exram.js";
import { mmc5PpuMapping } from "./nesMmc5Ppu.js";
import {
  nesMmc5RenderingStateSchema,
  invalidateMmc5RenderingWrite,
} from "./nesMmc5RenderingState.js";
import {
  nesByteValueSchema,
  nesByteBits,
  nesByteCandidates,
} from "./nesByteValue.js";
import type { NesRomMetadata } from "./nes.js";
import type {
  NesMapperState,
  NesMapperWrite,
  NesMapperTraceStep,
  NesMapperMapping,
} from "./nesMapperTrace.js";

export const nesMmc5RamWiringSchema = z.enum([
  "none",
  "ekrom",
  "etrom",
  "ewrom",
  "linear-64k",
  "linear-128k",
]);
const mmc5State = z.strictObject({
  mapper: z.literal(5),
  prg_mode: nesByteValueSchema.default(null),
  prg_banks: z
    .array(nesByteValueSchema)
    .length(5)
    .default([null, null, null, null, null])
    .describe(
      "Raw 5113–5117 bytes. 5113 always selects RAM; 5117 always selects ROM. Mode selects which intervening registers drive each CPU window.",
    ),
  ram_protect: z
    .array(nesByteValueSchema)
    .length(2)
    .default([null, null])
    .describe(
      "Raw 5102/5103 bytes; D0–D1 must equal 2 and 1 respectively for external RAM writes.",
    ),
  ram_wiring: nesMmc5RamWiringSchema
    .nullable()
    .default(null)
    .describe(
      "Explicit external RAM interpretation. Licensed EKROM/ETROM/EWROM preserve chip-select holes and aliases. Linear 64/128 KiB profiles follow the NES2 emulator convention, not identified board wiring. Nonempty layouts require matching NES2 RAM declarations; omission leaves RAM wiring unknown.",
    ),
  chr_mode: nesByteValueSchema.default(null),
  chr_banks: z
    .array(nesByteValueSchema)
    .length(12)
    .default(Array.from({ length: 12 }, () => null)),
  chr_bank_upper: z
    .array(nesByteValueSchema)
    .length(12)
    .default(Array.from({ length: 12 }, () => null))
    .describe(
      "Raw 5130 snapshot captured separately when each 5120–512B register is written; later 5130 writes do not retroactively change it.",
    ),
  chr_bank_modes: z
    .array(nesByteValueSchema)
    .length(12)
    .default(Array.from({ length: 12 }, () => null))
    .describe(
      "Raw 5101 snapshot when each 5120–512B register was written. Together with the raw byte and captured 5130, this establishes its physical ten-bit latch. Missing write-time mode stays unknown; later mode changes do not rescale a stored raw byte.",
    ),
  ppu_control: nesByteValueSchema
    .default(null)
    .describe(
      "MMC5's exact-address 2000 snoop, including sprite-size D5. PPU register mirrors do not update this fact. This is not the PPU's mirrored PPUCTRL state.",
    ),
  ppu_mask: nesByteValueSchema
    .default(null)
    .describe(
      "MMC5's exact-address 2001 snoop. D3/D4 enable PPU data substitutions; either proven set bit establishes enable. PPU mirrors do not update this latch, and no rendering/frame state is inferred.",
    ),
  last_chr_set: z.enum(["sprite", "background"]).nullable().default(null),
  chr_upper: nesByteValueSchema.default(null),
  exram_mode: nesByteValueSchema.default(null),
  exram_written: z
    .boolean()
    .nullable()
    .default(null)
    .describe(
      "Whether 5104 has been written since the last qualified reset. Reset establishes false and an exact 5104 write establishes true. The purpose of this hardware latch is not fully understood; false/unresolved reset-mode access remains unknown without discarding stored bytes. A proven non-reset mode under the conventional profile establishes a prior write.",
    ),
  exram: nesMmc5ExramSchema.default({}),
  nametable_control: nesByteValueSchema.default(null),
  fill_tile: nesByteValueSchema.default(null),
  fill_attribute: nesByteValueSchema.default(null),
  split: z.array(nesByteValueSchema).length(3).default([null, null, null]),
  irq_target: nesByteValueSchema.default(null),
  irq_control: nesByteValueSchema
    .default(null)
    .describe(
      "Last raw CPU write to 5204. An explicit initial_irq mmc5 model owns the current enable latch, which can differ after reset; this raw fact alone does not establish a scanline IRQ line.",
    ),
  multiplier: z.array(nesByteValueSchema).length(2).default([null, null]),
  audio_writes: z
    .array(nesByteValueSchema)
    .length(11)
    .default(Array.from({ length: 11 }, () => null))
    .describe(
      "Last raw writes to 5000–5007, 5010, 5011, 5015; not decoded hardware latches, waveforms or PCM IRQ state.",
    ),
});
export const nesMmc5StateSchema = z.union([
  mmc5State,
  mmc5State.extend({ ppu: nesMmc5RenderingStateSchema }),
]);
export type NesMmc5State = z.infer<typeof nesMmc5StateSchema>;
export const isMmc5State = (state: NesMapperState): state is NesMmc5State =>
  state.mapper === 5;
const bank = z.number().int().min(0).max(255),
  romBank = bank.max(127);
export const nesMmc5ViewSchema = z.discriminatedUnion("prg_mode", [
  z.strictObject({
    mapper: z.literal(5),
    prg_mode: z.literal(0),
    bank_e000: romBank,
  }),
  z.strictObject({
    mapper: z.literal(5),
    prg_mode: z.literal(1),
    bank_a000: bank,
    bank_e000: romBank,
  }),
  z.strictObject({
    mapper: z.literal(5),
    prg_mode: z.literal(2),
    bank_a000: bank,
    bank_c000: bank,
    bank_e000: romBank,
  }),
  z.strictObject({
    mapper: z.literal(5),
    prg_mode: z.literal(3),
    bank_8000: bank,
    bank_a000: bank,
    bank_c000: bank,
    bank_e000: romBank,
  }),
]);
export type NesMmc5View = z.infer<typeof nesMmc5ViewSchema>;
export const mmc5PrgView = (state: NesMmc5State): NesMmc5View | null => {
  const mode = nesByteBits(state.prg_mode, 3),
    e = nesByteBits(state.prg_banks[4], 127);
  if (mode === null || e === null) return null;
  if (mode === 0) return { mapper: 5, prg_mode: 0, bank_e000: e };
  const a = nesByteBits(state.prg_banks[2], 255);
  if (a === null) return null;
  if (mode === 1) return { mapper: 5, prg_mode: 1, bank_a000: a, bank_e000: e };
  const c = nesByteBits(state.prg_banks[3], 255);
  if (c === null) return null;
  if (mode === 2)
    return { mapper: 5, prg_mode: 2, bank_a000: a, bank_c000: c, bank_e000: e };
  const p = nesByteBits(state.prg_banks[1], 255);
  return p === null
    ? null
    : {
        mapper: 5,
        prg_mode: 3,
        bank_8000: p,
        bank_a000: a,
        bank_c000: c,
        bank_e000: e,
      };
};
export const mmc5StateFromView = (view: NesMmc5View): NesMmc5State =>
  nesMmc5StateSchema.parse({
    mapper: 5,
    prg_mode: view.prg_mode,
    prg_banks: [
      null,
      "bank_8000" in view ? view.bank_8000 : null,
      "bank_a000" in view ? view.bank_a000 : null,
      "bank_c000" in view ? view.bank_c000 : null,
      view.bank_e000,
    ],
  });
export const mmc5ViewKey = (view: NesMmc5View) => [
  5,
  view.prg_mode,
  ...("bank_8000" in view ? [view.bank_8000] : []),
  ...("bank_a000" in view ? [view.bank_a000] : []),
  ...("bank_c000" in view ? [view.bank_c000] : []),
  view.bank_e000,
];
export const mmc5ViewName = (view: NesMmc5View) =>
  `NES_M5_M${view.prg_mode}${"bank_8000" in view ? `_P${view.bank_8000.toString(16).padStart(2, "0")}` : ""}${"bank_a000" in view ? `_Q${view.bank_a000.toString(16).padStart(2, "0")}` : ""}${"bank_c000" in view ? `_R${view.bank_c000.toString(16).padStart(2, "0")}` : ""}_E${view.bank_e000.toString(16).padStart(2, "0")}`;

export const mmc5RamSize = (
  wiring: NesMmc5State["ram_wiring"],
): number | null =>
  wiring === null
    ? null
    : {
        none: 0,
        ekrom: 8192,
        etrom: 16384,
        ewrom: 32768,
        "linear-64k": 65536,
        "linear-128k": 131072,
      }[wiring];
export const mmc5RamAdmission = (
  header: NesRomMetadata,
  state: NesMmc5State,
): string | null => {
  const size = mmc5RamSize(state.ram_wiring);
  if (size === null) return null;
  const ram = header.prgRamSize ?? 0,
    nvram = header.prgNvramSize ?? 0;
  if (header.headerVersion !== "nes2")
    return "An MMC5 RAM wiring choice requires matching explicit NES 2.0 RAM/NVRAM declarations.";
  if (
    ram + nvram !== size ||
    (state.ram_wiring === "etrom"
      ? ![0, 8192, 16384].includes(ram) || ![0, 8192, 16384].includes(nvram)
      : ram !== 0 && nvram !== 0)
  )
    return "MMC5 ram_wiring does not match declared physical RAM/NVRAM capacity and chip arrangement.";
  return null;
};
const physicalRamBank = (
  wiring: NesMmc5State["ram_wiring"],
  selector: number,
): number | "unmapped" | "unknown" => {
  if (wiring === null) return "unknown";
  if (wiring === "none") return "unmapped";
  if (wiring === "ekrom") return (selector & 4) !== 0 ? "unmapped" : 0;
  if (wiring === "etrom") return (selector & 4) !== 0 ? 1 : 0;
  if (wiring === "ewrom")
    return (selector & 4) !== 0 ? "unmapped" : selector & 3;
  return selector & (wiring === "linear-64k" ? 7 : 15);
};
export type NesMmc5CpuCandidate =
  | { source: "rom" | "ram"; bank: number }
  | { source: "unmapped" | "unknown" };
export const mmc5CpuCandidates = (
  header: NesRomMetadata,
  state: NesMmc5State,
  address: number,
): NesMmc5CpuCandidate[] => {
  if (address < 0x6000 || address > 0xffff) return [];
  const slot = (address - 0x6000) >> 13,
    found = new Map<string, NesMmc5CpuCandidate>();
  const modes = [
    ...new Set(nesByteCandidates(state.prg_mode).map((v) => v & 3)),
  ];
  for (const mode of modes) {
    const reg =
      slot === 0
        ? 0
        : mode === 0
          ? 4
          : mode === 1
            ? slot < 3
              ? 2
              : 4
            : mode === 2
              ? slot < 3
                ? 2
                : slot
              : slot;
    const pair =
      slot === 0
        ? 0
        : mode === 0
          ? 3
          : mode === 1 || (mode === 2 && slot < 3)
            ? 1
            : 0;
    const forced = pair === 3 ? slot - 1 : pair === 1 ? (slot - 1) & 1 : 0;
    for (const raw of nesByteCandidates(state.prg_banks[reg] ?? null)) {
      const selected = (raw & ~pair) | forced;
      const rom = slot !== 0 && (reg === 4 || (raw & 128) !== 0);
      const ram = rom ? null : physicalRamBank(state.ram_wiring, selected & 15);
      const candidate: NesMmc5CpuCandidate = rom
        ? {
            source: "rom",
            bank: selected & (header.prgRom.size / 8192 - 1) & 127,
          }
        : typeof ram === "number"
          ? { source: "ram", bank: ram }
          : { source: ram! };
      found.set(JSON.stringify(candidate), candidate);
    }
  }
  return [...found.values()];
};
export const mmc5RamPermission = (state: NesMmc5State): boolean | null => {
  const a = [
    ...new Set(
      nesByteCandidates(state.ram_protect[0] ?? null).map((v) => v & 3),
    ),
  ];
  const b = [
    ...new Set(
      nesByteCandidates(state.ram_protect[1] ?? null).map((v) => v & 3),
    ),
  ];
  return !a.includes(2) || !b.includes(1)
    ? false
    : a.length === 1 && b.length === 1
      ? true
      : null;
};
export const nesMmc5CpuWindowSchema = z.strictObject({
  start: z.number().int().min(0x6000).max(0xe000),
  size: z.literal(8192),
  source: z.enum(["rom", "ram-unobserved", "unmapped", "unknown"]),
  bank: z.number().int().min(0).max(127).nullable(),
  file_offset: z.number().int().nonnegative().nullable(),
  readable: z.boolean().nullable(),
  writable: z.boolean().nullable(),
});
export const mmc5Mapping = (
  header: NesRomMetadata,
  state: NesMmc5State,
): NesMapperMapping => {
  const windows = Array.from({ length: 5 }, (_, i) => {
    const start = 0x6000 + i * 8192,
      c = mmc5CpuCandidates(header, state, start),
      first = c[0]!;
    const same = c.every((v) => v.source === first.source),
      source = same ? first.source : "unknown";
    const bank =
      (source === "rom" || source === "ram") &&
      c.every((v) => "bank" in v && "bank" in first && v.bank === first.bank) &&
      "bank" in first
        ? first.bank
        : null;
    return {
      start,
      size: 8192 as const,
      source: source === "ram" ? ("ram-unobserved" as const) : source,
      bank,
      file_offset:
        source === "rom" && bank !== null
          ? header.prgRom.offset + bank * 8192
          : null,
      readable:
        source === "rom" || source === "ram"
          ? true
          : source === "unmapped"
            ? false
            : null,
      writable:
        source === "rom" || source === "unmapped"
          ? false
          : source === "ram"
            ? mmc5RamPermission(state)
            : mmc5RamPermission(state) === false
              ? false
              : null,
    };
  });
  return {
    prg_view: mmc5PrgView(state),
    prg_windows: windows.slice(1).map((w) => ({
      start: w.start,
      size: w.size,
      bank: w.source === "rom" ? w.bank : null,
      file_offset: w.file_offset,
    })),
    cpu_windows: windows,
    chr_source: header.chrRom.size === 0 ? "ram-unobserved" : "rom",
    ...mmc5PpuMapping(header, state),
  };
};
/** Qualified reset establishes only documented latch bits, never an unobserved power-on image. */
export const applyMmc5Reset = (state: NesMmc5State): NesMmc5State => {
  state.prg_mode = { mask: 3, value: 3 };
  state.ram_protect = [
    { mask: 3, value: 1 },
    { mask: 3, value: 2 },
  ];
  state.exram_mode = { mask: 3, value: 3 };
  state.exram_written = false;
  state.chr_upper = { mask: 3, value: 0 };
  state.split[0] = { mask: 223, value: 0 };
  state.split[1] = 0;
  if ("ppu" in state) {
    state.ppu.phase = "unknown";
    state.ppu.split_y = null;
  }
  return state;
};
export const applyMmc5Write = (
  state: NesMmc5State,
  write: NesMapperWrite,
  inFrame?: boolean | null,
  eventIndex?: number,
): Pick<NesMapperTraceStep, "state" | "effect"> => {
  const a = write.address,
    byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  if ("ppu" in state)
    invalidateMmc5RenderingWrite(
      state.ppu,
      a,
      a === 0x2001
        ? state.ppu_mask
        : a === 0x5104
          ? state.exram_mode
          : (state.split[0] ?? null),
      byte,
    );
  if (a === 0x2000 || a === 0x2001) {
    state[a === 0x2000 ? "ppu_control" : "ppu_mask"] = byte;
    return { state, effect: "register-commit" };
  }
  if (a >= 0x5c00 && a <= 0x5fff) {
    return {
      state,
      effect: writeMmc5Exram(state, a, byte, inFrame, eventIndex),
    };
  }
  if (a === 0x5100) {
    state.prg_mode = byte;
    return { state, effect: "prg-bank" };
  }
  if (a >= 0x5113 && a <= 0x5117) {
    state.prg_banks[a - 0x5113] = byte;
    return { state, effect: "prg-bank" };
  }
  if (a === 0x5102 || a === 0x5103) {
    state.ram_protect[a - 0x5102] = byte;
    return { state, effect: "ram-control" };
  }
  if (a === 0x5101) state.chr_mode = byte;
  else if (a >= 0x5120 && a <= 0x512b) {
    state.chr_banks[a - 0x5120] = byte;
    state.chr_bank_upper[a - 0x5120] = state.chr_upper;
    state.chr_bank_modes[a - 0x5120] = state.chr_mode;
    state.last_chr_set = a <= 0x5127 ? "sprite" : "background";
  } else if (a === 0x5130) state.chr_upper = byte;
  else if (a === 0x5104) {
    state.exram_mode = byte;
    state.exram_written = true;
  } else if (a === 0x5105) state.nametable_control = byte;
  else if (a === 0x5106) state.fill_tile = byte;
  else if (a === 0x5107) state.fill_attribute = byte;
  else if (a >= 0x5200 && a <= 0x5202) state.split[a - 0x5200] = byte;
  else if (a === 0x5203) state.irq_target = byte;
  else if (a === 0x5204) state.irq_control = byte;
  else if (a === 0x5205 || a === 0x5206) state.multiplier[a - 0x5205] = byte;
  else {
    const audio = [
      0x5000, 0x5001, 0x5002, 0x5003, 0x5004, 0x5005, 0x5006, 0x5007, 0x5010,
      0x5011, 0x5015,
    ].indexOf(a);
    if (audio < 0) return { state, effect: "outside-mapper" };
    state.audio_writes[audio] = byte;
    return { state, effect: "audio-register" };
  }
  return { state, effect: "register-commit" };
};
export const mmc5Limitations =
  "MMC5 models four PRG modes, ROM/RAM source selection, explicit RAM wiring aliases/holes, write protection, mixed-source provenance and selected ROM-only native import windows. Its unsigned 8x8 multiplier reads derive exact common bits from current factor assumptions. Sparse 1 KiB ExRAM facts support CPU read/write mode 2 and readonly mode 3, independent of external RAM protection. Optional retained cells preserve absolute ppu-memory writer indices through the same event cursor, and ordered rendering captures preserve historical cell origins. Shared ppu-memory reads/writes use the same ExRAM owner, explicit CIRAM backing and tagged fill/zero sources; no ExRAM image is duplicated into nametable storage. Partial modes join outcomes; modes 0/1 read open bus. Their CPU writes use the byte only with a proven in-frame fact from the explicit event IRQ model; otherwise they invalidate the addressed cell rather than assuming a particular corruption or emulator zero. CHR A/B windows use physical ten-bit latches derived from write-time mode, raw byte and captured upper bits; mode changes never rescale previous bytes, and unspecified latch bits remain unknown. Exact 2000/2001 snooping preserves MMC5 sprite-size and substitution-enable assumptions without accepting PPU mirrors. Rendering bank-set selection requires a proven substitution enable; disabled or unknown gates join possible shared sets. PPU event reads can qualify sprite/background/non-rendering PPUDATA context; missing qualifications join possible bank sets. Nametable selectors, fill bytes, constant-zero pages and PPU ExRAM reads/writes retain common bits and storage facts. Ordinary pattern events examine every compatible byte in an authenticated full CHR snapshot, retaining sorted physical source offsets and only common value bits. A common byte leaves an ambiguous bank unresolved; static window mapping does not enumerate candidates. With explicit ppu model mmc5-background, qualified tile/attribute/low/high sequences derive extended palette/bank and split ExRAM/quadrant/fine-Y sources. pin92_high and PPUMASK gate substitutions; unknown facts join ordinary/extended/split paths. Screen columns and current/next-line prefetch positions are supplied mmc5_tile facts, not inferred address counts. Qualified render-frame/line events load/increment held split Y independently of IRQ state; 5201 writes do not retroactively reload it. Extended attributes capture ExRAM at the attribute fetch and use live 5130 on each pattern read; split uses live 5202 and explicit CL/SL wiring (omission joins both). Missing/contradictory context invalidates active interpretation while retaining captured facts. Up to 2816 physical ROM origins retain common byte proofs, without identifying an ambiguous bank/offset. Frozen graphics separates background/sprite query roles. Optional ppu_mmc5_background qualifies the first screen column and split Y independently for nametable/viewport per-row projection; tile, attribute, CHR and palette alternatives remain correlated through shared source pools. Omitted geometry retains unresolved extended/split overrides; historical active-tile facts are never substituted for query coordinates. Rendering without the selected model, automatic fetch/frame classification, CHR RAM contents, PCM/audio/timer IRQs, transient IRQ pulse timing and audio execution remain unresolved. Explicit event initial_irq model mmc5 retains counter bit proofs, delayed fourth-read clocks, supplied M2 idle phases, pending/enabled line state and pre-acknowledgement status D7/D6. Its conventional stable profile initializes scanline zero, releases on the 241st detection, and joins unconfirmed DMA reset/direct PPUMASK-disable effects. Exact 2002 bus proofs and FFFA/B reads reset frame state; a qualified reset disables scanline enable and establishes documented PRG/protection/ExRAM/CHR-upper/split reset bits while retaining captured CHR latches and storage; no power-on image is invented. The ExRAM-written latch is false after reset; its incompletely understood access effects leave reads unknown until 5104 is written. Initial mode-3/possibly-reset-mode reads require a true prior-write fact. Source instructions do not imply clocks or CPU IRQ delivery. RAM contents require caller facts or path-local writes. EKROM/ETROM/EWROM are explicit chip-layout assumptions; linear64/128KiB profiles are emulator-conventional alternatives. No reset defaults, commercial-game compatibility or physical timing is inferred.";
