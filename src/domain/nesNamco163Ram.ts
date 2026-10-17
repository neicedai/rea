import { z } from "zod";
import {
  joinNesBytes,
  nesByteBits,
  nesByteCandidates,
  nesByteValueSchema,
  nesKnownBitsSchema,
  type NesByteValue,
} from "./nesByteValue.js";

export const nesNamco163ChipRamSchema = z.strictObject({
  oam_dma_pending: z
    .union([z.literal("none"), nesByteValueSchema])
    .default("none")
    .describe(
      "Pending OAM-DMA source page. none is an explicit initial no-request assumption, null an unknown queued page. CPU writes at 4014 replace the pending request; the next supplied CPU read drains it before that read.",
    ),
  address_port: nesByteValueSchema
    .default(null)
    .describe(
      "Current pointer D0–D6 plus auto-increment D7; independent of the last raw external-RAM protection write.",
    ),
  increment_model: z
    .enum(["saturate", "wrap"])
    .nullable()
    .default(null)
    .describe(
      "Immutable caller chip interpretation: documented hardware saturates at 7F; common emulator models wrap. Omission joins both outcomes.",
    ),
  dma_reads: z
    .enum(["absent", "unobserved"])
    .default("unobserved")
    .describe(
      "Explicit DMA assumption for port reads. Unobserved repeated reads may advance an auto-incrementing pointer and prevent a byte proof; writes are not repeated.",
    ),
  bytes: z
    .array(nesByteValueSchema)
    .length(128)
    .default(Array.from({ length: 128 }, () => null))
    .describe(
      "Physical 128-byte chip RAM, indexed by address. Null bytes are unknown, never power-on/save defaults; this is separate from external PRG RAM.",
    ),
});
export type NesNamco163ChipRam = z.infer<typeof nesNamco163ChipRamSchema>;
export const nesNamco163RamReadSourceSchema = z.strictObject({
  kind: z.literal("namco163-chip-ram"),
  address_port: nesByteValueSchema,
  increment_model: nesNamco163ChipRamSchema.shape.increment_model,
  dma_reads: nesNamco163ChipRamSchema.shape.dma_reads,
  cells: z
    .array(
      z.strictObject({
        address: z.number().int().min(0).max(127),
        value: nesByteValueSchema,
      }),
    )
    .min(1)
    .max(128),
});
const read = z.strictObject({
  address: z.number().int().min(0).max(65535).nullable(),
  value: z.null(),
  source: nesNamco163RamReadSourceSchema.nullable(),
});
export const nesNamco163RamReadSchema = z.union([
  read,
  read.extend({
    value: z.number().int().min(0).max(255),
    source: nesNamco163RamReadSourceSchema,
  }),
  read.extend({
    value: z.null(),
    known_bits: nesKnownBitsSchema,
    source: nesNamco163RamReadSourceSchema,
  }),
]);
export type NesNamco163RamRead = z.infer<typeof nesNamco163RamReadSchema>;
const join = (values: readonly NesByteValue[]): NesByteValue =>
  values.reduce((a, b) => joinNesBytes(a, b));

/** Audio writes only active channel phase bytes; asynchronous phase updates are never frozen implicitly. */
export const invalidateNamco163Phase = (
  ram: NesNamco163ChipRam,
  control: NesByteValue,
): void => {
  if (nesByteBits(control, 64) === 64) return;
  const channels = Math.max(
    ...nesByteCandidates(ram.bytes[127] ?? null).map((v) => (v >> 4) & 7),
  );
  for (let channel = 7 - channels; channel < 8; channel++)
    for (const offset of [1, 3, 5])
      ram.bytes[0x40 + channel * 8 + offset] = null;
};
export const namco163ChipAddresses = (ram: NesNamco163ChipRam): number[] => [
  ...new Set(nesByteCandidates(ram.address_port).map((v) => v & 127)),
];
const advance = (ram: NesNamco163ChipRam): NesByteValue =>
  join(
    nesByteCandidates(ram.address_port).flatMap((v) => {
      if ((v & 128) === 0) return [v];
      const next = (v & 127) + 1;
      return ram.increment_model === "wrap"
        ? [128 | (next & 127)]
        : ram.increment_model === "saturate"
          ? [128 | Math.min(next, 127)]
          : [128 | (next & 127), 128 | Math.min(next, 127)];
    }),
  );
export const writeNamco163ChipRam = (
  ram: NesNamco163ChipRam,
  byte: NesByteValue,
): void => {
  const addresses = namco163ChipAddresses(ram);
  for (const address of addresses)
    ram.bytes[address] =
      addresses.length === 1
        ? byte
        : joinNesBytes(ram.bytes[address] ?? null, byte);
  ram.address_port = advance(ram);
};

/** A visible OAM-DMA trigger reads 256 bytes; all addresses in pages 48–4F alias the port. */
export const applyNamco163OamDma = (
  ram: NesNamco163ChipRam,
  page: NesByteValue,
): void => {
  const pages = nesByteCandidates(page).map((v) => v >= 0x48 && v <= 0x4f);
  if (!pages.some(Boolean)) return;
  const before = ram.address_port;
  const after = join(
    nesByteCandidates(before).flatMap((v) => {
      if ((v & 128) === 0) return [v];
      const wrap =
        ram.dma_reads === "absent"
          ? [v]
          : Array.from({ length: 128 }, (_, n) => 128 | n);
      return ram.increment_model === "wrap"
        ? wrap
        : ram.increment_model === "saturate"
          ? [255]
          : [...wrap, 255];
    }),
  );
  ram.address_port = pages.every(Boolean) ? after : joinNesBytes(before, after);
};

/** One explicit CPU read; missing address includes the possibility of no chip-port access. */
export const readNamco163ChipRam = (
  ram: NesNamco163ChipRam,
  address: number | null,
): NesNamco163RamRead => {
  if (ram.oam_dma_pending !== "none") {
    applyNamco163OamDma(ram, ram.oam_dma_pending);
    ram.oam_dma_pending = "none";
  }
  if (address !== null && (address & 0xf800) !== 0x4800)
    return { address, value: null, source: null };
  const before = ram.address_port;
  const repeated =
    ram.dma_reads === "unobserved" && nesByteBits(before, 128) !== 0;
  const atSaturatedEnd =
    ram.increment_model === "saturate" && nesByteBits(before, 127) === 127;
  const cells = (
    repeated && !atSaturatedEnd
      ? Array.from({ length: 128 }, (_, n) => n)
      : namco163ChipAddresses(ram)
  ).map((n) => ({ address: n, value: ram.bytes[n] ?? null }));
  const next =
    repeated && !atSaturatedEnd
      ? nesByteBits(before, 128) === 128
        ? { mask: 128, value: 128 }
        : null
      : advance(ram);
  ram.address_port = address === null ? joinNesBytes(before, next) : next;
  if (address === null) return { address, value: null, source: null };
  const proof = join(cells.map((c) => c.value));
  const source = {
    kind: "namco163-chip-ram" as const,
    address_port: before,
    increment_model: ram.increment_model,
    dma_reads: ram.dma_reads,
    cells,
  };
  if (typeof proof === "number") return { address, value: proof, source };
  if (proof === null) return { address, value: null, source };
  return { address, value: null, known_bits: proof, source };
};
