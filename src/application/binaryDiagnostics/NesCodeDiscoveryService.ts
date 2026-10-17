import { isDeepStrictEqual } from "node:util";
import type { ExecutionOptions } from "../AnalysisProvider.js";
import type { NesRomSnapshotPort } from "./NesRomSnapshotPort.js";
import type { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { err, ok, type Result } from "../../domain/result.js";
import { discoverNesCodeImmutableProfile } from "../../domain/nesCodeDiscoveryProfile.js";
import {
  discoverNesCodeInputSchema,
  nesCodeDiscoveryLimitations,
} from "../../domain/nesCodeDiscovery.js";
import { discoverNesCode } from "../../domain/nesCodeDiscoveryDerivation.js";
import { captureNesRomSnapshot } from "./captureNesRomSnapshot.js";

const OPERATION = "discover_nes_code";

/** Discover rooted source relationships from one immutable, board-qualified PRG snapshot. */
export class NesCodeDiscoveryService {
  constructor(readonly provider: NesRomSnapshotPort) {}

  close(): Promise<void> {
    return this.provider.close();
  }

  async discover(
    rawInput: unknown,
    options?: ExecutionOptions,
  ): Promise<Result<Evidence, AnalysisError>> {
    if (options?.signal?.aborted)
      return err(new AnalysisCancelledError(OPERATION));
    const parsed = discoverNesCodeInputSchema.safeParse(rawInput);
    if (!parsed.success)
      return err(
        analysisInputErrorFromIssues(OPERATION, parsed.error.issues, rawInput),
      );
    const input = parsed.data,
      profile = discoverNesCodeImmutableProfile(input.initial);
    for (const [index, root] of input.additional_roots.entries())
      if (
        !isDeepStrictEqual(
          discoverNesCodeImmutableProfile(root.initial),
          profile,
        )
      )
        return err(
          new AnalysisInputError(OPERATION, undefined, [
            {
              path: ["additional_roots", index, "initial"],
              reason: "invalid_value",
              message:
                "Additional roots must preserve the global mapper and immutable board qualifications; writable register and bank facts may differ.",
            },
          ]),
        );
    const captured = await captureNesRomSnapshot(
      this.provider,
      { ...input, includeChr: false },
      OPERATION,
      options,
    );
    if (!captured.ok) return captured;
    const { cartridge, source } = captured.value;
    try {
      options?.signal?.throwIfAborted();
      const code_discovery =
        source.status === "unsupported"
          ? source
          : await discoverNesCode(cartridge.header, source.prg, input, {
              signal: options?.signal,
            });
      return ok(
        createEvidence(
          {
            path: cartridge.artifact.path,
            format: "nes",
            architecture: "6502",
            sha256: cartridge.artifact.sha256,
          },
          this.provider.identity,
          {
            operation: OPERATION,
            parameters: input,
            result: {
              artifact: cartridge.artifact,
              header: cartridge.header,
              code_discovery,
              limitations: [nesCodeDiscoveryLimitations],
            },
            confidence: "derived",
            limitations: [nesCodeDiscoveryLimitations],
            locations: [
              { kind: "artifact-path", path: cartridge.artifact.path },
            ],
          },
        ),
      );
    } catch (cause) {
      if (options?.signal?.aborted)
        return err(new AnalysisCancelledError(OPERATION, { cause }));
      throw cause;
    }
  }
}
