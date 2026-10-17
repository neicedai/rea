import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import type {
  DiscoverNesCodeInput,
  NesCodeDiscovery,
} from "./nesCodeDiscovery.js";
import { discoverNesCodeImmutableProfile } from "./nesCodeDiscoveryProfile.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
export const admitNesCodeDiscovery = async (
  header: NesRomMetadata,
  prg: Uint8Array,
  input: DiscoverNesCodeInput,
  signal?: AbortSignal,
): Promise<Extract<NesCodeDiscovery, { status: "unsupported" }> | null> => {
  signal?.throwIfAborted();
  if (prg.length !== header.prgRom.size)
    return {
      status: "unsupported",
      reason:
        "PRG snapshot size differs from the declared immutable cartridge range.",
    };
  const profile = JSON.stringify(
    discoverNesCodeImmutableProfile(input.initial),
  );
  let admittedRoots = 0;
  const states = function* () {
    yield input.initial;
    for (const root of input.additional_roots) yield root.initial;
  };
  for (const state of states()) {
    signal?.throwIfAborted();
    if (admittedRoots > 0 && admittedRoots % 128 === 0) {
      await scheduler.yield();
      signal?.throwIfAborted();
    }
    admittedRoots++;
    if (JSON.stringify(discoverNesCodeImmutableProfile(state)) !== profile)
      return {
        status: "unsupported",
        reason:
          "All discovery roots must retain the same immutable board profile.",
      };
    const admitted = deriveNesMapperTrace(header, state, []);
    if (admitted.status === "unsupported") return admitted;
  }
  return null;
};

export function* nesDiscoveryRoots(input: DiscoverNesCodeInput) {
  for (const entry of input.roots) yield { entry, initial: input.initial };
  yield* input.additional_roots;
}
