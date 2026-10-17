import type { NesVrcWiring } from "./nesVrcBoard.js";
import type { NesBandaiVariant } from "./nesBandai.js";
import type { NesFme7Variant } from "./nesFme7.js";
import type { NesIrem78Variant } from "./nesIrem78.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type { NesPrgView } from "./nesPrgViews.js";

/** Immutable board assumptions travel independently of the original source header. */
export type NesBoardSelection =
  | { family: "vrc"; wiring: NesVrcWiring }
  | { family: "bandai"; variant: NesBandaiVariant }
  | { family: "sunsoft"; variant: NesFme7Variant }
  | { family: "sunsoft4"; variant: "normal" }
  | { family: "irem78"; variant: NesIrem78Variant };

export const nesBoardSelection = (
  state: NesMapperState | NesPrgView,
): NesBoardSelection | undefined =>
  "wiring" in state
    ? { family: "vrc", wiring: state.wiring }
    : state.mapper === 69
      ? { family: "sunsoft", variant: state.variant }
      : state.mapper === 68
        ? { family: "sunsoft4", variant: state.variant }
        : state.mapper === 78
          ? { family: "irem78", variant: state.variant }
          : state.mapper === 16
            ? { family: "bandai", variant: state.variant }
            : undefined;
