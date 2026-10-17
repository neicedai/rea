import { z } from "zod";
import type { NesPpuSprites } from "./nesPpuSprites.js";

const count = (maximum: number) =>
  z.strictObject({
    minimum: z.number().int().min(0).max(maximum),
    maximum: z.number().int().min(0).max(maximum),
  });
const candidate = (height: 8 | 16) =>
  z.strictObject({
    sprite: z.number().int().min(0).max(63),
    row_mask: z
      .number()
      .int()
      .min(1)
      .max(2 ** height - 1)
      .describe(
        "Bit r identifies a compatible display row r in this sprite's already-flipped mode.rows. Coordinates use stored Y + 1 without byte wrap.",
      ),
    selection: z.enum(["definite", "possible", "excluded"]),
    slots: z
      .tuple([z.number().int().min(0).max(7), z.number().int().min(0).max(7)])
      .meta({ minItems: 2, maxItems: 2 })
      .nullable()
      .describe(
        "Inclusive range of compatible secondary-OAM slots. Null means at least eight earlier vertical matches always exclude this candidate. Definite selection requires every compatible Y to hit this line and fewer than eight possibly matching earlier entries.",
      ),
  });
const scanlineMode = <H extends 8 | 16>(height: H) =>
  z.strictObject({
    height: z.literal(height),
    candidate_sets: z
      .array(z.array(candidate(height)).max(64))
      .min(1)
      .max(240)
      .describe(
        "Shared ordered candidate lists. Each visible line references its complete list through candidate_set; identical lists are stored once without losing any scanline or OAM index.",
      ),
    lines: z
      .array(
        z.strictObject({
          y: z.number().int().min(0).max(239),
          in_range: count(64),
          selected: count(8),
          excess: count(56).describe(
            "Count beyond eight vertical matches, not the buggy PPUSTATUS overflow flag.",
          ),
          candidate_set: z.number().int().min(0).max(239),
        }),
      )
      .length(240),
    coverage: z.strictObject({
      examined_scanlines: z.literal(240),
      uncertain_selection_scanlines: z.number().int().min(0).max(239),
      guaranteed_excess_scanlines: z.number().int().min(0).max(239),
      possible_excess_scanlines: z.number().int().min(0).max(239),
    }),
  });
export const nesPpuSpriteScanlinesSchema = z
  .strictObject({
    interpretation: z.literal("frozen-oam-0-first-eight"),
    modes: z
      .array(
        z.discriminatedUnion("height", [scanlineMode(8), scanlineMode(16)]),
      )
      .min(1)
      .max(2),
  })
  .superRefine((projection, ctx) => {
    for (const [modeIndex, mode] of projection.modes.entries())
      for (const [lineIndex, line] of mode.lines.entries())
        if (line.candidate_set >= mode.candidate_sets.length)
          ctx.addIssue({
            code: "custom",
            path: ["modes", modeIndex, "lines", lineIndex, "candidate_set"],
            message: "Scanline candidate reference is outside candidate_sets",
          });
  })
  .describe(
    "Conditional frozen-state geometry for all visible scanlines, starting the primary OAM search at entry zero. Each compatible global height is separate. All vertical matches consume slots regardless of X, pattern transparency, priority or PPUMASK; these fields do not establish rendering or observed visibility. Missing Y facts retain possible admission and slot ranges. No OAMADDR timing/corruption, secondary-OAM pipeline, overflow bug, clipping, collision or mapper/PPU clocks are simulated.",
  );
type Scanlines = z.infer<typeof nesPpuSpriteScanlinesSchema>;
type Mode = Scanlines["modes"][number];
type Line = Mode["lines"][number];

/** Geometry owns nomination; pixel opacity must not free an evaluation slot. */
export const deriveNesPpuSpriteScanlines = (
  sprites: NesPpuSprites["sprites"],
): Scanlines => {
  const heights = [
      ...new Set(sprites.flatMap((s) => s.modes.map((m) => m.height))),
    ],
    tops = sprites.map((sprite) => new Set(sprite.top_rows));
  return {
    interpretation: "frozen-oam-0-first-eight",
    modes: heights.map((height) => {
      const candidateSets: Mode["candidate_sets"] = [],
        indices = new Map<string, number>();
      const lines = Array.from({ length: 240 }, (_, y): Line => {
        let minimum = 0,
          maximum = 0;
        const candidates: Mode["candidate_sets"][number] = [];
        for (const [index, sprite] of sprites.entries()) {
          let rowMask = 0,
            matching = 0;
          for (let row = 0; row < height; row++)
            if (tops[index]!.has(y - row)) {
              rowMask |= 1 << row;
              matching++;
            }
          if (matching === 0) continue;
          const definite = matching === tops[index]!.size;
          candidates.push({
            sprite: sprite.index,
            row_mask: rowMask,
            selection:
              minimum >= 8
                ? "excluded"
                : definite && maximum < 8
                  ? "definite"
                  : "possible",
            slots: minimum >= 8 ? null : [minimum, Math.min(7, maximum)],
          });
          if (definite) minimum++;
          maximum++;
        }
        const key = JSON.stringify(candidates);
        let reference = indices.get(key);
        if (reference === undefined) {
          reference = candidateSets.length;
          indices.set(key, reference);
          candidateSets.push(candidates);
        }
        return {
          y,
          in_range: { minimum, maximum },
          selected: {
            minimum: Math.min(8, minimum),
            maximum: Math.min(8, maximum),
          },
          excess: {
            minimum: Math.max(0, minimum - 8),
            maximum: Math.max(0, maximum - 8),
          },
          candidate_set: reference,
        };
      });
      return {
        height,
        lines,
        candidate_sets: candidateSets,
        coverage: {
          examined_scanlines: 240,
          uncertain_selection_scanlines: lines.filter((line) =>
            candidateSets[line.candidate_set]!.some(
              (c) => c.selection === "possible",
            ),
          ).length,
          guaranteed_excess_scanlines: lines.filter(
            (line) => line.excess.minimum > 0,
          ).length,
          possible_excess_scanlines: lines.filter(
            (line) => line.excess.maximum > 0,
          ).length,
        },
      };
    }),
  };
};
