import {
  withCartridgeFile,
  type CartridgeFileSystem,
} from "../cartridgeFile.js";
import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { ArtifactReaderFailure } from "../../artifacts/ArtifactReader.js";

import type { NesCartridgePort } from "../../application/binaryDiagnostics/NesCartridgePort.js";
import type {
  NesRomSnapshotPort,
  NesRomSnapshotInput,
} from "../../application/binaryDiagnostics/NesRomSnapshotPort.js";
import type { ExecutionOptions } from "../../application/AnalysisProvider.js";
import { NES_CARTRIDGE_PROVIDER } from "../../application/InvestigationProviders.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../domain/providerCleanupError.js";
import { ArtifactOperationError } from "../../domain/artifactOperationError.js";
import { parseNesHeader } from "../../domain/nes.js";
import { resolveNesMapperLayout } from "../../domain/nesMapper.js";
import {
  decodeNesChrPage,
  NES_CHR_PAGE_BYTES,
  type InspectNesCartridgeInput,
  type NesCartridge,
} from "../../domain/nesCartridge.js";
import { err, ok } from "../../domain/result.js";

const OPERATION = "inspect_nes_cartridge";
const FILE_SYSTEM: CartridgeFileSystem = {
  open,
  lstat: (path) => lstat(path, { bigint: true }),
};
const invalid = (field: string, message: string) =>
  new AnalysisInputError(OPERATION, undefined, [
    { path: [field], reason: "invalid_format", message },
  ]);

/** Stream the complete digest while retaining the requested decoded page and admitted ROM sources. */
export class NesCartridgeProvider
  implements NesCartridgePort, NesRomSnapshotPort
{
  readonly identity = NES_CARTRIDGE_PROVIDER;
  constructor(
    readonly resources = new ArtifactResourceScope(),
    readonly fileSystem: CartridgeFileSystem = FILE_SYSTEM,
  ) {}
  async close(): Promise<void> {
    try {
      await this.resources.close();
    } catch (cause) {
      if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
        throw cleanupFailure(cause, cause.cleanup);
      throw cause;
    }
  }

  async inspect(input: InspectNesCartridgeInput, options?: ExecutionOptions) {
    const result = await this.read(input, false, options);
    return result.ok ? ok(result.value.cartridge) : result;
  }

  captureRom(input: NesRomSnapshotInput, options?: ExecutionOptions) {
    return this.read(input, true, options);
  }

  private async read(
    input: NesRomSnapshotInput,
    includeRom: boolean,
    options?: ExecutionOptions,
  ) {
    try {
      return ok(
        await withCartridgeFile(
          {
            resources: this.resources,
            fileSystem: this.fileSystem,
            path: input.path,
            providerId: this.identity.id,
            operation: OPERATION,
            signal: options?.signal,
            classifyFailure: (cause) =>
              cartridgeFailure(cause, input, options?.signal),
          },
          (file, before) =>
            inspectHandle(file, {
              input,
              fileSystem: this.fileSystem,
              before,
              includeRom,
              signal: options?.signal,
            }),
        ),
      );
    } catch (cause) {
      return err(cartridgeFailure(cause, input, options?.signal));
    }
  }
}

const inspectHandle = async (
  file: FileHandle,
  {
    input,
    fileSystem,
    before,
    signal,
    includeRom,
  }: {
    readonly input: NesRomSnapshotInput;
    readonly fileSystem: CartridgeFileSystem;
    readonly before: BigIntStats;
    readonly signal: AbortSignal | undefined;
    readonly includeRom: boolean;
  },
): Promise<{
  cartridge: NesCartridge;
  prgRom: Uint8Array | null;
  chrRom: Uint8Array | null;
}> => {
  signal?.throwIfAborted();
  const initial = await file.stat({ bigint: true });
  if (
    initial.dev !== before.dev ||
    initial.ino !== before.ino ||
    initial.size !== before.size ||
    initial.mtimeNs !== before.mtimeNs ||
    initial.ctimeNs !== before.ctimeNs
  )
    throw new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      "Cartridge changed while opening",
    );
  if (!initial.isFile())
    throw invalid("path", "Expected a regular NES cartridge file");
  if (initial.size > BigInt(input.max_file_bytes))
    throw new AnalysisResourceConstraintError(
      OPERATION,
      "file-size",
      "Cartridge exceeds the selected streaming I/O budget",
      { max_file_bytes: input.max_file_bytes },
    );
  const size = Number(initial.size);
  const prefix = await readRange(file, 0, Math.min(16, size), signal);
  const parsed = parseNesHeader(prefix, size);
  if (!parsed.ok) throw invalid("path", parsed.error);
  const header = parsed.value;
  const layout = resolveNesMapperLayout(header);
  const pages = Math.ceil(header.chrRom.size / NES_CHR_PAGE_BYTES);
  if (input.chr_page >= Math.max(1, pages))
    throw new AnalysisInputError(OPERATION, undefined, [
      {
        path: ["chr_page"],
        reason: "out_of_range",
        message: `CHR ROM has ${pages} source pages; select page 0 when CHR ROM is absent.`,
      },
    ]);
  const relativeOffset = input.chr_page * NES_CHR_PAGE_BYTES;
  const pageOffset = header.chrRom.offset + relativeOffset;
  const pageSize = Math.min(
    NES_CHR_PAGE_BYTES,
    header.chrRom.size - relativeOffset,
  );
  const page = await readRange(file, pageOffset, pageSize, signal);
  const sourceLayout =
    includeRom && input.board !== undefined
      ? resolveNesMapperLayout(header, undefined, input.board)
      : layout;
  // Conventional board admission bounds PRG and CHR independently, before allocation.
  const prgRom =
    includeRom && sourceLayout.ok
      ? await readRange(file, header.prgRom.offset, header.prgRom.size, signal)
      : null;
  const chrRom =
    includeRom && input.includeChr === true && sourceLayout.ok
      ? await readRange(file, header.chrRom.offset, header.chrRom.size, signal)
      : null;
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(65536);
  let position = 0;
  while (position <= size) {
    signal?.throwIfAborted();
    const read = await file.read(
      buffer,
      0,
      Math.min(buffer.length, size - position + 1),
      position,
    );
    if (read.bytesRead === 0) break;
    hash.update(buffer.subarray(0, read.bytesRead));
    position += read.bytesRead;
    if (position > size)
      throw new AnalysisArtifactChangedError(
        OPERATION,
        input.path,
        "Cartridge grew while hashing",
      );
  }
  const [after, current] = await Promise.all([
    file.stat({ bigint: true }),
    fileSystem.lstat(input.path).catch((cause: unknown) => {
      throw new AnalysisArtifactChangedError(
        OPERATION,
        input.path,
        "Cartridge path became unavailable during inspection",
        { cause },
      );
    }),
  ]);
  signal?.throwIfAborted();
  if (
    position !== size ||
    [after, current].some(
      (stat) =>
        !stat.isFile() ||
        stat.dev !== initial.dev ||
        stat.ino !== initial.ino ||
        stat.size !== initial.size ||
        stat.mtimeNs !== initial.mtimeNs ||
        stat.ctimeNs !== initial.ctimeNs,
    )
  )
    throw new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      "Cartridge identity or contents changed during inspection",
    );
  const cartridge: NesCartridge = {
    artifact: { path: input.path, sha256: hash.digest("hex"), bytes: size },
    header: { ...header, header: [...header.header] },
    prg_layout: layout.ok
      ? { status: "modeled", board: layout.value.board }
      : { status: "unmodeled", reason: layout.error },
    chr: {
      status: header.chrRom.size === 0 ? "no-chr-rom" : "rom",
      page: input.chr_page,
      page_bytes: NES_CHR_PAGE_BYTES,
      total_pages: pages,
      next_page: input.chr_page + 1 < pages ? input.chr_page + 1 : null,
      total_tiles: Math.floor(header.chrRom.size / 16),
      location: { offset: pageOffset, size: pageSize },
      bytes_hex: page.toString("hex"),
      tiles: decodeNesChrPage(page, relativeOffset / 16, pageOffset),
      incomplete_tile_bytes: pageSize % 16,
      interpretation: "nes-planar-2bpp-msb-left",
      palette: null,
      ppu_mapping: "unknown",
    },
    limitations: [
      "CHR source bytes are decoded as NES planar 2bpp tiles. This does not establish graphics usage, runtime PPU mapping, palette colors, sprites or nametable arrangement.",
      "Only the requested 4 KiB CHR source page is decoded; header ranges and SHA-256 cover the complete original cartridge. Page numbers are not mapper bank selectors.",
      ...(header.chrRom.size === 0
        ? [
            "No CHR ROM bytes are present. CHR RAM contents and graphics compressed or stored in PRG ROM remain unknown.",
          ]
        : []),
      ...(pageSize % 16 === 0
        ? []
        : [
            "The final source page contains an incomplete 16-byte tile; its raw bytes are preserved without fabricating pixels.",
          ]),
      "A modeled PRG layout describes static interpretation coverage, not host provider availability or observed hardware state.",
    ],
  };
  return { cartridge, prgRom, chrRom };
};

const readRange = async (
  file: FileHandle,
  offset: number,
  size: number,
  signal?: AbortSignal,
): Promise<Buffer> => {
  const bytes = Buffer.alloc(size);
  let total = 0;
  while (total < size) {
    signal?.throwIfAborted();
    const read = await file.read(bytes, total, size - total, offset + total);
    if (read.bytesRead === 0)
      throw new ArtifactReaderFailure(
        "integrity",
        "Cartridge was truncated during inspection",
      );
    total += read.bytesRead;
  }
  return bytes;
};

const cartridgeFailure = (
  cause: unknown,
  input: InspectNesCartridgeInput,
  signal?: AbortSignal,
): AnalysisError => {
  if (cause instanceof AnalysisError) return cause;
  if (cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined)
    return cleanupFailure(cause, cause.cleanup);
  if (signal?.aborted) return new AnalysisCancelledError(OPERATION, { cause });
  if (cause instanceof ArtifactReaderFailure && cause.reason === "integrity")
    return new AnalysisArtifactChangedError(
      OPERATION,
      input.path,
      cause.message,
      { cause },
    );
  if (cause instanceof Error && "code" in cause) {
    if (cause.code === "EACCES" || cause.code === "EPERM")
      return new AnalysisAccessDeniedError(OPERATION, input.path, cause.code, {
        cause,
      });
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(String(cause.code)))
      return invalid(
        "path",
        `Cartridge must be a readable regular file without symlinks (${String(cause.code)})`,
      );
  }
  return new ArtifactOperationError(
    OPERATION,
    "io",
    undefined,
    cause instanceof Error ? cause.message : "Cartridge inspection failed",
    { cause },
  );
};

const cleanupFailure = (
  cause: ArtifactReaderFailure,
  cleanup: NonNullable<ArtifactReaderFailure["cleanup"]>,
): ProviderCleanupError =>
  new ProviderCleanupError(
    NES_CARTRIDGE_PROVIDER.id,
    cleanup.resources,
    { reason: cleanup.reason },
    { cause, operation: OPERATION },
  );
