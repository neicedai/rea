import { z } from "zod";
import { nesTwoBitValueSchema, nesTwoBitProof } from "./nesByteValue.js";

const nonConvex = [
  [0, 3],
  [1, 2],
  [0, 1, 2],
  [0, 1, 3],
  [0, 2, 3],
  [1, 2, 3],
] as const;
export const nesPpuPixelSchema = z
  .union([
    nesTwoBitValueSchema,
    z.strictObject({
      choices: z
        .array(
          z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
        )
        .min(2)
        .max(3)
        .refine((choices) =>
          nonConvex.some(
            (set) =>
              set.length === choices.length &&
              set.every((value, index) => value === choices[index]),
          ),
        )
        .meta({ enum: nonConvex }),
    }),
  ])
  .describe(
    "Compatible two-bit pixel set. Numbers are singleton indices; null admits all four. Partial mask/value proofs represent bit-constrained sets. The six non-bit-constrained sets use canonical sorted choices instead: 0/3, 1/2, or any three distinct indices. Source-correlated low/high planes are decoded before alternatives are joined. Pixel zero is transparent; a choices set without zero proves opacity even when no index bit is common. Per-pixel alternatives do not imply independent choices across pixels or an observed frame.",
  );
export type NesPpuPixel = z.infer<typeof nesPpuPixelSchema>;

/** Preserve the exact nonempty subset; use ordinary bit proofs when they suffice. */
export const nesPpuPixelFromMask = (choices: number): NesPpuPixel => {
  switch (choices) {
    case 6:
      return { choices: [1, 2] };
    case 9:
      return { choices: [0, 3] };
    case 7:
      return { choices: [0, 1, 2] };
    case 11:
      return { choices: [0, 1, 3] };
    case 13:
      return { choices: [0, 2, 3] };
    case 14:
      return { choices: [1, 2, 3] };
    default: {
      if (!Number.isInteger(choices) || choices < 1 || choices > 15)
        throw new RangeError(
          "A PPU pixel requires a nonempty four-bit choice mask",
        );
      let first: number | null = null,
        mask = 3;
      for (let pixel = 0; pixel < 4; pixel++)
        if (choices & (1 << pixel)) {
          if (first === null) first = pixel;
          else mask &= ~(first ^ pixel);
        }
      return nesTwoBitProof(mask, first! & mask);
    }
  }
};

export const nesPpuPixelMask = (pixel: NesPpuPixel): number => {
  if (pixel === null) return 15;
  if (typeof pixel === "number") return 1 << pixel;
  if ("choices" in pixel) {
    let mask = 0;
    for (const choice of pixel.choices) mask |= 1 << choice;
    return mask;
  }
  let choices = 0;
  for (let value = 0; value < 4; value++)
    if ((value & pixel.mask) === pixel.value) choices |= 1 << value;
  return choices;
};
