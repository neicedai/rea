import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import type { NesRomMetadata } from "../domain/nes.js";
import { resolveNesMapperLayout } from "../domain/nesMapper.js";
import type { NesPrgView } from "../domain/nesPrgViews.js";
import { jsonValueSchema, type JsonValue } from "../domain/jsonValue.js";

export const GHIDRA_NES_LANGUAGE_ID = "6502:LE:16:default";
export const GHIDRA_NES_COMPILER_SPEC_ID = "default";

export const GHIDRA_NES_LIMITATIONS = [
  "NES analysis uses fixed CPU mappings, independent switchable-bank views, or explicitly recorded conditional PRG contexts. Alternative views are not simultaneous mappings; power-on state and execution-time bank switching are not established.",
  "Ghidra generic 6502 arithmetic, processor flags and stack semantics are not verified for Ricoh 2A03/2A07. Decimal mode, indirect-JMP page wrap, timing and unofficial opcodes require independent review; instruction bytes and assembly remain primary evidence.",
  "PPU, APU, controller, DMA, interrupt timing, and CPU RAM startup state are not emulated. CHR data, header bytes, and trailing data are not CPU executable mappings.",
  "The optional trainer is retained as cartridge metadata and is not applied to runtime RAM. Memory-mapped register regions describe address layout rather than observed hardware state.",
  "Cartridge PRG RAM/NVRAM and CHR RAM/NVRAM declarations are preserved, but their contents and address mappings are not reconstructed.",
] as const;

/** Admit an identified cartridge layout, not arbitrary 6502-family inputs. */
export const ghidraNesUnsupportedReason = (
  target: BinaryTarget,
): string | null => {
  if (target.format !== "nes") return null;
  return ghidraNesMetadataUnsupportedReason(target.nes, target.nesPrgViews);
};

/** The launch boundary uses the same admission rules as provider discovery. */
export const ghidraNesMetadataUnsupportedReason = (
  metadata: NesRomMetadata,
  views?: readonly NesPrgView[],
): string | null => {
  const layout = resolveNesMapperLayout(metadata, views);
  return layout.ok ? null : layout.error;
};

/** Preserve mapper-specific uncertainty in every NES tool result. */
export const ghidraNesLimitations = (
  target: BinaryTarget,
): readonly string[] => {
  if (target.format !== "nes") return [];
  const layout = resolveNesMapperLayout(target.nes, target.nesPrgViews);
  return [
    ...GHIDRA_NES_LIMITATIONS,
    ...(layout.ok ? layout.value.limitations : []),
  ];
};

/** Commit all header observations and the exact interpretation used at import. */
export const ghidraNesProfileParameters = (
  target: BinaryTarget,
): Readonly<Record<string, JsonValue>> => {
  if (target.format !== "nes") return {};
  const layout = resolveNesMapperLayout(target.nes, target.nesPrgViews);
  if (!layout.ok) throw new Error(layout.error);
  return {
    nes_rom: jsonValueSchema.parse(target.nes),
    nes_support_lane: "nes-contexts-v3",
    nes_mapper_layout: jsonValueSchema.parse(layout.value),
    loader: "BinaryLoader",
    language_id: GHIDRA_NES_LANGUAGE_ID,
    compiler_spec_id: GHIDRA_NES_COMPILER_SPEC_ID,
    load_image_evidence: "independent-nes-context-source-mappings-v3",
    address_coordinates: "nes-address-space-and-cpu-byte-address",
    entry_seed: "context-qualified-reset-nmi-irq-vectors-before-analysis-v3",
    analyzer_preset: "nes-context-vector-roots-v3",
    disabled_analyzers: [
      "Aggressive Instruction Finder",
      "Function Start Search",
    ],
    cpu_ram: {
      address: "0x0000",
      size: 0x800,
      initialized: false,
      mirrors: ["0x0800", "0x1000", "0x1800"],
    },
    hardware_register_regions: [
      { address: "0x2000", size: 0x2000, initialized: false, volatile: true },
      { address: "0x4000", size: 0x18, initialized: false, volatile: true },
    ],
    chr_mapping: "not-in-cpu-address-space",
    trainer_mapping: "metadata-only-not-applied",
    cartridge_ram_mapping: "declarations-only-not-mapped",
    nes_limitations: [...ghidraNesLimitations(target)],
  };
};
