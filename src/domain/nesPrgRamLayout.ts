import { nesVrcBoard } from "./nesVrcBoard.js";
import { fme7RamLayout } from "./nesFme7.js";
import { isMmc5State, mmc5RamAdmission, mmc5RamSize } from "./nesMmc5.js";
import type { NesRomMetadata } from "./nes.js";
import { mmc1HasFixedPrg } from "./nesMmc1.js";
import { nesMapper34Board } from "./nesMapper34.js";
import { isVrc4State, vrc4Board } from "./nesVrc4.js";
import type { NesMapperState } from "./nesMapperTrace.js";

/** Physical storage admitted by header and explicit wiring, independent of live bank/permission registers. */
export const nesPrgRamLayout = (
  header: NesRomMetadata,
  state?: NesMapperState,
): {
  start: number;
  bank_size: number;
  bank_count: number;
} | null => {
  const ram = header.prgRamSize ?? 0;
  if (header.mapper === 5 && state !== undefined && isMmc5State(state)) {
    const size = mmc5RamSize(state.ram_wiring);
    return size !== null && size > 0 && mmc5RamAdmission(header, state) === null
      ? { start: 0x6000, bank_size: 8192, bank_count: size / 8192 }
      : null;
  }
  if (header.mapper === 69 && state?.mapper === 69)
    return fme7RamLayout(header, state.variant);
  const nvram = header.prgNvramSize ?? 0;
  const size = ram + nvram;
  const singleChip = ram === 0 || nvram === 0;
  if (
    vrc4Board(
      header,
      state !== undefined && "wiring" in state ? state.wiring : undefined,
    ) !== null
  ) {
    if (
      state === undefined ||
      !isVrc4State(state) ||
      state.prg_ram_wiring === null
    )
      return null;
    const expected = state.prg_ram_wiring === "internal-2k" ? 2048 : 8192;
    return header.headerVersion === "nes2" && singleChip && size === expected
      ? { start: 0x6000, bank_size: size, bank_count: 1 }
      : null;
  }
  if (header.mapper === 0)
    return header.headerVersion === "nes2" &&
      singleChip &&
      [2048, 4096, 8192].includes(size)
      ? { start: 0x6000, bank_size: size, bank_count: 1 }
      : null;
  if (header.mapper === 4 && header.submapper === 1)
    return singleChip && [0, 1024].includes(size)
      ? { start: 0x7000, bank_size: 1024, bank_count: 1 }
      : null;
  const declared8k =
    header.headerVersion === "nes2" && singleChip && size === 8192;
  if (header.mapper === 19)
    return declared8k
      ? { start: 0x6000, bank_size: 8192, bank_count: 1 }
      : null;
  if (
    header.mapper === 10 ||
    (header.mapper === 34 && nesMapper34Board(header) === "NINA-001")
  )
    return header.headerVersion === "ines" || declared8k
      ? { start: 0x6000, bank_size: 8192, bank_count: 1 }
      : null;
  if (header.mapper === 25)
    return nesVrcBoard(
      header,
      state !== undefined && "wiring" in state ? state.wiring : undefined,
    )?.family === "vrc2" && declared8k
      ? { start: 0x6000, bank_size: 8192, bank_count: 1 }
      : null;
  if (header.mapper === 24 || header.mapper === 26)
    return declared8k
      ? { start: 0x6000, bank_size: 8192, bank_count: 1 }
      : null;
  if (header.mapper === 32)
    return header.submapper === 0 && declared8k
      ? { start: 0x6000, bank_size: 8192, bank_count: 1 }
      : null;
  if (
    header.mapper === 65 ||
    header.mapper === 67 ||
    header.mapper === 68 ||
    header.mapper === 73
  )
    return header.submapper === 0 && declared8k
      ? { start: 0x6000, bank_size: 8192, bank_count: 1 }
      : null;
  if (header.mapper === 4)
    return header.submapper !== 3 && declared8k
      ? { start: 0x6000, bank_size: 8192, bank_count: 1 }
      : null;
  if (
    header.mapper !== 1 ||
    mmc1HasFixedPrg(header) ||
    header.headerVersion !== "nes2"
  )
    return null;
  if (![8192, 16384, 32768].includes(size)) return null;
  if (size === 8192 && !singleChip) return null;
  const chrRam8k =
    (header.chrRamSize === 8192 && header.chrNvramSize === 0) ||
    (header.chrRamSize === 0 && header.chrNvramSize === 8192);
  if (header.chrRom.size === 0 && !chrRam8k) return null;
  if (
    size > 8192 &&
    header.chrRom.size > 8192 &&
    (size !== 16384 || header.chrRom.size > 65536)
  )
    return null;
  return { start: 0x6000, bank_size: 8192, bank_count: size / 8192 };
};
