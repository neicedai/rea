import { isVrc6State } from "./nesVrc6.js";
import {
  isMmc5State,
  mmc5CpuCandidates,
  mmc5RamPermission,
} from "./nesMmc5.js";
import { isNamco163State, namco163RamWritable } from "./nesNamco163.js";
import { isFme7State, fme7RamPermission, fme7RamBanks } from "./nesFme7.js";
import { nesByteBits } from "./nesByteValue.js";
import { nesPrgRamLayout } from "./nesPrgRamLayout.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import { isVrc4State } from "./nesVrc4.js";

/** Permissions, possible physical banks and optional addressed decoder coordinates; null means unknown wiring. */
export const nesPrgRamAccess = (
  header: NesRomMetadata,
  state: NesMapperState,
  address?: number,
): {
  readable: boolean | null;
  writable: boolean | null;
  banks: number[];
  ram_address?: number;
} | null => {
  const layout = nesPrgRamLayout(header, state);
  if (layout === null) return null;
  if (isMmc5State(state)) {
    if (address === undefined || address < 0x6000 || address > 0xffff)
      return null;
    const candidates = mmc5CpuCandidates(header, state, address);
    const banks = candidates.flatMap((c) =>
      c.source === "ram" ? [c.bank] : [],
    );
    if (banks.length === 0) return null;
    const allRam = candidates.every((c) => c.source === "ram");
    const permission = mmc5RamPermission(state);
    return {
      readable: allRam ? true : null,
      writable: allRam || permission === false ? permission : null,
      banks,
      ram_address: 0x6000 + (address & 8191),
    };
  }
  if (isNamco163State(state))
    return {
      readable: true,
      writable: namco163RamWritable(state, address),
      banks: [0],
    };
  if (isFme7State(state)) {
    const mode = nesByteBits(state.bank_6000, 64);
    if (mode === 0) return null;
    const permission = fme7RamPermission(state);
    const permitted = mode === null && permission !== false ? null : permission;
    return {
      readable: permitted,
      writable: permitted,
      banks: fme7RamBanks(state, layout.bank_count),
      ...(address === undefined
        ? {}
        : {
            ram_address:
              layout.start +
              ((address - layout.start) & (layout.bank_size - 1)),
          }),
    };
  }
  if (isVrc6State(state)) {
    const enable = nesByteBits(state.control, 128);
    const permitted = enable === null ? null : enable !== 0;
    return { readable: permitted, writable: permitted, banks: [0] };
  }
  if (state.mapper === 68) {
    const enabled = nesByteBits(state.prg_bank, 16);
    const permitted = enabled === null ? null : enabled !== 0;
    return { readable: permitted, writable: permitted, banks: [0] };
  }
  if (isVrc4State(state)) {
    if (
      address !== undefined &&
      (address < 0x6000 ||
        address >= (state.prg_ram_wiring === "internal-2k" ? 0x7000 : 0x8000))
    )
      return null;
    const bit = nesByteBits(state.prg_control, 1);
    const permitted = bit === null ? null : bit !== 0;
    return {
      readable: permitted,
      writable: permitted,
      banks: [0],
      ...(address === undefined
        ? {}
        : {
            ram_address:
              layout.start +
              ((address - layout.start) & (layout.bank_size - 1)),
          }),
    };
  }
  if (
    header.mapper === 10 ||
    header.mapper === 34 ||
    header.mapper === 32 ||
    header.mapper === 65 ||
    header.mapper === 67 ||
    header.mapper === 73 ||
    header.mapper === 25
  )
    return { readable: true, writable: true, banks: [0] };
  if (header.mapper === 1 && state.mapper === 1)
    return mmc1RamAccess(header, state, layout.bank_count);
  if (header.mapper !== 4 || header.submapper === 1 || state.mapper !== 4)
    return null;
  const enabled = nesByteBits(state.ram_protect, 128);
  const protectedBit = nesByteBits(state.ram_protect, 64);
  return {
    readable: enabled === null ? null : enabled !== 0,
    writable:
      enabled === 0 || protectedBit === 64
        ? false
        : enabled === 128 && protectedBit === 0
          ? true
          : null,
    banks: [0],
  };
};

const mmc1RamAccess = (
  header: NesRomMetadata,
  state: Extract<NesMapperState, { mapper: 1 }>,
  count: number,
) => {
  const shift = header.chrRom.size > 8192 ? 4 : count === 4 ? 2 : 3;
  const selected =
    state.chr_mode === 0
      ? [state.chr_bank_0]
      : [state.chr_bank_0, state.chr_bank_1];
  const banks =
    count === 1
      ? [0]
      : [
          ...new Set(
            selected.flatMap((bank) => {
              const mask =
                (typeof bank === "number" ? 31 : (bank?.mask ?? 0)) &
                ((count - 1) << shift);
              const value = nesByteBits(bank, mask)!;
              return Array.from({ length: count }, (_, index) => index).filter(
                (index) => ((index << shift) & mask) === value,
              );
            }),
          ),
        ].sort((left, right) => left - right);
  const prgEnabled =
    state.prg_ram_disable_bit === null ? null : state.prg_ram_disable_bit === 0;
  let chrEnabled: boolean | null = true;
  if (
    count === 1 &&
    header.chrRom.size <= 8192 &&
    header.prgRom.size <= 0x40000
  ) {
    const enabled = (bank: typeof state.chr_bank_0) => {
      const bit = nesByteBits(bank, 16);
      return bit === null ? null : bit === 0;
    };
    const first = enabled(state.chr_bank_0),
      second = enabled(state.chr_bank_1);
    // PPU A12 selects the output in 4 KiB mode. Without a PPU bus trace,
    // keep only permissions common to both possible CHR register outputs.
    chrEnabled = state.chr_mode === 0 ? first : first === second ? first : null;
  }
  const permitted =
    prgEnabled === false || chrEnabled === false
      ? false
      : prgEnabled === true && chrEnabled === true
        ? true
        : null;
  return { readable: permitted, writable: permitted, banks };
};

/** NROM has no RAM control register; write permission is an external assumption. */
export const nromRamAccess = (
  header: NesRomMetadata,
  state: Extract<NesMapperState, { mapper: 0 }>,
  address: number,
) => {
  if (
    header.mapper !== 0 ||
    header.headerVersion !== "nes2" ||
    address < 0x6000 ||
    address > 0x7fff
  )
    return null;
  const layout = nesPrgRamLayout(header);
  if (layout === null) return null;
  return {
    readable: true,
    writable: state.prg_ram_write_enabled,
    ram_address: 0x6000 + ((address - 0x6000) & (layout.bank_size - 1)),
  };
};
