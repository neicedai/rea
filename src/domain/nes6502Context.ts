import { isVrc2State } from "./nesVrc2.js";
import {
  nesCpuMapperIrqEvent,
  clockNesCpuMapperIrq,
  writeNesCpuMapperIrq,
} from "./nesCpuMapperIrq.js";
import { isNamco163IrqState, readNamco163Irq } from "./nesNamco163Irq.js";
import { isBandaiState } from "./nesBandai.js";
import { isFme7State } from "./nesFme7.js";
import { isMmc5State } from "./nesMmc5.js";
import { readMmc5Cpu } from "./nesMmc5Cpu.js";
import { readMmc5ExramCell } from "./nesMmc5Exram.js";
import { isMmc5IrqState } from "./nesMmc5Irq.js";
import { setNesCpuByte } from "./nesCpuRegister.js";
import { Nes6502Interrupts } from "./nes6502Interrupts.js";
import { NesCpuIoBus } from "./nesCpuIoBus.js";
import { NesDmcCpuDma } from "./nesDmcCpuDma.js";
import { nesDmcTimingPhase } from "./nesDmcTiming.js";
import {
  readNesHeldController,
  type NesSourcedCpuIoState,
} from "./nesCpuIo.js";
import { admitNesOamCpuDma, type NesOamCpuDmaState } from "./nesOamCpuDma.js";
import {
  Nes6502Bus,
  type NesCpuBusReadRole,
  type NesCpuBusWriteRole,
} from "./nes6502Bus.js";
import { readMmc5MixedWindow } from "./nesMmc5MemoryRead.js";
import { hasNamco163ChipRam } from "./nesNamco163.js";
import {
  invalidateNamco163Phase,
  namco163ChipAddresses,
  readNamco163ChipRam,
} from "./nesNamco163Ram.js";
import type { NesMapperEvent, NesMapperIrqState } from "./nesMapperEvents.js";
import type { NesPpuState, NesPpuOperation } from "./nesPpuState.js";
import type {
  NesControllersState,
  NesControllerOperation,
} from "./nesControllers.js";
import {
  initializeNesControllers,
  advanceNesControllers,
  nesControllerButtonsAt,
  nesControllerSourceD0,
} from "./nesControllersDerivation.js";
import { bindNesCpuDma } from "./nesCpuDma.js";
import type { NesApuState, NesApuOperation } from "./nesApu.js";
import { initializeNesApu, advanceNesApu } from "./nesApuDerivation.js";
import {
  initializeNesPpu,
  readNesPpuCpu,
  writeNesPpuCpu,
  applyNesOamDma,
  startNesOamDma,
} from "./nesPpuRegisters.js";
import { readFme7MixedWindow } from "./nesFme7MemoryRead.js";
import { readBandaiEeprom } from "./nesBandaiEeprom.js";
import {
  joinNesBytes,
  type NesByteValue,
  type NesKnownBits,
} from "./nesByteValue.js";
import type { NesMapperWrite } from "./nesMapperTrace.js";
import { mmc6RamAccess } from "./nesMmc6.js";
import type { NesRomMetadata } from "./nes.js";
import { nesPrgRamAccess, nromRamAccess } from "./nesPrgRam.js";
import type {
  NesCpuState,
  TraceNesCodeInput,
  NesCodeVector,
  NesDataRead,
  NesRamLocation,
  NesMapperByteOrigin,
  NesMapperWriteSource,
  NesDmaIoRead,
} from "./nesCodeTrace.js";
import type { NesMapperState } from "./nesMapperTrace.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import {
  NES_CPU_DMA_SOURCE_BYTES,
  nesCpuReadProofBytes,
} from "./nesCpuDmaBudget.js";
import type { NesOamDmaFrontier } from "./nesCodeTrace.js";
import {
  applyMappedNesMapperWrite,
  isNesMapperWriteAddress,
} from "./nesMapperTraceDerivation.js";

/** One conditional code path owns its RAM facts and mapper state; source bytes stay immutable. */
export class Nes6502Context {
  readonly ram = new Map<
    number,
    {
      value: number | null;
      known_bits?: NesKnownBits;
      origin:
        | { instruction_index: number; write_index: number }
        | { entry_interrupt_write_index: number }
        | { interrupt_index: number; interrupt_write_index: number }
        | { initial_ram_index: number }
        | { initial_prg_ram_index: number; bank: number };
    }
  >();
  private vrc2LatchSource: NesMapperWriteSource | null = null;
  private readonly mmc5FactorSources: NesMapperWriteSource[] = [
    { kind: "initial-state" },
    { kind: "initial-state" },
  ];
  private mmc5ExramModeSource: NesMapperWriteSource = { kind: "initial-state" };
  private readonly mmc5ExramSources = new Map<number, NesMapperWriteSource>();
  private eepromControlSource: NesMapperWriteSource = { kind: "initial-state" };
  private readonly eepromByteSources = new Map<number, number>();
  private chipAddressSource: NesMapperWriteSource = { kind: "initial-state" };
  private readonly chipByteSources = new Map<
    number,
    | { kind: "initial-chip-ram"; index: number }
    | { kind: "cpu-write"; instruction_index: number; write_index: number }
  >();
  mapperEvents: NesMapperEvent[] = [];
  private mapperEventCount = 0;
  irq: NesMapperIrqState | null;
  ppuOperations: NesPpuOperation[] = [];
  controllerOperations: NesControllerOperation[] = [];
  apuOperations: NesApuOperation[] = [];
  readonly apu: NesApuState | null;
  readonly controllers: NesControllersState | null;
  readonly ppu: NesPpuState | null;
  readonly cpu: NesCpuState;
  readonly bus: Nes6502Bus | null;
  readonly interrupts: Nes6502Interrupts | null;
  readonly io: NesCpuIoBus | null;
  readonly dmc: NesDmcCpuDma | null;
  readonly cpuDma: {
    initial: NesOamCpuDmaState;
    initialized: NesOamCpuDmaState;
    state: NesOamCpuDmaState;
  } | null;
  dmaActive = false;
  oamActive = false;
  private readonly chr: Uint8Array | undefined;
  instructionIndex: number | null = null;
  interruptIndex: number | null = null;
  writes: NesMapperWrite[] = [];
  dataReads: NesDataRead[] = [];
  oamDmaReads: NesDataRead[] = [];
  oamDmaFrontier: NesOamDmaFrontier | null = null;
  private oamSourceBytes = 0;
  private readonly maxOamSourceBytes: number;
  private dmcSourceBytes = 0;
  private readonly maxDmcSourceBytes: number;
  callDepth = 0;
  mapping;
  constructor(
    readonly header: NesRomMetadata,
    readonly prg: Uint8Array,
    public mapper: NesMapperState,
    {
      cpu,
      initialRam,
      initialPrgRam,
      initialPpu,
      initialControllers = null,
      initialApu = null,
      initialCpuBus = null,
      initialIrq = null,
      initialInterrupts = null,
      initialCpuDma = null,
      initialCpuIo = null,
      chr,
      maxOamSourceBytes = NES_CPU_DMA_SOURCE_BYTES,
      maxDmcSourceBytes = NES_CPU_DMA_SOURCE_BYTES,
    }: {
      cpu: NesCpuState;
      initialRam: TraceNesCodeInput["initial_ram"];
      initialPrgRam: TraceNesCodeInput["initial_prg_ram"];
      initialPpu: NesPpuState | null;
      initialControllers?: NesControllersState | null;
      initialApu?: NesApuState | null;
      initialCpuBus?: TraceNesCodeInput["initial_cpu_bus"];
      initialIrq?: NesMapperIrqState | null;
      initialInterrupts?: TraceNesCodeInput["initial_interrupts"];
      initialCpuDma?: TraceNesCodeInput["initial_cpu_dma"];
      initialCpuIo?: TraceNesCodeInput["initial_cpu_io"];
      chr?: Uint8Array | undefined;
      maxOamSourceBytes?: number;
      maxDmcSourceBytes?: number;
    },
  ) {
    this.cpu = cpu;
    this.io = initialCpuIo === null ? null : new NesCpuIoBus(initialCpuIo);
    this.irq = initialIrq === null ? null : structuredClone(initialIrq);
    this.interrupts =
      initialInterrupts === null
        ? null
        : new Nes6502Interrupts(initialInterrupts);
    this.maxOamSourceBytes = maxOamSourceBytes;
    this.maxDmcSourceBytes = maxDmcSourceBytes;
    this.chr = chr;
    this.apu = initialApu === null ? null : initializeNesApu(initialApu);
    this.ppu = initialPpu === null ? null : initializeNesPpu(initialPpu);
    this.controllers =
      initialControllers === null
        ? null
        : initializeNesControllers(initialControllers);
    if (this.controllers !== null) {
      const bound = bindNesCpuDma(this.controllers, this.ppu, mapper);
      if (!bound.ok)
        throw new Error(
          `Admitted CPU DMA facts became contradictory: ${bound.error.reason}`,
        );
    }
    this.cpuDma = null;
    if (initialCpuDma !== null) {
      const admitted = admitNesOamCpuDma(
        initialCpuDma,
        this.ppu,
        this.controllers,
        mapper,
        this.apu,
      );
      if (!admitted.ok)
        throw new Error(
          `Admitted CPU DMA became contradictory: ${admitted.error.reason}`,
        );
      this.cpuDma = {
        initial: structuredClone(initialCpuDma),
        initialized: structuredClone(admitted.value),
        state: admitted.value,
      };
      this.ppu!.oam!.dma_pending = structuredClone(
        admitted.value.oam_dma_pending,
      );
      if (this.controllers !== null)
        this.controllers.oam_dma_pending = structuredClone(
          admitted.value.oam_dma_pending,
        );
      if (hasNamco163ChipRam(mapper))
        mapper.chip_ram.oam_dma_pending =
          admitted.value.oam_dma_pending.status === "none"
            ? "none"
            : admitted.value.oam_dma_pending.status === "pending"
              ? admitted.value.oam_dma_pending.page
              : null;
    }
    const pending =
      (this.ppu?.oam != null && this.ppu.oam.dma_pending.status !== "none") ||
      (this.controllers !== null &&
        this.controllers.oam_dma_pending.status !== "none") ||
      (hasNamco163ChipRam(mapper) &&
        mapper.chip_ram.oam_dma_pending !== "none");
    this.bus =
      initialCpuBus === null
        ? null
        : new Nes6502Bus(
            initialCpuBus,
            pending,
            this.cpuDma !== null,
            this.apu?.dmc?.cpu_timing != null,
          );
    this.dmc =
      this.bus !== null && this.apu?.dmc?.cpu_timing != null
        ? new NesDmcCpuDma(this)
        : null;
    if (
      (this.cpuDma?.state.cpu_phase ?? nesDmcTimingPhase(this.apu)) != null &&
      this.apu?.frame_clocks === "cpu-ordered" &&
      this.apu.frame_sequencer.cpu_phase === null
    ) {
      const event = {
        kind: "apu-cpu-phase",
        phase: (this.cpuDma?.state.cpu_phase ?? nesDmcTimingPhase(this.apu))!,
      } as const;
      this.applyApuEvent(event);
      this.retainEvent(event);
    }
    this.mapping = mapperMapping(header, mapper, {
      chrRamSize: this.ppu?.chr_ram_size ?? null,
    });
    if (hasNamco163ChipRam(mapper))
      mapper.chip_ram.bytes.forEach((value, index) => {
        if (value !== null)
          this.chipByteSources.set(index, { kind: "initial-chip-ram", index });
      });
    if (isBandaiState(mapper) && "eeprom" in mapper)
      for (const [index, item] of mapper.eeprom.bytes.entries())
        this.eepromByteSources.set(item.address, index);
    if (
      isVrc2State(mapper) &&
      mapper.mapper === 23 &&
      mapper.latch_present === true &&
      mapper.latch_value !== null
    )
      this.vrc2LatchSource = { kind: "initial-state" };

    for (const [index, item] of initialRam.entries())
      this.ram.set(item.address, {
        value: item.value,
        origin: { initial_ram_index: index },
      });
    for (const [index, item] of initialPrgRam.entries())
      this.ram.set(
        this.ramKey({
          region: "prg-ram",
          ram_address: item.address,
          bank: item.bank,
        }),
        {
          value: item.value,
          origin: { initial_prg_ram_index: index, bank: item.bank },
        },
      );
  }
  source(address: number): {
    value: number | null;
    file_offset: number | null;
  } {
    const window = this.mapping.prg_windows.find(
      (window) =>
        address >= window.start && address < window.start + window.size,
    );
    if (window?.file_offset == null) return { value: null, file_offset: null };
    const offset = window.file_offset + address - window.start;
    return {
      value: this.prg[offset - this.header.prgRom.offset] ?? null,
      file_offset: offset,
    };
  }
  readVector(
    kind: "reset" | "nmi" | "irq",
    bus = false,
  ): {
    reads: NonNullable<NesCodeVector>;
    target: number | null;
  } {
    const base = { nmi: 0xfffa, reset: 0xfffc, irq: 0xfffe }[kind];
    const reads = [base, base + 1].map((address) => {
      const source = bus
        ? this.readBus(address, "vector")
        : this.source(address);
      return { address, value: source.value, file_offset: source.file_offset };
    });
    const low = reads[0]!.value;
    const high = reads[1]!.value;
    return {
      reads,
      target: low === null || high === null ? null : low | (high << 8),
    };
  }
  private ramAccess(address: number): {
    locations: NesRamLocation[];
    readable: boolean | null;
    writable: boolean | null;
    zero: Extract<NesMapperByteOrigin, { kind: "mmc6-disabled-half" }> | null;
  } | null {
    if (address < 8192)
      return {
        locations: [{ region: "internal-ram", ram_address: address & 2047 }],
        readable: true,
        writable: true,
        zero: null,
      };
    if (address < 0x6000 || (address > 0x7fff && !isMmc5State(this.mapper)))
      return null;
    if (this.mapper.mapper === 0) {
      const access = nromRamAccess(this.header, this.mapper, address);
      return access === null
        ? null
        : {
            readable: access.readable,
            writable: access.writable,
            locations: [
              { region: "prg-ram", ram_address: access.ram_address, bank: 0 },
            ],
            zero: null,
          };
    }
    if (
      this.header.mapper === 4 &&
      this.header.submapper === 1 &&
      this.mapper.mapper === 4
    ) {
      const access = mmc6RamAccess(this.header, this.mapper, address);
      return access === null
        ? null
        : {
            readable: access.readable,
            writable: access.writable,
            locations: [
              { region: "prg-ram", ram_address: access.ram_address, bank: 0 },
            ],
            zero:
              access.zero === null
                ? null
                : {
                    kind: "mmc6-disabled-half",
                    ram_address: access.ram_address,
                    ...access.zero,
                  },
          };
    }
    const access = nesPrgRamAccess(this.header, this.mapper, address);
    return access === null
      ? null
      : {
          ...access,
          zero: null,
          locations: access.banks.map((bank) => ({
            region: "prg-ram",
            ram_address: access.ram_address ?? address,
            bank,
          })),
        };
  }
  private ramKey(location: NesRamLocation): number {
    return (
      location.ram_address +
      (location.region === "prg-ram" ? location.bank * 8192 : 0)
    );
  }
  instructionSource(address: number) {
    if (isMmc5State(this.mapper)) {
      const device = this.readMmc5Device(address);
      if (device !== null) return device;
      const mixed = readMmc5MixedWindow(
        this.header,
        this.prg,
        this.mapper,
        address,
        (bank, ram_address) => {
          const fact = this.ram.get(
            this.ramKey({ region: "prg-ram", bank, ram_address }),
          );
          const value = fact?.value ?? fact?.known_bits;
          if (fact === undefined || value == null) return undefined;
          if ("instruction_index" in fact.origin)
            return { value, source: { kind: "cpu-write", ...fact.origin } };
          if ("initial_prg_ram_index" in fact.origin)
            return {
              value,
              source: {
                kind: "initial-prg-ram",
                index: fact.origin.initial_prg_ram_index,
              },
            };
          return undefined;
        },
      );
      if (mixed !== null) return mixed;
    }
    if (isFme7State(this.mapper)) {
      const mixed = readFme7MixedWindow(
        this.header,
        this.prg,
        this.mapper,
        address,
        (bank, ram_address) => {
          const fact = this.ram.get(
            this.ramKey({ region: "prg-ram", bank, ram_address }),
          );
          const value = fact?.value ?? fact?.known_bits;
          if (fact === undefined || value == null) return undefined;
          if ("instruction_index" in fact.origin)
            return { value, source: { kind: "cpu-write", ...fact.origin } };
          if ("initial_prg_ram_index" in fact.origin)
            return {
              value,
              source: {
                kind: "initial-prg-ram",
                index: fact.origin.initial_prg_ram_index,
              },
            };
          return undefined;
        },
      );
      if (mixed !== null) return mixed;
    }
    if (
      isBandaiState(this.mapper) &&
      "eeprom" in this.mapper &&
      address >= 0x6000 &&
      address <= 0x7fff
    ) {
      const read = readBandaiEeprom(
        this.mapper.eeprom,
        this.mapper.eeprom_control,
        address,
      );
      if ("known_bits" in read && read.source !== null) {
        const pointer = read.source.pointer;
        return {
          value: null,
          known_bits: read.known_bits,
          file_offset: null,
          ram_origins: [],
          mapper_origins: [
            {
              kind: "bandai-eeprom",
              line_source: read.source,
              control_source: { ...this.eepromControlSource },
              initial_eeprom_byte_indices:
                read.source.kind === "device-data"
                  ? [...this.eepromByteSources]
                      .filter(([address]) =>
                        typeof pointer === "number"
                          ? address === pointer
                          : pointer === null ||
                            (address & pointer.mask) === pointer.value,
                      )
                      .map(([, index]) => index)
                  : [],
            } satisfies NesMapperByteOrigin,
          ],
        };
      }
    }
    if (
      isVrc2State(this.mapper) &&
      this.mapper.mapper === 23 &&
      this.mapper.latch_present === true &&
      this.mapper.latch_value !== null &&
      this.vrc2LatchSource !== null &&
      address >= 0x6000 &&
      address <= 0x6fff
    )
      return {
        value: null,
        known_bits: { mask: 1, value: this.mapper.latch_value },
        file_offset: null,
        ram_origins: [],
        mapper_origins: [
          {
            kind: "vrc2-microwire-latch",
            latch_value: this.mapper.latch_value,
            source: { ...this.vrc2LatchSource },
          } satisfies NesMapperByteOrigin,
        ],
      };
    const access = this.ramAccess(address);
    if (access === null)
      return {
        ...this.source(address),
        ram_origins: [],
        mapper_origins: [] as NesMapperByteOrigin[],
      };
    if (access.zero !== null)
      return {
        value: 0,
        file_offset: null,
        ram_origins: [],
        mapper_origins: [access.zero],
      };
    if (access.readable !== true)
      return {
        value: null,
        file_offset: null,
        ram_origins: [],
        mapper_origins: [] as NesMapperByteOrigin[],
      };
    const facts = access.locations.map((location) => ({
      location,
      fact: this.ram.get(this.ramKey(location)),
    }));
    let proof: NesByteValue | undefined;
    for (const { fact } of facts) {
      const candidate = fact?.value ?? fact?.known_bits ?? null;
      proof = proof === undefined ? candidate : joinNesBytes(proof, candidate);
    }
    if (proof == null)
      return {
        value: null,
        file_offset: null,
        ram_origins: [],
        mapper_origins: [] as NesMapperByteOrigin[],
      };
    return {
      value: typeof proof === "number" ? proof : null,
      ...(typeof proof === "number" ? {} : { known_bits: proof }),
      file_offset: null,
      mapper_origins: [] as NesMapperByteOrigin[],
      ram_origins: facts.map(({ location, fact }) =>
        "initial_ram_index" in fact!.origin ||
        "interrupt_index" in fact!.origin ||
        "entry_interrupt_write_index" in fact!.origin
          ? {
              region: "internal-ram" as const,
              ram_address: location.ram_address,
              ...fact!.origin,
            }
          : "initial_prg_ram_index" in fact!.origin
            ? {
                region: "prg-ram" as const,
                ram_address: location.ram_address,
                ...fact!.origin,
              }
            : { ...location, ...fact!.origin },
      ),
    };
  }
  read(
    address: number | null,
    role: NesCpuBusReadRole = "data",
  ): number | null {
    return this.readValue(address, role).value;
  }
  private readMmc5Device(address: number) {
    if (!isMmc5State(this.mapper)) return null;
    const read = readMmc5Cpu(this.mapper, address);
    if (read === null) return null;
    const source = read.source;
    const cellOrigin =
      source?.kind === "mmc5-exram"
        ? readMmc5ExramCell(this.mapper, source.cell_address).origin
        : null;
    const proven = read.value !== null || "known_bits" in read;
    const origins: NesMapperByteOrigin[] =
      !proven ||
      source === null ||
      (source.kind === "mmc5-exram" &&
        (source.access !== "readable" || source.cell_value === null))
        ? []
        : source.kind === "mmc5-multiply"
          ? [
              {
                ...source,
                factor_sources: this.mmc5FactorSources.map((source) => ({
                  ...source,
                })),
              },
            ]
          : [
              {
                ...source,
                access: "readable",
                cell_value: source.cell_value!,
                mode_source: { ...this.mmc5ExramModeSource },
                byte_source: {
                  ...(this.ppu !== null && cellOrigin?.kind === "event-write"
                    ? cellOrigin
                    : (this.mmc5ExramSources.get(source.cell_address) ?? {
                        kind: "initial-state" as const,
                      })),
                },
              },
            ];
    return {
      value: read.value,
      ...("known_bits" in read ? { known_bits: read.known_bits } : {}),
      file_offset: null,
      ram_origins: [],
      mapper_origins: origins,
    };
  }
  private readMapperPort(
    address: number | null,
    record = true,
  ): {
    value: number | null;
    known_bits?: NesKnownBits;
    file_offset: null;
    ram_origins: never[];
    mapper_origins: NesMapperByteOrigin[];
  } | null {
    if (
      !hasNamco163ChipRam(this.mapper) ||
      (address !== null &&
        (address & 0xf800) !== 0x4800 &&
        this.mapper.chip_ram.oam_dma_pending === "none")
    )
      return null;
    const ram = this.mapper.chip_ram;
    invalidateNamco163Phase(ram, this.mapper.prg_banks[0] ?? null);
    const read = readNamco163ChipRam(ram, address);
    if (record) this.retainEvent({ kind: "cpu-read", address });
    if (address !== null && (address & 0xf800) !== 0x4800) return null;
    const proven = read.value !== null || "known_bits" in read;
    const source = read.source;
    const origins: NesMapperByteOrigin[] =
      proven && source !== null
        ? [
            {
              ...source,
              address_source: { ...this.chipAddressSource },
              cells: source.cells.map((cell) => {
                const origin = this.chipByteSources.get(cell.address);
                if (origin === undefined || cell.value === null)
                  throw new Error("Proven chip byte is missing its source");
                return { ...cell, value: cell.value, source: { ...origin } };
              }),
            },
          ]
        : [];
    return {
      value: read.value,
      ...("known_bits" in read ? { known_bits: read.known_bits } : {}),
      file_offset: null,
      ram_origins: [],
      mapper_origins: origins,
    };
  }
  private readPpuPort(address: number | null, record = true) {
    if (this.ppu === null) return null;
    const read = readNesPpuCpu(this.header, this.mapper, this.ppu, {
      address,
      index: this.ppu.next_event_index,
      chr: this.chr,
    });
    if (read === null) return null;
    this.ppuOperations.push(read.operation);
    if (record) this.retainEvent({ kind: "cpu-read", address });
    this.mapping = mapperMapping(this.header, this.mapper, {
      chrRamSize: this.ppu.chr_ram_size,
    });
    return {
      value: typeof read.value === "number" ? read.value : null,
      ...(typeof read.value === "object" && read.value !== null
        ? { known_bits: read.value }
        : {}),
      file_offset: null,
      ram_origins: [],
      mapper_origins:
        read.value !== null && read.origin !== null ? [read.origin] : [],
    };
  }
  /** Extra NMOS indexed/NOP reads have mapper side effects but are not semantic operands. */
  readMapperDummy(address: number | null): void {
    if (this.bus !== null) {
      this.readBus(address, "dummy");
      return;
    }
    this.captureOamDma(address);
    if (this.oamDmaFrontier !== null) return;
    if (this.controllers !== null || this.apu !== null || this.irq !== null) {
      this.readSharedCpuPort(address);
      return;
    }
    if (this.readPpuPort(address) === null) this.readMapperPort(address);
  }
  readValue(
    address: number | null,
    role: NesCpuBusReadRole = "data",
  ): NesDataRead {
    return this.readCpu(address, role, true);
  }
  readBus(address: number | null, role: NesCpuBusReadRole): NesDataRead {
    return this.readCpu(address, role, false);
  }
  peekInstruction(address: number): NesDataRead {
    return this.projectDataRead(address, this.instructionSource(address));
  }
  private readCpu(
    address: number | null,
    role: NesCpuBusReadRole,
    semantic: boolean,
  ): NesDataRead {
    if (this.bus === null) this.captureOamDma(address);
    if (this.bus !== null && !this.dmaActive) this.dmc?.beforeCpuRead(address);
    if (
      this.oamDmaFrontier !== null ||
      (this.bus !== null && !this.bus.permitRead(address))
    )
      return {
        address,
        value: null,
        file_offset: null,
        ram_origins: [],
        mapper_origins: [],
      };
    const mark = this.dmaReadMark();
    this.prepareDmcStop();
    const externalInternal =
      this.dmaActive &&
      (role === "data" || role === "dmc-get") &&
      address !== null &&
      address >= 0x4000 &&
      address <= 0x401f;
    const raw = this.readCpuSource(address, externalInternal);
    if (this.bus?.stopped != null) return raw.read;
    const projected = this.io?.project(
      raw.read,
      this.bus!.state.next_cycle_index,
      this.externalDriveMask(address, externalInternal, raw.hasPort),
      externalInternal,
    );
    const read = projected?.read ?? raw.read;
    this.commitCpuRead(read, { role, semantic, mark, state: projected?.state });
    return read;
  }
  private readCpuSource(
    address: number | null,
    externalOnly = false,
  ): { read: NesDataRead; hasPort: boolean } {
    if (
      !externalOnly &&
      this.io !== null &&
      (address === 0x4016 || address === 0x4017)
    ) {
      const mode = this.io.controllerMode(address);
      if (
        mode === "unknown" &&
        this.controllers !== null &&
        this.controllers.strobe !== true
      ) {
        this.bus!.stopped = { reason: "cpu-io-controller-uncertain", address };
        return {
          hasPort: false,
          read: {
            address,
            value: null,
            file_offset: null,
            ram_origins: [],
            mapper_origins: [],
          },
        };
      }
      if (mode === "hold" && this.controllers?.strobe !== true) {
        const held = structuredClone(
          this.io.state.held_controller ?? {
            pin_value: null,
            source: null,
            cycle_index: null,
          },
        );
        if (this.controllers !== null) {
          if (held.source !== null) {
            held.source.strobe = this.controllers.strobe;
            held.source.live = structuredClone(
              nesControllerButtonsAt(
                this.controllers,
                address === 0x4016 ? 1 : 2,
              ),
            );
            const bit = nesControllerSourceD0(
              held.source.strobe,
              held.source.live.value,
              held.source.serial_reports,
            );
            held.pin_value = bit === null ? null : { mask: 1, value: bit };
            if (
              held.source.reason === "unresolved-controller-bit" &&
              bit !== null
            )
              held.source.reason = null;
          } else if (this.controllers.strobe === null) {
            held.pin_value = null;
          }
        }
        const event = {
          kind: "controller-hold",
          address,
          held,
        } as const;
        this.applyControllerEvent(event);
        this.applyApuEvent(event);
        this.retainEvent(event);
        const read = readNesHeldController(event);
        return {
          hasPort: true,
          read: this.projectDataRead(address, {
            value: null,
            ...("known_bits" in read ? { known_bits: read.known_bits } : {}),
            file_offset: null,
            ram_origins: [],
            mapper_origins: [read.source],
          }),
        };
      }
    }
    const externalInternal =
      externalOnly &&
      address !== null &&
      address >= 0x4000 &&
      address <= 0x401f;
    const port = externalInternal
      ? null
      : this.controllers !== null || this.apu !== null || this.irq !== null
        ? this.readSharedCpuPort(address)
        : (this.readPpuPort(address) ?? this.readMapperPort(address));
    const source =
      port ??
      (address === null
        ? {
            value: null,
            file_offset: null,
            ram_origins: [],
            mapper_origins: [],
          }
        : this.instructionSource(address));
    return {
      read: this.projectDataRead(address, source),
      hasPort: port !== null,
    };
  }
  private externalDriveMask(
    address: number | null,
    externalOnly: boolean,
    hasPort: boolean,
  ): number {
    if (address === null || address < 0x4000 || address >= 0x6000) return 255;
    if (!externalOnly && (address === 0x4016 || address === 0x4017)) return 31;
    if (externalOnly && address <= 0x401f) return 0;
    if (hasPort) return 255;
    // Known cartridge read domains keep driving unknown bits when their model
    // is unselected. Other expansion drivers are excluded by this I/O profile.
    if (
      (this.mapper.mapper === 5 && address >= 0x5000) ||
      (this.mapper.mapper === 19 && address >= 0x4800)
    )
      return 255;
    return 0;
  }
  private dmaReadMark() {
    return this.dmaActive
      ? {
          events: this.mapperEvents.length,
          ppu: this.ppuOperations.length,
          controllers: this.controllerOperations.length,
          apu: this.apuOperations.length,
        }
      : null;
  }
  private commitCpuRead(
    read: NesDataRead,
    {
      role,
      semantic,
      mark,
      state,
      io,
    }: {
      role: NesCpuBusReadRole;
      semantic: boolean;
      mark: {
        events: number;
        ppu: number;
        controllers: number;
        apu: number;
      } | null;
      state?: NesSourcedCpuIoState | undefined;
      io?: NesDmaIoRead | undefined;
    },
  ): void {
    if (mark !== null) {
      const proofCost = nesCpuReadProofBytes([
        io === undefined ? read : { read, dma_io: io },
      ]);
      const cost = proofCost + (this.oamSourceBytes === 0 ? 0 : 1);
      const dmcCost = proofCost + (this.dmcSourceBytes === 0 ? 0 : 1);
      const exceedsOam =
        this.oamActive && cost > this.maxOamSourceBytes - this.oamSourceBytes;
      const exceedsDmc =
        this.dmc?.active != null &&
        dmcCost > this.maxDmcSourceBytes - this.dmcSourceBytes;
      if (exceedsOam || exceedsDmc) {
        // The entire transfer remains unapplied. Retain only actions whose proof
        // fits; mutated private device state from this tentative read is discarded.
        this.mapperEvents.length = mark.events;
        this.ppuOperations.length = mark.ppu;
        this.controllerOperations.length = mark.controllers;
        this.apuOperations.length = mark.apu;
        this.bus!.stopped = {
          reason: exceedsOam
            ? "oam-dma-source-budget"
            : "dmc-dma-source-budget",
          address: read.address,
        };
        return;
      }
      if (this.oamActive) this.oamSourceBytes += cost;
      if (this.dmc?.active != null) this.dmcSourceBytes += dmcCost;
    }
    if (state !== undefined) this.io!.state = state;
    if (semantic) this.dataReads.push(read);
    if (this.bus !== null) {
      this.bus.read(read, role, io);
      this.clockCpuBus();
    }
  }
  readDma(
    address: number,
    haltedAddress: number,
    role: NesCpuBusReadRole = "data",
  ): NesByteValue {
    const alias = 0x4000 | (address & 31);
    if (
      this.io === null ||
      haltedAddress < 0x4000 ||
      haltedAddress > 0x401f ||
      (alias !== 0x4015 && alias !== 0x4016 && alias !== 0x4017)
    ) {
      const read = this.readBus(address, role);
      return read.value ?? ("known_bits" in read ? read.known_bits : null);
    }
    if (!this.bus!.permitRead(address)) return null;
    const mark = this.dmaReadMark();
    this.prepareDmcStop();
    const internal = this.readCpuSource(alias);
    if (this.bus!.stopped !== null) return null;
    const external =
      address === alias
        ? {
            hasPort: false,
            read:
              alias === 0x4015
                ? {
                    address,
                    value: null,
                    file_offset: null,
                    ram_origins: [],
                    mapper_origins: [],
                  }
                : internal.read,
          }
        : this.readCpuSource(address, true);
    const projected = this.io.projectDma(
      external.read,
      internal.read,
      alias,
      this.externalDriveMask(address, true, external.hasPort),
      this.bus!.state.next_cycle_index,
    );
    this.commitCpuRead(projected.read, {
      role,
      semantic: false,
      mark,
      state: projected.state,
      io: projected.io,
    });
    return projected.value;
  }
  /** Effective reader stopping precedes the memory action on its qualified edge. */
  private prepareDmcStop(): void {
    if (
      this.bus === null ||
      this.apu?.dmc?.cpu_timing?.stop.status !== "pending" ||
      this.apu.dmc.cpu_timing.stop.delay !== 1
    )
      return;
    const event = { kind: "apu-dmc-stop" } as const;
    const apu = this.applyApuEvent(event);
    if (apu?.dmc_stop !== undefined) this.dmc?.stop(apu.dmc_stop);
    this.applyControllerEvent(event);
    this.retainEvent(event);
  }
  private clockCpuBus(): void {
    if (this.irq !== null) {
      const event = nesCpuMapperIrqEvent(this.irq);
      if (event !== null) {
        this.irq = clockNesCpuMapperIrq(this.irq, this.mapper).state;
        this.retainEvent(event);
      }
    }
    if (this.apu?.frame_clocks === "cpu-ordered") {
      const event = { kind: "apu-cpu-cycle" } as const;
      const apu = this.applyApuEvent(event);
      if (apu?.dmc_stop !== undefined) this.dmc?.stop(apu.dmc_stop);
      this.retainEvent(event);
    }
    if (this.cpuDma !== null)
      this.cpuDma.state.cpu_phase =
        this.cpuDma.state.cpu_phase === null
          ? null
          : this.cpuDma.state.cpu_phase === "get"
            ? "put"
            : "get";
    this.dmc?.afterCycle(this.bus!.state.next_cycle_index - 1, this.oamActive);
    if (this.bus !== null)
      this.interrupts?.sample(
        {
          cycle_index: this.bus.state.next_cycle_index - 1,
          mapper_event_count: this.mapperEventCount,
          i: this.cpu.i,
          cartridge_irq: this.irq === null ? false : this.irq.asserted,
          apu_frame_irq: this.apu === null ? false : this.apu.frame_irq.value,
          apu_dmc_irq: this.apu === null ? false : this.apu.dmc_irq.value,
        },
        this.dmaActive,
      );
  }
  private projectDataRead(
    address: number | null,
    source: ReturnType<Nes6502Context["instructionSource"]>,
  ): NesDataRead {
    const common = {
      address,
      file_offset: source.file_offset,
      ram_origins: source.ram_origins.map((origin) => ({
        byte_index: 0,
        ...origin,
      })),
      mapper_origins: source.mapper_origins.map((origin) => ({
        byte_index: 0,
        ...origin,
      })),
    };
    const read: NesDataRead =
      "known_bits" in source && source.known_bits !== undefined
        ? { ...common, value: null, known_bits: source.known_bits }
        : { ...common, value: source.value };
    return read;
  }
  /** Read a stable CPU page once; device-page bytes stay unknown rather than pretending opcode reads. */
  private retainEvent(event: NesMapperEvent): void {
    this.mapperEvents.push(event);
    this.mapperEventCount++;
    if (this.ppu !== null) this.ppu.next_event_index++;
    if (this.controllers !== null) this.controllers.next_event_index++;
    if (this.apu !== null) this.apu.next_event_index++;
  }
  get nextMapperEventIndex(): number {
    return this.mapperEventCount;
  }
  get retainedDmcSourceBytes(): number {
    return this.dmcSourceBytes;
  }
  deliverDmcSample(
    address: number,
    value: NesByteValue,
    cycleIndex: number,
    outputBoundary: boolean | null,
  ): void {
    const event = {
      kind: "apu-dmc-cpu-read",
      address,
      value,
      cycle_index: cycleIndex,
      output_boundary: outputBoundary,
    } as const;
    this.applyApuEvent(event);
    this.applyControllerEvent(event);
    this.retainEvent(event);
  }
  private applyControllerEvent(event: NesMapperEvent) {
    if (this.controllers === null) return null;
    const result = advanceNesControllers(this.controllers, event, {
      dmcReadsModeled: this.dmc !== null,
    });
    if (!result.ok)
      throw new Error(
        `Admitted controller events became contradictory: ${result.error.reason}`,
      );
    if (result.value !== null)
      this.controllerOperations.push(result.value.operation);
    return result.value;
  }
  private applyApuEvent(event: NesMapperEvent) {
    if (this.apu === null) return null;
    const result = advanceNesApu(this.apu, event);
    if (!result.ok)
      throw new Error(
        `Admitted APU events became contradictory: ${result.error.reason}`,
      );
    if (result.value !== null) this.apuOperations.push(result.value.operation);
    return result.value;
  }
  private readSharedCpuPort(address: number | null) {
    const event = { kind: "cpu-read" as const, address },
      apu = this.applyApuEvent(event),
      controlled = this.applyControllerEvent(event),
      ppuRead = this.readPpuPort(address, false),
      mapperRead = this.readMapperPort(address, false),
      irqRead = this.readMapperIrqPort(address);
    if (
      apu !== null ||
      controlled !== null ||
      ppuRead !== null ||
      mapperRead !== null ||
      irqRead !== null
    )
      this.retainEvent(event);
    if (apu?.read != null)
      return {
        value: null,
        ...("known_bits" in apu.read
          ? { known_bits: apu.read.known_bits }
          : {}),
        file_offset: null,
        ram_origins: [],
        mapper_origins: [apu.read.source],
      };
    return controlled?.read == null
      ? (ppuRead ?? irqRead ?? mapperRead)
      : {
          value: null,
          ...("known_bits" in controlled.read
            ? { known_bits: controlled.read.known_bits }
            : {}),
          file_offset: null,
          ram_origins: [],
          mapper_origins: [controlled.read.source],
        };
  }
  private readMapperIrqPort(address: number | null) {
    if (!isNamco163IrqState(this.irq) || this.mapper.mapper !== 19) return null;
    const read = readNamco163Irq(this.irq, this.mapper, address);
    return read === null
      ? null
      : {
          value: read.value,
          ...("known_bits" in read ? { known_bits: read.known_bits } : {}),
          file_offset: null,
          ram_origins: [],
          mapper_origins: [
            { ...read.source, mapper_event_index: this.mapperEventCount },
          ],
        };
  }
  private captureOamDma(haltedAddress: number | null): void {
    if (this.ppu?.oam?.dma_pending.status !== "pending") return;
    const page = this.ppu.oam.dma_pending.page;
    if (typeof page !== "number") return;
    const reads: NesDataRead[] = [];
    for (let offset = 0; offset < 256; offset++) {
      const address = page * 256 + offset;
      const source =
        page >= 0x20 && page <= 0x5f
          ? {
              value: null,
              file_offset: null,
              ram_origins: [],
              mapper_origins: [],
            }
          : this.instructionSource(address);
      const read = this.projectDataRead(address, source),
        cost = nesCpuReadProofBytes([read]) + (reads.length === 0 ? 0 : 1);
      if (cost > this.maxOamSourceBytes - this.oamSourceBytes) {
        this.oamDmaFrontier = {
          page,
          reads,
          available_source_bytes: this.maxOamSourceBytes,
          retained_source_bytes: this.oamSourceBytes,
        };
        return;
      }
      this.oamSourceBytes += cost;
      reads.push(read);
    }
    const values = reads.map(
      (read) => read.value ?? ("known_bits" in read ? read.known_bits : null),
    );
    const operation = applyNesOamDma(
      this.mapper,
      this.ppu,
      page,
      values,
      this.ppu.next_event_index,
    );
    this.oamDmaReads = reads;
    this.ppuOperations.push(operation);
    const event: NesMapperEvent =
      this.controllers === null
        ? { kind: "oam-dma", page, values }
        : { kind: "oam-dma", page, values, halted_cpu_address: haltedAddress };
    this.applyControllerEvent(event);
    this.applyApuEvent(event);
    this.retainEvent(event);
    this.mapping = mapperMapping(this.header, this.mapper, {
      chrRamSize: this.ppu.chr_ram_size,
    });
  }
  get retainedOamSourceBytes(): number {
    return this.oamSourceBytes;
  }
  startOrderedOamDma(page: number): void {
    const event = { kind: "oam-dma-start", page } as const;
    this.cpuDma!.state.oam_dma_pending = { status: "none" };
    this.ppuOperations.push(
      startNesOamDma(this.mapper, this.ppu!, page, this.ppu!.next_event_index),
    );
    this.applyControllerEvent(event);
    this.applyApuEvent(event);
    this.retainEvent(event);
  }
  write(
    address: number,
    byte: NesByteValue,
    consecutive = false,
    role: NesCpuBusWriteRole = "data",
  ): void {
    if (this.bus?.stopped != null) return;
    this.prepareDmcStop();
    if (address === 0x4014 && this.cpuDma !== null)
      this.cpuDma.state.oam_dma_pending = { status: "pending", page: byte };
    const value = typeof byte === "number" ? byte : null;
    const known_bits =
      typeof byte === "object" && byte !== null ? byte : undefined;
    const partial = known_bits === undefined ? {} : { known_bits };
    const write: NesMapperWrite =
      known_bits === undefined
        ? { address, value, preceded_by_cpu_write: consecutive }
        : {
            address,
            value: null,
            preceded_by_cpu_write: consecutive,
            known_bits,
          };
    this.writes.push(write);
    const apuWrite = this.applyApuEvent({ kind: "cpu-write", ...write });
    const ppuEventIndex = this.ppu?.next_event_index;
    let retainedWrite = false;
    const controllerWrite = this.applyControllerEvent({
      kind: "cpu-write",
      ...write,
    });
    const ppuWrite =
      this.ppu === null
        ? null
        : writeNesPpuCpu(this.header, this.mapper, this.ppu, {
            address,
            value: byte,
            index: this.ppu.next_event_index,
            dmcReadsModeled: this.dmc !== null,
          });
    if (
      (this.ppu !== null &&
        (ppuWrite !== null || isNesMapperWriteAddress(this.header, address))) ||
      (this.controllers !== null &&
        (controllerWrite !== null ||
          isNesMapperWriteAddress(this.header, address))) ||
      (this.apu !== null &&
        (apuWrite !== null || isNesMapperWriteAddress(this.header, address))) ||
      (this.irq !== null && isNesMapperWriteAddress(this.header, address))
    ) {
      if (ppuWrite !== null) this.ppuOperations.push(ppuWrite);
      this.retainEvent({ kind: "cpu-write", ...write });
      retainedWrite = true;
      this.mapping = mapperMapping(this.header, this.mapper, {
        chrRamSize: this.ppu?.chr_ram_size ?? null,
      });
    }
    const access = this.ramAccess(address);
    if (access !== null && access.writable !== false) {
      for (const location of access.locations) {
        const key = this.ramKey(location);
        if (access.writable === true && access.locations.length === 1)
          this.ram.set(key, {
            value: write.value,
            ...partial,
            origin:
              this.interruptIndex !== null
                ? {
                    interrupt_index: this.interruptIndex,
                    interrupt_write_index: this.writes.length - 1,
                  }
                : this.instructionIndex === null
                  ? { entry_interrupt_write_index: this.writes.length - 1 }
                  : {
                      instruction_index: this.instructionIndex,
                      write_index: this.writes.length - 1,
                    },
          });
        else {
          const previous = this.ram.get(key);
          if (previous === undefined) continue;
          // This cell may be written or retained. Its earlier source proves only
          // the bits shared by both possibilities, never a definite last writer.
          const proof = joinNesBytes(
            previous.value ?? previous.known_bits ?? null,
            write.value ?? known_bits ?? null,
          );
          if (proof === null) this.ram.delete(key);
          else
            this.ram.set(key, {
              value: typeof proof === "number" ? proof : null,
              ...(typeof proof === "number" ? {} : { known_bits: proof }),
              origin: previous.origin,
            });
        }
      }
    }
    if (
      isNesMapperWriteAddress(this.header, address) ||
      (hasNamco163ChipRam(this.mapper) && address === 0x4014)
    ) {
      if (isMmc5State(this.mapper) && this.instructionIndex !== null) {
        const source: NesMapperWriteSource = {
          kind: "cpu-write",
          instruction_index: this.instructionIndex,
          write_index: this.writes.length - 1,
        };
        if (address === 0x5205 || address === 0x5206)
          this.mmc5FactorSources[address - 0x5205] = source;
        if (address === 0x5104) this.mmc5ExramModeSource = source;
      }
      if (hasNamco163ChipRam(this.mapper)) {
        if (!retainedWrite) this.retainEvent({ kind: "cpu-write", ...write });
        if (this.instructionIndex !== null) {
          const source = {
            kind: "cpu-write" as const,
            instruction_index: this.instructionIndex,
            write_index: this.writes.length - 1,
          };
          if ((address & 0xf800) === 0xf800) this.chipAddressSource = source;
          if ((address & 0xf800) === 0x4800) {
            const addresses = namco163ChipAddresses(this.mapper.chip_ram);
            if (addresses.length === 1)
              this.chipByteSources.set(addresses[0]!, source);
          }
        }
      }
      const changed = applyMappedNesMapperWrite(
        this.header,
        this.mapper,
        write,
        {
          prg: this.prg,
          ...(isMmc5IrqState(this.irq)
            ? { mmc5_in_frame: this.irq.in_frame }
            : {}),
          ...(ppuEventIndex === undefined
            ? {}
            : { ppu_event_index: ppuEventIndex }),
        },
      );
      this.mapper = changed.state;
      if (
        isMmc5State(this.mapper) &&
        address >= 0x5c00 &&
        address <= 0x5fff &&
        this.ppu === null
      ) {
        if (changed.effect === "exram-write" && this.instructionIndex !== null)
          this.mmc5ExramSources.set(address - 0x5c00, {
            kind: "cpu-write",
            instruction_index: this.instructionIndex,
            write_index: this.writes.length - 1,
          });
        else if (
          readMmc5ExramCell(this.mapper, address - 0x5c00).value === null
        )
          this.mmc5ExramSources.delete(address - 0x5c00);
      }
      if (this.irq !== null)
        this.irq = writeNesCpuMapperIrq(
          this.irq,
          this.mapper,
          write,
          changed.effect,
        );
      if (changed.effect === "eeprom-control" && this.instructionIndex !== null)
        this.eepromControlSource = {
          kind: "cpu-write",
          instruction_index: this.instructionIndex,
          write_index: this.writes.length - 1,
        };
      if (
        isVrc2State(this.mapper) &&
        this.mapper.mapper === 23 &&
        address >= 0x6000 &&
        address <= 0x6fff
      )
        this.vrc2LatchSource =
          this.mapper.latch_present === true &&
          this.mapper.latch_value !== null &&
          this.instructionIndex !== null
            ? {
                kind: "cpu-write",
                instruction_index: this.instructionIndex,
                write_index: this.writes.length - 1,
              }
            : null;
      this.mapping = mapperMapping(this.header, this.mapper, {
        chrRamSize: this.ppu?.chr_ram_size ?? null,
      });
    }
    if (this.bus !== null) {
      this.io?.write(byte, this.bus.state.next_cycle_index);
      this.bus.write(write, this.writes.length - 1, role);
      this.clockCpuBus();
    }
  }
  push(value: NesByteValue, consecutive = false): void {
    if (this.cpu.sp === null)
      throw new Error("Stack must be resolved before applying effects");
    this.write(256 + this.cpu.sp, value, consecutive, "stack");
    setNesCpuByte(this.cpu, "sp", (this.cpu.sp - 1) & 255);
  }
  pop(): number | null {
    return this.popValue().value;
  }
  popValue(): NesDataRead {
    if (this.cpu.sp === null)
      throw new Error("Stack must be resolved before applying effects");
    const next = (this.cpu.sp + 1) & 255;
    setNesCpuByte(this.cpu, "sp", next);
    return this.readValue(256 + next, "stack");
  }
}
