import { z } from "zod";

const flag = z.boolean().nullable().default(null);
export const nesCpuInterruptLimitations =
  "Optional initial_interrupts model nmos-6502-interrupts requires the nominal CPU bus. external_irq qualifies a held contribution from every IRQ source not supplied by selected cartridge/APU models; omitted is unknown, never inactive. nmi_edges absent excludes new external/PPU NMI edges over this path; unobserved edges stop before execution. pending_irq/pending_nmi are previously polled boundary requests, independent of the current I flag. Normal instructions poll the physical sample immediately preceding their last nominal action; branches use the sample preceding the operand action and, on page crossing, the last dummy action. Without stalls these are the nominal penultimate, opcode and first dummy samples. DMA clocks update the physical line sample without adding an instruction poll. CLI/SEI/PLP use the old I; RTI restores I before its PC reads. Polls retain sampled contributions and the committed mapper-event prefix at that cycle. IRQ/NMI entry consumes both requests, derives seven bus actions with B=0, and permits a handler instruction before polling again. Automatic entries have separate stack-writer identities and do not consume the instruction budget. The budget reserves at most one automatic entry before each retained instruction; a pending request at exhaustion remains resumable. Unknown decisions and incomplete entries stop without committing their hypothetical effects. OAM stalls additionally require initial_cpu_dma; DMC stalls require initial_apu.dmc.cpu_timing. This conditional profile does not derive PPU NMI edges, NMI hijacking, unqualified DMC stop-window races or physical observations.";
export const nesCpuInterruptStateSchema = z
  .strictObject({
    model: z.literal("nmos-6502-interrupts"),
    external_irq: flag,
    nmi_edges: z.enum(["absent", "unobserved"]).default("unobserved"),
    pending_irq: flag,
    pending_nmi: flag,
  })
  .describe(nesCpuInterruptLimitations);
export type NesCpuInterruptState = z.infer<typeof nesCpuInterruptStateSchema>;
export const nesCpuInterruptSampleSchema = z.strictObject({
  cycle_index: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER - 1),
  mapper_event_count: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER),
  i: flag,
  external_irq: flag,
  cartridge_irq: flag,
  apu_frame_irq: flag,
  apu_dmc_irq: flag,
  requested_irq: flag,
});
export type NesCpuInterruptSample = z.infer<typeof nesCpuInterruptSampleSchema>;
export const nesCpuInterruptPollSchema = z.strictObject({
  after_instruction_index: z.number().int().nonnegative(),
  samples: z.array(nesCpuInterruptSampleSchema).max(2),
  pending_irq: flag,
  pending_nmi: flag,
});
export type NesCpuInterruptPoll = z.infer<typeof nesCpuInterruptPollSchema>;
