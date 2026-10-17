import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesPrgView } from "./nesPrgViews.js";

/** Mapper 22's board identity is unambiguous; other VRC2/VRC4 wiring needs separate admission. */
const vrc2aLimitations =
  "VRC2a / Mapper 22 uses two five-bit PRG selectors, a fixed final 16 KiB and eight split-nibble CHR selectors with CPU A0/A1 swapped. CHR selectors are shifted right once; the discarded low bit and data above each nibble remain raw evidence. Only mirroring D0 is used. PRG RAM, Microwire/latch reads, clone wiring and electrical timing are unverified; VRC4 swap mode and IRQs are not inferred.";

export const isVrc2Mapper = (mapper: number): mapper is 22 | 23 | 25 =>
  mapper === 22 || mapper === 23 || mapper === 25;

export const isVrc2State = (
  state: NesMapperState,
): state is Exclude<
  Extract<NesMapperState, { mapper: 22 | 23 | 25 }>,
  { variant: "vrc4" }
> => isVrc2Mapper(state.mapper) && !("variant" in state);

export const isVrc2View = (
  view: NesPrgView,
): view is Exclude<
  Extract<NesPrgView, { mapper: 22 | 23 | 25 }>,
  { variant: "vrc4" }
> => isVrc2Mapper(view.mapper) && !("variant" in view);

/** Keep family-wide rules and board-specific uncertainty in the same owning module. */
export const vrc2Limitations = (mapper: 22 | 23 | 25): string => {
  if (mapper === 22) return vrc2aLimitations;
  const ram =
    mapper === 25
      ? "One explicitly declared NES 2.0 8 KiB PRG RAM/NVRAM chip at 6000–7FFF is modeled without bank/protection registers; other RAM layouts are unverified."
      : "PRG RAM is unverified. An explicit latch_present true models one-bit loopback at 6000–6FFF without declared PRG RAM; only D0 is proven and upper open-bus bits remain unknown.";
  return `VRC2${mapper === 23 ? "b" : "c"} / Mapper ${mapper} requires NES 2.0 submapper 3 or an explicit matching wiring assumption for a legacy/submapper-0 header. This assumption does not alter header bytes or override a conflicting explicit submapper. Two five-bit PRG selectors retain a fixed final 16 KiB; eight split-nibble CHR selectors use all eight bits. CPU A0/A1 are ${mapper === 23 ? "in natural order" : "swapped"}. Only mirroring D0 is used. ${ram} ${mapper === 23 ? "Unspecified Microwire wiring" : "Microwire/EEPROM protocols"}, clone wiring and electrical timing are unverified; VRC4 swap mode and IRQs are not inferred.`;
};
