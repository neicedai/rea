import { createHash } from "node:crypto";
import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Synthetic protocol observations; callers independently author mappings and entries. */
export const fixtureNesLoadImage = (
  bytes: Buffer,
  name: string,
  mappings: NativeLoadImageObservation["mappings"],
  entryPoints: string[],
): NativeLoadImageObservation => ({
  executable_format: "Raw Binary",
  language_id: "6502:LE:16:default",
  compiler_spec_id: "default",
  image_base: "0x0",
  default_address_space: "RAM",
  source_files: [
    {
      name,
      size: bytes.length,
      original_sha256: hash(bytes),
      modified_sha256: hash(bytes),
    },
  ],
  mappings,
  relocations: [],
  entry_context: [],
  entry_points: entryPoints,
});

/** Fixed CPU windows from explicit physical banks, independent of the production mapper. */
export const fixtureNesPrgMappings = (
  bytes: Buffer,
  {
    contexts,
    bankSize,
    prgOffset,
    cpuBase,
  }: {
    readonly contexts: readonly {
      readonly space: string;
      readonly banks: readonly number[];
      readonly starts?: readonly number[];
    }[];
    readonly bankSize: number;
    readonly prgOffset: number;
    readonly cpuBase: number;
  },
): NativeLoadImageObservation["mappings"] =>
  contexts.flatMap(({ space, banks, starts }) =>
    banks.map((bank, slot) => {
      const start = starts?.[slot] ?? cpuBase + slot * bankSize;
      const offset = prgOffset + bank * bankSize;
      return {
        block: slot === 0 ? space : `${space}_A${start.toString(16)}`,
        start: `${space}:0x${start.toString(16)}`,
        end: `${space}:0x${(start + bankSize - 1).toString(16)}`,
        address_space: space,
        initialized: true,
        loaded: true,
        overlay: true,
        length: bankSize,
        source_file_index: 0,
        file_offset: offset,
        sha256: hash(bytes.subarray(offset, offset + bankSize)),
      };
    }),
  );
