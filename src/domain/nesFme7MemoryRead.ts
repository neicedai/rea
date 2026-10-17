import {
  nesByteBits,
  joinNesBytes,
  type NesByteValue,
} from "./nesByteValue.js";
import {
  fme7RamLayout,
  fme7RamPermission,
  fme7RamBanks,
  type NesFme7State,
} from "./nesFme7.js";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperByteOrigin } from "./nesCodeTrace.js";

type Origin = Extract<NesMapperByteOrigin, { kind: "fme7-window" }>;
type RamCandidate = Extract<
  Origin["source_candidates"][number],
  { kind: "ram" }
>;
export type NesFme7RamFact = Pick<RamCandidate, "value" | "source">;

/** An uncertain ROM/RAM mux proves only bits shared by every physical source candidate. */
export const readFme7MixedWindow = (
  header: NesRomMetadata,
  prg: Uint8Array,
  state: NesFme7State,
  address: number,
  readRam: (bank: number, address: number) => NesFme7RamFact | undefined,
) => {
  if (
    address < 0x6000 ||
    address > 0x7fff ||
    nesByteBits(state.bank_6000, 64) !== null
  )
    return null;
  const layout = fme7RamLayout(header, state.variant);
  if (layout === null || fme7RamPermission(state) !== true) return null;
  const sources: Origin["source_candidates"] = [];
  for (let bank = 0; bank < header.prgRom.size / 8192; bank++) {
    const count = header.prgRom.size / 8192;
    const control = state.bank_6000;
    if (
      typeof control === "number"
        ? bank !== (control & (count - 1))
        : control !== null &&
          (bank & control.mask & (count - 1)) !== (control.value & (count - 1))
    )
      continue;
    const offset = bank * 8192 + address - 0x6000,
      value = prg[offset];
    if (value === undefined) return null;
    sources.push({
      kind: "rom",
      file_offset: header.prgRom.offset + offset,
      value,
    });
  }
  const canonical =
    layout.start + ((address - layout.start) & (layout.bank_size - 1));
  for (const bank of fme7RamBanks(state, layout.bank_count)) {
    const fact = readRam(bank, canonical);
    if (fact === undefined) return null;
    sources.push({ kind: "ram", bank, ram_address: canonical, ...fact });
  }
  const common = sources.reduce<NesByteValue>(
    (value, source, i) =>
      i === 0 ? source.value : joinNesBytes(value, source.value),
    null,
  );
  if (common === null) return null;
  const origin: Origin = {
    kind: "fme7-window",
    variant: state.variant,
    bank_control: state.bank_6000,
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
