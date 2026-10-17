import type { NesRomMetadata } from "./nes.js";
import type { NesMmc5State } from "./nesMmc5.js";
import { mmc5ChrOffsets } from "./nesMmc5Ppu.js";
import { nesByteCandidates, type NesByteValue } from "./nesByteValue.js";
import type { NesMmc5FrozenTileBranch } from "./nesMmc5FrozenTile.js";
type Pattern = NesMmc5FrozenTileBranch["pattern"];
const sorted = (values: Iterable<number>): number[] =>
  [...new Set(values)].sort((a, b) => a - b);
const selected = (value: NesByteValue, mask: number): number[] =>
  sorted(nesByteCandidates(value).map((n) => n & mask));
const freezePattern = (pattern: Pattern): Pattern => {
  if (pattern.kind === "ordinary") {
    for (const group of pattern.groups) {
      Object.freeze(group.banks);
      Object.freeze(group);
    }
    Object.freeze(pattern.groups);
  } else if (pattern.kind === "4k") {
    Object.freeze(pattern.banks);
    Object.freeze(pattern.rows);
  }
  return Object.freeze(pattern);
};
/** Immutable selectors are interned only within one frozen projection operation. */
export const createMmc5FrozenPatterns = (
  header: NesRomMetadata,
  state: NesMmc5State,
  tables: readonly (0 | 1)[],
) => {
  const groups = new Map<string, Extract<Pattern, { kind: "ordinary" }>>(),
    splitPatterns = new Map<string, Pattern>(),
    extendedPatterns = new Map<string, Pattern>(),
    patternIds = new Map<Pattern | string, number>(),
    count = header.chrRom.size / 4096,
    splitBanks = count === 0 ? [] : selected(state.split[2] ?? null, count - 1),
    upper = selected(state.chr_upper, 3),
    wiring = "ppu" in state ? state.ppu.split_wiring : null;
  const id = (pattern: Pattern): number => {
    const key =
      pattern.kind === "unknown" ? `unknown:${pattern.reason}` : pattern;
    let id = patternIds.get(key);
    if (id === undefined) {
      id = patternIds.size;
      patternIds.set(key, id);
    }
    freezePattern(pattern);
    return id;
  };
  const split = (row: number, y: number): Pattern => {
    const rows = sorted([
        ...(wiring !== "sl" ? [row] : []),
        ...(wiring !== "cl" ? [y & 7] : []),
      ]),
      key = rows.join(":");
    let pattern = splitPatterns.get(key);
    if (pattern === undefined) {
      pattern = { kind: "4k", banks: splitBanks, rows };
      splitPatterns.set(key, pattern);
    }
    return pattern;
  };
  const extended = (value: NesByteValue, row: number): Pattern => {
    const low = selected(value, 63),
      key = `${low.join(":")}:${row}`;
    let pattern = extendedPatterns.get(key);
    if (pattern === undefined) {
      pattern = {
        kind: "4k",
        banks:
          count === 0
            ? []
            : sorted(
                upper.flatMap((high) =>
                  low.map((bank) => (high * 64 + bank) & (count - 1)),
                ),
              ),
        rows: [row],
      };
      extendedPatterns.set(key, pattern);
    }
    return pattern;
  };
  const ordinary = (gate: boolean, pin: boolean): Pattern => {
    const key = `${gate}:${pin}`;
    let pattern = groups.get(key);
    if (pattern === undefined) {
      const conditioned = { ...state, ppu_mask: gate ? 24 : 0 };
      pattern = {
        kind: "ordinary",
        groups: tables.flatMap((table) =>
          Array.from({ length: 4 }, (_, tile_page) => ({
            table,
            tile_page,
            banks: mmc5ChrOffsets(
              header,
              conditioned,
              table * 4096 + tile_page * 1024,
              pin ? "background" : undefined,
            ).map((offset) => (offset - header.chrRom.offset) / 1024),
          })),
        ),
      };
      groups.set(key, pattern);
    }
    return pattern;
  };
  return { id, split, extended, ordinary };
};
