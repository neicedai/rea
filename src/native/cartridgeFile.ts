import { constants, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type {
  ArtifactResourceScope,
  ArtifactResourceOwner,
} from "../artifacts/ArtifactResourceScope.js";
import { OwnedFileHandle } from "../filesystem/OwnedFileHandle.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";

/** Stable descriptor acquisition shared by local cartridge adapters and fault probes. */
export interface CartridgeFileSystem {
  open(path: string, flags: number): Promise<FileHandle>;
  lstat(path: string): Promise<BigIntStats>;
}

/** Retain the exact descriptor owner until cleanup succeeds, including failed inspections. */
export function withCartridgeFile<Value>(
  {
    resources,
    fileSystem,
    path,
    providerId,
    operation,
    signal,
    classifyFailure,
  }: {
    readonly resources: ArtifactResourceScope;
    readonly fileSystem: CartridgeFileSystem;
    readonly path: string;
    readonly providerId: string;
    readonly operation: string;
    readonly signal?: AbortSignal | undefined;
    readonly classifyFailure: (cause: unknown) => AnalysisError;
  },
  inspect: (file: FileHandle, before: BigIntStats) => Promise<Value>,
): Promise<Value> {
  return resources.run(async () => {
    signal?.throwIfAborted();
    const before = await fileSystem.lstat(path);
    if (!before.isFile())
      throw new AnalysisInputError(operation, undefined, [
        {
          path: ["path"],
          reason: "invalid_format",
          message: "Expected a regular cartridge file without symlinks",
        },
      ]);
    const file = await fileSystem.open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NOCTTY ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    const owner: ArtifactResourceOwner = {
      kind: "file-handle",
      resource: path,
      handle: new OwnedFileHandle(file),
    };
    let inspectionFailure: { readonly cause: unknown } | undefined;
    try {
      return await inspect(file, before);
    } catch (cause: unknown) {
      inspectionFailure = { cause };
      throw cause;
    } finally {
      const released = await resources.release(owner);
      if (released.kind === "failed") {
        const cleanup = new ProviderCleanupError(
          providerId,
          [path],
          {
            reason: ArtifactReaderFailure.cleanupObservation(
              released.cause,
              path,
            ).reason,
          },
          { cause: released.cause, operation },
        );
        throw inspectionFailure === undefined
          ? cleanup
          : analysisErrorWithCleanupFailure(
              classifyFailure(inspectionFailure.cause),
              cleanup,
              operation,
            );
      }
    }
  });
}
