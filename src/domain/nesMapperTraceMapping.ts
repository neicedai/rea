import { isBandaiState, bandaiPrgBanks } from "./nesBandai.js";
import { isMmc5State, mmc5Mapping, mmc5PrgView } from "./nesMmc5.js";
import {
  isNamco163State,
  namco163Mapping,
  namco163PrgView,
} from "./nesNamco163.js";
import {
  isFme7State,
  fme7PrgView,
  fme7LowerWindow,
  fme7Mask,
} from "./nesFme7.js";
import {
  isVrc6State,
  vrc6PrgBanks,
  vrc6ChrBanks,
  vrc6PatternCandidates,
  vrc6PpuMapping,
  vrc6Mirroring,
} from "./nesVrc6.js";
import { isVrc2State } from "./nesVrc2.js";
import { isVrc4State } from "./nesVrc4.js";
import {
  isH3001State,
  h3001Mirroring,
  h3001NametablePages,
} from "./nesH3001.js";
import { isSunsoft3State } from "./nesSunsoft3.js";
import { isSunsoft4State, type NesSunsoft4State } from "./nesSunsoft4.js";
import { isVrc3State } from "./nesVrc3.js";
import {
  isIrem78State,
  irem78Mirroring,
  irem78NametablePages,
} from "./nesIrem78.js";
import { sunsoft4NametableCandidates } from "./nesSunsoft4Nametable.js";
import type { NesNametableWindow } from "./nesNametableWindow.js";
import { namco108HasFixedPrg, isNamco108State } from "./nesNamco108.js";
import { isJ87State, j87ChrBank } from "./nesJ87.js";
import {
  nesByteBits,
  nesByteCandidates,
  type NesByteValue,
} from "./nesByteValue.js";
import {
  mmc1OuterBank,
  mmc1HasFixedPrg,
  mmc1PrgBanks,
  mmc1ChrBanks,
} from "./nesMmc1.js";
import { nesMapper34Board } from "./nesMapper34.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState, NesMapperMapping } from "./nesMapperTrace.js";
import type { NesPrgView } from "./nesPrgViews.js";

/** A complete selector can be passed directly to open_binary's nes_prg_views. */
export const mapperPrgView = (
  header: NesRomMetadata,
  state: NesMapperState,
): NesPrgView | null => {
  if (isMmc5State(state)) return mmc5PrgView(state);
  if (isNamco163State(state)) return namco163PrgView(state);
  if (isFme7State(state)) return fme7PrgView(state);
  if (isSunsoft3State(state)) {
    const bank = nesByteBits(state.prg_bank, 15);
    return bank === null ? null : { mapper: 67, prg_bank: bank };
  }
  if (isSunsoft4State(state)) {
    const bank = nesByteBits(state.prg_bank, 15);
    return bank === null
      ? null
      : { mapper: 68, variant: "normal", prg_bank: bank };
  }
  if (isVrc3State(state)) {
    const bank = nesByteBits(state.prg_bank, 7);
    return bank === null ? null : { mapper: 73, prg_bank: bank };
  }
  if (isIrem78State(state)) {
    const bank = nesByteBits(state.latch, 7);
    return bank === null
      ? null
      : { mapper: 78, variant: state.variant, prg_bank: bank };
  }
  if (
    state.mapper === 0 ||
    state.mapper === 3 ||
    isJ87State(state) ||
    mmc1HasFixedPrg(header) ||
    namco108HasFixedPrg(header)
  )
    return null;
  if (isNamco108State(state)) {
    const r6 = nesByteBits(state.banks[6], 15),
      r7 = nesByteBits(state.banks[7], 15);
    return r6 === null || r7 === null ? null : { mapper: state.mapper, r6, r7 };
  }
  if (isBandaiState(state)) {
    const selected = nesByteBits(state.prg_bank, 15);
    return selected === null
      ? null
      : state.mapper === 16
        ? { mapper: 16, variant: state.variant, prg_bank: selected }
        : { mapper: 159, prg_bank: selected };
  }
  if (isVrc6State(state)) {
    const pair = nesByteBits(state.prg_bank_16k, 15),
      single = nesByteBits(state.prg_bank_8k, 31);
    return pair === null || single === null
      ? null
      : { mapper: state.mapper, prg_bank_16k: pair, prg_bank_8k: single };
  }
  if (isVrc4State(state)) {
    const mode = nesByteBits(state.prg_control, 2);
    const first = nesByteBits(state.prg_banks[0], 31);
    const second = nesByteBits(state.prg_banks[1], 31);
    return mode === null || first === null || second === null
      ? null
      : {
          mapper: state.mapper,
          variant: "vrc4",
          ...(!("wiring" in state) ? {} : { wiring: state.wiring }),
          prg_mode: mode === 0 ? 0 : 1,
          prg_bank_0: first,
          prg_bank_1: second,
        };
  }
  if (isVrc2State(state)) {
    const first = nesByteBits(state.prg_banks[0], 31);
    const second = nesByteBits(state.prg_banks[1], 31);
    return first === null || second === null
      ? null
      : {
          mapper: state.mapper,
          ...(!("wiring" in state) ? {} : { wiring: state.wiring }),
          prg_bank_0: first,
          prg_bank_1: second,
        };
  }
  if (state.mapper === 75) {
    const first = nesByteBits(state.prg_banks[0], 15);
    const second = nesByteBits(state.prg_banks[1], 15);
    const third = nesByteBits(state.prg_banks[2], 15);
    return first === null || second === null || third === null
      ? null
      : {
          mapper: 75,
          prg_bank_0: first,
          prg_bank_1: second,
          prg_bank_2: third,
        };
  }
  if (state.mapper === 33) {
    const first = nesByteBits(state.prg_banks[0], 63);
    const second = nesByteBits(state.prg_banks[1], 63);
    return first === null || second === null
      ? null
      : { mapper: 33, prg_bank_0: first, prg_bank_1: second };
  }
  if (state.mapper === 32) {
    const mode = header.submapper === 1 ? 0 : nesByteBits(state.control, 2);
    const first = nesByteBits(state.prg_banks[0], 31);
    const second = nesByteBits(state.prg_banks[1], 31);
    return mode === null || first === null || second === null
      ? null
      : {
          mapper: 32,
          prg_mode: mode === 0 ? 0 : 1,
          prg_bank_0: first,
          prg_bank_1: second,
        };
  }
  if (isH3001State(state)) {
    const mode = nesByteBits(state.control, 128),
      first = nesByteBits(state.prg_banks[0], 63),
      second = nesByteBits(state.prg_banks[1], 63);
    return mode === null || first === null || second === null
      ? null
      : {
          mapper: 65,
          prg_mode: mode === 0 ? 0 : 1,
          prg_bank_0: first,
          prg_bank_1: second,
        };
  }
  if (state.mapper === 232) {
    const outer = nesByteBits(state.prg_outer_bank, 3);
    return outer === null || state.prg_bank === null
      ? null
      : { mapper: 232, prg_outer_bank: outer, prg_bank: state.prg_bank };
  }
  if (state.mapper === 1) {
    const bank = nesByteBits(state.prg_bank, 15);
    const outer =
      header.prgRom.size > 0x40000 ? mmc1OuterBank(state) : undefined;
    return state.prg_mode === null || bank === null || outer === null
      ? null
      : {
          mapper: 1,
          prg_mode: state.prg_mode,
          prg_bank: bank,
          ...(outer === undefined ? {} : { prg_outer_bank: outer }),
        };
  }
  if (
    state.mapper === 66 ||
    state.mapper === 11 ||
    state.mapper === 34 ||
    state.mapper === 7 ||
    state.mapper === 180 ||
    state.mapper === 2 ||
    state.mapper === 71 ||
    state.mapper === 9 ||
    state.mapper === 10
  )
    return state.prg_bank === null
      ? null
      : { mapper: state.mapper, prg_bank: state.prg_bank };
  const r6 = nesByteBits(state.banks[6], 63);
  const r7 = nesByteBits(state.banks[7], 63);
  const mode = nesByteBits(state.bank_select, 64);
  return mode === null || r6 == null || r7 == null
    ? null
    : {
        mapper: 4,
        prg_mode: mode === 0 ? 0 : 1,
        r6: r6 & 63,
        r7: r7 & 63,
      };
};

/** Partial maps preserve known fixed windows without inventing missing selectors. */
export const mapperMapping = (
  header: NesRomMetadata,
  state: NesMapperState,
  { chrRamSize = null }: { chrRamSize?: 8192 | null } = {},
): NesMapperMapping => {
  if (isMmc5State(state)) return mmc5Mapping(header, state);
  if (isNamco163State(state)) return namco163Mapping(header, state);
  const prgSize =
    state.mapper === 7 ||
    state.mapper === 66 ||
    state.mapper === 11 ||
    state.mapper === 34
      ? 32768
      : state.mapper === 0 ||
          state.mapper === 232 ||
          state.mapper === 180 ||
          state.mapper === 2 ||
          state.mapper === 71 ||
          state.mapper === 3 ||
          isJ87State(state) ||
          state.mapper === 1 ||
          state.mapper === 10 ||
          isSunsoft3State(state) ||
          isSunsoft4State(state) ||
          isVrc3State(state) ||
          isIrem78State(state) ||
          isBandaiState(state)
        ? 16384
        : 8192;
  const count = header.prgRom.size / prgSize;
  const outer = state.mapper === 1 && count > 16 ? mmc1OuterBank(state) : 0;
  const banks = namco108HasFixedPrg(header)
    ? [0, 1, 2, 3]
    : mmc1HasFixedPrg(header)
      ? [0, 1]
      : prgBanks(
          state.mapper === 32 && header.submapper === 1
            ? { ...state, control: 0 }
            : state,
          state.mapper === 1 ? Math.min(count, 16) : count,
        ).map((bank) =>
          bank === null || outer === null ? null : bank + outer * 16,
        );
  const chr = standardNesChrWindows(
    header,
    state,
    header.chrRom.size || chrRamSize || 0,
  );
  const lower = isFme7State(state) ? fme7LowerWindow(header, state) : null;
  return {
    prg_view: mapperPrgView(header, state),
    prg_windows: [
      ...(lower === null
        ? []
        : [
            {
              start: lower.start,
              size: lower.size,
              bank: lower.source === "rom" ? lower.bank : null,
              file_offset: lower.file_offset,
            },
          ]),
      ...banks.map((bank, index) => ({
        start: 32768 + index * prgSize,
        size: prgSize,
        bank,
        file_offset:
          bank === null ? null : header.prgRom.offset + bank * prgSize,
      })),
    ],
    chr_source:
      header.chrRom.size !== 0
        ? "rom"
        : chrRamSize === null
          ? "ram-unobserved"
          : "ram-assumed",
    chr_windows: chr.map((window) => ({
      ...window,
      file_offset:
        header.chrRom.size === 0 || window.bank === null
          ? null
          : header.chrRom.offset + window.bank * window.size,
    })),
    mirroring: mirroring(header, state),
    ...(lower === null ? {} : { lower_window: lower }),
    ...(isVrc6State(state)
      ? { nametable_windows: vrc6PpuMapping(header, state).nametables }
      : isSunsoft4State(state)
        ? { nametable_windows: sunsoft4NametableWindows(header, state) }
        : {}),
  };
};

/** Physical CHR address mux, independent of ROM file formatting or explicit RAM backing. */
export const standardNesChrWindows = (
  header: NesRomMetadata,
  state: Exclude<NesMapperState, { mapper: 5 | 19 }>,
  capacityBytes: number,
) => {
  // VRC3's admitted board has one fixed 8 KiB RAM window even without retained bytes.
  if (isVrc3State(state)) return [{ start: 0, size: 8192, bank: 0 }];
  if (isIrem78State(state)) {
    const bits = nesByteBits(
      state.latch,
      ((capacityBytes / 8192 - 1) & 15) << 4,
    );
    return [{ start: 0, size: 8192, bank: bits === null ? null : bits >> 4 }];
  }
  const chrSize =
    state.mapper === 4 ||
    state.mapper === 206 ||
    state.mapper === 32 ||
    isH3001State(state) ||
    state.mapper === 33 ||
    isVrc4State(state) ||
    isVrc6State(state) ||
    isBandaiState(state) ||
    isFme7State(state) ||
    isVrc2State(state)
      ? 1024
      : isSunsoft3State(state) || isSunsoft4State(state) || state.mapper === 76
        ? 2048
        : isJ87State(state)
          ? 8192
          : 4096;
  const chrCount = capacityBytes / chrSize;
  const chr =
    state.mapper === 34
      ? nesMapper34Board(header) === "BNROM"
        ? [0, 1]
        : [state.chr_bank_0, state.chr_bank_1]
      : chrBanks(state, chrCount);
  return chr.map((rawBank, index) => ({
    start: index * chrSize,
    size: chrSize,
    bank: rawBank === null || chrCount === 0 ? null : rawBank & (chrCount - 1),
  }));
};

/** A summary keeps proven source ownership even when its bank remains unresolved. */
const sunsoft4NametableWindows = (
  header: NesRomMetadata,
  state: NesSunsoft4State,
): NesNametableWindow[] =>
  Array.from({ length: 4 }, (_, page) => {
    const candidates = sunsoft4NametableCandidates(
        state,
        page,
        header.chrRom.size,
      ),
      sources = [...new Set(candidates.map((candidate) => candidate.source))],
      banks = [...new Set(candidates.map((candidate) => candidate.bank))],
      source = sources.length === 1 ? sources[0]! : "unknown",
      bank = source !== "unknown" && banks.length === 1 ? banks[0]! : null;
    return {
      start: 0x2000 + page * 1024,
      size: 1024,
      source,
      bank,
      file_offset:
        source === "chr-rom" && bank !== null
          ? header.chrRom.offset + bank * 1024
          : null,
    };
  });

/** Enumerate one window's compatible physical banks without expanding unrelated registers. */
export const standardNesChrCandidates = (
  state: Exclude<NesMapperState, { mapper: 5 | 19 }>,
  slot: number,
  count: number,
): number[] => {
  if (isVrc6State(state))
    return vrc6PatternCandidates(state, slot, count * 1024);
  const values = (value: NesByteValue, mask = count - 1) => [
    ...new Set(nesByteCandidates(value).map((byte) => byte & mask)),
  ];
  let banks: number[];
  if (isIrem78State(state))
    banks = values(state.latch, ((count - 1) & 15) << 4).map(
      (byte) => byte >> 4,
    );
  else if (isJ87State(state))
    banks = values(state.chr_bank, 3).map(
      (byte) => ((byte & 1) << 1) | ((byte & 2) >> 1),
    );
  else if (state.mapper === 76)
    banks = values(state.banks[slot + 2] ?? null, (count - 1) & 63);
  else if (isSunsoft3State(state))
    banks = values(state.chr_banks[slot] ?? null, (count - 1) & 63);
  else if (isSunsoft4State(state))
    banks = values(state.chr_banks[slot] ?? null, (count - 1) & 127);
  else if (
    isFme7State(state) ||
    isBandaiState(state) ||
    state.mapper === 32 ||
    isH3001State(state)
  )
    banks = values(state.chr_banks[slot] ?? null);
  else if (state.mapper === 1) {
    banks = (state.chr_mode === null ? [0, 1] : [state.chr_mode]).flatMap(
      (mode) =>
        mode === 0
          ? values(state.chr_bank_0, (count - 1) & 30).map(
              (bank) => bank + slot,
            )
          : values(
              slot === 0 ? state.chr_bank_0 : state.chr_bank_1,
              (count - 1) & 31,
            ),
    );
  } else if (state.mapper === 4 || state.mapper === 206) {
    const inversion =
      state.mapper === 206 ? 0 : nesByteBits(state.bank_select, 128);
    banks = (inversion === null ? [0, 1] : [inversion === 0 ? 0 : 1]).flatMap(
      (swap) => {
        const source = swap ? (slot + 4) % 8 : slot,
          paired = source < 4;
        return values(
          state.banks[paired ? Math.floor(source / 2) : source - 2] ?? null,
          (count - 1) & (paired ? 254 : 255),
        ).map((bank) => bank + (paired ? source & 1 : 0));
      },
    );
  } else if (state.mapper === 9 || state.mapper === 10) {
    const latch = slot === 0 ? state.latch_0 : state.latch_1;
    const fd = slot === 0 ? state.chr_fd_0 : state.chr_fd_1;
    const fe = slot === 0 ? state.chr_fe_0 : state.chr_fe_1;
    banks = (latch === null ? [fd, fe] : [latch === "fd" ? fd : fe]).flatMap(
      (bank) => values(bank),
    );
  } else if (state.mapper === 3 || state.mapper === 11 || state.mapper === 66)
    banks = values(state.chr_bank, count / 2 - 1).map(
      (bank) => bank * 2 + slot,
    );
  else if (state.mapper === 34)
    banks = values(slot === 0 ? state.chr_bank_0 : state.chr_bank_1);
  else if (state.mapper === 33) {
    const paired = slot < 4,
      register = paired ? Math.floor(slot / 2) : slot - 2;
    banks = values(
      state.chr_banks[register] ?? null,
      paired ? count / 2 - 1 : count - 1,
    ).map((bank) => (paired ? bank * 2 + (slot & 1) : bank));
  } else if (state.mapper === 75) {
    const bit = slot === 0 ? 2 : 4;
    banks = values(state.chr_banks[slot] ?? null, 15).flatMap((low) =>
      values(state.control, bit).map((high) => low | (high === 0 ? 0 : 16)),
    );
  } else if (isVrc2State(state) || isVrc4State(state)) {
    const shift = state.mapper === 22 ? 1 : 0;
    banks = values(state.chr_low[slot] ?? null, 15).flatMap((low) =>
      values(state.chr_high[slot] ?? null, isVrc4State(state) ? 31 : 15).map(
        (high) => (low | (high << 4)) >> shift,
      ),
    );
  } else banks = [slot];
  return [...new Set(banks.map((bank) => bank & (count - 1)))].sort(
    (a, b) => a - b,
  );
};

/** Physical nametable candidates retain aliases even when the mirror register is unresolved. */
export const standardNesNametablePages = (
  header: NesRomMetadata,
  state: Exclude<NesMapperState, { mapper: 5 | 19 | 24 | 26 }>,
  page: number,
  physicalCount: 2 | 4,
): number[] => {
  if (isIrem78State(state)) return irem78NametablePages(state, page);
  if (isSunsoft4State(state))
    return sunsoft4NametableCandidates(state, page, header.chrRom.size)
      .filter((candidate) => candidate.source === "ciram")
      .map((candidate) => candidate.bank);
  const selected = mirroring(header, state);
  const physical = (mode: string) =>
    mode === "vertical"
      ? page & 1
      : mode === "horizontal"
        ? page >> 1
        : mode === "one-screen-a"
          ? 0
          : mode === "one-screen-b"
            ? 1
            : mode === "four-screen"
              ? page
              : null;
  const known = physical(selected);
  if (known !== null) return [known];
  if (header.mirroring === "four-screen") return [0, 1, 2, 3];
  if (isH3001State(state)) return h3001NametablePages(state.mirroring, page);
  if (
    isFme7State(state) ||
    isBandaiState(state) ||
    isVrc4State(state) ||
    isSunsoft3State(state)
  ) {
    const byte = isVrc4State(state) ? state.control : state.mirroring;
    const modes = ["vertical", "horizontal", "one-screen-a", "one-screen-b"];
    return [
      ...new Set(
        nesByteCandidates(byte).map((value) => physical(modes[value & 3]!)!),
      ),
    ].sort((a, b) => a - b);
  }
  if (
    state.mapper === 4 ||
    state.mapper === 9 ||
    state.mapper === 10 ||
    state.mapper === 32 ||
    state.mapper === 33 ||
    state.mapper === 75 ||
    isVrc2State(state)
  )
    return [...new Set([page & 1, page >> 1])].sort((a, b) => a - b);
  return Array.from({ length: physicalCount }, (_, n) => n);
};

const prgBanks = (
  state: Exclude<NesMapperState, { mapper: 19 | 5 }>,
  count: number,
): (number | null)[] => {
  if (isFme7State(state))
    return [
      ...state.prg_banks.map((b) =>
        nesByteBits(b, (count - 1) & fme7Mask(state.variant)),
      ),
      count - 1,
    ];
  if (isBandaiState(state)) return bandaiPrgBanks(state, count);
  if (isJ87State(state)) return [0, count === 1 ? 0 : 1];
  if (isNamco108State(state))
    return [
      nesByteBits(state.banks[6], (count - 1) & 15),
      nesByteBits(state.banks[7], (count - 1) & 15),
      count - 2,
      count - 1,
    ];
  if (isSunsoft3State(state) || isSunsoft4State(state))
    return [nesByteBits(state.prg_bank, (count - 1) & 15), count - 1];
  if (isVrc3State(state))
    return [nesByteBits(state.prg_bank, (count - 1) & 7), count - 1];
  if (isIrem78State(state))
    return [nesByteBits(state.latch, (count - 1) & 7), count - 1];
  if (isVrc6State(state)) return vrc6PrgBanks(state, count);
  if (isVrc4State(state))
    return swappedPrgBanks(
      nesByteBits(state.prg_control, 2),
      nesByteBits(state.prg_banks[0], (count - 1) & 31),
      nesByteBits(state.prg_banks[1], (count - 1) & 31),
      count,
    );
  if (state.mapper === 0 || state.mapper === 3) return [0, count === 1 ? 0 : 1];
  if (
    state.mapper === 7 ||
    state.mapper === 66 ||
    state.mapper === 11 ||
    state.mapper === 34
  )
    return [
      count === 1
        ? 0
        : state.prg_bank === null
          ? null
          : state.prg_bank & (count - 1),
    ];
  if (isVrc2State(state))
    return [
      nesByteBits(state.prg_banks[0], (count - 1) & 31),
      nesByteBits(state.prg_banks[1], (count - 1) & 31),
      count - 2,
      count - 1,
    ];
  if (state.mapper === 75)
    return [
      ...state.prg_banks.map((value) => nesByteBits(value, (count - 1) & 15)),
      count - 1,
    ];
  if (state.mapper === 33)
    return [
      nesByteBits(state.prg_banks[0], (count - 1) & 63),
      nesByteBits(state.prg_banks[1], (count - 1) & 63),
      count - 2,
      count - 1,
    ];
  if (state.mapper === 32) {
    const first = nesByteBits(state.prg_banks[0], (count - 1) & 31);
    const second = nesByteBits(state.prg_banks[1], (count - 1) & 31);
    const mode = nesByteBits(state.control, 2);
    return swappedPrgBanks(mode, first, second, count);
  }
  if (isH3001State(state))
    return swappedPrgBanks(
      nesByteBits(state.control, 128),
      nesByteBits(state.prg_banks[0], (count - 1) & 63),
      nesByteBits(state.prg_banks[1], (count - 1) & 63),
      count,
    );
  if (state.mapper === 232) {
    const outer = nesByteBits(state.prg_outer_bank, (count / 4 - 1) & 3);
    return outer === null
      ? [null, null]
      : [
          state.prg_bank === null
            ? null
            : (outer * 4 + state.prg_bank) & (count - 1),
          (outer * 4 + 3) & (count - 1),
        ];
  }
  if (state.mapper === 180)
    return [
      0,
      count === 1
        ? 0
        : state.prg_bank === null
          ? null
          : state.prg_bank & (count - 1),
    ];
  if (state.mapper === 2 || state.mapper === 71)
    return [
      count === 1
        ? 0
        : state.prg_bank === null
          ? null
          : state.prg_bank & (count - 1),
      count - 1,
    ];
  if (state.mapper === 9 || state.mapper === 10) {
    const bank = state.prg_bank === null ? null : state.prg_bank & (count - 1);
    return state.mapper === 9
      ? [bank, count - 3, count - 2, count - 1]
      : [bank, count - 1];
  }
  if (state.mapper === 1) return mmc1PrgBanks(state, count);
  const r6 = state.banks[6];
  const r7 = state.banks[7];
  const bank6 = nesByteBits(r6, 63 & (count - 1));
  const bank7 = nesByteBits(r7, 63 & (count - 1));
  const mode = nesByteBits(state.bank_select, 64);
  return swappedPrgBanks(mode, bank6, bank7, count);
};

const swappedPrgBanks = (
  mode: number | null,
  first: number | null,
  second: number | null,
  count: number,
): (number | null)[] =>
  mode === null
    ? [
        first === count - 2 ? first : null,
        second,
        first === count - 2 ? first : null,
        count - 1,
      ]
    : mode === 0
      ? [first, second, count - 2, count - 1]
      : [count - 2, second, first, count - 1];

const latchBank = (
  latch: "fd" | "fe" | null,
  fd: number | null,
  fe: number | null,
  mask: number,
): number | null => {
  if (latch !== null) return latch === "fd" ? fd : fe;
  // Unknown latch still has a known physical source when both selectors alias.
  return fd !== null && fe !== null && (fd & mask) === (fe & mask) ? fd : null;
};
const chrBanks = (
  state: Exclude<NesMapperState, { mapper: 34 | 19 | 5 | 73 | 78 }>,
  count: number,
): (number | null)[] => {
  if (isFme7State(state))
    return state.chr_banks.map((b) => nesByteBits(b, count - 1));
  if (isBandaiState(state))
    return state.chr_banks.map((byte) => nesByteBits(byte, count - 1));
  if (isSunsoft3State(state))
    return state.chr_banks.map((byte) => nesByteBits(byte, (count - 1) & 63));
  if (isSunsoft4State(state))
    return state.chr_banks.map((byte) => nesByteBits(byte, (count - 1) & 127));
  if (isJ87State(state)) return [j87ChrBank(state.chr_bank, count - 1)];
  if (state.mapper === 76)
    return state.banks
      .slice(2, 6)
      .map((byte) => nesByteBits(byte, (count - 1) & 63));
  if (isVrc6State(state)) return vrc6ChrBanks(state, count);
  if (isVrc4State(state))
    return state.chr_low.map((raw, index) => {
      const mask = count - 1;
      const low = nesByteBits(raw, mask & 15);
      const high = nesByteBits(state.chr_high[index], (mask >> 4) & 31);
      return low === null || high === null ? null : low | (high << 4);
    });
  if (
    state.mapper === 0 ||
    state.mapper === 232 ||
    state.mapper === 180 ||
    state.mapper === 2 ||
    state.mapper === 71 ||
    state.mapper === 7
  )
    return [0, 1];
  if (state.mapper === 3 || state.mapper === 66 || state.mapper === 11)
    return state.chr_bank === null
      ? count === 2
        ? [0, 1]
        : [null, null]
      : [state.chr_bank * 2, state.chr_bank * 2 + 1];
  if (state.mapper === 9 || state.mapper === 10)
    return [
      latchBank(state.latch_0, state.chr_fd_0, state.chr_fe_0, count - 1),
      latchBank(state.latch_1, state.chr_fd_1, state.chr_fe_1, count - 1),
    ];
  if (state.mapper === 1) return mmc1ChrBanks(state, count);
  if (isVrc2State(state))
    return state.chr_low.map((raw, index) => {
      const shift = state.mapper === 22 ? 1 : 0;
      const mask = (count - 1) << shift;
      const low = nesByteBits(raw, mask & 15);
      const high = nesByteBits(state.chr_high[index], (mask >> 4) & 15);
      return low === null || high === null
        ? null
        : (low | (high << 4)) >> shift;
    });
  if (state.mapper === 75)
    return state.chr_banks.map((raw, index) => {
      const low = nesByteBits(raw, (count - 1) & 15);
      const high = nesByteBits(
        state.control,
        (count - 1) & 16 ? (index === 0 ? 2 : 4) : 0,
      );
      return low === null || high === null ? null : low | (high === 0 ? 0 : 16);
    });
  if (state.mapper === 32 || isH3001State(state))
    return state.chr_banks.map((bank) => nesByteBits(bank, (count - 1) & 255));
  if (state.mapper === 33)
    return state.chr_banks.flatMap((raw, index) => {
      const bank = nesByteBits(
        raw,
        (index < 2 ? count / 2 - 1 : count - 1) & 255,
      );
      return index < 2
        ? bank === null
          ? [null, null]
          : [bank * 2, bank * 2 + 1]
        : [bank];
    });
  const [r0, r1, r2, r3, r4, r5] = state.banks.map((value, index) =>
    nesByteBits(value, (count - 1) & (index < 2 ? 254 : 255)),
  );
  const paired = [
    r0 == null ? null : r0 & ~1,
    r0 == null ? null : (r0 & ~1) + 1,
    r1 == null ? null : r1 & ~1,
    r1 == null ? null : (r1 & ~1) + 1,
  ];
  const single = [r2 ?? null, r3 ?? null, r4 ?? null, r5 ?? null];
  const inversion =
    state.mapper === 206 ? 0 : nesByteBits(state.bank_select, 128);
  if (inversion === null) {
    const common = paired.map((bank, index) => {
      const other = single[index];
      return bank != null &&
        other != null &&
        (bank & (count - 1)) === (other & (count - 1))
        ? bank
        : null;
    });
    return [...common, ...common];
  }
  return inversion === 0 ? [...paired, ...single] : [...single, ...paired];
};

const mirroring = (
  header: NesRomMetadata,
  state: Exclude<NesMapperState, { mapper: 19 | 5 }>,
): NesMapperMapping["mirroring"] => {
  if (isIrem78State(state)) return irem78Mirroring(state);
  if (isSunsoft4State(state)) {
    const bits = nesByteBits(state.control, 3);
    return bits === null
      ? "unknown"
      : (["vertical", "horizontal", "one-screen-a", "one-screen-b"] as const)[
          bits
        ]!;
  }
  if (isBandaiState(state) || isFme7State(state) || isSunsoft3State(state)) {
    const bits = nesByteBits(state.mirroring, 3);
    return bits === null
      ? "unknown"
      : (["vertical", "horizontal", "one-screen-a", "one-screen-b"] as const)[
          bits
        ]!;
  }
  if (isVrc6State(state))
    return vrc6Mirroring(vrc6PpuMapping(header, state).nametables);
  if (isVrc4State(state)) {
    const bits = nesByteBits(state.control, 3);
    return bits === null
      ? "unknown"
      : (["vertical", "horizontal", "one-screen-a", "one-screen-b"] as const)[
          bits
        ]!;
  }
  if (isVrc2State(state)) {
    const bit = nesByteBits(state.control, 1);
    return bit === null ? "unknown" : bit === 0 ? "vertical" : "horizontal";
  }
  if (state.mapper === 75) {
    if (header.mirroring === "four-screen") return "four-screen";
    const bit = nesByteBits(state.control, 1);
    return bit === null ? "unknown" : bit === 0 ? "vertical" : "horizontal";
  }
  if (state.mapper === 33) {
    const bit = nesByteBits(state.prg_banks[0], 64);
    return bit === null ? "unknown" : bit === 0 ? "vertical" : "horizontal";
  }
  if (state.mapper === 32) {
    if (header.submapper === 1) return "one-screen-b";
    const bit = nesByteBits(state.control, 1);
    return bit === null ? "unknown" : bit === 0 ? "vertical" : "horizontal";
  }
  if (isH3001State(state)) return h3001Mirroring(state.mirroring);
  if (isNamco108State(state) || isJ87State(state) || isVrc3State(state))
    return header.mirroring;
  if (state.mapper === 4 && header.submapper === 2) return header.mirroring;
  if (state.mapper === 71) {
    if (header.submapper === 0) return header.mirroring;
    if (header.submapper !== 1 || state.mirroring === null) return "unknown";
    return state.mirroring === 0 ? "one-screen-a" : "one-screen-b";
  }
  if (
    state.mapper === 0 ||
    state.mapper === 232 ||
    state.mapper === 180 ||
    state.mapper === 2 ||
    state.mapper === 3 ||
    state.mapper === 66 ||
    state.mapper === 11 ||
    state.mapper === 34
  )
    return header.mirroring;
  if (header.mirroring === "four-screen")
    return state.mapper === 4 ? "four-screen" : "unknown";
  if (state.mirroring === null) return "unknown";
  if (state.mapper === 7)
    return state.mirroring === 0 ? "one-screen-a" : "one-screen-b";
  if (state.mapper !== 1)
    return state.mirroring === 0 ? "vertical" : "horizontal";
  return (["one-screen-a", "one-screen-b", "vertical", "horizontal"] as const)[
    state.mirroring
  ];
};
