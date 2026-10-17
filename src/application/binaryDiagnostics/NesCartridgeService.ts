import { isAbsolute } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { NesCartridgePort } from "./NesCartridgePort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import {
  decodeNesChrPage,
  inspectNesCartridgeInputSchema,
  nesCartridgeSchema,
  NES_CHR_PAGE_BYTES,
  type NesCartridge,
} from "../../domain/nesCartridge.js";
import { parseNesHeader } from "../../domain/nes.js";
import { resolveNesMapperLayout } from "../../domain/nesMapper.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { err, ok, type Result } from "../../domain/result.js";

const OPERATION = "inspect_nes_cartridge";

/** Shared CLI/MCP request validation and provenance for offline cartridge graphics. */
export class NesCartridgeService {
  constructor(readonly provider: NesCartridgePort) {}
  close(): Promise<void> {
    return this.provider.close();
  }

  async inspect(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const input = inspectNesCartridgeInputSchema.safeParse(rawInput);
    if (!input.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, input.error.issues, rawInput),
      );
    if (!isAbsolute(input.data.path))
      return err(
        new AnalysisInputError(OPERATION, undefined, [
          {
            path: ["path"],
            reason: "invalid_format",
            message: "Expected an absolute filesystem path on this host.",
          },
        ]),
      );
    const result = await this.provider.inspect(input.data, options);
    if (!result.ok) return result;
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = nesCartridgeSchema.safeParse(result.value);
    if (
      !parsed.success ||
      parsed.data.artifact.path !== input.data.path ||
      parsed.data.artifact.bytes > input.data.max_file_bytes ||
      parsed.data.chr.page !== input.data.chr_page ||
      !isConsistentNesCartridge(parsed.data)
    )
      return err(
        new AnalysisOutputError(
          OPERATION,
          "Cartridge inspection returned inconsistent source identity, header, page or tile evidence.",
        ),
      );
    const value = parsed.data;
    return ok(
      createEvidence(
        {
          path: value.artifact.path,
          format: "nes",
          architecture: "6502",
          sha256: value.artifact.sha256,
        },
        this.provider.identity,
        {
          operation: OPERATION,
          parameters: input.data,
          result: value,
          confidence: "derived",
          limitations: value.limitations,
          locations: [{ kind: "artifact-path", path: value.artifact.path }],
        },
      ),
    );
  }
}

/** Verify source ranges and pixel derivation before publishing cartridge-backed Evidence. */
export const isConsistentNesCartridge = (report: NesCartridge): boolean => {
  const header = parseNesHeader(
    Buffer.from(report.header.header),
    report.artifact.bytes,
  );
  if (!header.ok || !isDeepStrictEqual(header.value, report.header))
    return false;
  const chr = report.chr;
  const pages = Math.ceil(header.value.chrRom.size / NES_CHR_PAGE_BYTES);
  if (chr.page >= Math.max(1, pages)) return false;
  const offset = chr.page * NES_CHR_PAGE_BYTES;
  const size = Math.min(NES_CHR_PAGE_BYTES, header.value.chrRom.size - offset);
  const fileOffset = header.value.chrRom.offset + offset;
  const layout = resolveNesMapperLayout(header.value);
  const expectedLayout = layout.ok
    ? { status: "modeled", board: layout.value.board }
    : { status: "unmodeled", reason: layout.error };
  return (
    isDeepStrictEqual(report.prg_layout, expectedLayout) &&
    chr.status === (header.value.chrRom.size === 0 ? "no-chr-rom" : "rom") &&
    chr.total_pages === pages &&
    chr.total_tiles === Math.floor(header.value.chrRom.size / 16) &&
    chr.next_page === (chr.page + 1 < pages ? chr.page + 1 : null) &&
    chr.location.offset === fileOffset &&
    chr.location.size === size &&
    chr.bytes_hex.length === size * 2 &&
    chr.incomplete_tile_bytes === size % 16 &&
    isDeepStrictEqual(
      chr.tiles,
      decodeNesChrPage(
        Buffer.from(chr.bytes_hex, "hex"),
        offset / 16,
        fileOffset,
      ),
    )
  );
};
