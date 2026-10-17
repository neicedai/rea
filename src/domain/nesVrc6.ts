import type { NesPrgView } from "./nesPrgViews.js";
import type { NesNametableWindow } from "./nesNametableWindow.js";
import { z } from "zod";
import {
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

export const nesVrc6StateSchema = z.strictObject({
  mapper: z.union([z.literal(24), z.literal(26)]),
  prg_bank_16k: nesByteValueSchema.default(null),
  prg_bank_8k: nesByteValueSchema.default(null),
  control: nesByteValueSchema
    .default(null)
    .describe(
      "Raw B003 PPU banking/nametable/RAM control; D7 enables WRAM independently of PPU bits.",
    ),
  chr_banks: z
    .array(nesByteValueSchema)
    .length(8)
    .default(Array.from({ length: 8 }, () => null)),
  audio_registers: z
    .array(nesByteValueSchema)
    .length(10)
    .default(Array.from({ length: 10 }, () => null))
    .describe(
      "Raw internal 9000..9003, A000..A002, B000..B002 writes, in that order. Register facts do not establish oscillator phase, samples or elapsed cycles.",
    ),
  irq_latch: nesByteValueSchema.default(null),
  irq_control: nesByteValueSchema.default(null),
  irq_enabled: z.boolean().nullable().default(null),
  last_irq_command: z.enum(["control", "acknowledge"]).nullable().default(null),
});
export type NesVrc6State = z.infer<typeof nesVrc6StateSchema>;
export const isVrc6State = (state: NesMapperState): state is NesVrc6State =>
  state.mapper === 24 || state.mapper === 26;

export const isVrc6View = (
  view: NesPrgView,
): view is Extract<NesPrgView, { mapper: 24 | 26 }> =>
  view.mapper === 24 || view.mapper === 26;

export const vrc6Limitations =
  "Conventional VRC6a/Mapper 24 and VRC6b/Mapper 26 differ by CPU A0/A1 swapping. PRG uses a switchable 16 KiB pair, a switchable 8 KiB bank and the final fixed 8 KiB. Raw CHR/control bytes derive all B003 modes, paired/duplicated pattern pages and CIRAM versus CHR-ROM nametable sources. Selected initial_ppu facts can qualify retained CIRAM and palette bytes; unprovided contents remain unknown. Alternate 512 KiB CHR PCB wiring and extra nametable RAM require separate profiles. One explicit NES 2.0 8 KiB PRG RAM/NVRAM chip uses B003 D7; legacy capacity and unprovided contents remain unknown. IRQ calculations require explicit model vrc6 and supplied vrc-cpu-cycle events; writes do not imply clocks or CPU acceptance. Audio register writes are retained without oscillator/sample simulation or a playback claim. Power-on state, silicon timing and game compatibility are not established.";

/** Decode physical ports once, retaining original bus bytes and unknown register bits. */
export const applyVrc6Write = (
  state: NesVrc6State,
  write: NesMapperWrite,
): Pick<NesMapperTraceStep, "state" | "effect"> => {
  if (write.address < 0x8000) return { state, effect: "outside-mapper" };
  const low = write.address & 3;
  const port = state.mapper === 24 ? low : ((low & 1) << 1) | (low >> 1);
  const base = write.address & 0xf000;
  const byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  if (base === 0x8000 || base === 0xc000) {
    state[base === 0x8000 ? "prg_bank_16k" : "prg_bank_8k"] = byte;
    return { state, effect: "prg-bank" };
  }
  if (base === 0x9000 || ((base === 0xa000 || base === 0xb000) && port < 3)) {
    state.audio_registers[
      base === 0x9000 ? port : (base === 0xa000 ? 4 : 7) + port
    ] = byte;
    return { state, effect: "audio-register" };
  }
  if (base === 0xb000) {
    state.control = byte;
    return { state, effect: "register-commit" };
  }
  if (base === 0xd000 || base === 0xe000) {
    state.chr_banks[(base === 0xd000 ? 0 : 4) + port] = byte;
    return { state, effect: "chr-bank" };
  }
  if (base === 0xf000 && port === 0) {
    state.irq_latch = byte;
    return { state, effect: "irq-latch" };
  }
  if (base === 0xf000 && port === 1) {
    state.irq_control = byte;
    const enabled = nesByteBits(byte, 2);
    state.irq_enabled = enabled === null ? null : enabled !== 0;
    state.last_irq_command = "control";
    return { state, effect: "irq-control" };
  }
  if (base === 0xf000 && port === 2) {
    const enabled = nesByteBits(state.irq_control, 1);
    state.irq_enabled = enabled === null ? null : enabled !== 0;
    state.last_irq_command = "acknowledge";
    return { state, effect: "irq-acknowledge" };
  }
  return { state, effect: "outside-mapper" };
};

export const vrc6PrgBanks = (
  state: NesVrc6State,
  count: number,
): (number | null)[] => {
  const pair = nesByteBits(state.prg_bank_16k, (count / 2 - 1) & 15);
  return [
    pair === null ? null : pair * 2,
    pair === null ? null : pair * 2 + 1,
    nesByteBits(state.prg_bank_8k, (count - 1) & 31),
    count - 1,
  ];
};

const controls = (byte: NesByteValue): number[] =>
  Array.from({ length: 64 }, (_, v) => v).filter((v) =>
    typeof byte === "number"
      ? (byte & 63) === v
      : byte === null || (v & byte.mask & 63) === (byte.value & 63),
  );
const common = (values: readonly (number | null)[]): number | null =>
  values.length > 0 && values.every((v) => v === values[0]) ? values[0]! : null;

/** Resolve register index and any forced A10 separately from the source memory. */
const nametableSelectors = (
  control: number,
): { regs: number[]; forced: (number | null)[] } => {
  const key = control & 0x2f;
  if (key === 0x20 || key === 0x27)
    return { regs: [6, 6, 7, 7], forced: [0, 1, 0, 1] };
  if (key === 0x23 || key === 0x24)
    return { regs: [6, 7, 6, 7], forced: [0, 0, 1, 1] };
  if (key === 0x28 || key === 0x2f)
    return { regs: [6, 6, 7, 7], forced: [0, 0, 0, 0] };
  if (key === 0x2b || key === 0x2c)
    return { regs: [6, 7, 6, 7], forced: [1, 1, 1, 1] };
  const low = control & 7;
  return {
    regs:
      low === 1 || low === 5
        ? [4, 5, 6, 7]
        : low === 0 || low >= 6
          ? [6, 6, 7, 7]
          : [6, 7, 6, 7],
    forced: [null, null, null, null],
  };
};

type Vrc6PpuSelection = { reg: number; forced: number | null };

const patternSelector = (control: number, slot: number): Vrc6PpuSelection => {
  const mode = control & 3;
  const paired = mode === 1 || (mode >= 2 && slot >= 4);
  return {
    reg:
      mode === 0
        ? slot
        : mode === 1
          ? slot >> 1
          : slot < 4
            ? slot
            : 4 + ((slot - 4) >> 1),
    forced: paired && (control & 32) !== 0 ? slot & 1 : null,
  };
};

/** Snapshot raw proofs before projecting forced A10 and the board's physical lines. */
const createBankProjection = (raw: readonly NesByteValue[]) => {
  const proofs = raw.map((byte) =>
    typeof byte === "number"
      ? { mask: 255, value: byte }
      : { mask: byte?.mask ?? 0, value: byte?.value ?? 0 },
  );
  const cache = new Map<string, readonly number[]>();
  return (
    reg: number,
    mask: number,
    forced: number | null,
  ): readonly number[] => {
    const key = `${reg}:${mask}:${forced}`;
    const previous = cache.get(key);
    if (previous !== undefined) return previous;
    const proof = proofs[reg]!;
    const knownMask = (proof.mask | (forced === null ? 0 : 1)) & mask;
    const knownValue =
      (forced === null ? proof.value : (proof.value & ~1) | forced) & knownMask;
    const result = Object.freeze(
      Array.from({ length: mask + 1 }, (_, bank) => bank).filter(
        (bank) => (bank & knownMask) === knownValue,
      ),
    );
    cache.set(key, result);
    return result;
  };
};

export type NesVrc6NametableCandidate = {
  readonly source: "ciram" | "chr-rom";
  readonly bank: number;
};
export type NesVrc6PpuCandidates = {
  pattern(slot: number): readonly number[];
  nametable(page: number): readonly NesVrc6NametableCandidate[];
  nametableSource(): "ciram" | "chr-rom" | "unknown";
};

/** Operation-local lazy projections capture facts even when later mapper writes mutate state. */
export const createVrc6PpuCandidates = (
  state: NesVrc6State,
  chrCapacityBytes: number,
): NesVrc6PpuCandidates => {
  const alternatives = controls(state.control);
  const project = createBankProjection(state.chr_banks);
  const romMask = chrCapacityBytes / 1024 - 1;
  const patterns = new Map<number, readonly number[]>();
  const nametables = new Map<number, readonly NesVrc6NametableCandidate[]>();
  const selectors = new Map<number, ReturnType<typeof nametableSelectors>>();
  const sources = new Set(
    alternatives.map((control) => ((control & 16) !== 0 ? "chr-rom" : "ciram")),
  );
  const source =
    sources.size === 1 ? sources.values().next().value! : "unknown";
  return Object.freeze({
    pattern(slot: number) {
      const previous = patterns.get(slot);
      if (previous !== undefined) return previous;
      const selections = new Map<string, Vrc6PpuSelection>();
      for (const control of alternatives) {
        const selection = patternSelector(control, slot);
        selections.set(`${selection.reg}:${selection.forced}`, selection);
      }
      const banks = new Set<number>();
      if (chrCapacityBytes > 0)
        for (const { reg, forced } of selections.values())
          for (const bank of project(reg, romMask, forced)) banks.add(bank);
      const result = Object.freeze([...banks].sort((a, b) => a - b));
      patterns.set(slot, result);
      return result;
    },
    nametable(page: number) {
      const previous = nametables.get(page);
      if (previous !== undefined) return previous;
      const selections = new Map<
        string,
        Vrc6PpuSelection & { source: "ciram" | "chr-rom" }
      >();
      for (const control of alternatives) {
        let selected = selectors.get(control);
        if (selected === undefined) {
          selected = nametableSelectors(control);
          selectors.set(control, selected);
        }
        const source = (control & 16) !== 0 ? "chr-rom" : "ciram";
        const reg = selected.regs[page]!;
        const forced = selected.forced[page]!;
        selections.set(`${source}:${reg}:${forced}`, { source, reg, forced });
      }
      const candidates = new Map<string, NesVrc6NametableCandidate>();
      for (const { source, reg, forced } of selections.values()) {
        if (source === "chr-rom" && chrCapacityBytes <= 0) continue;
        for (const bank of project(
          reg,
          source === "ciram" ? 1 : romMask,
          forced,
        ))
          candidates.set(`${source}:${bank}`, Object.freeze({ source, bank }));
      }
      const result = Object.freeze(
        [...candidates.values()].sort((a, b) =>
          a.source === b.source
            ? a.bank - b.bank
            : a.source === "ciram"
              ? -1
              : 1,
        ),
      );
      nametables.set(page, result);
      return result;
    },
    nametableSource: () => source,
  });
};

export const vrc6PatternCandidates = (
  state: NesVrc6State,
  slot: number,
  chrCapacityBytes: number,
): number[] => [
  ...createVrc6PpuCandidates(state, chrCapacityBytes).pattern(slot),
];

export const vrc6NametableCandidates = (
  state: NesVrc6State,
  page: number,
  chrCapacityBytes: number,
): NesVrc6NametableCandidate[] => [
  ...createVrc6PpuCandidates(state, chrCapacityBytes).nametable(page),
];

/** Physical pattern summaries retain a bank only when all candidates agree. */
export const vrc6ChrBanks = (
  state: NesVrc6State,
  count: number,
): (number | null)[] => {
  const candidates = createVrc6PpuCandidates(state, count * 1024);
  return Array.from({ length: 8 }, (_, slot) =>
    common(candidates.pattern(slot)),
  );
};

/** Join physical PPU sources across every control value consistent with known bits. */
export const vrc6PpuMapping = (header: NesRomMetadata, state: NesVrc6State) => {
  const packet = createVrc6PpuCandidates(state, header.chrRom.size);
  const source = packet.nametableSource();
  const nametables: NesNametableWindow[] = Array.from(
    { length: 4 },
    (_, slot) => {
      const selected =
        source === "unknown"
          ? null
          : common(packet.nametable(slot).map((candidate) => candidate.bank));
      return {
        start: 0x2000 + slot * 1024,
        size: 1024,
        source,
        bank: selected,
        file_offset:
          source === "chr-rom" && selected !== null
            ? header.chrRom.offset + selected * 1024
            : null,
      };
    },
  );
  return {
    chr: Array.from({ length: 8 }, (_, slot) => common(packet.pattern(slot))),
    nametables,
  };
};

/** Mirroring describes CIRAM alias geometry; explicit windows retain physical page identity. */
export const vrc6Mirroring = (
  windows: readonly NesNametableWindow[],
):
  | "vertical"
  | "horizontal"
  | "one-screen-a"
  | "one-screen-b"
  | "custom"
  | "unknown" => {
  if (windows.some((w) => w.source !== "ciram" || w.bank === null))
    return "unknown";
  const [a, b, c, d] = windows.map((w) => w.bank);
  if (a === b && a === c && a === d)
    return a === 0 ? "one-screen-a" : "one-screen-b";
  if (a === c && b === d) return "vertical";
  if (a === b && c === d) return "horizontal";
  return "custom";
};
