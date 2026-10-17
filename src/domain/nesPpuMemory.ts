import type { NesRomMetadata } from "./nes.js";
import { compareUnicodeCodePoints } from "./unicodeCodePointOrder.js";
import { nesOamAdmission } from "./nesOam.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import { isMmc5State } from "./nesMmc5.js";
import {
  readMmc5ExramCell,
  updateMmc5ExramCell,
  admitMmc5ExramOrigins,
} from "./nesMmc5Exram.js";
import { replicateMmc5Palette } from "./nesMmc5Rendering.js";
import type { NesMmc5Fetch } from "./nesMmc5Ppu.js";
import {
  mmc5FrozenPatternPages,
  mmc5FrozenNametablePages,
  readMmc5FrozenNametablePage,
} from "./nesMmc5PpuMemory.js";
import {
  isVrc6State,
  vrc6PatternCandidates,
  vrc6NametableCandidates,
} from "./nesVrc6.js";
import { isSunsoft4State } from "./nesSunsoft4.js";
import { sunsoft4NametableCandidates } from "./nesSunsoft4Nametable.js";
import {
  isNamco163State,
  createNamco163PpuCandidates,
  namco163PatternCandidates,
  namco163NametableCandidates,
} from "./nesNamco163.js";
import type { NesPpuPatternLocation } from "./nesPpuPattern.js";
import type {
  NesPpuNametableLocation,
  NesPpuNametableSourcePage,
} from "./nesPpuNametableSource.js";
import {
  standardNesChrWindows,
  standardNesChrCandidates,
  standardNesNametablePages,
} from "./nesMapperTraceMapping.js";
import { joinNesBytes, type NesByteValue } from "./nesByteValue.js";
import { ppuSmall, ppuBits } from "./nesPpuAddress.js";
import type {
  NesPpuState,
  NesPpuOrigin,
  NesPpuSource,
  NesPpuBusOperation,
} from "./nesPpuState.js";

type Space = "chr-ram" | "nametable" | "palette";
export type PpuMemoryRead = {
  value: NesByteValue;
  sources: Extract<
    NesPpuSource,
    {
      kind:
        | "rom"
        | "memory"
        | "unknown"
        | "mmc5-exram"
        | "mmc5-fill"
        | "mmc5-zero";
    }
  >[];
  reason: string | null;
};
type PpuPatternRead = Omit<PpuMemoryRead, "sources"> & {
  sources: (
    | Extract<NesPpuSource, { kind: "rom" | "unknown" }>
    | (Extract<NesPpuSource, { kind: "memory" }> & {
        space: "chr-ram" | "nametable";
      })
  )[];
};
const store = (state: NesPpuState, space: Space) =>
  space === "chr-ram"
    ? state.chr_ram
    : space === "nametable"
      ? state.nametable
      : state.palette;
export const ppuPaletteAddress = (address: number): number => {
  const cell = address & 31;
  return (cell & 19) === 16 ? cell & 15 : cell;
};
export const readNesPpuCell = <S extends Space>(
  state: NesPpuState,
  space: S,
  address: number,
): Extract<NesPpuSource, { kind: "memory" }> & { space: S } => {
  const fact = store(state, space)[String(address)];
  return {
    kind: "memory",
    space,
    address,
    mask: space === "palette" ? 63 : 255,
    value:
      typeof fact === "object" && fact !== null && "origin" in fact
        ? fact.value
        : (fact ?? null),
    origin:
      fact === undefined
        ? null
        : typeof fact === "object" && fact !== null && "origin" in fact
          ? fact.origin
          : { kind: "initial-memory", space, address },
  };
};
export const nesPpuAdmission = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  chr?: Uint8Array | null,
): string | null => {
  const oamReason = nesOamAdmission(state);
  if (oamReason !== null) return oamReason;
  if (chr != null && chr.length !== header.chrRom.size)
    return "CHR snapshot length must match the declared ROM extent.";
  if (
    isMmc5State(mapper) &&
    (state.chr_ram_size !== null ||
      state.nametable_layout === "four-screen-4k" ||
      Object.keys(state.chr_ram).length !== 0)
  )
    return "MMC5 retained backing admits CHR ROM and unknown/explicit CIRAM; linear CHR RAM and extra four-screen storage require separate wiring models.";
  if (isMmc5State(mapper)) {
    const failure = admitMmc5ExramOrigins(mapper, state.next_event_index);
    if (failure !== null) return failure;
  }
  if (
    (isVrc6State(mapper) || isNamco163State(mapper)) &&
    (header.chrRom.size === 0 || state.nametable_layout === "four-screen-4k")
  )
    return `${isNamco163State(mapper) ? "Namco 163" : "VRC6"} byte backing requires its qualified CHR-ROM profile and no extra nametable storage; CIRAM backing is unknown or explicitly ciram-2k.`;
  if (state.chr_ram_size !== null) {
    if (header.chrRom.size !== 0)
      return "Explicit CHR RAM requires no CHR ROM; mixed source wiring is not modeled.";
    if (
      header.headerVersion === "nes2" &&
      !(
        (header.chrRamSize === 8192 && header.chrNvramSize === 0) ||
        (header.chrRamSize === 0 && header.chrNvramSize === 8192)
      )
    )
      return "Linear 8 KiB CHR RAM requires one matching NES2 RAM/NVRAM declaration.";
  } else if (Object.keys(state.chr_ram).length !== 0)
    return "Initial CHR RAM bytes require explicit chr_ram_size wiring.";
  if (
    state.nametable_layout === null &&
    Object.keys(state.nametable).length !== 0
  )
    return "Initial nametable bytes require an explicit physical layout.";
  if (
    state.nametable_layout === "ciram-2k" &&
    Object.keys(state.nametable).some((key) => Number(key) >= 2048)
  )
    return "CIRAM input addresses must use canonical physical offsets 0..2047.";
  if (
    state.nametable_layout === "ciram-2k" &&
    header.mirroring === "four-screen" &&
    header.mapper !== 78
  )
    return "Four-screen cartridge declarations require four-screen-4k nametable backing.";
  if (
    state.nametable_layout === "four-screen-4k" &&
    (header.mirroring !== "four-screen" || header.mapper === 78)
  )
    return "Four-screen nametable backing requires a matching cartridge declaration.";
  const origins: NesPpuOrigin[] = [state.status_origin, state.io_latch.origin];
  for (const [field, origin] of [
    ["status", state.status_origin],
    ["io-latch", state.io_latch.origin],
  ] as const)
    if (
      origin.kind === "initial-memory" ||
      origin.kind === "dma-write" ||
      (origin.kind === "dma-byte" &&
        (field !== "io-latch" || state.oam === null)) ||
      (origin.kind === "initial-register" && origin.field !== field)
    )
      return "Initial PPU register origins must identify their own register fact or a preceding CPU event.";
  for (const space of ["chr-ram", "nametable", "palette"] as const)
    for (const [address, fact] of Object.entries(store(state, space)))
      if (typeof fact === "object" && fact !== null && "origin" in fact) {
        const origin = fact.origin;
        if (
          origin.kind === "initial-register" ||
          origin.kind === "event-read" ||
          origin.kind === "dma-write" ||
          origin.kind === "dma-byte" ||
          (origin.kind === "initial-memory" &&
            (origin.space !== space || origin.address !== Number(address)))
        )
          return "Memory fact origins must identify the same initial physical cell or a preceding event write.";
        origins.push(origin);
      }
  for (const source of state.read_buffer.sources) {
    if (source.kind === "oam-attribute-zeroes")
      return "OAM wiring facts cannot be external PPUDATA buffer sources.";
    if (source.mask !== 255)
      return "Read-buffer sources describe complete external bus bytes; their contributing mask must be 255.";
    if (source.kind === "unknown") continue;
    if (
      source.kind === "mmc5-exram" ||
      source.kind === "mmc5-fill" ||
      source.kind === "mmc5-zero"
    ) {
      if (!isMmc5State(mapper))
        return "MMC5 buffered sources require Mapper 5.";
      if (source.kind === "mmc5-exram") {
        if (
          source.origin?.kind === "event-write" &&
          source.origin.index >= state.next_event_index
        )
          return "Retained ExRAM buffer origins must precede next_event_index.";
        if (
          source.origin?.kind === "initial-exram" &&
          source.origin.address !== source.address
        )
          return "Buffered ExRAM origins must identify the same physical cell.";
        if (source.origin === null && source.value !== null)
          return "Known ExRAM buffer bytes require a captured source origin.";
      }
      const available =
        source.kind === "mmc5-zero"
          ? 0
          : source.kind === "mmc5-fill"
            ? source.register === 0x5106
              ? source.register_value
              : replicateMmc5Palette(source.register_value, 0)
            : source.attribute_shift === null
              ? source.cell_value
              : replicateMmc5Palette(source.cell_value, source.attribute_shift);
      const proof = ppuBits(available),
        supplied = ppuBits(source.value);
      if (
        (proof.mask & supplied.mask) !== supplied.mask ||
        (proof.value & supplied.mask) !== supplied.value
      )
        return "Buffered MMC5 byte facts must follow their captured cell/register proof.";
      continue;
    }
    if (source.kind === "rom") {
      const offset = source.file_offset - header.chrRom.offset;
      const proof = ppuBits(source.value);
      if (
        chr == null ||
        offset < 0 ||
        offset >= chr.length ||
        (chr[offset]! & proof.mask) !== proof.value
      )
        return "Read-buffer ROM source facts must match the authenticated CHR snapshot.";
    } else {
      if (
        source.kind === "register" &&
        (source.field !== "read-buffer" ||
          source.origin.kind !== "initial-register" ||
          source.origin.field !== "read-buffer")
      )
        return "A register-backed read buffer must identify its supplied initial read-buffer fact.";
      if (
        source.kind === "memory" &&
        ((source.origin === null && source.value !== null) ||
          source.origin?.kind === "event-read" ||
          source.origin?.kind === "dma-write" ||
          source.origin?.kind === "dma-byte" ||
          source.origin?.kind === "initial-register" ||
          (source.origin?.kind === "initial-memory" &&
            (source.origin.space !== source.space ||
              source.origin.address !== source.address)))
      )
        return "Known read-buffer memory facts require a matching physical source origin.";
      if (source.origin !== null) origins.push(source.origin);
      if (
        source.kind === "memory" &&
        (source.space === "palette" ||
          source.space === "oam" ||
          (source.space === "chr-ram" && state.chr_ram_size === null) ||
          (source.space === "nametable" && state.nametable_layout === null) ||
          source.address >=
            (source.space === "chr-ram"
              ? 8192
              : state.nametable_layout === "ciram-2k"
                ? 2048
                : 4096))
      )
        return "Read-buffer memory sources require established external CHR RAM or nametable cells within the declared backing.";
    }
  }
  if (
    origins.some(
      (origin) =>
        (origin.kind === "event-read" ||
          origin.kind === "event-write" ||
          origin.kind === "dma-write" ||
          origin.kind === "dma-byte") &&
        origin.index >= state.next_event_index,
    )
  )
    return "Retained PPU origins must precede next_event_index.";
  if (state.read_buffer.sources.length !== 0) {
    const available = ppuBits(
      state.read_buffer.sources.map((s) => s.value).reduce(joinNesBytes),
    );
    const buffer = ppuBits(state.read_buffer.value);
    if (
      (available.mask & buffer.mask) !== buffer.mask ||
      (available.value & buffer.mask) !== buffer.value
    )
      return "Read-buffer source alternatives do not prove the supplied byte facts.";
  }
  return null;
};

const patternLocations = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  address: number,
): { size: number; addresses: number[] } | null => {
  if (mapper.mapper === 5 || mapper.mapper === 19) return null;
  if (isVrc6State(mapper))
    return header.chrRom.size === 0
      ? null
      : {
          size: 1024,
          addresses: vrc6PatternCandidates(
            mapper,
            address >> 10,
            header.chrRom.size,
          ).map((bank) => bank * 1024 + (address & 1023)),
        };
  const capacity = header.chrRom.size || state.chr_ram_size || 0;
  if (capacity === 0) return null;
  const window = standardNesChrWindows(header, mapper, capacity).find(
    (w) => address >= w.start && address < w.start + w.size,
  )!;
  const count = capacity / window.size;
  const banks =
    window.bank === null
      ? standardNesChrCandidates(mapper, (address / window.size) | 0, count)
      : [window.bank];
  return {
    size: window.size,
    addresses: banks.map((bank) => bank * window.size + address - window.start),
  };
};

/** Normalize one logical 1 KiB pattern block to physical storage, independently of byte contents. */
export const nesPpuPatternPages = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  slot: number,
  fetch?: NesMmc5Fetch,
): NesPpuPatternLocation[] => {
  if (isMmc5State(mapper))
    return mmc5FrozenPatternPages(header, mapper, slot, fetch);
  if (isNamco163State(mapper))
    return namco163PatternCandidates(mapper, slot, header.chrRom.size)
      .map((candidate): NesPpuPatternLocation =>
        candidate.source === "unknown"
          ? { kind: "unknown", reason: candidate.reason }
          : candidate.source === "chr-rom"
            ? {
                kind: "rom",
                file_offset: header.chrRom.offset + candidate.bank * 1024,
              }
            : state.nametable_layout === null
              ? { kind: "unknown", reason: "unknown-nametable-wiring" }
              : { kind: "ciram", address: (candidate.bank * 1024) as 0 | 1024 },
      )
      .filter(
        (page, index, pages) =>
          page.kind !== "unknown" ||
          pages.findIndex(
            (other) => other.kind === "unknown" && other.reason === page.reason,
          ) === index,
      );
  const locations = patternLocations(header, mapper, state, slot * 1024);
  return locations === null
    ? []
    : locations.addresses.map((address) =>
        header.chrRom.size === 0
          ? { kind: "chr-ram", address }
          : { kind: "rom", file_offset: header.chrRom.offset + address },
      );
};

/** A pattern CIRAM page and a nametable page refer to the same retained physical cells. */
export const readNesPpuPatternPage = (
  header: NesRomMetadata,
  state: NesPpuState,
  page: NesPpuPatternLocation,
  offset: number,
  chr?: Uint8Array,
): PpuPatternRead["sources"][number] => {
  if (page.kind === "unknown") return { ...page, value: null, mask: 255 };
  if (page.kind === "rom") {
    const fileOffset = page.file_offset + offset;
    return {
      kind: "rom",
      file_offset: fileOffset,
      mask: 255,
      value:
        chr?.length === header.chrRom.size
          ? (chr[fileOffset - header.chrRom.offset] ?? null)
          : null,
    };
  }
  return readNesPpuCell(
    state,
    page.kind === "ciram" ? "nametable" : "chr-ram",
    page.address + offset,
  );
};

/** Coordinates remain independent of the caller's retained bytes and the CHR snapshot. */
export const nesPpuNametablePages = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  page: number,
  fetch?: NesMmc5Fetch,
): NesPpuNametableLocation[] => {
  if (isMmc5State(mapper))
    return mmc5FrozenNametablePages(
      mapper,
      page,
      state.nametable_layout === "ciram-2k",
      fetch,
    );
  const candidates = isSunsoft4State(mapper)
    ? sunsoft4NametableCandidates(mapper, page, header.chrRom.size)
    : isVrc6State(mapper)
      ? vrc6NametableCandidates(mapper, page, header.chrRom.size)
      : isNamco163State(mapper)
        ? namco163NametableCandidates(mapper, page, header.chrRom.size)
        : null;
  if (candidates !== null) {
    const pages = candidates.map((candidate): NesPpuNametableLocation =>
      candidate.source === "unknown"
        ? { kind: "unknown", reason: candidate.reason }
        : candidate.source === "chr-rom"
          ? {
              kind: "rom",
              file_offset: header.chrRom.offset + candidate.bank * 1024,
            }
          : state.nametable_layout === null
            ? { kind: "unknown", reason: "unknown-nametable-wiring" }
            : candidate.bank * 1024,
    );
    return [
      ...new Map(
        pages.map((source) => [
          typeof source === "number"
            ? `memory:${source}`
            : source.kind === "rom"
              ? `rom:${source.file_offset}`
              : JSON.stringify(source),
          source,
        ]),
      ).values(),
    ];
  }
  if (state.nametable_layout === null) return [];
  if (mapper.mapper === 19 || isVrc6State(mapper)) return [];
  return standardNesNametablePages(
    header,
    mapper,
    page,
    state.nametable_layout === "ciram-2k" ? 2 : 4,
  ).map((bank) => bank * 1024);
};

/** Read one offset from the same candidate page for tiles and attributes. */
export const readNesPpuNametablePage = (
  header: NesRomMetadata,
  state: NesPpuState,
  page: NesPpuNametableLocation,
  offset: number,
  chr?: Uint8Array,
  mapper?: NesMapperState,
): PpuMemoryRead["sources"][number] => {
  if (typeof page === "number")
    return readNesPpuCell(state, "nametable", page + offset);
  if (page.kind === "unknown") return { ...page, value: null, mask: 255 };
  if (page.kind === "mmc5-zero")
    return { kind: "mmc5-zero", value: 0, mask: 255 };
  if (page.kind === "mmc5-fill")
    return {
      kind: "mmc5-fill",
      register: offset < 960 ? 0x5106 : 0x5107,
      register_value: offset < 960 ? page.tile : page.attribute,
      value: offset < 960 ? page.tile : replicateMmc5Palette(page.attribute, 0),
      mask: 255,
    };
  if (page.kind === "mmc5-exram") {
    if (mapper === undefined || !isMmc5State(mapper))
      return {
        kind: "unknown",
        reason: "missing-mmc5-exram-owner",
        value: null,
        mask: 255,
      };
    const cell = readMmc5ExramCell(mapper, offset);
    return {
      kind: "mmc5-exram",
      address: offset,
      cell_value: cell.value,
      value: readMmc5FrozenNametablePage(mapper, page, offset),
      origin: cell.origin,
      attribute_shift: null,
      mask: 255,
    };
  }
  const fileOffset = page.file_offset + offset;
  return {
    kind: "rom",
    file_offset: fileOffset,
    value:
      chr?.length === header.chrRom.size
        ? (chr[fileOffset - header.chrRom.offset] ?? null)
        : null,
    mask: 255,
  };
};

/** Capture each immutable ROM page once; numeric pages continue to refer to final memory. */
export const captureNesPpuNametablePages = (
  header: NesRomMetadata,
  pages: readonly NesPpuNametableLocation[],
  chr?: Uint8Array,
  cache = new Map<
    number,
    Extract<NesPpuNametableSourcePage, { kind: "rom" }>
  >(),
): NesPpuNametableSourcePage[] =>
  pages.map((page) => {
    if (typeof page === "number" || page.kind !== "rom") return page;
    const existing = cache.get(page.file_offset);
    if (existing !== undefined) return existing;
    const offset = page.file_offset - header.chrRom.offset,
      captured = {
        ...page,
        bytes_hex:
          chr?.length === header.chrRom.size
            ? Array.from(chr.subarray(offset, offset + 1024), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join("")
            : null,
      };
    cache.set(page.file_offset, captured);
    return captured;
  });

export const readNesPpuNametable = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  address: number,
  chr?: Uint8Array,
  fetch?: NesMmc5Fetch,
): PpuMemoryRead => {
  const pages = nesPpuNametablePages(
    header,
    mapper,
    state,
    (address >> 10) & 3,
    fetch,
  );
  if (pages.length === 0)
    return { value: null, sources: [], reason: "unknown-nametable-wiring" };
  const sources = pages.map((page) =>
      readNesPpuNametablePage(header, state, page, address & 1023, chr, mapper),
    ),
    unresolved = sources.find((source) => source.kind === "unknown");
  return {
    value: sources.map((source) => source.value).reduce(joinNesBytes),
    sources,
    reason:
      unresolved?.kind === "unknown"
        ? unresolved.reason
        : sources.some((source) => source.kind === "rom") &&
            chr?.length !== header.chrRom.size
          ? "missing-chr-snapshot"
          : null,
  };
};

/** Read every compatible pattern source without confusing CIRAM with separate CHR RAM. */
export const readNesPpuPatternMemory = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  address: number,
  chr?: Uint8Array,
  fetch?: NesMmc5Fetch,
): PpuPatternRead => {
  const pages = nesPpuPatternPages(header, mapper, state, address >> 10, fetch);
  if (pages.length === 0)
    return { value: null, sources: [], reason: "unknown-chr-wiring" };
  if (
    !isNamco163State(mapper) &&
    !isMmc5State(mapper) &&
    header.chrRom.size !== 0 &&
    chr?.length !== header.chrRom.size
  )
    return { value: null, sources: [], reason: "missing-chr-snapshot" };
  const sources = pages.map((page) =>
    readNesPpuPatternPage(header, state, page, address & 1023, chr),
  );
  const unresolved = sources.find((source) => source.kind === "unknown");
  return {
    value: sources.map((s) => s.value).reduce(joinNesBytes),
    sources,
    reason:
      unresolved?.kind === "unknown"
        ? unresolved.reason
        : sources.some((source) => source.kind === "rom") &&
            chr?.length !== header.chrRom.size
          ? "missing-chr-snapshot"
          : null,
  };
};

export const readNesPpuMemory = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  address: number,
  chr?: Uint8Array,
): PpuMemoryRead =>
  address < 8192
    ? readNesPpuPatternMemory(header, mapper, state, address, chr)
    : readNesPpuNametable(header, mapper, state, address, chr);

/** Internal palette storage is distinct from the external PPU bus underlay. */
export const readNesPpuPalette = (
  state: NesPpuState,
  address: number,
): PpuMemoryRead => {
  const source = readNesPpuCell(state, "palette", ppuPaletteAddress(address));
  return { value: source.value, sources: [source], reason: null };
};

export const writeNesPpuMemory = (
  header: NesRomMetadata,
  mapper: NesMapperState,
  state: NesPpuState,
  {
    address,
    addressProof,
    value,
    index,
    cpuPort = false,
  }: {
    address: number | null;
    addressProof: NesPpuState["v"];
    value: NesByteValue;
    index: number;
    cpuPort?: boolean;
  },
): NonNullable<NesPpuBusOperation["write"]> => {
  // One format-bounded address expansion, with each mapper mux computed only once.
  type Target = { space: Space | "mmc5-exram"; address: number };
  type Plan = { targets: Target[]; readonly: boolean; unknown: boolean };
  const pattern: Plan[] = Array.from({ length: 8 }, (_, slot) => {
    if (header.chrRom.size !== 0 && !isNamco163State(mapper))
      return { targets: [], readonly: true, unknown: false };
    const sources = nesPpuPatternPages(header, mapper, state, slot);
    return {
      targets: sources.flatMap((source): Target[] =>
        source.kind === "chr-ram" || source.kind === "ciram"
          ? [
              {
                space: source.kind === "ciram" ? "nametable" : "chr-ram",
                address: source.address,
              },
            ]
          : [],
      ),
      readonly: sources.some((source) => source.kind === "rom"),
      unknown:
        sources.length === 0 ||
        sources.some((source) => source.kind === "unknown"),
    };
  });
  const tables = Array.from({ length: 4 }, (_, page) => {
    const sources = nesPpuNametablePages(
      header,
      mapper,
      state,
      page,
      isMmc5State(mapper) ? "ppudata" : undefined,
    );
    return {
      targets: sources.flatMap((source): Target[] =>
        typeof source === "number"
          ? [{ space: "nametable", address: source }]
          : source.kind === "mmc5-exram"
            ? [{ space: "mmc5-exram", address: 0 }]
            : [],
      ),
      readonly: sources.some(
        (source) =>
          typeof source !== "number" &&
          (source.kind === "rom" ||
            source.kind === "mmc5-fill" ||
            source.kind === "mmc5-zero"),
      ),
      unknown:
        sources.length === 0 ||
        sources.some(
          (source) =>
            typeof source !== "number" &&
            (source.kind === "unknown" ||
              (source.kind === "mmc5-exram" &&
                isMmc5State(mapper) &&
                mapper.exram_written === false)),
        ),
    };
  });
  const destinations = new Map<string, Target>();
  const possibleDebug =
    isNamco163State(mapper) &&
    createNamco163PpuCandidates(mapper, header.chrRom.size).debug() !== false;
  const low = ppuBits(addressProof.low),
    high = ppuBits(addressProof.high);
  let unverified = false,
    ignored = false,
    debugWrite = false;
  for (let bus = address ?? 0; bus <= (address ?? 16383); bus++) {
    if (
      address === null &&
      ((bus & 255 & low.mask) !== low.value ||
        ((bus >> 8) & high.mask & 63) !== (high.value & 63))
    )
      continue;
    const external = bus < 0x3f00 || !cpuPort;
    debugWrite ||= possibleDebug && external;
    const plan: Plan =
      bus < 8192
        ? pattern[bus >> 10]!
        : external
          ? tables[(bus >> 10) & 3]!
          : {
              targets: [{ space: "palette", address: ppuPaletteAddress(bus) }],
              readonly: false,
              unknown: false,
            };
    ignored ||= plan.readonly;
    unverified ||= plan.unknown;
    for (const { space, address: base } of plan.targets) {
      const physical = space === "palette" ? base : base + (bus & 1023);
      destinations.set(`${space}:${physical}`, { space, address: physical });
    }
  }
  if (debugWrite) {
    // The audio-debug electrical outputs are unmodeled. Do not invent a physical
    // destination or retain CIRAM contents that an unverified external write may change.
    state.nametable = {};
    unverified = true;
  }
  const targets = [...destinations.values()].sort(
    (a, b) =>
      compareUnicodeCodePoints(a.space, b.space) || a.address - b.address,
  );
  const definite = targets.length === 1 && !unverified && !ignored;
  for (const target of targets) {
    if (target.space === "mmc5-exram") {
      if (isMmc5State(mapper))
        updateMmc5ExramCell(mapper, target.address, value, {
          access:
            mapper.exram_written === false
              ? "invalidate"
              : definite
                ? "write"
                : "conditional-write",
          eventIndex: index,
        });
      continue;
    }
    if (debugWrite && target.space === "nametable") continue;
    const bytes = store(state, target.space),
      data = target.space === "palette" ? ppuSmall(value, 63) : value;
    if (definite)
      bytes[String(target.address)] = {
        value: data,
        origin: { kind: "event-write", index },
      };
    else {
      const previous = readNesPpuCell(state, target.space, target.address),
        joined = joinNesBytes(previous.value, data);
      const common = target.space === "palette" ? ppuSmall(joined, 63) : joined;
      if (common === null) delete bytes[String(target.address)];
      else
        bytes[String(target.address)] = {
          value: common,
          origin: previous.origin!,
        };
    }
  }
  return {
    status: unverified
      ? "unverified"
      : targets.length === 0
        ? "ignored"
        : definite
          ? "written"
          : "uncertain",
    destinations: targets,
    invalidated_spaces: debugWrite ? ["nametable"] : [],
    reason: debugWrite
      ? "namco163-audio-debug"
      : unverified
        ? "unknown-memory-wiring"
        : targets.length === 0 && ignored
          ? "chr-rom-readonly"
          : null,
  };
};
