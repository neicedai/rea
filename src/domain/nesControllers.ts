import { z } from "zod";
import { nesByteValueSchema } from "./nesByteValue.js";
import { nesDmaRequestSchema } from "./nesCpuDma.js";

export const nesControllerLimitations =
  "Optional initial_controllers model standard-controllers interprets two held eight-button D0 reports, explicit controller-buttons changes and 4016 strobe writes. Button/report bits, initial alignment and strobe are caller assumptions; no gameplay or input capture is observed. High strobe reads live A; low strobe shifts the frozen report and official-pad overreads return one. Upper bus bits, expansion controllers, microphone, Zapper, turbo and analog devices remain unknown. dma_reads absent explicitly qualifies no unobserved controller clocks. Without selected source DMC cpu_timing, possible DMC enable degrades it; possible DMA clocks retain monotonic serial-position alternatives. The physical OAM-DMA queue is reconciled across selected models, with contradictory facts rejected. Qualified packet halted_cpu_address can exclude internal-device DMA hazards without establishing DMA timing. Controller read origins retain embedded held/report byte facts and prior event indices; MMIO never gets a fake ROM or RAM offset. controller_trace separates initial/initialized/final state, compact position deltas and unapplied frontiers. Source events commit only with their containing instruction; no CPU/PPU/audio timing, input-event scheduling or commercial-game compatibility is inferred.";

const port = z.union([z.literal(1), z.literal(2)]),
  eventIndex = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const nesControllerButtonsOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("initial-buttons"), port }),
  z.strictObject({ kind: z.literal("buttons-event"), port, index: eventIndex }),
]);
const reportOrigin = z.union([
  nesControllerButtonsOriginSchema,
  z.strictObject({ kind: z.literal("initial-report"), port }),
  z.strictObject({
    kind: z.literal("latch-write"),
    port,
    index: eventIndex,
    buttons_origin: nesControllerButtonsOriginSchema,
  }),
  z.strictObject({ kind: z.literal("joined-report"), port, index: eventIndex }),
]);
const buttonFact = z.strictObject({
  value: nesByteValueSchema,
  origin: nesControllerButtonsOriginSchema,
});
const serialReport = z.strictObject({
  position: z.number().int().min(0).max(8),
  buttons: nesByteValueSchema,
  origin: reportOrigin,
});
const serialReports = z
  .array(serialReport)
  .min(1)
  .max(9)
  .superRefine((reports, ctx) => {
    const positions = new Set<number>();
    for (const [index, report] of reports.entries()) {
      if (positions.has(report.position))
        ctx.addIssue({
          code: "custom",
          path: [index, "position"],
          message: "Each serial position has one common report proof",
        });
      positions.add(report.position);
    }
  })
  .meta({
    allOf: Array.from({ length: 9 }, (_, position) => ({
      contains: {
        type: "object",
        properties: { position: { const: position } },
        required: ["position"],
      },
      minContains: 0,
      maxContains: 1,
    })),
  });
const portState = (number: 1 | 2) =>
  z.strictObject({
    serial_reports: serialReports.default(
      Array.from({ length: 9 }, (_, position) => ({
        position,
        buttons: null,
        origin: { kind: "initial-report" as const, port: number },
      })),
    ),
  });
export const nesControllersStateSchema = z
  .strictObject({
    model: z.literal("standard-controllers"),
    buttons: z
      .tuple([
        z.union([nesByteValueSchema, buttonFact]),
        z.union([nesByteValueSchema, buttonFact]),
      ])
      .default([null, null]),
    strobe: z.boolean().nullable().default(null),
    ports: z.tuple([portState(1), portState(2)]).prefault([{}, {}]),
    dma_reads: z.enum(["absent", "unobserved"]).default("unobserved"),
    oam_dma_pending: nesDmaRequestSchema.prefault({ status: "unknown" }),
    next_event_index: eventIndex.default(0),
  })
  .describe(
    "Conditional standard eight-button serial pads on 4016/4017 D0. Button bits are A,B,Select,Start,Up,Down,Left,Right in bits 0..7 and are held until an explicit controller-buttons event. This is a caller input assumption, not observed input. Strobe and report alignment default unknown; serial_reports describe only the low-strobe branch. High strobe continuously samples live A without advancing. Official-pad post-report bits are one; expansion devices, microphone and upper open-bus bits remain unknown. dma_reads absent explicitly qualifies no unobserved extra controller clocks; omission joins monotonic extra clocks. Without selected source DMC cpu_timing, a possible 4015 D4 enable degrades this qualification. The physical OAM-DMA request is reconciled with selected PPU/cartridge models before analysis.",
  );
export type NesControllersState = z.infer<typeof nesControllersStateSchema>;
export const nesControllerButtonsEventSchema = z
  .strictObject({
    kind: z.literal("controller-buttons"),
    port,
    buttons: nesByteValueSchema,
  })
  .describe(
    "Explicit external button-state assumption, held from this event until replaced. Requires initial_controllers model standard-controllers. Does not imply wall-clock time or a user input event was observed.",
  );
export const nesControllerReadSourceSchema = z
  .strictObject({
    kind: z.literal("standard-controller"),
    port,
    strobe: z.boolean().nullable(),
    live: buttonFact,
    serial_reports: serialReports,
    tail_bit: z.literal(1),
    dma_reads: z.enum(["absent", "unobserved"]),
    reason: z.string().min(1).nullable(),
  })
  .describe(
    "D0 serial proof before this CPU read. Low-strobe reports retain compatible positions and embedded byte/origin facts; high strobe reads live A. Position eight is the standard-pad constant-one tail. Upper seven CPU bits are unmodeled, never a fake ROM or RAM byte.",
  );
const controllerRead = z.strictObject({
  address: z.union([z.literal(16406), z.literal(16407)]),
  value: z.null(),
  source: nesControllerReadSourceSchema,
});
export const nesControllerCpuReadSchema = z.union([
  controllerRead,
  controllerRead.extend({
    known_bits: z.strictObject({
      mask: z.literal(1),
      value: z.union([z.literal(0), z.literal(1)]),
    }),
  }),
]);
export type NesControllerCpuRead = z.infer<typeof nesControllerCpuReadSchema>;
const controllerView = z.strictObject({
  strobe: z.boolean().nullable(),
  dma_reads: z.enum(["absent", "unobserved"]),
  oam_dma_pending: nesDmaRequestSchema,
  positions: z.tuple([
    z.array(z.number().int().min(0).max(8)).min(1).max(9),
    z.array(z.number().int().min(0).max(8)).min(1).max(9),
  ]),
});
export const nesControllerOperationSchema = z
  .strictObject({
    event_index: eventIndex,
    kind: z.enum([
      "cpu-read",
      "cpu-write",
      "controller-buttons",
      "oam-dma",
      "oam-dma-start",
      "controller-hold",
    ]),
    address: z.number().int().min(0).max(65535).nullable(),
    port: port.nullable(),
    before: controllerView,
    after: controllerView,
    effects: z
      .array(
        z.enum([
          "buttons-update",
          "strobe-write",
          "serial-read",
          "held-read",
          "dma-queued",
          "dma-consumed",
          "oam-interference",
          "dmc-uncertainty",
        ]),
      )
      .max(7),
    reason: z.string().min(1).nullable(),
  })
  .describe(
    "Controller deltas and position views, without repeating button/report storage images. The referenced mapper event owns any CPU read source; source-only unapplied accesses appear in frontier.",
  );
export type NesControllerOperation = z.infer<
  typeof nesControllerOperationSchema
>;
export const nesControllerTraceSchema = z
  .strictObject({
    initial: nesControllersStateSchema,
    initialized: nesControllersStateSchema,
    operations: z.array(nesControllerOperationSchema),
    final: nesControllersStateSchema,
    frontier: z.array(nesControllerOperationSchema),
  })
  .describe(
    "Initial caller facts, initialized shared DMA facts, committed controller operations/final state and unapplied source frontier. Absolute indices start at initial_controllers.next_event_index and advance for every committed mapper event; source mapper_event_range uses relative step indices. Resume final state with the same controller wiring/qualification.",
  );
