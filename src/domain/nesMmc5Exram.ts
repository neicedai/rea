import { z } from "zod";
import {
  joinNesBytes,
  nesByteValueSchema,
  type NesByteValue,
} from "./nesByteValue.js";
import type { NesMmc5State } from "./nesMmc5.js";

const address = z.number().int().min(0).max(1023);
export const nesMmc5ExramOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("initial-exram"), address }),
  z.strictObject({
    kind: z.literal("event-write"),
    index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
]);
export type NesMmc5ExramOrigin = z.infer<typeof nesMmc5ExramOriginSchema>;
export const nesMmc5ExramCellSchema = z.union([
  nesByteValueSchema,
  z.strictObject({
    value: nesByteValueSchema,
    origin: nesMmc5ExramOriginSchema,
  }),
]);
export const nesMmc5ExramSchema = z
  .record(
    z.string().regex(/^(?:0|[1-9]\d{0,2}|10[01]\d|102[0-3])$/),
    nesMmc5ExramCellSchema,
  )
  .meta({ maxProperties: 1024 })
  .describe(
    "Sparse physical 1 KiB ExRAM cells at canonical decimal offsets 0..1023. Bare byte/partial/null facts remain accepted caller inputs. Retained facts may identify their initial physical cell or an absolute event-write preceding initial_ppu.next_event_index; no separate cursor or power-on image is inferred.",
  );
const capturedCell = z.strictObject({
  address,
  value: nesByteValueSchema,
});
export const nesMmc5ExramCapturedCellSchema = z.union([
  capturedCell,
  capturedCell.extend({ origin: nesMmc5ExramOriginSchema }),
]);
export type NesMmc5ExramCell = {
  address: number;
  value: NesByteValue;
  origin: NesMmc5ExramOrigin | null;
};
type Storage = { exram: z.infer<typeof nesMmc5ExramSchema> };

/** Physical storage fact only; CPU/PPU owners separately qualify whether the access reaches it. */
export const readMmc5ExramCell = (
  state: Storage,
  cellAddress: number,
): NesMmc5ExramCell => {
  const cell = state.exram[String(cellAddress)];
  if (cell === undefined)
    return { address: cellAddress, value: null, origin: null };
  if (typeof cell === "object" && cell !== null && "origin" in cell)
    return { address: cellAddress, ...structuredClone(cell) };
  return {
    address: cellAddress,
    value: structuredClone(cell),
    origin:
      cell === null ? null : { kind: "initial-exram", address: cellAddress },
  };
};

/** A conditional write retains the earlier source only for bits shared by stored and retained bytes. */
export const updateMmc5ExramCell = (
  state: Storage,
  cellAddress: number,
  value: NesByteValue,
  {
    access,
    eventIndex,
  }: {
    access: "write" | "conditional-write" | "invalidate" | "ignored";
    eventIndex?: number | undefined;
  },
): NesMmc5ExramCell & {
  disposition: "stored" | "joined" | "invalidated" | "ignored";
} => {
  const key = String(cellAddress),
    previous = readMmc5ExramCell(state, cellAddress);
  if (access === "ignored") return { ...previous, disposition: "ignored" };
  if (access === "invalidate") {
    state.exram[key] = null;
    return {
      address: cellAddress,
      value: null,
      origin: null,
      disposition: "invalidated",
    };
  }
  if (access === "conditional-write") {
    const common = joinNesBytes(previous.value, value),
      cell = state.exram[key];
    state.exram[key] =
      common !== null &&
      typeof cell === "object" &&
      cell !== null &&
      "origin" in cell
        ? { value: common, origin: structuredClone(cell.origin) }
        : common;
    return { ...readMmc5ExramCell(state, cellAddress), disposition: "joined" };
  }
  state.exram[key] =
    eventIndex === undefined
      ? structuredClone(value)
      : {
          value: structuredClone(value),
          origin: { kind: "event-write", index: eventIndex },
        };
  return { ...readMmc5ExramCell(state, cellAddress), disposition: "stored" };
};

/** Held rendering captures are historical facts and need not equal subsequently overwritten storage. */
export const admitMmc5ExramOrigins = (
  state: NesMmc5State,
  nextEventIndex: number | null,
): string | null => {
  const cells: { address: number; origin: NesMmc5ExramOrigin | null }[] = [];
  for (const [key, cell] of Object.entries(state.exram))
    if (typeof cell === "object" && cell !== null && "origin" in cell)
      cells.push({ address: Number(key), origin: cell.origin });
  if ("ppu" in state) {
    const captures: z.infer<typeof nesMmc5ExramCapturedCellSchema>[] = [
      ...(state.ppu.extended_attribute === null
        ? []
        : [state.ppu.extended_attribute]),
      ...state.ppu.split_tiles,
      ...state.ppu.split_attributes,
    ];
    for (const cell of captures)
      cells.push({
        address: cell.address,
        origin: "origin" in cell ? cell.origin : null,
      });
  }
  for (const cell of cells) {
    if (
      cell.origin?.kind === "initial-exram" &&
      cell.origin.address !== cell.address
    )
      return "Retained ExRAM origins must identify the same physical cell.";
    if (cell.origin?.kind === "event-write") {
      if (nextEventIndex === null)
        return "Retained ExRAM event origins require initial_ppu.next_event_index.";
      if (cell.origin.index >= nextEventIndex)
        return "Retained ExRAM event origins must precede initial_ppu.next_event_index.";
    }
  }
  return null;
};
