import { err, ok, type Result } from "./result.js";

/** A byte range in the original .nes file, before any CPU/PPU mapping. */
export interface NesRomRegion {
  readonly offset: number;
  readonly size: number;
}

/** Header declarations and file ranges; these do not establish mapper support. */
export interface NesRomMetadata {
  readonly headerVersion: "ines" | "nes2";
  readonly header: readonly number[];
  readonly mapper: number;
  /** iNES does not encode a submapper. */
  readonly submapper: number | null;
  /** Raw byte 7 bits 0-1; value 3 uses the NES 2.0 extended console field. */
  readonly consoleType: number;
  /** Conventional mirroring names; some mappers control the actual arrangement. */
  readonly mirroring: "horizontal" | "vertical" | "four-screen";
  readonly battery: boolean;
  readonly trainer: NesRomRegion | null;
  readonly prgRom: NesRomRegion;
  readonly chrRom: NesRomRegion;
  /** Uninterpreted bytes after CHR-ROM, including any miscellaneous ROMs. */
  readonly trailingData: NesRomRegion | null;
  readonly miscRomCount: number | null;
  /** Only NES 2.0 distinguishes volatile/nonvolatile RAM sizes unambiguously. */
  readonly prgRamSize: number | null;
  readonly prgNvramSize: number | null;
  readonly chrRamSize: number | null;
  readonly chrNvramSize: number | null;
}

const NES_HEADER_SIZE = 16;
const MAX_SAFE_OFFSET = BigInt(Number.MAX_SAFE_INTEGER);

/** Identify the format independently of filenames; full admission still checks its header. */
export const hasNesSignature = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x4e &&
  bytes[1] === 0x45 &&
  bytes[2] === 0x53 &&
  bytes[3] === 0x1a;

/**
 * Parse an iNES/NES 2.0 header from a prefix, checking its declared regions
 * against the original file size without allocating any ROM-sized buffers.
 * https://www.nesdev.org/wiki/INES
 * https://www.nesdev.org/wiki/NES_2.0
 */
export const parseNesHeader = (
  bytes: Buffer,
  fileSize = bytes.length,
): Result<NesRomMetadata, string> => {
  if (!Number.isSafeInteger(fileSize) || fileSize < 0)
    return err("invalid NES file size: expected a nonnegative safe integer");
  if (bytes.length < NES_HEADER_SIZE || fileSize < NES_HEADER_SIZE)
    return err("truncated NES header: an iNES/NES 2.0 header needs 16 bytes");
  if (!hasNesSignature(bytes))
    return err("invalid NES signature: expected NES followed by 0x1a");

  const header = Array.from(bytes.subarray(0, NES_HEADER_SIZE));
  const versionBits = bytes.readUInt8(7) & 0x0c;
  if (versionBits !== 0 && versionBits !== 8)
    return err("unsupported or ambiguous legacy NES header version");
  const nes2 = versionBits === 8;
  if (!nes2 && bytes.subarray(12, 16).some((value) => value !== 0))
    return err(
      "ambiguous legacy iNES header: reserved bytes 12-15 are nonzero",
    );

  const prgSize = romSize(
    bytes.readUInt8(4),
    nes2 ? bytes.readUInt8(9) & 15 : 0,
    16_384,
  );
  const chrSize = romSize(
    bytes.readUInt8(5),
    nes2 ? bytes.readUInt8(9) >>> 4 : 0,
    8192,
  );
  if (prgSize > MAX_SAFE_OFFSET || chrSize > MAX_SAFE_OFFSET)
    return err("NES ROM size exceeds safely addressable file offsets");
  if (prgSize === 0n) return err("NES image declares no PRG-ROM");

  const trainerSize = (bytes.readUInt8(6) & 4) !== 0 ? 512 : 0;
  const trainerEnd = BigInt(NES_HEADER_SIZE + trainerSize);
  const prgEnd = trainerEnd + prgSize;
  const chrEnd = prgEnd + chrSize;
  if (chrEnd > MAX_SAFE_OFFSET)
    return err("NES ROM layout exceeds safely addressable file offsets");
  const originalSize = BigInt(fileSize);
  for (const [name, end] of [
    ["trainer", trainerEnd],
    ["PRG-ROM", prgEnd],
    ["CHR-ROM", chrEnd],
  ] as const)
    if (end > originalSize)
      return err(
        `truncated NES ${name}: declared range ends at byte ${end}; the file has ${fileSize}`,
      );

  const payloadEnd = Number(chrEnd);
  const miscRomCount = nes2 ? bytes.readUInt8(14) & 3 : null;
  if (miscRomCount !== null && miscRomCount > 0 && payloadEnd === fileSize)
    return err(
      "truncated NES miscellaneous ROM data: header declares ROMs after CHR-ROM",
    );

  return ok({
    headerVersion: nes2 ? "nes2" : "ines",
    header,
    mapper:
      (bytes.readUInt8(6) >>> 4) |
      (bytes.readUInt8(7) & 0xf0) |
      (nes2 ? (bytes.readUInt8(8) & 15) << 8 : 0),
    submapper: nes2 ? bytes.readUInt8(8) >>> 4 : null,
    consoleType: bytes.readUInt8(7) & 3,
    mirroring:
      (bytes.readUInt8(6) & 8) !== 0
        ? "four-screen"
        : (bytes.readUInt8(6) & 1) !== 0
          ? "vertical"
          : "horizontal",
    battery: (bytes.readUInt8(6) & 2) !== 0,
    trainer:
      trainerSize === 0 ? null : { offset: NES_HEADER_SIZE, size: trainerSize },
    prgRom: { offset: Number(trainerEnd), size: Number(prgSize) },
    chrRom: { offset: Number(prgEnd), size: Number(chrSize) },
    trailingData:
      payloadEnd === fileSize
        ? null
        : { offset: payloadEnd, size: fileSize - payloadEnd },
    miscRomCount,
    prgRamSize: nes2 ? ramSize(bytes.readUInt8(10) & 15) : null,
    prgNvramSize: nes2 ? ramSize(bytes.readUInt8(10) >>> 4) : null,
    chrRamSize: nes2 ? ramSize(bytes.readUInt8(11) & 15) : null,
    chrNvramSize: nes2 ? ramSize(bytes.readUInt8(11) >>> 4) : null,
  });
};

/** A size MSB of 15 selects 2^exponent * (2 * multiplier + 1) bytes. */
const romSize = (lsb: number, msb: number, unit: number): bigint =>
  msb === 15
    ? (1n << BigInt(lsb >>> 2)) * BigInt((lsb & 3) * 2 + 1)
    : BigInt((msb << 8) | lsb) * BigInt(unit);

/** Shift zero means absent; other values encode 64 * 2^shift bytes. */
const ramSize = (shift: number): number => (shift === 0 ? 0 : 64 * 2 ** shift);
