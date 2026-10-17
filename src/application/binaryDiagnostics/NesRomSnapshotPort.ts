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
import type { NesBoardSelection } from "../../domain/nesBoardSelection.js";

/** Internal capture choices; public header metadata never implies observed PPU activity. */
export type NesRomSnapshotInput = InspectNesCartridgeInput & {
  board?: NesBoardSelection;
  includeChr?: boolean;
};

/** Requested ROM bytes and header/digest from one stable descriptor, bounded by board admission. */
export interface NesRomSnapshotPort {
  readonly identity: ProviderIdentity;
  close(): Promise<void>;
  captureRom(
    input: NesRomSnapshotInput,
    options?: ExecutionOptions,
  ): Promise<
    Result<
      {
        readonly cartridge: NesCartridge;
        /** Null when the selected conventional board interpretation rejects the source. */
        readonly prgRom: Uint8Array | null;
        /** Complete admitted CHR source only when requested; an empty array establishes no CHR ROM. */
        readonly chrRom: Uint8Array | null;
      },
      AnalysisError
    >
  >;
}
