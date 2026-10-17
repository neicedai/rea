import { z } from "zod";
import {
  nesByteValueSchema,
  nesByteProof,
  type NesByteValue,
} from "./nesByteValue.js";
import { ok, err, type Result } from "./result.js";
import type { NesPpuState } from "./nesPpuState.js";
import type { NesMapperState } from "./nesMapperTrace.js";

/** One physical CPU request, projected into the participating device snapshots. */
export const nesDmaRequestSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("none") }),
  z.strictObject({ status: z.literal("unknown") }),
  z.strictObject({ status: z.literal("pending"), page: nesByteValueSchema }),
]);
export type NesDmaRequest = z.infer<typeof nesDmaRequestSchema>;
export const nesOamDmaStartEventSchema = z
  .strictObject({
    kind: z.literal("oam-dma-start"),
    page: z.number().int().min(0).max(255),
  })
  .describe(
    "Qualified start of an ordered OAM transfer. Consumes only the queued request, without inventing packet reads, writes, controller clocks or elapsed cycles. Subsequent explicit CPU reads/2004 writes and clock events own the transfer. Requires initial_ppu.oam.",
  );
export const clearNesDmaRequest = (
  ppu: NesPpuState,
  mapper: NesMapperState,
): void => {
  ppu.oam!.dma_pending = { status: "none" };
  if (mapper.mapper === 19 && "chip_ram" in mapper)
    mapper.chip_ram.oam_dma_pending = "none";
};
type DmaFailure = { kind: "incompatible-dma-request"; reason: string };
export const mergeNesDmaRequests = (
  requests: readonly NesDmaRequest[],
): Result<NesDmaRequest, DmaFailure> => {
  let result: NesDmaRequest = { status: "unknown" };
  for (const request of requests) {
    if (request.status === "unknown") continue;
    if (result.status === "unknown") {
      result = structuredClone(request);
      continue;
    }
    if (request.status === "none" && result.status === "none") continue;
    if (request.status === "pending" && result.status === "pending") {
      const bits = (value: NesByteValue) =>
          typeof value === "number"
            ? { mask: 255, value }
            : (value ?? { mask: 0, value: 0 }),
        left = bits(result.page),
        right = bits(request.page);
      if (((left.value ^ right.value) & left.mask & right.mask) === 0) {
        result = {
          status: "pending",
          page: nesByteProof(left.mask | right.mask, left.value | right.value),
        };
        continue;
      }
    }
    return err({
      kind: "incompatible-dma-request",
      reason:
        "Controller, OAM and cartridge models contradict the same pending CPU OAM-DMA request.",
    });
  }
  return ok(result);
};

/** Inputs are cloned by their analysis owner before binding shared physical facts. */
export const bindNesCpuDma = (
  controllers: { oam_dma_pending: NesDmaRequest },
  ppu: NesPpuState | null,
  mapper: NesMapperState,
): Result<null, DmaFailure> => {
  const chip =
      mapper.mapper === 19 && "chip_ram" in mapper ? mapper.chip_ram : null,
    requests = [controllers.oam_dma_pending];
  if (ppu?.oam != null) requests.push(ppu.oam.dma_pending);
  if (chip !== null)
    requests.push(
      chip.oam_dma_pending === "none"
        ? { status: "none" }
        : { status: "pending", page: chip.oam_dma_pending },
    );
  const merged = mergeNesDmaRequests(requests);
  if (!merged.ok) return merged;
  controllers.oam_dma_pending = structuredClone(merged.value);
  if (ppu?.oam != null) ppu.oam.dma_pending = structuredClone(merged.value);
  if (chip !== null)
    chip.oam_dma_pending =
      merged.value.status === "none"
        ? "none"
        : merged.value.status === "pending"
          ? merged.value.page
          : null;
  return ok(null);
};
