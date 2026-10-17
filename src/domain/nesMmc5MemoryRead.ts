import { joinNesBytes, type NesByteValue } from "./nesByteValue.js";
import { mmc5CpuCandidates, type NesMmc5State } from "./nesMmc5.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperByteOrigin } from "./nesCodeTrace.js";

type Origin = Extract<NesMapperByteOrigin, { kind: "mmc5-window" }>;
type Ram = Extract<Origin["source_candidates"][number], { kind: "ram" }>;

/** A window mux proves only bits common to every possible ROM/RAM byte. */
export const readMmc5MixedWindow = (
  header: NesRomMetadata,
  prg: Uint8Array,
  state: NesMmc5State,
  address: number,
  readRam: (
    bank: number,
    address: number,
  ) => Pick<Ram, "value" | "source"> | undefined,
) => {
  const candidates = mmc5CpuCandidates(header, state, address);
  if (candidates.length < 2 || candidates.every((c) => c.source === "ram"))
    return null;
  const sources: Origin["source_candidates"] = [];
  for (const candidate of candidates) {
    if (!("bank" in candidate)) return null;
    if (candidate.source === "rom") {
      const offset = candidate.bank * 8192 + (address & 8191);
      const value = prg[offset];
      if (value === undefined) return null;
      sources.push({
        kind: "rom",
        file_offset: header.prgRom.offset + offset,
        value,
      });
    } else {
      const canonical = 0x6000 + (address & 8191);
      const fact = readRam(candidate.bank, canonical);
      if (fact === undefined) return null;
      sources.push({
        kind: "ram",
        bank: candidate.bank,
        ram_address: canonical,
        ...fact,
      });
    }
  }
  const common = sources.reduce<NesByteValue>(
    (value, source, i) =>
      i === 0 ? source.value : joinNesBytes(value, source.value),
    null,
  );
  if (common === null) return null;
  const origin: Origin = {
    kind: "mmc5-window",
    prg_mode: state.prg_mode,
    prg_banks: [...state.prg_banks],
    ram_wiring: state.ram_wiring,
    source_candidates: sources,
  };
  return {
    value: typeof common === "number" ? common : null,
    ...(typeof common === "number" ? {} : { known_bits: common }),
    file_offset: null,
    ram_origins: [],
    mapper_origins: [origin],
  };
};
