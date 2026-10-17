export type NesDiscoveryRamCell = Readonly<{
  writer_witness_indices: readonly number[];
  initial_unwritten_possible: boolean;
  unknown_write_possible: boolean;
}>;
export type NesDiscoveryRamPage = readonly (NesDiscoveryRamCell | undefined)[];
/** Values live in the current-value owner; RAM pages retain only actual source alternatives. */
export type NesDiscoveryRam = readonly (NesDiscoveryRamPage | undefined)[];
export const emptyNesDiscoveryRam = (): NesDiscoveryRam =>
  Object.freeze(Array<undefined>(64).fill(undefined));
export const readNesDiscoveryRam = (
  ram: NesDiscoveryRam,
  address: number,
): NesDiscoveryRamCell | undefined => ram[address >> 5]?.[address & 31];
const immutableCell = (cell: NesDiscoveryRamCell): NesDiscoveryRamCell =>
  Object.freeze({
    writer_witness_indices: Object.freeze(
      [...new Set(cell.writer_witness_indices)].sort((a, b) => a - b),
    ),
    initial_unwritten_possible: cell.initial_unwritten_possible,
    unknown_write_possible: cell.unknown_write_possible,
  });
export const writeNesDiscoveryRam = (
  ram: NesDiscoveryRam,
  address: number,
  cell: NesDiscoveryRamCell | undefined,
): NesDiscoveryRam => {
  const pageIndex = address >> 5,
    page = [...(ram[pageIndex] ?? Array<undefined>(32).fill(undefined))],
    pages = [...ram];
  page[address & 31] = cell === undefined ? undefined : immutableCell(cell);
  pages[pageIndex] = Object.freeze(page);
  return Object.freeze(pages);
};
/** A possible unlocated write does not erase the possibility of an earlier or initial byte. */
export const markUnknownNesDiscoveryRamWrites = (
  ram: NesDiscoveryRam,
  start = 0,
  end = 2048,
): NesDiscoveryRam => {
  const pages = [...ram];
  for (let index = start >> 5; index < (end + 31) >> 5; index++) {
    const page = [...(ram[index] ?? Array<undefined>(32).fill(undefined))];
    for (let offset = 0; offset < 32; offset++) {
      const address = index * 32 + offset;
      if (address < start || address >= end) continue;
      const cell = page[offset];
      page[offset] = immutableCell({
        writer_witness_indices: cell?.writer_witness_indices ?? [],
        initial_unwritten_possible: cell?.initial_unwritten_possible ?? true,
        unknown_write_possible: true,
      });
    }
    pages[index] = Object.freeze(page);
  }
  return Object.freeze(pages);
};
export const clearNesDiscoveryStack = (ram: NesDiscoveryRam): NesDiscoveryRam =>
  markUnknownNesDiscoveryRamWrites(ram, 256, 512);
const commonCell = (
  left: NesDiscoveryRamCell | undefined,
  right: NesDiscoveryRamCell | undefined,
): NesDiscoveryRamCell | undefined => {
  if (left === right) return left;
  const cell = immutableCell({
    writer_witness_indices: [
      ...(left?.writer_witness_indices ?? []),
      ...(right?.writer_witness_indices ?? []),
    ],
    initial_unwritten_possible:
      (left?.initial_unwritten_possible ?? true) ||
      (right?.initial_unwritten_possible ?? true),
    unknown_write_possible:
      (left?.unknown_write_possible ?? false) ||
      (right?.unknown_write_possible ?? false),
  });
  if (
    cell.writer_witness_indices.length === 0 &&
    cell.initial_unwritten_possible &&
    !cell.unknown_write_possible
  )
    return undefined;
  return JSON.stringify(cell) === JSON.stringify(left) ? left : cell;
};
export const joinNesDiscoveryRam = (
  left: NesDiscoveryRam,
  right: NesDiscoveryRam,
): NesDiscoveryRam => {
  if (left === right) return left;
  let pages: (NesDiscoveryRamPage | undefined)[] | undefined;
  for (let index = 0; index < 64; index++) {
    const a = left[index],
      b = right[index];
    if (a === b) continue;
    const page: (NesDiscoveryRamCell | undefined)[] = [];
    let changed = false;
    for (let offset = 0; offset < 32; offset++) {
      const cell = commonCell(a?.[offset], b?.[offset]);
      page.push(cell);
      changed ||= cell !== a?.[offset];
    }
    if (changed) {
      pages ??= [...left];
      pages[index] = Object.freeze(page);
    }
  }
  return pages === undefined ? left : Object.freeze(pages);
};
