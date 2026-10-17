import type { NesRomMetadata } from "./nes.js";
import {
  nesMapperStateSchema,
  type NesMapperState,
  type NesMapperMapping,
} from "./nesMapperTrace.js";
import type { NesCodeDiscovery } from "./nesCodeDiscovery.js";
import type { NesDataRead, NesCodeVector } from "./nesCodeTrace.js";
import { setNesCpuByte } from "./nesCpuRegister.js";
import type { NesByteValue } from "./nesByteValue.js";
import type { Nes6502InstructionContext } from "./nes6502Instruction.js";
import type { NesCpuBusReadRole, NesCpuBusWriteRole } from "./nes6502Bus.js";
import type { NesDiscoveryState } from "./nesCodeDiscoveryState.js";
import {
  readNesDiscoveryRam,
  writeNesDiscoveryRam,
  markUnknownNesDiscoveryRamWrites,
  clearNesDiscoveryStack,
} from "./nesCodeDiscoveryRam.js";
import {
  moveNesDiscoveryStack,
  writeNesDiscoveryStack,
  invalidateNesDiscoveryFrame,
} from "./nesCodeDiscoveryFrame.js";
import type { NesDiscoveryEvidence } from "./nesCodeDiscoveryEvidence.js";
import type { NesDiscoveryRelativeEvidence } from "./nesCodeDiscoveryRelativeEvidence.js";
import {
  NesDiscoveryStackMemory,
  type NesDiscoveryStackByteProof,
} from "./nesCodeDiscoveryStackMemory.js";
import { mapperMapping } from "./nesMapperTraceMapping.js";
import {
  applyMappedNesMapperWrite,
  isNesMapperWriteAddress,
} from "./nesMapperTraceDerivation.js";
import type { Nes6502Opcode } from "./nes6502Opcodes.js";
import type { NesDiscoveryDomainEvidence } from "./nesCodeDiscoveryDomainEvidence.js";
import type { NesDiscoveryConditionEvidence } from "./nesCodeDiscoveryConditionEvidence.js";
import {
  assignNesDiscoveryValue,
  copyNesDiscoveryValue,
  forgetNesDiscoveryValues,
  nesDiscoveryValueDomain,
  nesDiscoveryValueConditions,
  nesDiscoveryRegisterVariables,
} from "./nesCodeDiscoveryValues.js";
import {
  nesDiscoveryByteDomain,
  nesDiscoveryDomainProof,
} from "./nesCodeDiscoveryDomains.js";
import { discoverNesCodeImmutableProfile } from "./nesCodeDiscoveryProfile.js";

type Reference = Extract<
  NesCodeDiscovery,
  { status: "derived" }
>["data_references"][number];
export const unknownNesDiscoveryMapper = (
  state: NesMapperState,
): NesMapperState =>
  nesMapperStateSchema.parse(discoverNesCodeImmutableProfile(state));

/** Original bytes are resolved independently, including operands crossing CPU windows. */
export const readNesDiscoveryRom = (
  header: NesRomMetadata,
  prg: Uint8Array,
  mapping: NesMapperMapping,
  address: number,
) => {
  const window = mapping.prg_windows.find(
      (window) =>
        address >= window.start && address < window.start + window.size,
    ),
    file_offset =
      window?.file_offset == null
        ? null
        : window.file_offset + address - window.start;
  return {
    value:
      file_offset === null
        ? null
        : (prg[file_offset - header.prgRom.offset] ?? null),
    file_offset,
  };
};

/** Static semantic memory has no selected device model, bus clocks or read side effects. */
export class NesCodeDiscoveryMemory implements Nes6502InstructionContext {
  readonly bus = null;
  readonly controllers = null;
  callDepth = 0;
  readonly cpu;
  readonly references: Omit<Reference, "index" | "analysis_index">[] = [];
  readonly frontiers: string[] = [];
  mapping;
  readonly header: NesRomMetadata;
  readonly prg: Uint8Array;
  readonly evidence: NesDiscoveryEvidence;
  readonly analysisIndex: number;
  readonly stackMemory: NesDiscoveryStackMemory;
  stackAliasConflict = false;
  readonly invalidatedVariables = new Set<number>();
  operandSource: { variable: number | null; domain: bigint } | null = null;
  private opcode: Nes6502Opcode | null = null;
  private before: NesDiscoveryState | null = null;
  readonly domainEvidence: NesDiscoveryDomainEvidence;
  readonly conditionEvidence: NesDiscoveryConditionEvidence;
  private lastStackProof: NesDiscoveryStackByteProof = null;
  constructor(
    source: {
      header: NesRomMetadata;
      prg: Uint8Array;
      evidence: NesDiscoveryEvidence;
      relativeEvidence: NesDiscoveryRelativeEvidence;
      analysisIndex: number;
      domainEvidence: NesDiscoveryDomainEvidence;
      conditionEvidence: NesDiscoveryConditionEvidence;
    },
    public mapper: NesMapperState,
    readonly state: NesDiscoveryState,
    readonly nodeIndex: number,
  ) {
    this.header = source.header;
    this.prg = source.prg;
    this.evidence = source.evidence;
    this.analysisIndex = source.analysisIndex;
    this.domainEvidence = source.domainEvidence;
    this.conditionEvidence = source.conditionEvidence;
    this.cpu = state.cpu;
    this.stackMemory = new NesDiscoveryStackMemory(state, {
      physicalEvidence: source.evidence,
      relativeEvidence: source.relativeEvidence,
      nodeIndex,
      analysisIndex: source.analysisIndex,
      domains: source.domainEvidence,
      conditions: source.conditionEvidence,
      physicalOrigin: (address, domain) => this.physicalOrigin(address, domain),
    });
    this.mapping = mapperMapping(this.header, mapper);
  }
  prepareInstruction(opcode: Nes6502Opcode, before: NesDiscoveryState): void {
    this.opcode = opcode;
    this.before = before;
  }
  private sourceDomain(value: NesByteValue): bigint {
    const register =
      this.opcode?.mnemonic === "STA" || this.opcode?.mnemonic === "PHA"
        ? "a"
        : this.opcode?.mnemonic === "STX"
          ? "x"
          : this.opcode?.mnemonic === "STY"
            ? "y"
            : null;
    return register === null || this.before === null
      ? nesDiscoveryByteDomain(value)
      : this.before.register_domains[register];
  }
  private sourceVariable(): number | null {
    const register =
      this.opcode?.mnemonic === "STA"
        ? "a"
        : this.opcode?.mnemonic === "STX"
          ? "x"
          : this.opcode?.mnemonic === "STY"
            ? "y"
            : null;
    return register === null ? null : nesDiscoveryRegisterVariables[register];
  }
  private relativeStackRead(address: number | null, role: NesCpuBusReadRole) {
    if (address === null)
      return role === "stack" ? this.stackMemory.read(null) : undefined;
    const physical = address & 2047;
    return address < 0x2000 &&
      physical >= 256 &&
      physical < 512 &&
      this.cpu.sp !== null
      ? this.stackMemory.read(physical)
      : undefined;
  }
  private physicalOrigin(
    physical: number,
    domain: bigint,
  ): Reference["ram_origins"][number] {
    const cell = readNesDiscoveryRam(this.state.ram, physical);
    return {
      ram_address: physical,
      writer_nodes: this.evidence.writerNodes(
        cell?.writer_witness_indices ?? [],
      ),
      writer_witness_indices: [...(cell?.writer_witness_indices ?? [])],
      domain_index: this.domainEvidence.domain(domain),
      initial_unwritten_possible: cell?.initial_unwritten_possible ?? true,
      unknown_write_possible: cell?.unknown_write_possible ?? false,
      condition_witness_indices: [
        ...nesDiscoveryValueConditions(this.state.values, 4 + physical),
      ],
    };
  }
  readValue(
    address: number | null,
    role: NesCpuBusReadRole = "data",
  ): NesDataRead {
    let value: NesByteValue = null,
      file_offset: number | null = null;
    let ram_origins: Reference["ram_origins"] = [],
      relative_stack_origins: Reference["relative_stack_origins"] = [];
    const stack = this.relativeStackRead(address, role);
    if (stack !== undefined) {
      const source = stack;
      value = source.value;
      ram_origins = source.ram_origins;
      relative_stack_origins = source.relative_stack_origins;
      this.lastStackProof = source.proof;
      if (source.conflict) {
        this.stackAliasConflict = true;
        this.frontiers.push("stack-alias-conflict");
      }
    } else if (address !== null && address < 0x2000) {
      const physical = address & 2047,
        domain = nesDiscoveryValueDomain(this.state.values, 4 + physical);
      value = nesDiscoveryDomainProof(domain);
      ram_origins.push(this.physicalOrigin(physical, domain));
    } else if (address !== null) {
      const source = readNesDiscoveryRom(
        this.header,
        this.prg,
        this.mapping,
        address,
      );
      value = source.value;
      file_offset = source.file_offset;
    }
    if (role !== "pointer")
      this.operandSource = {
        variable:
          address !== null && address < 0x2000 ? 4 + (address & 2047) : null,
        domain:
          address !== null && address < 0x2000
            ? nesDiscoveryValueDomain(this.state.values, 4 + (address & 2047))
            : (stack?.domain ?? nesDiscoveryByteDomain(value)),
      };
    this.references.push({
      node_index: this.nodeIndex,
      kind: role === "pointer" ? "pointer" : "read",
      address,
      value,
      file_offsets: file_offset === null ? [] : [file_offset],
      ram_origins,
      relative_stack_origins,
    });
    const base = { address, file_offset, ram_origins: [], mapper_origins: [] };
    return typeof value === "number"
      ? { ...base, value }
      : value === null
        ? { ...base, value: null }
        : { ...base, value: null, known_bits: value };
  }
  read(
    address: number | null,
    role: NesCpuBusReadRole = "data",
  ): number | null {
    return this.readValue(address, role).value;
  }
  readMapperDummy(address: number | null): void {
    this.readValue(address);
  }
  write(
    address: number,
    value: NesByteValue,
    consecutive = false,
    role: NesCpuBusWriteRole = "data",
  ): void {
    const domain = this.sourceDomain(value);
    value = nesDiscoveryDomainProof(domain);
    const mapperWrite = isNesMapperWriteAddress(this.header, address);
    const physical = address & 2047,
      relative_stack_origins =
        address < 0x2000 && physical >= 256 && physical < 512
          ? this.stackMemory.write(physical, value, domain)
          : [];
    this.references.push({
      node_index: this.nodeIndex,
      kind: mapperWrite ? "mapper-write" : "write",
      address,
      value,
      file_offsets: [],
      ram_origins: [],
      relative_stack_origins,
    });
    if (address < 0x2000) {
      const physical = address & 2047;
      if (physical >= 256 && physical < 512)
        writeNesDiscoveryStack(this.state.frame, physical, role === "stack");
      const witness = this.evidence.write({
        node_index: this.nodeIndex,
        analysis_index: this.analysisIndex,
        address: physical,
        domain,
      });
      const variable = 4 + physical,
        source = this.sourceVariable();
      this.invalidatedVariables.add(variable);
      this.state.values =
        source === null
          ? assignNesDiscoveryValue(this.state.values, variable, domain)
          : copyNesDiscoveryValue(this.state.values, variable, source);
      this.state.ram = writeNesDiscoveryRam(this.state.ram, physical, {
        writer_witness_indices: [witness],
        initial_unwritten_possible: false,
        unknown_write_possible: false,
      });
    }
    if (mapperWrite) {
      const base = {
          address,
          value: typeof value === "number" ? value : null,
          preceded_by_cpu_write: consecutive,
        },
        write =
          typeof value === "object" && value !== null
            ? { ...base, value: null, known_bits: value }
            : base;
      const changed = applyMappedNesMapperWrite(
        this.header,
        this.mapper,
        write,
        {
          prg: this.prg,
        },
      );
      if (changed.rom_bus !== null)
        this.references.push({
          node_index: this.nodeIndex,
          kind: "mapper-bus",
          address,
          value: changed.rom_bus.value,
          file_offsets: changed.rom_bus.sources.map(
            (source) => source.file_offset,
          ),
          ram_origins: [],
          relative_stack_origins: [],
        });
      this.mapper = changed.state;
      this.mapping = mapperMapping(this.header, this.mapper);
    }
  }
  push(value: NesByteValue, consecutive = false): void {
    if (this.cpu.sp === null) {
      setNesCpuByte(this.cpu, "sp", null);
      writeNesDiscoveryStack(this.state.frame, null, true);
      this.state.ram = clearNesDiscoveryStack(this.state.ram);
      const variables = Array.from({ length: 256 }, (_, i) => 260 + i);
      for (const variable of variables) this.invalidatedVariables.add(variable);
      this.state.values = forgetNesDiscoveryValues(
        this.state.values,
        variables,
      );
      this.references.push({
        node_index: this.nodeIndex,
        kind: "write",
        address: null,
        value,
        file_offsets: [],
        ram_origins: [],
        relative_stack_origins: this.stackMemory.write(
          null,
          value,
          this.sourceDomain(value),
        ),
      });
    } else {
      this.write(256 + this.cpu.sp, value, consecutive, "stack");
      this.cpu.sp = (this.cpu.sp - 1) & 255;
    }
    moveNesDiscoveryStack(this.state.frame, -1);
    this.stackMemory.shift(-1);
  }
  popValue(): NesDataRead & { stack_proof: NesDiscoveryStackByteProof } {
    moveNesDiscoveryStack(this.state.frame, 1);
    this.stackMemory.shift(1);
    this.lastStackProof = null;
    if (this.cpu.sp === null) {
      setNesCpuByte(this.cpu, "sp", null);
      const value = this.readValue(null, "stack");
      return { ...value, stack_proof: this.lastStackProof };
    }
    this.cpu.sp = (this.cpu.sp + 1) & 255;
    const value = this.readValue(256 + this.cpu.sp, "stack");
    return { ...value, stack_proof: this.lastStackProof };
  }
  readVector(kind: "reset" | "nmi" | "irq") {
    return readNesDiscoveryVector(this.header, this.prg, this.mapping, kind);
  }
  invalidateUnknownStore(): void {
    this.state.ram = markUnknownNesDiscoveryRamWrites(this.state.ram);
    const variables = Array.from({ length: 2048 }, (_, i) => 4 + i);
    for (const variable of variables) this.invalidatedVariables.add(variable);
    this.state.values = forgetNesDiscoveryValues(this.state.values, variables);
    this.stackMemory.clear();
    invalidateNesDiscoveryFrame(this.state.frame);
    this.mapper = unknownNesDiscoveryMapper(this.mapper);
    this.mapping = mapperMapping(this.header, this.mapper);
  }
}

export const readNesDiscoveryVector = (
  header: NesRomMetadata,
  prg: Uint8Array,
  mapping: NesMapperMapping,
  kind: "reset" | "nmi" | "irq",
): {
  reads: NonNullable<NesCodeVector>;
  target: number | null;
} => {
  const base = { reset: 0xfffc, nmi: 0xfffa, irq: 0xfffe }[kind],
    reads = [base, base + 1].map((address) => ({
      address,
      ...readNesDiscoveryRom(header, prg, mapping, address),
    })),
    low = reads[0]!.value,
    high = reads[1]!.value;
  return {
    reads,
    target: low === null || high === null ? null : low | (high << 8),
  };
};
