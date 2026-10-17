import type { NesRomMetadata } from "./nes.js";
import type { NesMmc5State } from "./nesMmc5.js";
import { readMmc5ExramCell } from "./nesMmc5Exram.js";
import {
  nesByteBits,
  nesByteCandidates,
  nesByteProof,
  joinNesBytes,
  type NesByteValue,
} from "./nesByteValue.js";
import {
  readMmc5Ppu,
  mmc5ChrOffsets,
  mmc5ChrByteProof,
  type NesMmc5Fetch,
  type NesMmc5PpuRead,
} from "./nesMmc5Ppu.js";
import {
  mmc5Substitutions,
  nextMmc5SplitY,
  type NesMmc5RenderingState,
  type NesMmc5TilePosition,
} from "./nesMmc5RenderingState.js";

type State = Extract<NesMmc5State, { ppu: NesMmc5RenderingState }>;
type Path = NesMmc5RenderingState["paths"][number];
type ReadKind = "tile" | "attribute" | "pattern-low" | "pattern-high" | "other";
type Reason =
  | "missing-tile"
  | "unexpected-address"
  | "incompatible-tile"
  | "unqualified-fetch"
  | null;
const proof = (read: NesMmc5PpuRead): NesByteValue =>
  read.value ?? ("known_bits" in read ? read.known_bits : null);
const join = (values: NesByteValue[]): NesByteValue =>
  values.length === 0 ? null : values.reduce(joinNesBytes);
const exram = (state: State, address: number) => {
  const cell = readMmc5ExramCell(state, address);
  return {
    address,
    value: state.exram_written === false ? null : cell.value,
    ...(state.exram_written !== false && cell.origin !== null
      ? { origin: cell.origin }
      : {}),
  };
};
export const replicateMmc5Palette = (
  byte: NesByteValue,
  shift: number,
): NesByteValue => {
  const bits =
    typeof byte === "number"
      ? { mask: 255, value: byte }
      : (byte ?? { mask: 0, value: 0 });
  return nesByteProof(
    ((bits.mask >> shift) & 3) * 85,
    ((bits.value >> shift) & 3) * 85,
  );
};
const attributeAddress = (address: number) =>
  (address & 0x2c00) | 0x3c0 | ((address & 0x380) >> 4) | ((address & 31) >> 2);

/** No logical screen coordinates or split clocks are inferred from bus address counts. */
export const advanceMmc5Rendering = (
  state: State,
  kind: "mmc5-render-frame" | "mmc5-render-line",
): void => {
  state.ppu.split_y =
    kind === "mmc5-render-frame"
      ? (state.split[1] ?? null)
      : nextMmc5SplitY(state.ppu.split_y);
  state.ppu.phase = "unknown";
};

/** Phase-independent possible background interpretations; no captured tile history or clocks are consumed. */
export const mmc5BackgroundPaths = (
  state: NesMmc5State,
  column: number | null,
): { paths: Path[]; splitColumns: number[] } => {
  const paths = new Set<Path>(),
    splitColumns = new Set<number>();
  const gates = mmc5Substitutions(state.ppu_mask),
    pins = "ppu" in state ? state.ppu.pin92_high : null;
  const columns =
    column === null ? Array.from({ length: 32 }, (_, i) => i) : [column];
  for (const mode of new Set(
    nesByteCandidates(state.exram_mode).map((n) => n & 3),
  )) {
    if (mode >= 2 || gates !== true || pins !== true) paths.add("normal");
    if (mode >= 2 || gates === false || pins === false) continue;
    for (const control of nesByteCandidates(state.split[0] ?? null))
      for (const c of columns) {
        const inside =
          (control & 128) !== 0 &&
          ((control & 64) !== 0 ? c >= (control & 31) : c < (control & 31));
        paths.add(inside ? "split" : mode === 1 ? "extended" : "normal");
        if (inside) splitColumns.add(c);
      }
  }
  return {
    paths: (["normal", "extended", "split"] as const).filter((path) =>
      paths.has(path),
    ),
    splitColumns: [...splitColumns].sort((a, b) => a - b),
  };
};

const finish = (
  source: NesMmc5PpuRead,
  ppu: NesMmc5RenderingState,
  info: { fetch: ReadKind; reason: Reason; rows?: number[] },
  value = proof(source),
): NesMmc5PpuRead => {
  const hasNormal =
    info.fetch === "tile"
      ? ppu.paths.some((p) => p !== "split")
      : ppu.paths.includes("normal");
  const hasExram =
    info.fetch === "tile"
      ? ppu.paths.includes("split")
      : info.fetch === "attribute" && ppu.paths.some((p) => p !== "normal");
  const overrideCells =
    hasExram && !hasNormal
      ? info.fetch === "tile"
        ? ppu.split_tiles
        : [
            ...(ppu.paths.includes("extended") &&
            ppu.extended_attribute !== null
              ? [ppu.extended_attribute]
              : []),
            ...ppu.split_attributes,
          ]
      : null;
  const addresses = new Set(overrideCells?.map((cell) => cell.address));
  const base = {
    status: source.status,
    bank: source.bank,
    file_offset: source.file_offset,
    mmc5: {
      ...source.mmc5,
      limitation:
        info.reason === "unqualified-fetch" ? source.mmc5.limitation : null,
      chr_sets: ppu.paths.includes("normal") ? source.mmc5.chr_sets : [],
      registers: ppu.paths.includes("normal") ? source.mmc5.registers : [],
      nametable_sources: hasExram
        ? hasNormal
          ? [...new Set([...source.mmc5.nametable_sources, "exram" as const])]
          : ["exram" as const]
        : source.mmc5.nametable_sources,
      cell_address:
        overrideCells === null
          ? source.mmc5.cell_address
          : addresses.size === 1
            ? [...addresses][0]!
            : null,
      cell_value:
        overrideCells === null
          ? source.mmc5.cell_value
          : join(overrideCells.map((cell) => cell.value)),
      rendering: {
        paths: [...ppu.paths],
        fetch: info.fetch,
        nametable_address: ppu.nametable_address,
        tile_column: ppu.tile_column,
        tile_y: ppu.tile_y,
        extended_attribute: structuredClone(ppu.extended_attribute),
        split_tiles: structuredClone(ppu.split_tiles),
        split_attributes: structuredClone(ppu.split_attributes),
        pattern_rows: info.rows ?? [],
        reason: info.reason,
      },
    },
  };
  return typeof value === "number"
    ? { ...base, value }
    : value === null
      ? { ...base, value: null }
      : { ...base, value: null, known_bits: value };
};

const tileRead = (
  state: State,
  address: number,
  ordinary: NesMmc5PpuRead,
  tile?: NesMmc5TilePosition,
): NesMmc5PpuRead => {
  const ppu = state.ppu,
    selected = mmc5BackgroundPaths(state, tile?.column ?? null);
  ppu.paths = selected.paths;
  ppu.nametable_address = address;
  ppu.tile_column = tile?.column ?? null;
  ppu.tile_y =
    tile?.line === "current"
      ? ppu.split_y
      : tile?.line === "next"
        ? nextMmc5SplitY(ppu.split_y)
        : joinNesBytes(ppu.split_y, nextMmc5SplitY(ppu.split_y));
  const cells = new Set<number>();
  for (const y of nesByteCandidates(ppu.tile_y))
    for (const column of selected.splitColumns)
      cells.add((y & 248) * 4 + column);
  ppu.split_tiles = [...cells]
    .sort((a, b) => a - b)
    .map((address) => exram(state, address));
  ppu.extended_attribute = null;
  ppu.split_attributes = [];
  ppu.pattern_address = null;
  ppu.phase = "attribute";
  ppu.tile_value = join(
    ppu.paths.map((path) =>
      path === "split"
        ? join(ppu.split_tiles.map((cell) => cell.value))
        : proof(ordinary),
    ),
  );
  const splitOnly = ppu.paths.length === 1 && ppu.paths[0] === "split";
  return finish(
    {
      ...ordinary,
      status: splitOnly
        ? "exram"
        : ppu.paths.includes("split")
          ? "unknown-nametable-bank"
          : ordinary.status,
      bank: splitOnly || ppu.paths.includes("split") ? null : ordinary.bank,
    },
    ppu,
    { fetch: "tile", reason: null },
    ppu.tile_value,
  );
};

const attributeRead = (
  state: State,
  address: number,
  ordinary: NesMmc5PpuRead,
): NesMmc5PpuRead => {
  const ppu = state.ppu;
  if (
    ppu.phase !== "attribute" ||
    ppu.nametable_address === null ||
    (ppu.nametable_address & 1023) >= 960
  )
    return invalidRead(state, ordinary, "attribute", "missing-tile");
  if (address !== attributeAddress(ppu.nametable_address))
    return invalidRead(state, ordinary, "attribute", "unexpected-address");
  if (ppu.paths.includes("extended"))
    ppu.extended_attribute = exram(state, ppu.nametable_address & 1023);
  const positions = new Map<
    string,
    { address: number; shift: 0 | 2 | 4 | 6 }
  >();
  for (const tile of ppu.split_tiles) {
    const address = attributeAddress(tile.address) & 1023,
      shift = (((tile.address >> 4) & 4) | (tile.address & 2)) as 0 | 2 | 4 | 6;
    positions.set(`${address}:${shift}`, { address, shift });
  }
  ppu.split_attributes = [...positions.values()]
    .sort((a, b) => a.address - b.address || a.shift - b.shift)
    .map(({ address, shift }) => ({ ...exram(state, address), shift }));
  const value = join(
    ppu.paths.map((path) =>
      path === "normal"
        ? proof(ordinary)
        : path === "extended"
          ? replicateMmc5Palette(ppu.extended_attribute?.value ?? null, 6)
          : join(
              ppu.split_attributes.map((cell) =>
                replicateMmc5Palette(cell.value, cell.shift),
              ),
            ),
    ),
  );
  ppu.phase = "pattern-low";
  return finish(
    {
      ...ordinary,
      status: ppu.paths.includes("normal")
        ? ppu.paths.length === 1
          ? ordinary.status
          : "unknown-nametable-bank"
        : "exram",
      bank:
        ppu.paths.length === 1 && ppu.paths[0] === "normal"
          ? ordinary.bank
          : null,
    },
    ppu,
    { fetch: "attribute", reason: null },
    value,
  );
};

const invalidRead = (
  state: State,
  ordinary: NesMmc5PpuRead,
  fetch: ReadKind,
  reason: Exclude<Reason, null>,
): NesMmc5PpuRead => {
  const ppu = state.ppu;
  // Inactive captured geometry is historical evidence, not the next tile's position.
  ppu.paths = mmc5BackgroundPaths(state, null).paths;
  ppu.phase = "unknown";
  if (ppu.paths.every((path) => path === "normal"))
    return finish(ordinary, ppu, { fetch, reason });
  const rom_sources =
    "rom_sources" in ordinary.mmc5 ? ordinary.mmc5.rom_sources : null;
  return finish(
    {
      status: fetch.startsWith("pattern")
        ? "unknown-chr-bank"
        : "unknown-nametable-bank",
      bank: null,
      file_offset: null,
      value: null,
      mmc5: {
        ...ordinary.mmc5,
        ...(fetch.startsWith("pattern")
          ? {
              rom_sources: {
                status: "unresolved" as const,
                reason: "rendering-context" as const,
                file_offsets: rom_sources?.file_offsets ?? [],
              },
            }
          : {}),
      },
    },
    ppu,
    { fetch, reason },
    null,
  );
};

const renderOffsets = (
  header: NesRomMetadata,
  state: State,
  address: number,
): { offsets: number[]; rows: number[] } => {
  const offsets = new Set<number>(),
    rows = new Set<number>(),
    count = header.chrRom.size / 4096,
    ppu = state.ppu;
  if (count === 0) return { offsets: [], rows: [] };
  for (const path of ppu.paths) {
    if (path === "normal") {
      for (const offset of mmc5ChrOffsets(
        header,
        state,
        address,
        ppu.pin92_high === true ? "background" : undefined,
      ))
        offsets.add(offset);
      rows.add(address & 7);
    } else if (path === "extended") {
      const low = new Set(
        nesByteCandidates(ppu.extended_attribute?.value ?? null).map(
          (v) => v & 63,
        ),
      );
      const high = new Set(
        nesByteCandidates(state.chr_upper).map((v) => v & 3),
      );
      for (const upper of high)
        for (const bank of low)
          offsets.add(
            header.chrRom.offset +
              ((upper * 64 + bank) & (count - 1)) * 4096 +
              (address & 4095),
          );
      rows.add(address & 7);
    } else {
      const selectedRows = new Set<number>();
      if (ppu.split_wiring !== "sl") selectedRows.add(address & 7);
      if (ppu.split_wiring !== "cl")
        for (const y of nesByteCandidates(ppu.tile_y)) selectedRows.add(y & 7);
      for (const bank of new Set(
        nesByteCandidates(state.split[2] ?? null).map((v) => v & (count - 1)),
      ))
        for (const row of selectedRows) {
          offsets.add(
            header.chrRom.offset + bank * 4096 + (address & 4088) + row,
          );
          rows.add(row);
        }
    }
  }
  return {
    offsets: [...offsets].sort((a, b) => a - b),
    rows: [...rows].sort((a, b) => a - b),
  };
};

const patternRead = (
  header: NesRomMetadata,
  state: State,
  address: number,
  ordinary: NesMmc5PpuRead,
  chr?: Uint8Array,
): NesMmc5PpuRead => {
  const ppu = state.ppu,
    high = (address & 8) !== 0,
    fetch = high ? "pattern-high" : "pattern-low";
  if (ppu.phase !== (high ? "pattern-high" : "pattern-low"))
    return invalidRead(state, ordinary, fetch, "missing-tile");
  if (
    high &&
    address !== (ppu.pattern_address === null ? null : ppu.pattern_address + 8)
  )
    return invalidRead(state, ordinary, fetch, "unexpected-address");
  const knownTile = nesByteBits(ppu.tile_value, 255);
  const partial =
    typeof ppu.tile_value === "number"
      ? { mask: 255, value: ppu.tile_value }
      : ppu.tile_value;
  if (
    (knownTile !== null && knownTile !== ((address >> 4) & 255)) ||
    (partial !== null && ((address >> 4) & partial.mask) !== partial.value)
  )
    return invalidRead(state, ordinary, fetch, "incompatible-tile");
  const candidates = renderOffsets(header, state, address),
    result = mmc5ChrByteProof(header, chr, candidates.offsets);
  const banks = new Set(
    candidates.offsets.map((offset) =>
      Math.floor((offset - header.chrRom.offset) / 1024),
    ),
  );
  const bank = banks.size === 1 ? [...banks][0]! : null,
    file_offset =
      candidates.offsets.length === 1 ? candidates.offsets[0]! : null;
  ppu.pattern_address = high ? ppu.pattern_address : address;
  ppu.phase = high ? "idle" : "pattern-high";
  return finish(
    {
      status:
        file_offset !== null
          ? "chr-rom"
          : bank !== null
            ? "unknown-chr-offset"
            : "unknown-chr-bank",
      bank,
      file_offset,
      value: null,
      mmc5: { ...ordinary.mmc5, rom_sources: result.rom_sources },
    },
    ppu,
    { fetch, reason: null, rows: candidates.rows },
    result.value,
  );
};

/** Qualified sequential tile interpreter; ordinary mode remains a distinct joined path. */
export const readMmc5BackgroundPpu = (
  header: NesRomMetadata,
  state: State,
  address: number,
  {
    fetch,
    chr,
    tile,
    ordinaryRead,
  }: {
    fetch?: NesMmc5Fetch | undefined;
    chr?: Uint8Array | undefined;
    tile?: NesMmc5TilePosition | undefined;
    ordinaryRead?: NesMmc5PpuRead | undefined;
  } = {},
): NesMmc5PpuRead => {
  const ppu = state.ppu,
    base =
      ordinaryRead ??
      readMmc5Ppu(header, state, address, {
        fetch: ppu.pin92_high === true ? fetch : undefined,
        chr,
        ordinary: fetch !== undefined || ppu.pin92_high === false,
      });
  const ordinary = { ...base, mmc5: { ...base.mmc5, fetch: fetch ?? null } };
  if (fetch !== "background") {
    ppu.phase = "unknown";
    return finish(
      ordinary,
      {
        ...ppu,
        paths:
          fetch === undefined
            ? mmc5BackgroundPaths(state, null).paths
            : ["normal"],
      },
      {
        fetch: "other",
        reason: fetch === undefined ? "unqualified-fetch" : null,
      },
    );
  }
  const normalized =
    address >= 0x3000 && address < 0x3f00 ? address - 0x1000 : address;
  if (normalized >= 0x2000 && normalized < 0x3000)
    return (normalized & 1023) < 960
      ? tileRead(state, normalized, ordinary, tile)
      : attributeRead(state, normalized, ordinary);
  if (address < 8192) return patternRead(header, state, address, ordinary, chr);
  ppu.phase = "unknown";
  return finish(ordinary, ppu, {
    fetch: "other",
    reason: "unexpected-address",
  });
};
