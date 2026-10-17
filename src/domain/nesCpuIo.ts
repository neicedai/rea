import { z } from "zod";
import {
  nesByteValueSchema,
  nesByteProof,
  type NesByteValue,
} from "./nesByteValue.js";
import { nesControllerReadSourceSchema } from "./nesControllers.js";
import { nesApuReadSourceSchema } from "./nesApu.js";

const index = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const pin = z
  .strictObject({
    mask: z.literal(1),
    value: z.union([z.literal(0), z.literal(1)]),
  })
  .nullable();
export const nesHeldControllerSchema = z.strictObject({
  pin_value: pin,
  source: nesControllerReadSourceSchema.nullable(),
  cycle_index: index.nullable(),
});
export const nesControllerHoldEventSchema = z
  .strictObject({
    kind: z.literal("controller-hold"),
    address: z.union([z.literal(0x4016), z.literal(0x4017)]),
    held: nesHeldControllerSchema,
  })
  .describe(
    "Qualified controller output with /OE continuously asserted. Returns the embedded held D0 fact without another serial clock. Embedded source/cycle identity is a caller assumption in supplied-event replay; source CPU I/O tracing supplies the preceding actual read.",
  );
export const nesHeldControllerSourceSchema = z.strictObject({
  kind: z.literal("held-controller"),
  address: z.union([z.literal(0x4016), z.literal(0x4017)]),
  held: nesHeldControllerSchema,
});
export const nesHeldControllerReadSchema = z.union([
  z.strictObject({
    address: z.union([z.literal(0x4016), z.literal(0x4017)]),
    value: z.null(),
    source: nesHeldControllerSourceSchema,
  }),
  z.strictObject({
    address: z.union([z.literal(0x4016), z.literal(0x4017)]),
    value: z.null(),
    known_bits: pin.unwrap(),
    source: nesHeldControllerSourceSchema,
  }),
]);
export const readNesHeldController = (
  event: z.infer<typeof nesControllerHoldEventSchema>,
) => ({
  address: event.address,
  value: null,
  source: {
    kind: "held-controller" as const,
    address: event.address,
    held: structuredClone(event.held),
  },
  ...(event.held.pin_value === null
    ? {}
    : { known_bits: event.held.pin_value }),
});

const latchOrigin = z.strictObject({
  mask: z.number().int().min(1).max(255),
  source: z.union([
    z.strictObject({
      kind: z.literal("initial-latch"),
      line: z.enum(["cpu", "external"]),
    }),
    z.strictObject({
      kind: z.literal("cycle"),
      line: z.enum(["cpu", "external"]),
      index,
    }),
  ]),
});
const origins = z.array(latchOrigin).max(8);
export const nesCpuIoLatchViewSchema = z.strictObject({
  cpu_latch: nesByteValueSchema,
  external_latch: nesByteValueSchema,
  latch_origins: z.strictObject({ cpu: origins, external: origins }),
});
export type NesCpuIoOrigin = z.infer<typeof latchOrigin>;
export const nesCpuIoLimitations =
  "Optional initial_cpu_io model 2a03-io requires the nominal bus. It qualifies conventional stable CPU/external data latches, excluding decay, unmodeled cartridge pull effects and unmodeled expansion read drivers at 4020–5FFF. Known MMC5/Namco read domains remain driven unknown when unselected. Separate latches preserve 4015 internal isolation and D5; controller D0–D4 drive the external bus while D5–D7 retain its prior value. Unknown driven bits erase prior facts. controller_clocking contiguous models NES/AV Famicom /OE sets; per-cycle models RF Famicom. Active-controller state and held D0 default unknown; no reset, console identity or initial latch byte is inferred. cpu_bus.io retains initial/initialized/committed-final latches and bit origins; retained input origins remain caller facts, and numeric cycle indices alone do not establish target/path identity; unknown initial /OE stops before an ambiguous read. cpu-io mapper origins retain raw device facts and both prior latches. With qualified NTSC OAM or DMC DMA, low DMA address bits combine with halted CPU high bits to activate 4015/4016/4017: status is internal, controller lower pins conflict by AND, and external reads still apply once. dma_io retains both source reads and CPU/external results within one bus cycle. PAL 2A07 decode quirks, unmodeled pins, analog bus races, unselected DMC timing and physical observations remain unknown.";
const state = z.strictObject({
  model: z.literal("2a03-io"),
  controller_clocking: z.enum(["contiguous", "per-cycle"]),
  cpu_latch: nesByteValueSchema.default(null),
  external_latch: nesByteValueSchema.default(null),
  active_controller: z
    .union([z.literal(0), z.literal(1), z.literal(2)])
    .nullable()
    .default(null),
  held_controller: nesHeldControllerSchema.nullable().default(null),
});
const sourcedState = state
  .extend({
    latch_origins: z.strictObject({ cpu: origins, external: origins }),
  })
  .meta({
    allOf: (["cpu", "external"] as const).flatMap((line) =>
      Array.from({ length: 8 }, (_, bit) => {
        const masks = Array.from(
          { length: 255 },
          (_, index) => index + 1,
        ).filter((mask) => (mask & (1 << bit)) !== 0);
        const field = line === "cpu" ? "cpu_latch" : "external_latch";
        return {
          if: {
            anyOf: [
              {
                properties: { [field]: { type: "integer" } },
                required: [field],
              },
              {
                properties: {
                  [field]: {
                    type: "object",
                    properties: { mask: { enum: masks } },
                    required: ["mask"],
                  },
                },
                required: [field],
              },
            ],
          },
          then: {
            properties: {
              latch_origins: {
                properties: {
                  [line]: {
                    contains: {
                      properties: { mask: { enum: masks } },
                      required: ["mask"],
                    },
                    minContains: 1,
                    maxContains: 1,
                  },
                },
              },
            },
          },
          else: {
            properties: {
              latch_origins: {
                properties: {
                  [line]: {
                    contains: {
                      properties: { mask: { enum: masks } },
                      required: ["mask"],
                    },
                    minContains: 0,
                    maxContains: 0,
                  },
                },
              },
            },
          },
        };
      }),
    ),
  });
export const nesCpuIoStateSchema = z
  .union([state, sourcedState])
  .superRefine((value, ctx) => {
    if (value.active_controller === 0 && value.held_controller !== null)
      ctx.addIssue({
        code: "custom",
        path: ["held_controller"],
        message:
          "An inactive controller output cannot retain an active held read.",
      });
    if (
      (value.active_controller === 1 || value.active_controller === 2) &&
      value.held_controller?.source != null &&
      value.held_controller.source.port !== value.active_controller
    )
      ctx.addIssue({
        code: "custom",
        path: ["held_controller", "source", "port"],
        message: "Held source must identify the active controller port.",
      });
    if (!("latch_origins" in value)) return;
    for (const line of ["cpu", "external"] as const) {
      const byte = line === "cpu" ? value.cpu_latch : value.external_latch;
      const mask = typeof byte === "number" ? 255 : (byte?.mask ?? 0);
      let covered = 0;
      for (const origin of value.latch_origins[line]) {
        if ((origin.mask & covered) !== 0 || (origin.mask & ~mask) !== 0)
          ctx.addIssue({
            code: "custom",
            path: ["latch_origins", line],
            message: "Latch origins must prove disjoint known bits only.",
          });
        covered |= origin.mask;
      }
      if (covered !== mask)
        ctx.addIssue({
          code: "custom",
          path: ["latch_origins", line],
          message: "Every known latch bit requires one source.",
        });
    }
  })
  .describe(nesCpuIoLimitations)
  .meta({
    allOf: [
      {
        if: {
          properties: { active_controller: { const: 0 } },
          required: ["active_controller"],
        },
        then: { properties: { held_controller: { type: "null" } } },
      },
      ...([1, 2] as const).map((port) => ({
        if: {
          properties: { active_controller: { const: port } },
          required: ["active_controller"],
        },
        then: {
          properties: {
            held_controller: {
              properties: { source: { properties: { port: { const: port } } } },
            },
          },
        },
      })),
    ],
  });
export type NesCpuIoState = z.infer<typeof nesCpuIoStateSchema>;
export type NesSourcedCpuIoState = z.infer<typeof sourcedState>;
export const nesCpuIoReadSourceSchema = z.strictObject({
  kind: z.literal("cpu-io"),
  operation: z.enum([
    "open-bus",
    "external-open-bus",
    "apu-status",
    "controller",
  ]),
  raw_value: nesByteValueSchema,
  cpu_latch: nesByteValueSchema,
  external_latch: nesByteValueSchema,
  latch_origins: z.strictObject({ cpu: origins, external: origins }),
  device_source: z
    .union([
      nesControllerReadSourceSchema,
      nesHeldControllerSourceSchema,
      nesApuReadSourceSchema,
    ])
    .nullable(),
});

export const nesIoBits = (
  value: NesByteValue,
): { mask: number; value: number } =>
  typeof value === "number"
    ? { mask: 255, value }
    : (value ?? { mask: 0, value: 0 });
export const replaceNesIoBits = (
  before: NesByteValue,
  value: NesByteValue,
  driven: number,
): NesByteValue => {
  const old = nesIoBits(before),
    next = nesIoBits(value);
  return nesByteProof(
    (old.mask & ~driven) | (next.mask & driven),
    (old.value & ~driven) | (next.value & driven),
  );
};
export const andNesIoBits = (
  left: NesByteValue,
  right: NesByteValue,
): NesByteValue => {
  const a = nesIoBits(left),
    b = nesIoBits(right);
  const zeroes = (a.mask & ~a.value) | (b.mask & ~b.value),
    ones = a.mask & b.mask & a.value & b.value;
  return nesByteProof(zeroes | ones, ones);
};
