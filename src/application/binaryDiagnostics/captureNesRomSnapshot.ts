import { nesBoardSelection } from "../../domain/nesBoardSelection.js";
import { isAbsolute } from "node:path";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { NesRomSnapshotPort } from "./NesRomSnapshotPort.js";
import { isConsistentNesCartridge } from "./NesCartridgeService.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisInputError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../../domain/result.js";
import {
  nesCartridgeSchema,
  type NesCartridge,
} from "../../domain/nesCartridge.js";
import type { TraceNesCodeInput } from "../../domain/nesCodeTrace.js";
import { deriveNesMapperTrace } from "../../domain/nesMapperTraceDerivation.js";

export const captureNesRomSnapshot = async (
  provider: NesRomSnapshotPort,
  input: Pick<TraceNesCodeInput, "path" | "max_file_bytes" | "initial"> & {
    includeChr?: boolean;
    initial_ppu?: TraceNesCodeInput["initial_ppu"];
  },
  operation: string,
  options?: ExecutionOptions,
): Promise<
  Result<
    {
      cartridge: NesCartridge;
      source:
        | { status: "unsupported"; reason: string }
        | { status: "supported"; prg: Uint8Array; chr: Uint8Array | null };
    },
    AnalysisError
  >
> => {
  if (!isAbsolute(input.path))
    return err(
      new AnalysisInputError(operation, undefined, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: "Expected an absolute cartridge path.",
        },
      ]),
    );
  const board = nesBoardSelection(input.initial);
  const captured = await provider.captureRom(
    {
      path: input.path,
      chr_page: 0,
      max_file_bytes: input.max_file_bytes,
      ...(board === undefined ? {} : { board }),
      ...(input.includeChr === undefined
        ? {}
        : { includeChr: input.includeChr }),
    },
    options,
  );
  if (!captured.ok) return captured;
  const report = nesCartridgeSchema.safeParse(captured.value.cartridge);
  if (
    !report.success ||
    report.data.artifact.path !== input.path ||
    report.data.artifact.bytes > input.max_file_bytes ||
    !isConsistentNesCartridge(report.data)
  )
    return err(
      new AnalysisOutputError(
        operation,
        "Inconsistent cartridge snapshot metadata",
      ),
    );
  const cartridge = report.data;
  const admission = deriveNesMapperTrace(
    cartridge.header,
    input.initial,
    [],
    undefined,
    input.initial_ppu?.next_event_index,
  );
  const prg = captured.value.prgRom;
  if (admission.status === "unsupported")
    return ok({ cartridge, source: admission });
  if (
    !(prg instanceof Uint8Array) ||
    prg.length !== cartridge.header.prgRom.size
  )
    return err(
      new AnalysisOutputError(
        operation,
        "Missing or inconsistent admitted PRG snapshot",
      ),
    );
  const chr = captured.value.chrRom;
  if (
    input.includeChr === true &&
    (!(chr instanceof Uint8Array) ||
      chr.length !== cartridge.header.chrRom.size)
  )
    return err(
      new AnalysisOutputError(
        operation,
        "Missing or inconsistent admitted CHR snapshot",
      ),
    );
  return ok({ cartridge, source: { status: "supported", prg, chr } });
};
