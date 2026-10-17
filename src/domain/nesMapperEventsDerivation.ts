import { admitNesMapperIrqEvents } from "./nesMapperIrqAdmission.js";
import { readNesDmcMemory } from "./nesDmcMemory.js";
import { nesDmcReadReady } from "./nesDmcTiming.js";
import { readNesHeldController } from "./nesCpuIo.js";
import {
  clockNesCpuMapperIrq,
  writeNesCpuMapperIrq,
  nesCpuMapperIrqEvent,
} from "./nesCpuMapperIrq.js";
import {
  invalidateNamco163Phase,
  readNamco163ChipRam,
} from "./nesNamco163Ram.js";
import { hasNamco163ChipRam, isNamco163State } from "./nesNamco163.js";
import { isNamco163IrqState, readNamco163Irq } from "./nesNamco163Irq.js";
import { isMmc5State, applyMmc5Reset } from "./nesMmc5.js";
import { readMmc5Cpu } from "./nesMmc5Cpu.js";
import {
  isMmc5IrqState,
  initializeMmc5Irq,
  advanceMmc5Irq,
} from "./nesMmc5Irq.js";
import { readMmc5Ppu, writeMmc5Ppu } from "./nesMmc5Ppu.js";
import {
  advanceMmc5Rendering,
  readMmc5BackgroundPpu,
} from "./nesMmc5Rendering.js";
import { isBandaiState } from "./nesBandai.js";
import {
  readBandaiEeprom,
  completeBandaiEepromWrite,
} from "./nesBandaiEeprom.js";
import { isVrc6State } from "./nesVrc6.js";
import { applyMmc3A12 } from "./nesMmc3A12.js";
import { clockMmc3Irq, writeMmc3Irq, isMmc3IrqState } from "./nesMmc3Irq.js";
import { scheduler } from "node:timers/promises";
import type { NesRomMetadata } from "./nes.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import type {
  NesMapperEvent,
  NesMapperIrqState,
  NesMapperEventsTrace,
  NesLegacyMapperEventsTrace,
  NesMapperCpuRead,
  NesMapperEventStep,
  NesPpuMapperEventStep,
  NesStoredMapperEventSnapshot,
  NesCpuIrqMapperEventStep,
} from "./nesMapperEvents.js";
import {
  deriveNesMapperTrace,
  applyMappedNesMapperWrite,
} from "./nesMapperTraceDerivation.js";
import { latchAfterPpuRead } from "./nesLatchMapper.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import { normalizeNesPrgViews, type NesPrgView } from "./nesPrgViews.js";
import { nesPpuAdmission } from "./nesPpuMemory.js";
import {
  initializeNesPpu,
  readNesPpuCpu,
  writeNesPpuCpu,
  accessNesPpuBus,
  applyNesOamDma,
  startNesOamDma,
} from "./nesPpuRegisters.js";
import type { NesPpuState, NesPpuOperation } from "./nesPpuState.js";
import { nesPpuBusSourceResolved } from "./nesPpuState.js";
import { deriveNesPpuPatternTable } from "./nesPpuPatternDerivation.js";
import { deriveNesPpuNametable } from "./nesPpuNametableDerivation.js";
import type { NesPpuNametablePage } from "./nesPpuNametable.js";
import { nesOamEventsAdmission } from "./nesOam.js";
import { deriveNesPpuSprites } from "./nesPpuSpritesDerivation.js";
import { deriveNesPpuViewport } from "./nesPpuViewportDerivation.js";
import type { NesPpuViewportSelection } from "./nesPpuViewport.js";
import {
  admitNesPpuMmc5Background,
  type NesPpuMmc5BackgroundSelection,
} from "./nesPpuMmc5BackgroundSelection.js";
import type {
  NesControllersState,
  NesControllerOperation,
} from "./nesControllers.js";
import {
  initializeNesControllers,
  admitNesControllerEvents,
  advanceNesControllers,
  admitNesControllers,
} from "./nesControllersDerivation.js";
import { bindNesCpuDma } from "./nesCpuDma.js";
import type { NesApuState, NesApuOperation } from "./nesApu.js";
import {
  admitNesApu,
  initializeNesApu,
  advanceNesApu,
} from "./nesApuDerivation.js";

type MapperEventContext = {
  signal?: AbortSignal | undefined;
  prg?: Uint8Array | undefined;
  chr?: Uint8Array | null | undefined;
  initialIrq?: NesMapperIrqState | null;
  initialPpu?: NesPpuState | null;
  initialControllers?: NesControllersState | null;
  initialApu?: NesApuState | null;
  apuFrontier?: readonly NesApuOperation[];
  controllerFrontier?: readonly NesControllerOperation[];
  ppuPatternTable?: 0 | 1 | null;
  ppuNametable?: NesPpuNametablePage | null;
  ppuSprites?: boolean;
  ppuViewport?: NesPpuViewportSelection | null;
  ppuMmc5Background?: NesPpuMmc5BackgroundSelection | null;
  ppuFrontier?: readonly NesPpuOperation[];
};
export function deriveNesMapperEvents(
  header: NesRomMetadata,
  initial: NesMapperState,
  events: readonly NesMapperEvent[],
  context?: MapperEventContext & {
    initialPpu?: null;
    initialControllers?: null;
    initialApu?: null;
  },
): Promise<NesLegacyMapperEventsTrace>;
export function deriveNesMapperEvents(
  header: NesRomMetadata,
  initial: NesMapperState,
  events: readonly NesMapperEvent[],
  context?: MapperEventContext,
): Promise<NesMapperEventsTrace>;

/** Read provenance precedes latch updates; event order is a supplied assumption. */
export async function deriveNesMapperEvents(
  header: NesRomMetadata,
  initial: NesMapperState,
  events: readonly NesMapperEvent[],
  {
    signal,
    prg,
    chr,
    initialIrq = null,
    initialPpu = null,
    initialControllers = null,
    initialApu = null,
    apuFrontier = [],
    controllerFrontier = [],
    ppuPatternTable = null,
    ppuNametable = null,
    ppuSprites = false,
    ppuViewport = null,
    ppuMmc5Background = null,
    ppuFrontier = [],
  }: MapperEventContext = {},
): Promise<NesMapperEventsTrace> {
  signal?.throwIfAborted();
  const backgroundAdmission = admitNesPpuMmc5Background(ppuMmc5Background, {
    mapper: initial.mapper,
    nametable: ppuNametable !== null,
    viewport: ppuViewport !== null,
  });
  if (backgroundAdmission !== null)
    return { status: "unsupported", reason: backgroundAdmission };
  if (
    (ppuPatternTable !== null ||
      ppuNametable !== null ||
      ppuSprites ||
      ppuViewport !== null) &&
    initialPpu === null
  )
    return {
      status: "unsupported",
      reason:
        "Final PPU graphics selections require initial_ppu model ppu-memory.",
    };
  if ((ppuSprites || ppuViewport !== null) && initialPpu?.oam == null)
    return {
      status: "unsupported",
      reason:
        "Final sprite/viewport decoding requires initial_ppu.oam model oam-memory.",
    };
  const admitted = deriveNesMapperTrace(
    header,
    initial,
    [],
    undefined,
    initialPpu?.next_event_index,
  );
  if (admitted.status === "unsupported") return admitted;
  if (initialApu !== null) {
    const admission = admitNesApu(initialApu);
    if (!admission.ok)
      return { status: "unsupported", reason: admission.error.reason };
    if (events.length > Number.MAX_SAFE_INTEGER - initialApu.next_event_index)
      return {
        status: "unsupported",
        reason:
          "Supplied events exceed the remaining safe APU event identity range.",
      };
  } else if (
    events.some(
      (event) =>
        event.kind === "apu-frame-clock" ||
        event.kind === "apu-frame-reset" ||
        event.kind === "apu-cpu-cycle" ||
        event.kind === "apu-cpu-phase" ||
        event.kind === "apu-dmc-read" ||
        event.kind === "apu-dmc-cpu-read" ||
        event.kind === "apu-dmc-clock" ||
        event.kind === "apu-dmc-stop",
    )
  )
    return {
      status: "unsupported",
      reason:
        "APU clocks and DMC grants require initial_apu model apu-registers.",
    };
  const apu = initialApu === null ? null : initializeNesApu(initialApu),
    initializedApu = apu === null ? null : structuredClone(apu),
    dmcReadsModeled = apu?.dmc?.cpu_timing != null,
    apuOperations: NesApuOperation[] = [];
  if (initialPpu !== null) {
    const reason = nesPpuAdmission(header, initial, initialPpu, chr);
    if (reason !== null) return { status: "unsupported", reason };
    if (events.length > Number.MAX_SAFE_INTEGER - initialPpu.next_event_index)
      return {
        status: "unsupported",
        reason:
          "Supplied events exceed the remaining safe PPU event identity range.",
      };
  }
  let state = structuredClone(admitted.final);
  const ppu = initialPpu === null ? null : initializeNesPpu(initialPpu);
  if (initialControllers !== null) {
    const admittedControllers = admitNesControllers(initialControllers);
    if (!admittedControllers.ok)
      return {
        status: "unsupported",
        reason: admittedControllers.error.reason,
      };
  }
  const controllers =
    initialControllers === null
      ? null
      : initializeNesControllers(initialControllers);
  if (controllers !== null) {
    const bound = bindNesCpuDma(controllers, ppu, state);
    if (!bound.ok) return { status: "unsupported", reason: bound.error.reason };
  }
  const controllerAdmission = admitNesControllerEvents(controllers, events);
  if (!controllerAdmission.ok)
    return { status: "unsupported", reason: controllerAdmission.error.reason };
  const initializedControllers =
    controllers === null ? null : structuredClone(controllers);
  const controllerOperations: NesControllerOperation[] = [];
  const oamReason = nesOamEventsAdmission(ppu, events);
  if (oamReason !== null) return { status: "unsupported", reason: oamReason };
  if (
    initial.mapper !== 5 &&
    events.some(
      (event) =>
        (event.kind === "ppu-write" && initialPpu === null) ||
        (event.kind === "ppu-read" && "mmc5_fetch" in event),
    )
  )
    return {
      status: "unsupported",
      reason:
        "PPU writes require initial_ppu model ppu-memory or Mapper 5; mmc5_fetch qualifications require Mapper 5.",
    };
  const irqFailure = admitNesMapperIrqEvents(
    header,
    initial,
    events,
    initialIrq,
  );
  if (irqFailure !== null) return { status: "unsupported", reason: irqFailure };
  if (
    events.some(
      (event) =>
        event.kind === "mmc5-render-frame" ||
        event.kind === "mmc5-render-line" ||
        "mmc5_tile" in event,
    ) &&
    !(isMmc5State(initial) && "ppu" in initial)
  )
    return {
      status: "unsupported",
      reason:
        "MMC5 rendering events/tile positions require initial.ppu model mmc5-background.",
    };
  let irq = initialIrq === null ? null : structuredClone(initialIrq);
  if (isMmc5IrqState(irq)) {
    const initialized = initializeMmc5Irq(irq);
    if (!initialized.ok)
      return { status: "unsupported", reason: initialized.error };
    irq = initialized.value;
  }
  type Trace = Extract<NesMapperEventsTrace, { status: "derived" }>;
  const steps: NesMapperEventStep[] = [];
  const ppuSteps: NesPpuMapperEventStep[] = [];
  const cpuIrqSteps: NesCpuIrqMapperEventStep[] = [];
  const snapshots: NesStoredMapperEventSnapshot[] = [];
  const irqPerEvent =
    initialIrq !== null && nesCpuMapperIrqEvent(initialIrq) !== null;
  const snapshotIndices = new Map<string, number>();
  const views = new Map<string, NesPrgView>();
  const retain = (mapping: ReturnType<typeof mapperMapping>) => {
    if (mapping.prg_view !== null)
      views.set(JSON.stringify(mapping.prg_view), mapping.prg_view);
  };
  const ppuOperations: NesPpuOperation[] = [];
  const ppuCoverage = {
    bus_reads: 0,
    unknown_bus_sources: 0,
    unknown_bus_values: 0,
  };
  const retainPpuOperation = (operation: NesPpuOperation) => {
    ppuOperations.push(operation);
    for (const read of operation.bus_reads) {
      ppuCoverage.bus_reads++;
      if (!nesPpuBusSourceResolved(read)) ppuCoverage.unknown_bus_sources++;
      if (read.value === null && !("known_bits" in read))
        ppuCoverage.unknown_bus_values++;
    }
  };
  let mapping = mapperMapping(header, state, {
    chrRamSize: ppu?.chr_ram_size ?? null,
  });
  const initialMapping = mapping;
  retain(mapping);
  const retainSnapshot = () => {
    const snapshot = irqPerEvent ? { state, mapping } : { state, mapping, irq },
      key = JSON.stringify(snapshot);
    const existing = snapshotIndices.get(key);
    if (existing !== undefined) return existing;
    const index = snapshots.length;
    snapshots.push(structuredClone(snapshot));
    snapshotIndices.set(key, index);
    return index;
  };
  if (ppu !== null || controllers !== null || apu !== null || irqPerEvent)
    retainSnapshot();
  let unknownReads = 0;
  let unknownNametableReads = 0;
  let unknownCpuReads = 0;
  for (const [index, event] of events.entries()) {
    if (index % 128 === 0) await scheduler.yield();
    signal?.throwIfAborted();
    let readSource: Trace["steps"][number]["read_source"] = null;
    let writeEffect: Trace["steps"][number]["write_effect"] = null;
    let irqClock: boolean | null = false;
    const dmcRead =
      event.kind === "apu-dmc-cpu-read" && apu !== null
        ? {
            address: event.address,
            value: event.value,
            source: {
              kind: "cpu-dma" as const,
              index: apu.next_event_index,
              cycle_index: event.cycle_index,
            },
          }
        : event.kind === "apu-dmc-read" && apu?.dmc != null
          ? readNesDmcMemory(header, mapping, prg ?? null, {
              address: apu.dmc.current_address,
              index: apu.next_event_index,
            })
          : undefined;
    const apuAdvance = apu === null ? null : advanceNesApu(apu, event, dmcRead);
    if (apuAdvance !== null && !apuAdvance.ok)
      return { status: "unsupported", reason: apuAdvance.error.reason };
    const apuStep = apuAdvance?.ok === true ? apuAdvance.value : null;
    if (apuStep !== null) apuOperations.push(apuStep.operation);
    const controllerAdvance =
      controllers === null
        ? null
        : advanceNesControllers(controllers, event, { dmcReadsModeled });
    if (controllerAdvance !== null && !controllerAdvance.ok)
      return { status: "unsupported", reason: controllerAdvance.error.reason };
    const controllerStep =
      controllerAdvance?.ok === true ? controllerAdvance.value : null;
    if (controllerStep !== null)
      controllerOperations.push(controllerStep.operation);
    let cpuRead: NesMapperCpuRead | undefined =
      apuStep?.read ?? controllerStep?.read ?? undefined;
    if (isMmc5IrqState(irq) && isMmc5State(state)) {
      const advanced = advanceMmc5Irq(irq, state, event);
      irq = advanced.state;
      irqClock = advanced.clock;
      cpuRead ??= advanced.read;
    }
    if (hasNamco163ChipRam(state))
      invalidateNamco163Phase(state.chip_ram, state.prg_banks[0] ?? null);
    if (
      event.kind === "apu-frame-clock" ||
      event.kind === "apu-frame-reset" ||
      event.kind === "apu-cpu-cycle" ||
      event.kind === "apu-cpu-phase" ||
      event.kind === "apu-dmc-read" ||
      event.kind === "apu-dmc-cpu-read" ||
      event.kind === "apu-dmc-clock" ||
      event.kind === "apu-dmc-stop"
    ) {
      // The APU owner consumed the qualified unit edge above.
    } else if (event.kind === "controller-hold") {
      cpuRead = readNesHeldController(event);
      if (!("known_bits" in cpuRead)) unknownCpuReads++;
    } else if (event.kind === "controller-buttons") {
      // The explicit external input fact was consumed by the controller owner above.
    } else if (event.kind === "oam-dma-start") {
      retainPpuOperation(
        startNesOamDma(state, ppu!, event.page, ppu!.next_event_index),
      );
    } else if (event.kind === "oam-dma") {
      retainPpuOperation(
        applyNesOamDma(
          state,
          ppu!,
          event.page,
          event.values,
          ppu!.next_event_index,
        ),
      );
    } else if (
      event.kind === "mmc5-render-frame" ||
      event.kind === "mmc5-render-line"
    ) {
      if (isMmc5State(state) && "ppu" in state)
        advanceMmc5Rendering(state, event.kind);
    } else if (event.kind === "mmc5-cpu-cycle" || event.kind === "mmc5-reset") {
      // The explicit MMC5 model consumed this edge/reset above.
      if (event.kind === "mmc5-reset" && isMmc5State(state))
        state = applyMmc5Reset(state);
    } else if (
      event.kind === "namco163-cpu-cycle" ||
      event.kind === "fme7-cpu-cycle" ||
      event.kind === "h3001-cpu-cycle" ||
      event.kind === "sunsoft3-cpu-cycle" ||
      event.kind === "vrc3-cpu-cycle" ||
      event.kind === "bandai-cpu-cycle" ||
      event.kind === "vrc-cpu-cycle"
    ) {
      if (irq !== null) {
        const clocked = clockNesCpuMapperIrq(irq, state);
        irq = clocked.state;
        irqClock = clocked.clock;
      }
    } else if (event.kind === "cpu-read") {
      const ppuRead =
        ppu === null
          ? null
          : readNesPpuCpu(header, state, ppu, {
              address: event.address,
              index: ppu.next_event_index,
              chr: chr ?? undefined,
            });
      if (ppuRead !== null) {
        retainPpuOperation(ppuRead.operation);
        cpuRead ??= {
          address: event.address,
          value: typeof ppuRead.value === "number" ? ppuRead.value : null,
          source: ppuRead.origin,
          ...(typeof ppuRead.value === "object" && ppuRead.value !== null
            ? { known_bits: ppuRead.value }
            : {}),
        };
      }
      const chipRead = hasNamco163ChipRam(state)
        ? readNamco163ChipRam(state.chip_ram, event.address)
        : null;
      cpuRead ??=
        isNamco163IrqState(irq) && isNamco163State(state)
          ? (readNamco163Irq(irq, state, event.address) ?? undefined)
          : undefined;
      cpuRead ??=
        isMmc5State(state) && event.address !== null
          ? (readMmc5Cpu(state, event.address) ?? {
              address: event.address,
              value: null,
              source: null,
            })
          : hasNamco163ChipRam(state)
            ? chipRead!
            : isBandaiState(state) && event.address !== null
              ? readBandaiEeprom(
                  "eeprom" in state ? state.eeprom : undefined,
                  state.eeprom_control,
                  event.address,
                )
              : { address: event.address, value: null, source: null };
      if (cpuRead.value === null && !("known_bits" in cpuRead))
        unknownCpuReads++;
    } else if (event.kind === "eeprom-write-complete") {
      if (!isBandaiState(state) || !("eeprom" in state))
        return {
          status: "unsupported",
          reason:
            "EEPROM completion requires an explicit compatible Bandai EEPROM model.",
        };
      const completed = completeBandaiEepromWrite(state.eeprom);
      if (!completed.ok)
        return {
          status: "unsupported",
          reason: `events[${index}]: ${completed.error}`,
        };
      state.eeprom = completed.value;
    } else if (event.kind === "ppu-a12" || event.kind === "cpu-m2-fall") {
      if (isMmc3IrqState(irq) && state.mapper === 4) {
        const filtered = applyMmc3A12(irq, event, state.irq_latch);
        irq = filtered.state;
        irqClock = filtered.clock;
      }
    } else if (event.kind === "mmc3-irq-clock") {
      irqClock = true;
      if (isMmc3IrqState(irq) && state.mapper === 4)
        irq =
          irq.model === "mc-acc"
            ? {
                ...clockMmc3Irq(irq, state.irq_latch),
                mcacc_prescaler: { a12_high: false, pulses: [1] },
              }
            : { ...clockMmc3Irq(irq, state.irq_latch), a12_filter: ["high"] };
    } else if (event.kind === "cpu-write") {
      if (isMmc3IrqState(irq)) irq = writeMmc3Irq(irq, event);
      const ppuWrite =
        ppu === null
          ? null
          : writeNesPpuCpu(header, state, ppu, {
              address: event.address,
              value:
                event.value ??
                ("known_bits" in event ? event.known_bits : null),
              index: ppu.next_event_index,
              dmcReadsModeled,
            });
      if (ppuWrite !== null) retainPpuOperation(ppuWrite);
      const changed = applyMappedNesMapperWrite(header, state, event, {
        prg,
        ...(isMmc5IrqState(irq) ? { mmc5_in_frame: irq.in_frame } : {}),
        ...(ppu === null ? {} : { ppu_event_index: ppu.next_event_index }),
      });
      state = changed.state;
      writeEffect = changed.effect;
      if (irq !== null)
        irq = writeNesCpuMapperIrq(irq, state, event, changed.effect);
    } else if (
      ppu !== null &&
      (event.kind === "ppu-read" || event.kind === "ppu-write")
    ) {
      const operation = accessNesPpuBus(
        header,
        state,
        ppu,
        event.kind === "ppu-read"
          ? event
          : {
              kind: "ppu-write",
              address: event.address,
              value:
                event.value ??
                ("known_bits" in event ? event.known_bits : null),
            },
        ppu.next_event_index,
        chr ?? undefined,
      );
      retainPpuOperation(operation);
      readSource = operation.bus_reads[0] ?? null;
      if (
        readSource !== null &&
        !nesPpuBusSourceResolved(operation.bus_reads[0]!)
      ) {
        if (event.address < 8192) unknownReads++;
        else unknownNametableReads++;
      }
    } else if (event.kind === "ppu-write") {
      if (isMmc5State(state))
        writeEffect = writeMmc5Ppu(
          state,
          event.address,
          event.value ?? ("known_bits" in event ? event.known_bits : null),
        );
    } else if (isMmc5State(state)) {
      readSource =
        "ppu" in state
          ? readMmc5BackgroundPpu(header, state, event.address, {
              fetch: "mmc5_fetch" in event ? event.mmc5_fetch : undefined,
              chr: chr ?? undefined,
              tile: "mmc5_tile" in event ? event.mmc5_tile : undefined,
            })
          : readMmc5Ppu(header, state, event.address, {
              fetch: "mmc5_fetch" in event ? event.mmc5_fetch : undefined,
              chr: chr ?? undefined,
            });
      if (event.address < 8192 && readSource.file_offset === null)
        unknownReads++;
      if (
        event.address >= 0x2000 &&
        event.address < 0x3f00 &&
        readSource.value === null &&
        !("known_bits" in readSource)
      )
        unknownNametableReads++;
    } else if (
      "nametable_windows" in mapping &&
      event.address >= 0x2000 &&
      event.address < 0x3f00
    ) {
      const address =
        event.address >= 0x3000 ? event.address - 0x1000 : event.address;
      const window = mapping.nametable_windows.find(
        (w) => address >= w.start && address < w.start + w.size,
      )!;
      const offset =
        window.file_offset === null
          ? null
          : window.file_offset + address - window.start;
      readSource = {
        status:
          window.source === "ciram"
            ? "ciram-unobserved"
            : offset === null
              ? "unknown-nametable-bank"
              : "chr-rom",
        bank: window.bank,
        file_offset: offset,
      };
      if (readSource.status !== "chr-rom") unknownNametableReads++;
    } else {
      const window = mapping.chr_windows.find(
        (window) =>
          event.address >= window.start &&
          event.address < window.start + window.size,
      );
      const offset =
        window?.file_offset == null
          ? null
          : window.file_offset + event.address - window.start;
      readSource = {
        status:
          event.address >= 8192
            ? "outside-pattern-tables"
            : mapping.chr_source === "ram-unobserved"
              ? "chr-ram-unobserved"
              : window !== undefined &&
                  "source" in window &&
                  window.source === "ciram"
                ? "ciram-unobserved"
                : offset === null
                  ? "unknown-chr-bank"
                  : "chr-rom",
        bank: window?.bank ?? null,
        file_offset: offset,
      };
      if (
        readSource.status === "unknown-chr-bank" ||
        readSource.status === "chr-ram-unobserved" ||
        readSource.status === "ciram-unobserved"
      )
        unknownReads++;
      if (state.mapper === 9 || state.mapper === 10)
        state = latchAfterPpuRead(state, event.address);
    }
    if (ppu !== null) ppu.next_event_index++;
    if (controllers !== null) controllers.next_event_index++;
    if (apu !== null) apu.next_event_index++;
    mapping = mapperMapping(header, state, {
      chrRamSize: ppu?.chr_ram_size ?? null,
    });
    retain(mapping);
    const eventStep = {
      index,
      event: { ...event },
      ...(dmcRead === undefined ? {} : { dmc_read: dmcRead }),
      ...(cpuRead === undefined ? {} : { cpu_read: cpuRead }),
      write_effect: writeEffect,
      read_source: readSource,
      irq_clock: irqClock,
    };
    if (ppu === null && controllers === null && apu === null && !irqPerEvent)
      steps.push({
        ...eventStep,
        state: structuredClone(state),
        irq: irq === null ? null : structuredClone(irq),
        mapping,
      });
    else if (irqPerEvent) {
      const step = {
        ...eventStep,
        mapper_snapshot: retainSnapshot(),
        irq: irq === null ? null : structuredClone(irq),
      };
      if (ppu === null && controllers === null && apu === null)
        cpuIrqSteps.push(step);
      else ppuSteps.push(step);
    } else ppuSteps.push({ ...eventStep, mapper_snapshot: retainSnapshot() });
  }
  signal?.throwIfAborted();
  const controllerTrace =
    controllers === null ||
    initialControllers === null ||
    initializedControllers === null
      ? null
      : {
          initial: structuredClone(initialControllers),
          initialized: initializedControllers,
          operations: controllerOperations,
          final: controllers,
          frontier: structuredClone([...controllerFrontier]),
        };
  const apuTrace =
    apu === null || initialApu === null || initializedApu === null
      ? null
      : {
          initial: structuredClone(initialApu),
          initialized: initializedApu,
          operations: apuOperations,
          dmc_read_ready: nesDmcReadReady(apu),
          final: apu,
          frontier: structuredClone([...apuFrontier]),
        };
  const common = {
    status: "derived" as const,
    ...(apuTrace === null ? {} : { apu_trace: apuTrace }),
    initial: structuredClone(initial),
    initial_irq: initialIrq === null ? null : structuredClone(initialIrq),
    initial_mapping: initialMapping,
    final: state,
    final_irq: irq,
    final_mapping: mapping,
    nes_prg_views: normalizeNesPrgViews(views.values()),
    coverage: {
      supplied_events: events.length,
      processed_events: events.length,
      unknown_pattern_reads: unknownReads,
      ...(events.some(
        (e) => e.kind === "cpu-read" || e.kind === "controller-hold",
      )
        ? { unknown_cpu_reads: unknownCpuReads }
        : {}),
      ...(ppu !== null ||
      isVrc6State(initial) ||
      isNamco163State(initial) ||
      isMmc5State(initial)
        ? { unknown_nametable_reads: unknownNametableReads }
        : {}),
    },
  };
  return ppu === null || initialPpu === null
    ? controllerTrace !== null
      ? {
          ...common,
          steps: ppuSteps,
          mapper_snapshots: snapshots,
          controller_trace: controllerTrace,
        }
      : apuTrace !== null
        ? {
            ...common,
            steps: ppuSteps,
            mapper_snapshots: snapshots,
            apu_trace: apuTrace,
          }
        : irqPerEvent
          ? { ...common, steps: cpuIrqSteps, mapper_snapshots: snapshots }
          : { ...common, steps }
    : {
        ...common,
        steps: ppuSteps,
        mapper_snapshots: snapshots,
        controller_trace: controllerTrace,
        ppu_trace: {
          viewport:
            ppuViewport === null
              ? null
              : await deriveNesPpuViewport(header, state, ppu, {
                  selection: ppuViewport,
                  mmc5Background: ppuMmc5Background?.viewport ?? null,
                  chr: chr ?? undefined,
                  signal,
                }),
          initial: structuredClone(initialPpu),
          operations: ppuOperations,
          final: ppu,
          sprites: ppuSprites
            ? await deriveNesPpuSprites(header, state, ppu, {
                chr: chr ?? undefined,
                signal,
              })
            : null,
          ...(ppuPatternTable === null
            ? {}
            : {
                pattern_table: await deriveNesPpuPatternTable(
                  header,
                  state,
                  ppu,
                  ppuPatternTable,
                  chr ?? undefined,
                  signal,
                ),
              }),
          ...(ppuNametable === null
            ? {}
            : {
                nametable: await deriveNesPpuNametable(
                  header,
                  state,
                  ppu,
                  ppuNametable,
                  signal,
                  chr ?? undefined,
                  ppuMmc5Background?.nametable ?? null,
                ),
              }),
          coverage: ppuCoverage,
          frontier: structuredClone([...ppuFrontier]),
        },
      };
}

/** Reject incompatible clocks/models before constructing any retained snapshots. */
