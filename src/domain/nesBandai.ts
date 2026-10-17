import { z } from "zod";
import { nesByteValueSchema, nesByteBits } from "./nesByteValue.js";
import { nesBandaiEepromStateSchema } from "./nesBandaiEepromState.js";
import { writeBandaiEepromControl } from "./nesBandaiEeprom.js";
import type { NesRomMetadata } from "./nes.js";
import type {
  NesMapperState,
  NesMapperWrite,
  NesMapperTraceStep,
} from "./nesMapperTrace.js";

export const nesBandaiVariantSchema = z.enum(["fcg", "lz93d50"]);
export type NesBandaiVariant = z.infer<typeof nesBandaiVariantSchema>;
const fields = {
  prg_bank: nesByteValueSchema.default(null),
  chr_banks: z
    .array(nesByteValueSchema)
    .length(8)
    .default(Array.from({ length: 8 }, () => null)),
  mirroring: nesByteValueSchema.default(null),
  irq_control: nesByteValueSchema.default(null),
  irq_low: nesByteValueSchema
    .default(null)
    .describe(
      "Raw last B-port write; direct counter byte on FCG-1/2, reload latch byte on LZ93D50. Does not establish elapsed counter cycles.",
    ),
  irq_high: nesByteValueSchema.default(null),
  eeprom_control: nesByteValueSchema
    .default(null)
    .describe(
      "Raw LZ93D50 D-port direction/SDA/SCL command. Serial transactions and EEPROM contents are not established by this byte alone.",
    ),
};
const mapper16 = z.strictObject({
  mapper: z.literal(16),
  variant: nesBandaiVariantSchema,
  ...fields,
});
const mapper159 = z.strictObject({ mapper: z.literal(159), ...fields });
export const nesBandaiStateSchema = z.union([
  mapper16,
  mapper159,
  mapper16.extend({ eeprom: nesBandaiEepromStateSchema }),
  mapper159.extend({ eeprom: nesBandaiEepromStateSchema }),
]);
export type NesBandaiState = z.infer<typeof nesBandaiStateSchema>;
export const isBandaiState = (state: NesMapperState): state is NesBandaiState =>
  state.mapper === 16 || state.mapper === 159;

/** Keep observed chip declarations separate from a caller-selected legacy assumption. */
export const bandaiBoard = (
  header: Pick<NesRomMetadata, "mapper" | "submapper">,
  variant?: NesBandaiVariant,
): NesBandaiVariant | null => {
  if (header.mapper === 159)
    return (header.submapper === null || header.submapper === 0) &&
      (variant === undefined || variant === "lz93d50")
      ? "lz93d50"
      : null;
  if (header.mapper !== 16) return null;
  const declared =
    header.submapper === 4 ? "fcg" : header.submapper === 5 ? "lz93d50" : null;
  if (header.submapper !== null && header.submapper !== 0)
    return declared !== null && (variant === undefined || variant === declared)
      ? declared
      : null;
  return variant ?? null;
};

export const bandaiLimitations =
  "Bandai FCG Mapper 16 uses explicit fcg or lz93d50 chip selection matching NES 2.0 submapper 4/5; a caller-selected variant may disambiguate legacy/submapper-0 headers without rewriting source bytes. Mapper 159 identifies LZ93D50/X24C01 separately. Conventional PRG is 16–256 KiB with a switchable lower 16 KiB and fixed final upper bank; eight independent 1 KiB CHR ROM selectors and two mirroring bits retain raw partial writes. FCG-1/2 decodes writes only at 6000–7FFF and directly writes IRQ counter bytes; LZ93D50 decodes 8000–FFFF and copies a separate reload latch on control writes. Supplied CPU cycles and a matching explicit IRQ model are required to calculate counters and assertion; plain writes/untimed source instructions never imply cycles or CPU IRQ acceptance. Raw EEPROM control alone does not establish contents or write completion. An explicit eeprom model x24c01/x24c02 admits MSB-first serial transitions, sparse physical byte assumptions and D4 read proofs; X24C02 requires an explicit four/sixteen-byte page revision. STOP stages a busy write; only a supplied eeprom-write-complete event commits it. Source instructions, IRQ cycles and control writes never imply elapsed write time. EEPROM NVRAM is not CPU-addressable PRG RAM. Other Bandai boards, deprecated composite profiles, extra PRG outer wiring and power-on state remain unmodeled.";

/** Admit only the selected physical decoder, retaining wrong-window writes as outside. */
export const applyBandaiWrite = (
  header: NesRomMetadata,
  state: NesBandaiState,
  write: NesMapperWrite,
): Pick<NesMapperTraceStep, "state" | "effect"> => {
  const board = bandaiBoard(
    header,
    "variant" in state ? state.variant : undefined,
  );
  if (
    board === null ||
    write.address < (board === "fcg" ? 0x6000 : 0x8000) ||
    (board === "fcg" && write.address > 0x7fff)
  )
    return { state, effect: "outside-mapper" };
  const port = write.address & 15,
    byte = write.value ?? ("known_bits" in write ? write.known_bits : null);
  if (port < 8) {
    state.chr_banks[port] = byte;
    return { state, effect: "chr-bank" };
  }
  if (port === 8) {
    state.prg_bank = byte;
    return { state, effect: "prg-bank" };
  }
  if (port === 9) {
    state.mirroring = byte;
    return { state, effect: "nametable" };
  }
  if (port === 10) {
    state.irq_control = byte;
    return { state, effect: "irq-control" };
  }
  if (port === 11 || port === 12) {
    state[port === 11 ? "irq_low" : "irq_high"] = byte;
    return { state, effect: "irq-latch" };
  }
  if (port === 13 && board === "lz93d50") {
    if ("eeprom" in state)
      state.eeprom = writeBandaiEepromControl(
        state.eeprom,
        state.eeprom_control,
        byte,
      );
    state.eeprom_control = byte;
    return { state, effect: "eeprom-control" };
  }
  return { state, effect: "outside-mapper" };
};

export const bandaiPrgBanks = (
  state: NesBandaiState,
  count: number,
): (number | null)[] => [
  nesByteBits(state.prg_bank, (count - 1) & 15),
  count - 1,
];
