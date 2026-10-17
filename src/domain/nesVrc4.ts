import { nesVrcBoard, type NesVrcWiring } from "./nesVrcBoard.js";
import { nesByteBits } from "./nesByteValue.js";
import type { NesRomMetadata } from "./nes.js";
import type {
  NesMapperState,
  NesMapperWrite,
  NesMapperTraceStep,
} from "./nesMapperTrace.js";
import type { NesPrgView } from "./nesPrgViews.js";

/** Select VRC4 only after retaining the header or caller's exact wiring identity. */
export const vrc4Board = (
  header: Pick<NesRomMetadata, "mapper" | "submapper">,
  wiring?: NesVrcWiring,
) => {
  const board = nesVrcBoard(header, wiring);
  return board?.family === "vrc4" ? board : null;
};

export const isVrc4State = (
  state: NesMapperState,
): state is Extract<NesMapperState, { variant: "vrc4" }> =>
  "variant" in state && state.variant === "vrc4";

export const isVrc4View = (
  view: NesPrgView,
): view is Extract<NesPrgView, { variant: "vrc4" }> =>
  "variant" in view && view.variant === "vrc4";

export const vrc4Limitations =
  "VRC4 requires variant vrc4 and either a matching NES 2.0 submapper 1/2 or an explicit wiring assumption for legacy/submapper-0 headers. Caller-selected wiring never overrides a conflicting explicit header or changes ROM bytes. Two five-bit PRG selectors and swap bit D1 map four 8 KiB windows; eight split CHR selectors use four low and five high bits. Mirroring uses D1:D0 at internal port 9000; 9002 controls PRG swap and WRAM enable, while 9003 selects external hardware whose effects are unmodeled. IRQ latch/control/acknowledge writes and proven enable state are retained; Explicit event initial_irq model vrc4 and vrc-cpu-cycle inputs derive conventional counter, prescaler and latched IRQ state. Register-only/source traces do not infer elapsed cycles; physical silicon timing and CPU delivery remain unverified. Source tracing models explicitly selected prg_ram_wiring internal-2k or external-8k with matching single-chip NES 2.0 capacity and 9002 D0 gating. The first uses the chip decoder at 6000–6FFF and mirrors 2 KiB; the second uses external decoding through 7FFF. Wiring omissions, unwritten bytes, clone circuitry and unspecified power-on state remain unknown; VRC2 submapper 3 does not inherit these features.";

/** Interpret register ports only after header/state admission has established the board. */
export const applyVrc4Write = (
  state: Extract<NesMapperState, { variant: "vrc4" }>,
  write: NesMapperWrite,
  header: NesRomMetadata,
): Pick<NesMapperTraceStep, "state" | "effect"> => {
  const byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  const board = vrc4Board(header, "wiring" in state ? state.wiring : undefined);
  if (board === null || write.address < 0x8000)
    return { state, effect: "outside-mapper" };
  const port =
    ((write.address >> board.a0) & 1) |
    (((write.address >> board.a1) & 1) << 1);
  const base = write.address & 0xf000;
  if (base === 0x8000 || base === 0xa000) {
    state.prg_banks[base === 0x8000 ? 0 : 1] = byte;
    return { state, effect: "prg-bank" };
  }
  if (base === 0x9000) {
    if (port === 0) {
      state.control = byte;
      return { state, effect: "nametable" };
    }
    if (port === 2) {
      state.prg_control = byte;
      return { state, effect: "prg-ram-control" };
    }
    return {
      state,
      effect: port === 3 ? "external-select" : "outside-mapper",
    };
  }
  if (base < 0xf000) {
    const index = ((base - 0xb000) >> 12) * 2 + (port >> 1);
    (port & 1 ? state.chr_high : state.chr_low)[index] = byte;
    return { state, effect: "chr-bank" };
  }
  if (port < 2) {
    if (port === 0) state.irq_latch_low = byte;
    else state.irq_latch_high = byte;
    return { state, effect: "irq-latch" };
  }
  if (port === 2) {
    state.irq_control = byte;
    const enabled = nesByteBits(byte, 2);
    state.irq_enabled = enabled === null ? null : enabled !== 0;
    state.last_irq_command = "control";
    return { state, effect: "irq-control" };
  }
  const enabled = nesByteBits(state.irq_control, 1);
  state.irq_enabled = enabled === null ? null : enabled !== 0;
  state.last_irq_command = "acknowledge";
  return { state, effect: "irq-acknowledge" };
};
