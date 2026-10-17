import type { NesRomMetadata } from "./nes.js";
import type { NesMmc5State } from "./nesMmc5.js";
import type { NesPpuNametableSourcePage } from "./nesPpuNametableSource.js";
import { nesByteCandidates, type NesByteValue } from "./nesByteValue.js";
import { readMmc5ExramCell, type NesMmc5ExramOrigin } from "./nesMmc5Exram.js";
import { mmc5NametableChoices } from "./nesMmc5Ppu.js";
import { replicateMmc5Palette } from "./nesMmc5Rendering.js";
import { createMmc5FrozenPatterns } from "./nesMmc5FrozenTilePatterns.js";
import { createMmc5FrozenTilePixels } from "./nesMmc5FrozenTilePixels.js";

type Shift = 0 | 2 | 4 | 6;
type Table = 0 | 1;
type Ordinary = {
  source: NesPpuNametableSourcePage;
  tile: NesByteValue;
  attribute: NesByteValue;
};
type Attribute = {
  source: NesPpuNametableSourcePage;
  address: number;
  value: NesByteValue;
  origin: NesMmc5ExramOrigin | null;
  shift: Shift;
};
type Pattern =
  | {
      kind: "ordinary";
      groups: { table: Table; tile_page: number; banks: number[] }[];
    }
  | { kind: "4k"; banks: number[]; rows: number[] }
  | { kind: "unknown"; reason: string };
export type NesMmc5FrozenTileBranch = {
  path: "normal" | "extended" | "split" | "unknown";
  tile_source: NesPpuNametableSourcePage;
  tile_address: number;
  tile_origin: NesMmc5ExramOrigin | null;
  tile: NesByteValue;
  attribute: Attribute;
  palette_choices: number[];
  pattern: Pattern;
  coupling: "independent" | "tile-extended-attribute" | "tile-split-attribute";
  unresolved_reason: string | null;
  screen_column: number | null;
  split_y: number | null;
};
export type NesMmc5FrozenTileRow = {
  branches: NesMmc5FrozenTileBranch[];
  /** Bit n identifies compatible paired-plane pattern pixel n. */
  pixelIndexMasks: number[];
  /** Bit n identifies a compatible background palette address, including universal zero. */
  paletteIndexMasks: number[];
  /** Original physical 1 KiB CHR page file offsets, sorted and deduplicated. */
  chrPages: number[];
};
type RowInput = {
  nametableAddress: number;
  row: number;
  ordinary: readonly Ordinary[];
  screenColumn: number | null;
  /** Exact coordinates, never a joined bit envelope; null means unqualified geometry. */
  splitY: readonly number[] | null;
};
const sorted = (values: Iterable<number>): number[] =>
  [...new Set(values)].sort((a, b) => a - b);
const selected = (value: NesByteValue, mask: number): number[] =>
  sorted(nesByteCandidates(value).map((n) => n & mask));
const paletteChoices = (value: NesByteValue, shift: number): number[] =>
  sorted(nesByteCandidates(value).map((n) => (n >> shift) & 3));
const attrAddress = (offset: number): number =>
  960 | ((offset & 896) >> 4) | ((offset & 31) >> 2);
const attrShift = (offset: number): Shift => {
  const shift = ((offset >> 4) & 4) | (offset & 2);
  return shift === 0 ? 0 : shift === 2 ? 2 : shift === 4 ? 4 : 6;
};
const unknown = (reason: string) => ({ kind: "unknown" as const, reason });
const overridePaths = (
  state: NesMmc5State,
  mode: number,
  columns: number[],
) => {
  const paths = new Set<"normal" | "extended" | "split">();
  for (const control of selected(state.split[0] ?? null, 223))
    for (const column of columns) {
      const inside =
        (control & 128) !== 0 &&
        ((control & 64) !== 0
          ? column >= (control & 31)
          : column < (control & 31));
      paths.add(inside ? "split" : mode === 1 ? "extended" : "normal");
    }
  return paths;
};

/** Preserve the exact image of every seed coordinate through the 239/255 wrap rule. */
export const advanceMmc5FrozenSplitY = (
  value: NesByteValue,
  lines: number,
): number[] =>
  sorted(
    nesByteCandidates(value).map((y) => {
      if (y < 240) return (y + lines) % 240;
      const untilWrap = 256 - y;
      return lines < untilWrap ? y + lines : (lines - untilWrap) % 240;
    }),
  );

const scenarios = (state: NesMmc5State, column: number | null) => {
  const result = new Map<
    string,
    {
      path: "normal" | "extended" | "split";
      mode: number;
      gate: boolean;
      pin: boolean;
    }
  >();
  const pins =
    "ppu" in state && state.ppu.pin92_high !== null
      ? [state.ppu.pin92_high]
      : [false, true];
  const gates = new Set(
    nesByteCandidates(state.ppu_mask).map((n) => (n & 24) !== 0),
  );
  const columns =
    column === null ? Array.from({ length: 32 }, (_, i) => i) : [column];
  for (const mode of selected(state.exram_mode, 3))
    for (const gate of gates)
      for (const pin of pins) {
        const paths =
          mode >= 2 || !gate || !pin
            ? new Set(["normal" as const])
            : overridePaths(state, mode, columns);
        for (const path of paths)
          result.set(`${path}:${mode}:${gate}:${pin}`, {
            path,
            mode,
            gate,
            pin,
          });
      }
  return [...result.values()];
};

const exramFact = (state: NesMmc5State, address: number) => {
  const cell = readMmc5ExramCell(state, address);
  return state.exram_written === false
    ? { address, value: null, origin: null }
    : cell;
};
const ordinaryReason = (
  state: NesMmc5State,
  source: NesPpuNametableSourcePage,
): string | null => {
  if (typeof source === "number") return null;
  if (source.kind === "unknown") return source.reason;
  return state.exram_written === false && source.kind === "mmc5-exram"
    ? "mmc5-exram-access-unverified"
    : null;
};
const ordinaryBranches = (
  state: NesMmc5State,
  input: RowInput,
  mode: number,
): Pick<
  NesMmc5FrozenTileBranch,
  "tile_source" | "tile_address" | "tile_origin" | "tile" | "attribute"
>[] => {
  const offset = input.nametableAddress & 1023,
    address = attrAddress(offset),
    shift = attrShift(offset);
  return mmc5NametableChoices(
    { ...state, exram_mode: mode },
    input.nametableAddress,
  ).map((choice) => {
    if (choice.source === "exram") {
      const tile = exramFact(state, offset),
        attribute = exramFact(state, address),
        source = { kind: "mmc5-exram" as const };
      return {
        tile_source: source,
        tile_address: offset,
        tile_origin: tile.origin,
        tile: tile.value,
        attribute: { source, ...attribute, shift },
      };
    }
    if (choice.source === "fill" || choice.source === "zero") {
      const fill = choice.source === "fill",
        source: NesPpuNametableSourcePage = fill
          ? {
              kind: "mmc5-fill",
              tile: state.fill_tile,
              attribute: state.fill_attribute,
            }
          : { kind: "mmc5-zero" };
      return {
        tile_source: source,
        tile_address: offset,
        tile_origin: null,
        tile: fill ? state.fill_tile : 0,
        attribute: {
          source,
          address,
          value: fill ? replicateMmc5Palette(state.fill_attribute, 0) : 0,
          origin: null,
          shift,
        },
      };
    }
    const source = input.ordinary.find(
      (candidate) => candidate.source === (choice.bank ?? 0) * 1024,
    );
    const backing = source?.source ?? unknown("unknown-nametable-wiring");
    return {
      tile_source: backing,
      tile_address: offset,
      tile_origin: null,
      tile: source?.tile ?? null,
      attribute: {
        source: backing,
        address,
        value: source?.attribute ?? null,
        origin: null,
        shift,
      },
    };
  });
};

const splitBranch = (
  state: NesMmc5State,
  input: RowInput,
  y: number,
  pattern: Pattern,
): NesMmc5FrozenTileBranch => {
  const address = (y & 248) * 4 + input.screenColumn!,
    tile = exramFact(state, address),
    attribute = exramFact(state, attrAddress(address)),
    shift = attrShift(address),
    source = { kind: "mmc5-exram" as const };
  return {
    path: "split",
    tile_source: source,
    tile_address: address,
    tile_origin: tile.origin,
    tile: tile.value,
    attribute: { source, ...attribute, shift },
    palette_choices: paletteChoices(attribute.value, shift),
    pattern,
    coupling:
      state.exram_written !== false && address === attribute.address
        ? "tile-split-attribute"
        : "independent",
    unresolved_reason:
      state.exram_written === false ? "mmc5-exram-access-unverified" : null,
    screen_column: input.screenColumn,
    split_y: y,
  };
};

const missingSplit = (input: RowInput): NesMmc5FrozenTileBranch => {
  const source = unknown("missing-split-coordinate");
  return {
    path: "unknown",
    tile_source: source,
    tile_address: input.nametableAddress & 1023,
    tile_origin: null,
    tile: null,
    attribute: {
      source,
      address: attrAddress(input.nametableAddress & 1023),
      value: null,
      origin: null,
      shift: 0,
    },
    palette_choices: [0, 1, 2, 3],
    pattern: source,
    coupling: "independent",
    unresolved_reason: "missing-split-coordinate",
    screen_column: input.screenColumn,
    split_y: null,
  };
};

const freezeFacts = <T>(value: T): T => {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeFacts(child);
    Object.freeze(value);
  }
  return value;
};
const createBranchIntern = (
  patterns: ReturnType<typeof createMmc5FrozenPatterns>,
  snapshot: { header: NesRomMetadata; bytes: Uint8Array | undefined },
) => {
  const values = new Map<string, NesMmc5FrozenTileBranch>(),
    ids = new Map<NesMmc5FrozenTileBranch, number>(),
    sets = new Map<string, NesMmc5FrozenTileBranch[]>();
  const add = (branch: NesMmc5FrozenTileBranch): NesMmc5FrozenTileBranch => {
    const { header, bytes } = snapshot;
    if (header.chrRom.size === 0 && branch.pattern.kind !== "unknown") {
      branch.pattern = { kind: "unknown", reason: "mmc5-chr-ram-unmodeled" };
      branch.unresolved_reason = "mmc5-chr-ram-unmodeled";
    } else if (bytes === undefined || bytes.length !== header.chrRom.size)
      branch.unresolved_reason ??=
        bytes === undefined ? "missing-snapshot" : "inconsistent-snapshot";
    const key = JSON.stringify({
        ...branch,
        pattern: patterns.id(branch.pattern),
      }),
      existing = values.get(key);
    if (existing !== undefined) return existing;
    const retained = {
      ...branch,
      tile_source: structuredClone(branch.tile_source),
      tile: structuredClone(branch.tile),
      tile_origin: structuredClone(branch.tile_origin),
      attribute: structuredClone(branch.attribute),
      palette_choices: [...branch.palette_choices],
    };
    freezeFacts(retained);
    values.set(key, retained);
    ids.set(retained, ids.size);
    return retained;
  };
  return {
    add,
    set(branches: NesMmc5FrozenTileBranch[]): NesMmc5FrozenTileBranch[] {
      const distinct = [...new Set(branches)].sort(
          (a, b) => ids.get(a)! - ids.get(b)!,
        ),
        key = distinct.map((branch) => ids.get(branch)!).join(":"),
        existing = sets.get(key);
      if (existing !== undefined) return existing;
      freezeFacts(distinct);
      sets.set(key, distinct);
      return distinct;
    },
  };
};
const createBranchProducer = (
  state: NesMmc5State,
  patterns: ReturnType<typeof createMmc5FrozenPatterns>,
  snapshot: { header: NesRomMetadata; bytes: Uint8Array | undefined },
) => {
  const scenarioCache = new Map<number | null, ReturnType<typeof scenarios>>(),
    splits = new Map<string, NesMmc5FrozenTileBranch>(),
    intern = createBranchIntern(patterns, snapshot),
    sl = "ppu" in state && state.ppu.split_wiring === "sl";
  const split = (input: RowInput, y: number): NesMmc5FrozenTileBranch => {
    const key = `${input.screenColumn}:${y}:${sl ? -1 : input.row}`;
    let branch = splits.get(key);
    if (branch === undefined) {
      branch = intern.add(
        splitBranch(state, input, y, patterns.split(input.row, y)),
      );
      splits.set(key, branch);
    }
    return branch;
  };
  return (input: RowInput): NesMmc5FrozenTileBranch[] => {
    const branches: NesMmc5FrozenTileBranch[] = [];
    let possible = scenarioCache.get(input.screenColumn);
    if (possible === undefined) {
      possible = scenarios(state, input.screenColumn);
      scenarioCache.set(input.screenColumn, possible);
    }
    if (possible.some((scenario) => scenario.path === "split")) {
      if (input.screenColumn === null || input.splitY === null)
        branches.push(intern.add(missingSplit(input)));
      else for (const y of input.splitY) branches.push(split(input, y));
    }
    for (const scenario of possible.filter(
      (scenario) => scenario.path !== "split",
    ))
      for (const ordinary of ordinaryBranches(state, input, scenario.mode)) {
        const branch: NesMmc5FrozenTileBranch = {
          ...ordinary,
          path: scenario.path,
          palette_choices: paletteChoices(
            ordinary.attribute.value,
            ordinary.attribute.shift,
          ),
          pattern: patterns.ordinary(scenario.gate, scenario.pin),
          coupling: "independent",
          unresolved_reason: ordinaryReason(state, ordinary.tile_source),
          screen_column: input.screenColumn,
          split_y: null,
        };
        if (scenario.path === "extended") {
          const attribute = exramFact(state, input.nametableAddress & 1023);
          branch.attribute = {
            source: { kind: "mmc5-exram" },
            ...attribute,
            shift: 6,
          };
          branch.palette_choices = paletteChoices(attribute.value, 6);
          branch.pattern = patterns.extended(attribute.value, input.row);
          if (
            typeof ordinary.tile_source !== "number" &&
            ordinary.tile_source.kind === "mmc5-exram" &&
            state.exram_written !== false
          )
            branch.coupling = "tile-extended-attribute";
          if (state.exram_written === false)
            branch.unresolved_reason = "mmc5-exram-access-unverified";
        }
        branches.push(intern.add(branch));
      }
    return intern.set(branches);
  };
};

/** Frozen query geometry is explicit; captured pipeline positions never supply missing coordinates. */
export const createMmc5FrozenTileProjector = ({
  header,
  mapper,
  chr,
  patternTables,
}: {
  header: NesRomMetadata;
  mapper: NesMmc5State;
  chr?: Uint8Array | undefined;
  patternTables: readonly Table[];
}) => {
  const state = structuredClone(mapper),
    bytes = chr?.slice(),
    patterns = createMmc5FrozenPatterns(header, state, patternTables),
    pixels = createMmc5FrozenTilePixels(header, bytes, patterns.id),
    branchesFor = createBranchProducer(state, patterns, { header, bytes });
  return {
    projectRow(input: RowInput): NesMmc5FrozenTileRow {
      const branches = branchesFor(input);
      return { branches, ...pixels.project(branches, input.row) };
    },
  };
};
