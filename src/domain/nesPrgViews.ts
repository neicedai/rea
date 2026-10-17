import { nesBandaiVariantSchema } from "./nesBandai.js";
import { nesIrem78VariantSchema } from "./nesIrem78.js";
import { nesMmc5ViewSchema, mmc5ViewKey } from "./nesMmc5.js";
import { nesFme7ViewSchema } from "./nesFme7.js";
import { nesNamco163ViewSchema } from "./nesNamco163.js";
import { nesVrc2WiringSchema, nesVrc4WiringSchema } from "./nesVrcBoard.js";
import { z } from "zod";

const vrc4Fields = {
  variant: z.literal("vrc4"),
  prg_mode: z.union([z.literal(0), z.literal(1)]),
  prg_bank_0: z.number().int().min(0).max(31),
  prg_bank_1: z.number().int().min(0).max(31),
};

/** Complete PRG selectors for one static UxROM, AxROM, Camerica/Quattro, BNROM/NINA-001, Color Dreams, GxROM, Bandai FCG, Sunsoft 3/4/FME-7, Irem G-101/H3001/Cosmo Carrier/Holy Diver, Taito TC0190, VRC1/VRC2/VRC3/VRC4/VRC6, Namco 108/163, MMC1, MMC2, MMC3, MMC4 or MMC5 CPU address-space view. */
export const nesPrgViewSchema = z.union([
  ...nesMmc5ViewSchema.options,
  nesNamco163ViewSchema,
  ...nesFme7ViewSchema.options,
  z.strictObject({
    mapper: z.literal(16),
    variant: nesBandaiVariantSchema,
    prg_bank: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(159),
    prg_bank: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(67),
    prg_bank: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(73),
    prg_bank: z.number().int().min(0).max(7),
  }),
  z.strictObject({
    mapper: z.literal(78),
    variant: nesIrem78VariantSchema,
    prg_bank: z.number().int().min(0).max(7),
  }),
  z.strictObject({
    mapper: z.literal(68),
    variant: z
      .literal("normal")
      .describe(
        "Immutable ordinary Sunsoft 4 board interpretation; excludes Dual Cartridge System external ROM and licensing circuitry. Original header observations are preserved.",
      ),
    prg_bank: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.union([z.literal(24), z.literal(26)]),
    prg_bank_16k: z.number().int().min(0).max(15),
    prg_bank_8k: z.number().int().min(0).max(31),
  }),
  z.strictObject({
    mapper: z.union([z.literal(21), z.literal(23), z.literal(25)]),
    ...vrc4Fields,
  }),
  z.strictObject({
    mapper: z.union([z.literal(21), z.literal(23), z.literal(25)]),
    ...vrc4Fields,
    wiring: nesVrc4WiringSchema,
  }),
  z.strictObject({
    mapper: z.union([z.literal(22), z.literal(23), z.literal(25)]),
    prg_bank_0: z.number().int().min(0).max(31),
    prg_bank_1: z.number().int().min(0).max(31),
  }),
  z.strictObject({
    mapper: z.union([z.literal(22), z.literal(23), z.literal(25)]),
    wiring: nesVrc2WiringSchema,
    prg_bank_0: z.number().int().min(0).max(31),
    prg_bank_1: z.number().int().min(0).max(31),
  }),
  z.strictObject({
    mapper: z.literal(75),
    prg_bank_0: z.number().int().min(0).max(15),
    prg_bank_1: z.number().int().min(0).max(15),
    prg_bank_2: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(33),
    prg_bank_0: z.number().int().min(0).max(63),
    prg_bank_1: z.number().int().min(0).max(63),
  }),
  z.strictObject({
    mapper: z.literal(32),
    prg_mode: z.union([z.literal(0), z.literal(1)]),
    prg_bank_0: z.number().int().min(0).max(31),
    prg_bank_1: z.number().int().min(0).max(31),
  }),
  z.strictObject({
    mapper: z.literal(65),
    prg_mode: z.union([z.literal(0), z.literal(1)]),
    prg_bank_0: z.number().int().min(0).max(63),
    prg_bank_1: z.number().int().min(0).max(63),
  }),
  z.strictObject({
    mapper: z.literal(76),
    r6: z.number().int().min(0).max(15),
    r7: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(206),
    r6: z.number().int().min(0).max(15),
    r7: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(232),
    prg_outer_bank: z.number().int().min(0).max(3),
    prg_bank: z.number().int().min(0).max(3),
  }),
  z.strictObject({
    mapper: z.literal(180),
    prg_bank: z.number().int().min(0).max(7),
  }),
  z.strictObject({
    mapper: z.literal(34),
    prg_bank: z.number().int().min(0).max(3),
  }),
  z.strictObject({
    mapper: z.literal(71),
    prg_bank: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(11),
    prg_bank: z.number().int().min(0).max(3),
  }),
  z.strictObject({
    mapper: z.literal(66),
    prg_bank: z.number().int().min(0).max(3),
  }),
  z.strictObject({
    mapper: z.literal(7),
    prg_bank: z.number().int().min(0).max(7),
  }),
  z.strictObject({
    mapper: z.literal(2),
    prg_bank: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(1),
    prg_mode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    prg_bank: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(1),
    prg_mode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    prg_bank: z.number().int().min(0).max(15),
    prg_outer_bank: z.union([z.literal(0), z.literal(1)]),
  }),
  z.strictObject({
    mapper: z.literal(4),
    prg_mode: z.union([z.literal(0), z.literal(1)]),
    r6: z.number().int().min(0).max(63),
    r7: z.number().int().min(0).max(63),
  }),
  z.strictObject({
    mapper: z.literal(9),
    prg_bank: z.number().int().min(0).max(15),
  }),
  z.strictObject({
    mapper: z.literal(10),
    prg_bank: z.number().int().min(0).max(15),
  }),
]);

export type NesPrgView = z.infer<typeof nesPrgViewSchema>;

const selectors = (view: NesPrgView): readonly number[] => {
  if ("variant" in view && view.variant === "vrc4")
    return [
      view.mapper,
      4,
      !("wiring" in view)
        ? -1
        : nesVrc4WiringSchema.options.indexOf(view.wiring),
      view.prg_mode,
      view.prg_bank_0,
      view.prg_bank_1,
    ];
  switch (view.mapper) {
    case 5:
      return mmc5ViewKey(view);
    case 69:
      return [
        view.mapper,
        ["fme7", "5a", "5b"].indexOf(view.variant),
        view.lower_window.source === "ram" ? -1 : view.lower_window.bank,
        view.prg_bank_0,
        view.prg_bank_1,
        view.prg_bank_2,
      ];
    case 16:
      return [view.mapper, view.variant === "fcg" ? 0 : 1, view.prg_bank];
    case 78:
      return [
        view.mapper,
        view.variant === "cosmo-carrier" ? 0 : 1,
        view.prg_bank,
      ];
    case 159:
    case 67:
    case 68:
    case 73:
      return [view.mapper, view.prg_bank];
    case 24:
    case 26:
      return [view.mapper, view.prg_bank_16k, view.prg_bank_8k];
    case 22:
    case 23:
    case 25:
      return [
        view.mapper,
        2,
        !("wiring" in view)
          ? -1
          : nesVrc2WiringSchema.options.indexOf(view.wiring),
        view.prg_bank_0,
        view.prg_bank_1,
      ];
    case 19:
    case 75:
      return [view.mapper, view.prg_bank_0, view.prg_bank_1, view.prg_bank_2];
    case 33:
      return [view.mapper, view.prg_bank_0, view.prg_bank_1];
    case 32:
    case 65:
      return [view.mapper, view.prg_mode, view.prg_bank_0, view.prg_bank_1];
    case 232:
      return [view.mapper, view.prg_outer_bank, view.prg_bank];
    case 1:
      return [
        view.mapper,
        view.prg_mode,
        view.prg_bank,
        "prg_outer_bank" in view ? view.prg_outer_bank : -1,
      ];
    case 206:
    case 76:
      return [view.mapper, view.r6, view.r7];
    case 4:
      return [view.mapper, view.prg_mode, view.r6, view.r7];
    case 34:
    case 11:
    case 66:
    case 7:
    case 71:
    case 180:
    case 2:
    case 9:
    case 10:
      return [view.mapper, view.prg_bank];
  }
};
const compareViews = (left: NesPrgView, right: NesPrgView): number => {
  const a = selectors(left),
    b = selectors(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i]! - b[i]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
};

/** Normalize produced raw states without imposing an import resource limit. */
export const normalizeNesPrgViews = (
  views: Iterable<NesPrgView>,
): NesPrgView[] => {
  const unique = new Map<string, NesPrgView>();
  for (const view of views) unique.set(selectors(view).join(":"), view);
  return [...unique.values()].sort(compareViews);
};

/** Admit caller-selected raw states for a bounded analysis import. */
export const nesPrgViewsSchema = z
  .array(nesPrgViewSchema)
  .min(1)
  // MMC3 has two PRG modes and two independent six-bit PRG selectors.
  .max(2 * 64 * 64)
  .superRefine((views, context) => {
    const seen = new Set<string>();
    for (const [index, view] of views.entries()) {
      const key = selectors(view).join(":");
      if (seen.has(key))
        context.addIssue({
          code: "custom",
          path: [index],
          message: "NES PRG views must contain unique register states.",
        });
      seen.add(key);
    }
  })
  .overwrite(normalizeNesPrgViews)
  .meta({ uniqueItems: true })
  .describe(
    "Unique PRG register states, normalized by mapper, mode, and raw selectors. This set does not describe a temporal sequence of bank switches.",
  );
