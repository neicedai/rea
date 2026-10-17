import { z } from "zod";

const interval = z
  .strictObject({
    min: z.number().int().min(0).max(41565),
    max: z.number().int().min(0).max(41565),
  })
  .refine(
    (range) => range.min <= range.max,
    "Frame position minimum exceeds maximum",
  );
export const nesApuFrameSchema = z
  .strictObject({
    region: z.enum(["ntsc", "pal"]),
    position: interval.nullable().default(null),
    five_step: z.boolean().nullable().default(null),
    cpu_phase: z.enum(["get", "put"]).nullable().default(null),
    reset_delay: z
      .strictObject({
        min: z.number().int().min(0).max(4),
        max: z.number().int().min(0).max(4),
      })
      .refine(
        (range) => range.min <= range.max,
        "Reset delay minimum exceeds maximum",
      )
      .prefault({ min: 0, max: 4 }),
    clock_block: z
      .union([z.literal(0), z.literal(1)])
      .nullable()
      .default(null),
    origin: z
      .union([
        z.strictObject({ kind: z.literal("initial-phase") }),
        z.strictObject({
          kind: z.enum(["cpu-cycle", "cpu-write", "phase-assumption"]),
          index: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        }),
      ])
      .prefault({ kind: "initial-phase" }),
  })
  .superRefine((state, ctx) => {
    const max =
      state.region === "ntsc"
        ? state.five_step === false
          ? 29829
          : 37281
        : state.five_step === false
          ? 33253
          : 41565;
    if (state.position !== null && state.position.max > max)
      ctx.addIssue({
        code: "custom",
        path: ["position", "max"],
        message: "Frame position exceeds the region/mode sequence",
      });
  })
  .meta({
    allOf: [
      {
        if: { properties: { region: { const: "ntsc" } }, required: ["region"] },
        then: {
          properties: {
            position: {
              properties: { min: { maximum: 37281 }, max: { maximum: 37281 } },
            },
          },
        },
      },
      ...(
        [
          ["ntsc", 29829],
          ["pal", 33253],
        ] as const
      ).map(([region, max]) => ({
        if: {
          properties: {
            region: { const: region },
            five_step: { const: false },
          },
          required: ["region", "five_step"],
        },
        then: {
          properties: {
            position: {
              properties: { min: { maximum: max }, max: { maximum: max } },
            },
          },
        },
      })),
    ],
  })
  .describe(
    "Conventional ordered CPU-edge frame sequencer. position is elapsed CPU edges since reset; zero is the reset boundary. Null is unknown phase. Get/put identifies the current write-cycle parity; each apu-cpu-cycle advances one subsequent CPU edge. reset_delay is remaining edges, including zero/no pending reset. A block of one suppresses a unit pulse on the next edge. Intervals cover correlations conservatively; no power-on phase, CPU instruction timing or within-cycle collision is inferred.",
  );
export type NesApuFrame = z.infer<typeof nesApuFrameSchema>;
export const nesApuFrameSignalsSchema = z
  .strictObject({
    quarter: z.boolean().nullable(),
    half: z.boolean().nullable(),
    irq: z.boolean().nullable(),
    reset: z.boolean().nullable(),
  })
  .refine(
    (signals) => signals.half !== true || signals.quarter === true,
    "A definite half clock includes a definite quarter clock",
  )
  .meta({
    if: { properties: { half: { const: true } }, required: ["half"] },
    then: { properties: { quarter: { const: true } } },
  })
  .describe(
    "Definite true, absent false or possible null signals on this supplied CPU edge. Half includes a quarter signal. IRQ is the gated frame request before the flag latch; reset identifies delayed 4017 completion.",
  );
export type NesApuFrameSignals = z.infer<typeof nesApuFrameSignalsSchema>;
const flags = (flag: boolean | null): boolean[] =>
  flag === null ? [false, true] : [flag];
const join = (values: readonly boolean[]): boolean | null =>
  values.every((value) => value === values[0]) ? values[0]! : null;
type Edge = { quarter: boolean; half: boolean; irq: boolean };
const schedule = (region: NesApuFrame["region"], five: boolean) => {
  const times =
    region === "ntsc"
      ? [7457, 14913, 22371, 29828, 29829, 29830, 37281, 37282]
      : [8313, 16627, 24939, 33252, 33253, 33254, 41565, 41566];
  return {
    period: five ? times[7]! : times[5]!,
    edges: [
      { at: times[0]!, quarter: true, half: false, irq: false },
      { at: times[1]!, quarter: true, half: true, irq: false },
      { at: times[2]!, quarter: true, half: false, irq: false },
      ...(five
        ? [{ at: times[6]!, quarter: true, half: true, irq: false }]
        : [
            { at: times[3]!, quarter: false, half: false, irq: true },
            { at: times[4]!, quarter: true, half: true, irq: true },
            { at: times[5]!, quarter: false, half: false, irq: true },
          ]),
    ],
  };
};

export const queueNesApuFrameReset = (
  state: NesApuFrame,
  index: number,
): void => {
  state.reset_delay =
    state.cpu_phase === "get"
      ? { min: 3, max: 3 }
      : state.cpu_phase === "put"
        ? { min: 4, max: 4 }
        : { min: 3, max: 4 };
  state.origin = { kind: "cpu-write", index };
};

/** Jump through a compact phase cover; no loop or allocation proportional to the period. */
export function clockNesApuFrame(
  state: NesApuFrame,
  control: { fiveStep: boolean | null; inhibit: boolean | null },
  index: number,
): NesApuFrameSignals {
  const quarters: boolean[] = [],
    halves: boolean[] = [],
    irqs: boolean[] = [],
    resets: boolean[] = [],
    modes: boolean[] = [],
    blocks: boolean[] = [],
    positions: number[] = [],
    delays: number[] = [];
  const resetChoices: ("none" | "pending" | "complete")[] = [];
  if (state.reset_delay.min === 0) resetChoices.push("none");
  if (state.reset_delay.min <= 1 && state.reset_delay.max >= 1)
    resetChoices.push("complete");
  if (state.reset_delay.max > 1) resetChoices.push("pending");
  for (const five of flags(state.five_step)) {
    const { period, edges } = schedule(state.region, five),
      min = state.position?.min ?? 0,
      max = Math.min(state.position?.max ?? period - 1, period - 1);
    if (min > max) continue;
    const possible: Edge[] = edges.filter(
      (edge) => edge.at - 1 >= min && edge.at - 1 <= max,
    );
    if (max - min + 1 > possible.length)
      possible.push({ quarter: false, half: false, irq: false });
    for (const completion of resetChoices)
      for (const selected of flags(control.fiveStep)) {
        // A completed/absent reset must already agree with the last written mode.
        if (completion === "none" && five !== selected) continue;
        const reset = completion === "complete";
        resets.push(reset);
        if (completion === "pending")
          delays.push(
            Math.max(1, state.reset_delay.min - 1),
            state.reset_delay.max - 1,
          );
        else delays.push(0);
        if (reset) positions.push(0);
        else if (max + 1 === period)
          positions.push(0, ...(min < max ? [min + 1, period - 1] : []));
        else positions.push(min + 1, max + 1);
        modes.push(reset ? selected : five);
        for (const block of state.clock_block === null
          ? [0, 1]
          : [state.clock_block])
          for (const edge of possible) {
            const regular = block === 0 && edge.quarter,
              restart = block === 0 && !regular && reset && selected;
            quarters.push(regular || restart);
            halves.push((regular && edge.half) || restart);
            blocks.push(regular || restart);
            for (const inhibited of flags(control.inhibit))
              irqs.push(edge.irq && !inhibited);
          }
      }
  }
  state.five_step = join(modes);
  state.position = { min: Math.min(...positions), max: Math.max(...positions) };
  state.reset_delay = {
    min: Math.min(...delays),
    max: Math.max(...delays),
  };
  const blocked = join(blocks);
  state.clock_block = blocked === null ? null : blocked ? 1 : 0;
  state.cpu_phase =
    state.cpu_phase === null ? null : state.cpu_phase === "get" ? "put" : "get";
  state.origin = { kind: "cpu-cycle", index };
  return {
    quarter: join(quarters),
    half: join(halves),
    irq: join(irqs),
    reset: join(resets),
  };
}
