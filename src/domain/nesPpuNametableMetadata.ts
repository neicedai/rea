import type { NesPpuState } from "./nesPpuState.js";
import type {
  NesPpuNametable,
  NesPpuNametablePage,
} from "./nesPpuNametable.js";
import { readNesPpuPaletteCell } from "./nesPpuPalette.js";
import { nesByteBits } from "./nesByteValue.js";

export type NesPpuNametableMetadata = Pick<
  NesPpuNametable,
  "page" | "ppu_address" | "pattern_tables" | "palette_cells" | "palettes"
>;
/** Common frozen page/palette facts do not interpret an ordinary or overridden tile. */
export const nesPpuNametableMetadata = (
  ppu: NesPpuState,
  page: NesPpuNametablePage,
): NesPpuNametableMetadata => {
  const control = nesByteBits(ppu.control, 16);
  return {
    page,
    ppu_address: 8192 + page * 1024,
    pattern_tables: control === null ? [0, 1] : control === 0 ? [0] : [1],
    palette_cells: ([0, 1, 2, 3, 5, 6, 7, 9, 10, 11, 13, 14, 15] as const).map(
      (address) => {
        const { value, code } = readNesPpuPaletteCell(ppu, address);
        return { address, value, code };
      },
    ),
    palettes: Array.from({ length: 4 }, (_, subpalette) => ({
      subpalette,
      cells: [0, subpalette * 3 + 1, subpalette * 3 + 2, subpalette * 3 + 3],
    })),
  };
};
