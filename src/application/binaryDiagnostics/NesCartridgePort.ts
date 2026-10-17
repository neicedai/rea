import type {
  ExecutionOptions,
  ProviderIdentity,
} from "../AnalysisProvider.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import type {
  InspectNesCartridgeInput,
  NesCartridge,
} from "../../domain/nesCartridge.js";
import type { Result } from "../../domain/result.js";

/** Stable cartridge observations and bounded CHR decoding without acquiring an engine. */
export interface NesCartridgePort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  inspect(
    input: InspectNesCartridgeInput,
    options?: ExecutionOptions,
  ): Promise<Result<NesCartridge, AnalysisError>>;
}
