import { enterNes6502Interrupt } from "./nes6502InterruptEntry.js";
import { admitNesOamCpuDma, NES_OAM_DMA_CYCLES } from "./nesOamCpuDma.js";
import {
  nesDmcTimingPhase,
  NES_DMC_INLINE_TRANSFERS,
  NES_DMC_OAM_TRANSFERS,
  NES_DMC_STALL_CYCLES,
} from "./nesDmcTiming.js";
import { deriveNesOamCpuDma } from "./nesOamCpuDmaDerivation.js";
import { hasNamco163ChipRam } from "./nesNamco163.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import type { NesMapperEvent } from "./nesMapperEvents.js";
import { nesPrgRamLayout } from "./nesPrgRamLayout.js";
import { nesPpuAdmission } from "./nesPpuMemory.js";
import { admitNesPpuMmc5Background } from "./nesPpuMmc5BackgroundSelection.js";
import { admitNesControllers } from "./nesControllersDerivation.js";
import { bindNesCpuDma } from "./nesCpuDma.js";
import { admitNesApu } from "./nesApuDerivation.js";
import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import {
  deriveNesMapperTrace,
  deriveNesMapperTraceWithCancellation,
  isNesMapperWriteAddress,
} from "./nesMapperTraceDerivation.js";
import { decodeNes6502Opcode } from "./nes6502Opcodes.js";
import { applyNes6502Instruction } from "./nes6502Instruction.js";
import { Nes6502Context } from "./nes6502Context.js";
import { Nes6502InstructionFetch } from "./nes6502InstructionFetch.js";
import { admitNesMapperIrqEvents } from "./nesMapperIrqAdmission.js";
import { nesCpuMapperIrqEvent } from "./nesCpuMapperIrq.js";
import type {
  NesCodeTrace,
  NesCodePath,
  NesCpuBusCycle,
  TraceNesCodeInput,
} from "./nesCodeTrace.js";

type SourceBudget = { instruction: number; entry: number; fixed: number };
const sourceEventCapacity = (
  input: TraceNesCodeInput,
  next: number,
  budget: SourceBudget,
): boolean =>
  input.max_instructions <=
  Math.floor(
    (Number.MAX_SAFE_INTEGER -
      next -
      budget.fixed -
      (typeof input.entry === "object" ? budget.entry : 0)) /
      budget.instruction,
  );

/** Follow a conditional source-backed path; no guessed branch or active hardware state. */
export const deriveNesCode = async (
  header: NesRomMetadata,
  prg: Uint8Array,
  input: TraceNesCodeInput,
  {
    signal,
    chr,
  }: {
    signal?: AbortSignal | undefined;
    chr?: Uint8Array | null | undefined;
  } = {},
): Promise<NesCodeTrace> => {
  const backgroundAdmission = admitNesPpuMmc5Background(
    input.ppu_mmc5_background,
    {
      mapper: input.initial.mapper,
      nametable: input.ppu_nametable !== null,
      viewport: input.ppu_viewport !== null,
    },
  );
  if (backgroundAdmission !== null)
    return { status: "unsupported", reason: backgroundAdmission };
  if (
    input.initial_cpu_bus !== null &&
    input.initial_apu?.dmc != null &&
    input.initial_apu.dmc.cpu_timing === null
  )
    return {
      status: "unsupported",
      reason:
        "Source DMC DMA requires initial_apu.dmc.cpu_timing model 2a03-dmc-dma. Without request timing, use qualified apu-dmc-read grants/output clocks through trace_nes_mapper_events; nominal source CPU cycles cannot establish DMC stalls.",
    };
  const timing = input.initial_apu?.dmc?.cpu_timing;
  if (timing != null && input.initial_cpu_bus !== null) {
    const origins = [
      ...(timing.stop.status === "pending" ? [timing.stop.origin] : []),
      ...(timing.request.status === "pending" &&
      timing.request.type === "duplicate"
        ? [timing.request.origin]
        : []),
    ];
    if (
      origins.some(
        (origin) =>
          origin.kind === "dmc-read" &&
          origin.cycle_index >= input.initial_cpu_bus!.next_cycle_index,
      )
    )
      return {
        status: "unsupported",
        reason:
          "Retained DMC read origins must precede the initial CPU bus cycle index.",
      };
    if (
      timing.request.status === "pending" &&
      timing.request.type === "duplicate" &&
      (timing.request.origin.cycle_index !==
        input.initial_cpu_bus.next_cycle_index - 1 ||
        [
          input.initial_apu?.frame_clocks === "cpu-ordered"
            ? input.initial_apu.frame_sequencer.cpu_phase
            : null,
          input.initial_cpu_dma?.cpu_phase,
          nesDmcTimingPhase(input.initial_apu),
        ].includes("get"))
    )
      return {
        status: "unsupported",
        reason:
          "A retained duplicate DMC request must immediately follow its triggering get on the next put cycle.",
      };
  }
  if (input.initial_cpu_io !== null) {
    if (input.initial_cpu_bus === null)
      return {
        status: "unsupported",
        reason: "CPU I/O latches require initial_cpu_bus model nmos-6502-bus.",
      };
    if (
      input.initial_cpu_dma?.region === "pal" ||
      (input.initial_apu?.frame_clocks === "cpu-ordered" &&
        input.initial_apu.frame_sequencer.region === "pal")
    )
      return {
        status: "unsupported",
        reason:
          "The selected 2A03 I/O profile cannot establish PAL 2A07 DMA/controller decode behavior.",
      };
    const io = input.initial_cpu_io;
    const sources =
      "latch_origins" in io
        ? [...io.latch_origins.cpu, ...io.latch_origins.external]
        : [];
    if (
      sources.some(
        (origin) =>
          origin.source.kind === "cycle" &&
          origin.source.index >= input.initial_cpu_bus!.next_cycle_index,
      ) ||
      (io.held_controller?.cycle_index != null &&
        io.held_controller.cycle_index >=
          input.initial_cpu_bus.next_cycle_index)
    )
      return {
        status: "unsupported",
        reason:
          "Retained CPU I/O sources must precede the initial CPU bus cycle index.",
      };
  }
  const dmcTransfers =
    input.initial_apu?.dmc?.cpu_timing == null
      ? 0
      : input.initial_cpu_dma === null
        ? NES_DMC_INLINE_TRANSFERS
        : NES_DMC_OAM_TRANSFERS;
  const pauseCycles =
    (input.initial_cpu_dma === null ? 0 : NES_OAM_DMA_CYCLES) +
    dmcTransfers * NES_DMC_STALL_CYCLES;
  const busBudget: SourceBudget = {
    instruction: (input.initial_interrupts === null ? 8 : 15) + pauseCycles,
    entry: 7 + pauseCycles,
    fixed: 0,
  };
  const edgeFactor =
    1 +
    Number(input.initial_apu?.frame_clocks === "cpu-ordered") +
    Number(input.initial_irq !== null);
  const eventExtra =
    Number(input.initial_cpu_dma !== null) +
    Number(input.initial_apu?.dmc?.cpu_timing != null) +
    dmcTransfers * (1 + Number(input.initial_cpu_io !== null)) +
    (input.initial_cpu_dma !== null && input.initial_cpu_io !== null ? 24 : 0);
  const phaseMarker = Number(
    input.initial_apu?.frame_clocks === "cpu-ordered" &&
      input.initial_apu.frame_sequencer.cpu_phase === null &&
      (input.initial_cpu_dma?.cpu_phase ??
        nesDmcTimingPhase(input.initial_apu)) != null,
  );
  const eventBudget: SourceBudget =
    input.initial_cpu_bus === null
      ? { instruction: 8, entry: 3, fixed: 0 }
      : {
          instruction: busBudget.instruction * edgeFactor + eventExtra,
          entry: busBudget.entry * edgeFactor + eventExtra,
          fixed: phaseMarker,
        };
  if (input.initial_cpu_dma !== null) {
    if (input.initial_cpu_bus === null)
      return {
        status: "unsupported",
        reason: "Ordered OAM DMA requires initial_cpu_bus model nmos-6502-bus.",
      };
    const admitted = admitNesOamCpuDma(
      input.initial_cpu_dma,
      input.initial_ppu,
      input.initial_controllers,
      input.initial,
      input.initial_apu,
    );
    if (!admitted.ok)
      return { status: "unsupported", reason: admitted.error.reason };
  }
  if (input.initial_interrupts !== null) {
    if (input.initial_cpu_bus === null)
      return {
        status: "unsupported",
        reason:
          "Source interrupt polling requires initial_cpu_bus model nmos-6502-bus.",
      };
    if (
      input.initial_apu !== null &&
      input.initial_apu.frame_clocks !== "cpu-ordered"
    )
      return {
        status: "unsupported",
        reason:
          "Source interrupt polling requires CPU-ordered timing for a selected APU model.",
      };
    if (
      typeof input.entry === "object" &&
      (input.initial_interrupts.pending_irq !== false ||
        input.initial_interrupts.pending_nmi !== false)
    )
      return {
        status: "unsupported",
        reason:
          "An explicitly accepted entry requires cleared initial interrupt boundary requests.",
      };
  }
  if (input.initial_irq !== null) {
    const failure = admitNesMapperIrqEvents(
      header,
      input.initial,
      [],
      input.initial_irq,
    );
    if (failure !== null) return { status: "unsupported", reason: failure };
    if (input.initial_cpu_bus === null)
      return {
        status: "unsupported",
        reason:
          "Source cartridge IRQ clocks require initial_cpu_bus model nmos-6502-bus.",
      };
    if (nesCpuMapperIrqEvent(input.initial_irq) === null)
      return {
        status: "unsupported",
        reason:
          "Source MMC3/MMC5 IRQ timing requires qualified PPU signals unavailable from the CPU-only source bus; use trace_nes_mapper_events.",
      };
    if (!sourceEventCapacity(input, 0, eventBudget))
      return {
        status: "unsupported",
        reason:
          "Source mapper event indices cannot accommodate the instruction and accepted-entry event budgets.",
      };
  }
  if (
    input.initial_cpu_bus !== null &&
    !sourceEventCapacity(
      input,
      input.initial_cpu_bus.next_cycle_index,
      busBudget,
    )
  )
    return {
      status: "unsupported",
      reason:
        "Initial CPU bus cycle index cannot accommodate the instruction and interrupt-entry cycle budgets.",
    };
  if (input.initial_apu !== null) {
    if (
      input.initial_apu.frame_clocks === "cpu-ordered" &&
      input.initial_cpu_bus === null
    )
      return {
        status: "unsupported",
        reason:
          "Source-code CPU-edge timing requires initial_cpu_bus model nmos-6502-bus for cpu-ordered APU framing.",
      };
    const admission = admitNesApu(input.initial_apu);
    if (!admission.ok)
      return { status: "unsupported", reason: admission.error.reason };
    if (
      !sourceEventCapacity(
        input,
        input.initial_apu.next_event_index,
        eventBudget,
      )
    )
      return {
        status: "unsupported",
        reason:
          "Initial APU event index cannot accommodate the instruction budget and accepted-entry bus actions and edges.",
      };
  }
  if (
    (input.ppu_sprites || input.ppu_viewport !== null) &&
    input.initial_ppu?.oam == null
  )
    return {
      status: "unsupported",
      reason:
        "Final sprite/viewport decoding requires initial_ppu.oam model oam-memory.",
    };
  if (
    (input.ppu_pattern_table !== null ||
      input.ppu_nametable !== null ||
      input.ppu_sprites ||
      input.ppu_viewport !== null) &&
    input.initial_ppu === null
  )
    return {
      status: "unsupported",
      reason:
        "Final PPU graphics selections require initial_ppu model ppu-memory.",
    };
  const admission = deriveNesMapperTrace(
    header,
    input.initial,
    [],
    undefined,
    input.initial_ppu?.next_event_index,
  );
  if (input.initial_ppu !== null) {
    const reason = nesPpuAdmission(
      header,
      input.initial,
      input.initial_ppu,
      chr,
    );
    if (reason !== null) return { status: "unsupported", reason };
    const ppuEventBound =
      input.initial_cpu_bus !== null ||
      input.initial_controllers !== null ||
      input.initial_apu !== null
        ? eventBudget
        : {
            instruction: input.initial_ppu.oam === null ? 4 : 5,
            entry: 3,
            fixed: 0,
          };
    if (
      !sourceEventCapacity(
        input,
        input.initial_ppu.next_event_index,
        ppuEventBound,
      )
    )
      return {
        status: "unsupported",
        reason: `Initial PPU event index cannot accommodate the instruction budget and accepted-entry bus actions (up to ${ppuEventBound.instruction} events per instruction).`,
      };
  }
  if (admission.status === "unsupported") return admission;
  if (input.initial_controllers !== null) {
    const admittedControllers = admitNesControllers(input.initial_controllers);
    if (!admittedControllers.ok)
      return {
        status: "unsupported",
        reason: admittedControllers.error.reason,
      };
    const bound = bindNesCpuDma(
      structuredClone(input.initial_controllers),
      input.initial_ppu === null ? null : structuredClone(input.initial_ppu),
      structuredClone(admission.final),
    );
    if (!bound.ok) return { status: "unsupported", reason: bound.error.reason };
    if (
      !sourceEventCapacity(
        input,
        input.initial_controllers.next_event_index,
        eventBudget,
      )
    )
      return {
        status: "unsupported",
        reason:
          "Initial controller event index cannot accommodate the instruction budget and accepted-entry bus actions and edges.",
      };
  }
  if (input.initial_prg_ram.length > 0) {
    const layout = nesPrgRamLayout(header, input.initial);
    if (layout === null)
      return {
        status: "unsupported",
        reason:
          "Initial PRG RAM requires an established physical RAM layout for this board",
      };
    const invalid = input.initial_prg_ram.findIndex(
      (item) =>
        item.bank >= layout.bank_count ||
        item.address < layout.start ||
        item.address >= layout.start + layout.bank_size,
    );
    if (invalid !== -1)
      return {
        status: "unsupported",
        reason: `initial_prg_ram[${invalid}] is outside the board's canonical physical RAM bank/address range`,
      };
  }
  const recordsDeviceEvents =
    input.initial_cpu_io !== null ||
    input.initial_cpu_dma !== null ||
    input.initial_interrupts !== null ||
    hasNamco163ChipRam(input.initial) ||
    input.initial_irq !== null ||
    input.initial_ppu !== null ||
    input.initial_controllers !== null ||
    input.initial_apu !== null;
  const context = new Nes6502Context(
    header,
    prg,
    structuredClone(admission.final),
    {
      cpu: structuredClone(input.cpu),
      initialRam: input.initial_ram,
      initialPrgRam: input.initial_prg_ram,
      initialPpu: input.initial_ppu,
      initialControllers: input.initial_controllers,
      initialApu: input.initial_apu,
      initialCpuBus: input.initial_cpu_bus,
      initialIrq: input.initial_irq,
      initialInterrupts: input.initial_interrupts,
      initialCpuDma: input.initial_cpu_dma,
      initialCpuIo: input.initial_cpu_io,
      maxOamSourceBytes: input.max_oam_dma_source_bytes,
      maxDmcSourceBytes: input.max_dmc_dma_source_bytes,
      chr: chr ?? undefined,
    },
  );
  const interrupt = typeof input.entry === "object" ? input.entry : null;
  const selectedVector =
    typeof input.entry === "number"
      ? null
      : context.readVector(
          typeof input.entry === "string"
            ? input.entry
            : input.entry.accepted_interrupt,
        );
  const vector = selectedVector?.reads ?? null;
  const entry =
    typeof input.entry === "number" ? input.entry : selectedVector!.target;
  let pc = entry;
  let choicesUsed = 0;
  const instructions: NesCodePath["instructions"] = [];
  const mapperEvents: NesMapperEvent[] = [...context.mapperEvents];
  context.mapperEvents = [];
  let stop: NesCodePath["stop"] = {
    reason: "unresolved-vector",
    address: null,
    bytes_hex: "",
    file_offsets: [],
    ram_origins: [],
    mapper_origins: [],
    interrupt_vector: null,
    data_reads: [],
    successors: [],
  };
  let entryInterrupt: NesCodePath["entry_interrupt"] = null;
  let committedCpu = structuredClone(context.cpu);
  let committedBus =
    context.bus === null ? null : structuredClone(context.bus.state);
  let busFrontier = false;
  type InterruptTrace = Extract<
    NesCodePath,
    { interrupts: unknown }
  >["interrupts"];
  const automaticEntries: InterruptTrace["entries"] = [];
  let interruptFrontier: InterruptTrace["frontier"] = null;
  type DmaTrace = Extract<NesCodePath, { cpu_dma: unknown }>["cpu_dma"];
  const dmaTransfers: DmaTrace["transfers"] = [];
  let dmaFrontier: DmaTrace["frontier"] = null;
  let committedDma =
    context.cpuDma === null ? null : structuredClone(context.cpuDma.state);
  let committedIo =
    context.io === null ? null : structuredClone(context.io.state);
  let committedDmcCount = 0;
  const dmcBoundaryCycles: NesCpuBusCycle[] = [];
  const transferDma = async (address: number): Promise<boolean> => {
    context.instructionIndex = null;
    context.dmc?.beginInstruction(instructions.length);
    const derived = await deriveNesOamCpuDma(
      context,
      address,
      instructions.length,
      { index: dmaTransfers.length, eventStart: mapperEvents.length, signal },
    );
    if (derived.status === "stopped") {
      dmaFrontier = derived.frontier;
      stop.reason = context.bus!.stopped!.reason;
      stop.address = address;
      return false;
    }
    if (derived.status === "complete") {
      dmaTransfers.push(derived.transfer);
      mapperEvents.push(...context.mapperEvents);
      committedDma = structuredClone(context.cpuDma!.state);
      committedIo =
        context.io === null ? null : structuredClone(context.io.state);
      committedBus = structuredClone(context.bus!.state);
      context.bus!.begin();
      context.writes = [];
      context.mapperEvents = [];
      context.ppuOperations = [];
      context.controllerOperations = [];
      context.apuOperations = [];
      committedDmcCount = context.dmc?.transfers.length ?? 0;
    }
    context.dmc?.beforeCpuRead(address);
    if (context.bus?.stopped != null) {
      stop.reason = context.bus.stopped.reason;
      stop.address = address;
      busFrontier = true;
      return false;
    }
    if (context.dmc !== null && context.bus!.cycles.length > 0) {
      dmcBoundaryCycles.push(...context.bus!.cycles);
      mapperEvents.push(...context.mapperEvents);
      committedBus = structuredClone(context.bus!.state);
      committedIo =
        context.io === null ? null : structuredClone(context.io.state);
      committedDma =
        context.cpuDma === null ? null : structuredClone(context.cpuDma.state);
      committedDmcCount = context.dmc.transfers.length;
      context.bus!.begin();
      context.mapperEvents = [];
      context.writes = [];
      context.ppuOperations = [];
      context.controllerOperations = [];
      context.apuOperations = [];
    }
    return true;
  };
  if (
    interrupt !== null &&
    entry !== null &&
    !(await transferDma(interrupt.return_address))
  )
    pc = null;
  if (interrupt !== null && entry !== null && pc !== null) {
    if (context.cpu.sp === null) {
      stop.reason = "unknown-stack";
      stop.address = entry;
      pc = null;
    } else {
      enterNes6502Interrupt(
        context,
        interrupt.accepted_interrupt,
        interrupt.return_address,
      );
      if (context.bus?.stopped != null) {
        stop.reason = context.bus.stopped.reason;
        stop.address = entry;
        busFrontier = true;
        pc = null;
      } else {
        entryInterrupt = {
          kind: interrupt.accepted_interrupt,
          return_address: interrupt.return_address,
          writes: context.writes,
          cpu_after: { ...context.cpu },
          ...(context.bus === null
            ? {}
            : { cpu_bus_cycles: context.bus.cycles }),
          ...(recordsDeviceEvents
            ? {
                mapper_event_range: {
                  start: mapperEvents.length,
                  count: context.mapperEvents.length,
                },
              }
            : {}),
        };
        mapperEvents.push(...context.mapperEvents);
        committedCpu = structuredClone(context.cpu);
        committedDmcCount = context.dmc?.transfers.length ?? 0;
        committedBus =
          context.bus === null ? null : structuredClone(context.bus.state);
        committedDma =
          context.cpuDma === null
            ? null
            : structuredClone(context.cpuDma.state);
        committedIo =
          context.io === null ? null : structuredClone(context.io.state);
      }
    }
  }
  while (pc !== null) {
    context.ppuOperations = [];
    context.controllerOperations = [];
    context.apuOperations = [];
    context.oamDmaReads = [];
    context.oamDmaFrontier = null;
    context.bus?.begin();
    context.interrupts?.begin();
    busFrontier = false;
    signal?.throwIfAborted();
    if (instructions.length > 0 && instructions.length % 128 === 0) {
      await scheduler.yield();
      signal?.throwIfAborted();
    }
    stop = {
      reason: "instruction-budget",
      address: pc,
      bytes_hex: "",
      file_offsets: [],
      ram_origins: [],
      mapper_origins: [],
      interrupt_vector: null,
      data_reads: [],
      successors: [],
    };
    if (instructions.length >= input.max_instructions) break;
    context.writes = [];
    context.dataReads = [];
    context.mapperEvents = [];
    context.interruptIndex = null;
    if (!(await transferDma(pc))) break;
    const decision = context.interrupts?.decision() ?? null;
    if (decision === "unknown") {
      stop.reason = "interrupt-uncertain";
      break;
    }
    if (decision !== null) {
      interruptFrontier = {
        kind: decision,
        return_address: pc,
        before_instruction_index: instructions.length,
      };
      if (context.cpu.sp === null) {
        stop.reason = "unknown-stack";
        break;
      }
      context.instructionIndex = null;
      context.interruptIndex = automaticEntries.length;
      busFrontier = true;
      const accepted = enterNes6502Interrupt(context, decision, pc);
      stop.interrupt_vector = accepted.reads;
      if (context.bus?.stopped != null || accepted.target === null) {
        stop.reason = context.bus?.stopped?.reason ?? "unresolved-vector";
        break;
      }
      automaticEntries.push({
        index: automaticEntries.length,
        before_instruction_index: instructions.length,
        kind: decision,
        return_address: pc,
        target_address: accepted.target,
        interrupt_vector: accepted.reads,
        cpu_after: { ...context.cpu },
        writes: context.writes,
        cpu_bus_cycles: context.bus!.cycles,
        mapper_event_range: {
          start: mapperEvents.length,
          count: context.mapperEvents.length,
        },
      });
      mapperEvents.push(...context.mapperEvents);
      context.interrupts!.accepted();
      committedCpu = structuredClone(context.cpu);
      committedDmcCount = context.dmc?.transfers.length ?? 0;
      committedBus = structuredClone(context.bus!.state);
      committedDma =
        context.cpuDma === null ? null : structuredClone(context.cpuDma.state);
      committedIo =
        context.io === null ? null : structuredClone(context.io.state);
      interruptFrontier = null;
      busFrontier = false;
      pc = accepted.target;
      continue;
    }
    context.instructionIndex = instructions.length;
    busFrontier = context.bus !== null;
    const view = context.mapping.prg_view;
    const fetch = new Nes6502InstructionFetch(context, pc);
    const first = fetch.read(0);
    if (first === null) {
      stop.reason = context.bus?.stopped?.reason ?? "unmapped-instruction";
      break;
    }
    const decoded = decodeNes6502Opcode(first);
    if (decoded !== undefined) {
      for (let byte = 1; byte < decoded.length; byte++) {
        if (decoded.mnemonic === "JSR" && byte === 2) break;
        if (fetch.read(byte) === null) break;
      }
    }
    Object.assign(stop, fetch.fields());
    if (decoded === undefined) {
      stop.reason = "unsupported-opcode";
      break;
    }
    if (
      fetch.bytes.length !== (decoded.mnemonic === "JSR" ? 2 : decoded.length)
    ) {
      stop.reason = context.bus?.stopped?.reason ?? "unmapped-instruction";
      break;
    }
    if (
      context.ppu?.oam != null &&
      context.ppu.oam.dma_pending.status !== "none"
    ) {
      await scheduler.yield();
      signal?.throwIfAborted();
    }
    if (
      context.bus === null &&
      ((hasNamco163ChipRam(context.mapper) &&
        context.mapper.chip_ram.oam_dma_pending !== "none") ||
        (context.ppu?.oam != null &&
          context.ppu.oam.dma_pending.status !== "none") ||
        (context.controllers !== null &&
          context.controllers.oam_dma_pending.status !== "none"))
    )
      context.readMapperDummy(pc);
    if (context.oamDmaFrontier !== null) {
      stop = {
        ...stop,
        reason: "oam-dma-source-budget",
        oam_dma_frontier: context.oamDmaFrontier,
      };
      break;
    }
    if (context.oamDmaReads.length !== 0)
      stop = { ...stop, oam_dma_reads: context.oamDmaReads };
    const options = {
      pc,
      ...(decoded.mnemonic === "JSR"
        ? { fetchJsrHigh: () => fetch.read(2) }
        : {}),
    };
    let applied = applyNes6502Instruction(
      context,
      decoded,
      fetch.bytes,
      options,
    );
    let assumption: NesCodePath["instructions"][number]["branch_assumption"] =
      null;
    if ("reason" in applied && applied.reason === "unknown-branch") {
      const choice = input.branch_choices[choicesUsed];
      if (choice !== undefined) {
        if (choice.address !== pc) {
          stop.reason = "branch-choice-mismatch";
          stop.successors = applied.successors ?? [];
          break;
        }
        applied = applyNes6502Instruction(context, decoded, fetch.bytes, {
          ...options,
          branchTaken: choice.taken,
        });
        assumption = { choice_index: choicesUsed++, taken: choice.taken };
      }
    }
    Object.assign(stop, fetch.fields());
    stop.data_reads = context.dataReads;
    if (context.bus?.stopped != null) {
      stop.reason = context.bus.stopped.reason;
      break;
    }
    if ("reason" in applied) {
      stop.interrupt_vector = applied.interruptVector ?? null;
      stop.reason = applied.reason;
      stop.successors = applied.successors ?? [];
      break;
    }
    context.interrupts?.poll(
      instructions.length,
      decoded.mnemonic,
      decoded.mode === "rel",
    );
    const eventRange = recordsDeviceEvents
      ? {
          mapper_event_range: {
            start: mapperEvents.length,
            count: context.mapperEvents.length,
          },
        }
      : {};
    mapperEvents.push(...context.mapperEvents);
    instructions.push({
      index: instructions.length,
      ...(context.bus === null ? {} : { cpu_bus_cycles: context.bus.cycles }),
      ...(context.oamDmaReads.length === 0
        ? {}
        : { oam_dma_reads: context.oamDmaReads }),
      ...eventRange,
      address: pc,
      ...fetch.fields(),
      interrupt_vector: applied.interruptVector ?? null,
      data_reads: context.dataReads,
      mnemonic: decoded.mnemonic,
      encoding: decoded.encoding,
      addressing_mode: decoded.mode,
      prg_view: view,
      branch_assumption: assumption,
      cpu_after: { ...context.cpu },
      next_address: applied.next,
      writes: context.writes,
    });
    committedCpu = structuredClone(context.cpu);
    committedDmcCount = context.dmc?.transfers.length ?? 0;
    committedBus =
      context.bus === null ? null : structuredClone(context.bus.state);
    committedDma =
      context.cpuDma === null ? null : structuredClone(context.cpuDma.state);
    committedIo =
      context.io === null ? null : structuredClone(context.io.state);
    busFrontier = false;
    pc = applied.next;
  }
  if (busFrontier && context.bus !== null)
    stop = {
      ...stop,
      cpu_bus_frontier: {
        cycles: context.bus.cycles,
        writes: context.writes,
        mapper_events: context.mapperEvents,
        blocked_address: context.bus.stopped?.address ?? null,
      },
    };
  signal?.throwIfAborted();
  const mapperWrites = instructions.flatMap((instruction) =>
    instruction.writes.filter((write) =>
      isNesMapperWriteAddress(header, write.address),
    ),
  );
  const mapperTrace: NesCodePath["mapper_trace"] = recordsDeviceEvents
    ? await deriveNesMapperEvents(header, input.initial, mapperEvents, {
        signal,
        prg,
        chr,
        initialPpu: input.initial_ppu,
        initialControllers: input.initial_controllers,
        initialApu: input.initial_apu,
        initialIrq: input.initial_irq,
        apuFrontier: context.apuOperations,
        controllerFrontier: context.controllerOperations,
        ppuPatternTable: input.ppu_pattern_table,
        ppuNametable: input.ppu_nametable,
        ppuSprites: input.ppu_sprites,
        ppuViewport: input.ppu_viewport,
        ppuMmc5Background: input.ppu_mmc5_background,
        ppuFrontier: context.ppuOperations,
      })
    : await deriveNesMapperTraceWithCancellation(
        header,
        input.initial,
        mapperWrites,
        prg,
        { signal },
      );
  signal?.throwIfAborted();
  return {
    status: "derived",
    resolved_entry: entry,
    cpu_bus:
      context.bus === null || committedBus === null
        ? null
        : {
            initial: context.bus.initial,
            initialized: context.bus.initialized,
            final: committedBus,
            ...(context.dmc === null
              ? {}
              : {
                  dmc: {
                    transfers: context.dmc.transfers.slice(
                      0,
                      committedDmcCount,
                    ),
                    boundary_cycles: dmcBoundaryCycles,
                    retained_source_bytes: context.retainedDmcSourceBytes,
                    frontier:
                      busFrontier || dmaFrontier !== null
                        ? {
                            transfers:
                              context.dmc.transfers.slice(committedDmcCount),
                            active: context.dmc.active,
                          }
                        : null,
                  },
                }),
            ...(context.io === null || committedIo === null
              ? {}
              : {
                  io: {
                    initial: context.io.initial,
                    initialized: context.io.initialized,
                    final: committedIo,
                    frontier:
                      busFrontier || dmaFrontier !== null
                        ? context.io.state
                        : null,
                  },
                }),
          },
    entry_vector: vector,
    entry_interrupt: entryInterrupt,
    instructions,
    branch_choices_used: choicesUsed,
    stop,
    final_cpu: committedCpu,
    mapper_trace: mapperTrace,
    ...(context.cpuDma === null || committedDma === null
      ? {}
      : {
          cpu_dma: {
            initial: context.cpuDma.initial,
            initialized: context.cpuDma.initialized,
            final: committedDma,
            transfers: dmaTransfers,
            frontier: dmaFrontier,
            retained_source_bytes: context.retainedOamSourceBytes,
          },
        }),
    ...(context.interrupts === null
      ? {}
      : {
          interrupts: {
            initial: context.interrupts.initial,
            final: context.interrupts.state,
            polls: context.interrupts.polls,
            entries: automaticEntries,
            frontier: interruptFrontier,
          },
        }),
  };
};
