import { z } from "zod";
import type { NesRomMetadata } from "./nes.js";

export const nesVrc2WiringSchema = z.enum(["vrc2a", "vrc2b", "vrc2c"]);
export const nesVrc4WiringSchema = z.enum([
  "vrc4a",
  "vrc4b",
  "vrc4c",
  "vrc4d",
  "vrc4e",
  "vrc4f",
]);
export type NesVrcWiring =
  | z.infer<typeof nesVrc2WiringSchema>
  | z.infer<typeof nesVrc4WiringSchema>;

// Physical port-select lines, not the combined legacy emulator decoders.
const boards = {
  vrc2a: { mapper: 22, submapper: 0, family: "vrc2", a0: 1, a1: 0 },
  vrc2b: { mapper: 23, submapper: 3, family: "vrc2", a0: 0, a1: 1 },
  vrc2c: { mapper: 25, submapper: 3, family: "vrc2", a0: 1, a1: 0 },
  vrc4a: { mapper: 21, submapper: 1, family: "vrc4", a0: 1, a1: 2 },
  vrc4b: { mapper: 25, submapper: 1, family: "vrc4", a0: 1, a1: 0 },
  vrc4c: { mapper: 21, submapper: 2, family: "vrc4", a0: 6, a1: 7 },
  vrc4d: { mapper: 25, submapper: 2, family: "vrc4", a0: 3, a1: 2 },
  vrc4e: { mapper: 23, submapper: 2, family: "vrc4", a0: 2, a1: 3 },
  vrc4f: { mapper: 23, submapper: 1, family: "vrc4", a0: 0, a1: 1 },
} as const;

/** Resolve an explicit assumption without changing or overriding source header facts. */
export const nesVrcBoard = (
  header: Pick<NesRomMetadata, "mapper" | "submapper">,
  wiring?: NesVrcWiring,
) => {
  const selected = wiring === undefined ? undefined : boards[wiring];
  if (selected !== undefined && selected.mapper !== header.mapper) return null;
  const declared = Object.entries(boards).find(
    ([, board]) =>
      board.mapper === header.mapper &&
      board.submapper === (header.submapper ?? 0),
  );
  if (header.submapper !== null && header.submapper !== 0) {
    if (
      declared === undefined ||
      (wiring !== undefined && declared[0] !== wiring)
    )
      return null;
  }
  const profile = wiring ?? (declared?.[0] as NesVrcWiring | undefined);
  if (profile === undefined) return null;
  return {
    ...boards[profile],
    wiring: profile,
    name: `Konami ${profile.slice(0, -1).toUpperCase()}${profile.at(-1)}`,
  };
};
