import { nesByteBits, type NesByteValue } from "./nesByteValue.js";
import { nesPrgRamLayout } from "./nesPrgRamLayout.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";

/** Physical MMC6 RAM, mirrored four times; open bus is deliberately unknown. */
export const mmc6RamAccess = (
  header: NesRomMetadata,
  state: Extract<NesMapperState, { mapper: 4 }>,
  address: number,
): {
  ram_address: number;
  readable: boolean | null;
  writable: boolean | null;
  zero: {
    bank_select: Exclude<NesByteValue, null>;
    ram_protect: Exclude<NesByteValue, null>;
  } | null;
} | null => {
  if (
    header.mapper !== 4 ||
    header.submapper !== 1 ||
    address < 0x7000 ||
    address > 0x7fff
  )
    return null;
  const layout = nesPrgRamLayout(header);
  if (layout === null) return null;
  const ram_address = layout.start | (address & (layout.bank_size - 1));
  const enabled = nesByteBits(state.bank_select, 32);
  if (enabled === 0)
    return { ram_address, readable: false, writable: false, zero: null };
  const protect = state.ram_protect;
  const shift = (address & 0x200) === 0 ? 4 : 6;
  const read = nesByteBits(protect, 2 << shift);
  const write = nesByteBits(protect, 1 << shift);
  const otherRead = nesByteBits(protect, shift === 4 ? 128 : 32);
  const readable =
    read === 0 ? false : enabled === null || read === null ? null : true;
  return {
    ram_address,
    readable,
    writable:
      readable === false || write === 0
        ? false
        : readable === true && write !== null
          ? true
          : null,
    zero:
      enabled === 32 && read === 0 && otherRead !== null && otherRead !== 0
        ? { bank_select: state.bank_select!, ram_protect: protect! }
        : null,
  };
};
