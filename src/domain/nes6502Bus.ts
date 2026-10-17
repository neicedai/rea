import type {
  NesCpuBusState,
  NesCpuBusCycle,
  NesDataRead,
  NesDmaIoRead,
  NesDmaCpuBusCycle,
} from "./nesCodeTrace.js";
import type { NesMapperWrite } from "./nesMapperTrace.js";

export type NesCpuBusReadRole = Extract<
  NesCpuBusCycle,
  { kind: "read" }
>["role"];
export type NesCpuBusWriteRole = Extract<
  NesCpuBusCycle,
  { kind: "write" }
>["role"];
/** One source path owns nominal bus progress; a stopped source action owns only its frontier. */
export class Nes6502Bus {
  readonly initial: NesCpuBusState;
  readonly initialized: NesCpuBusState;
  readonly state: NesCpuBusState;
  cycles: NesDmaCpuBusCycle[] = [];
  stopped: {
    reason:
      | "cpu-timing-dma"
      | "cpu-timing-unresolved"
      | "cpu-dma-request"
      | "cpu-dma-phase"
      | "cpu-dma-io-conflict"
      | "cpu-io-controller-uncertain"
      | "oam-dma-source-budget"
      | "dmc-dma-request"
      | "dmc-dma-phase"
      | "dmc-dma-address"
      | "dmc-dma-stop-timing"
      | "dmc-dma-stop-window"
      | "dmc-dma-source-budget";
    address: number | null;
  } | null = null;
  constructor(
    initial: NesCpuBusState,
    pending: boolean,
    private readonly modeledOam = false,
    private readonly modeledDmc = false,
  ) {
    this.initial = structuredClone(initial);
    this.state = structuredClone(initial);
    if (pending && !modeledOam) this.state.dma_reads = "unobserved";
    this.initialized = structuredClone(this.state);
  }
  begin(): void {
    this.cycles = [];
    this.stopped = null;
  }
  permitRead(address: number | null): boolean {
    if (this.stopped !== null) return false;
    if (this.state.dma_reads !== "absent")
      this.stopped = { reason: "cpu-timing-dma", address };
    return this.stopped === null;
  }
  unresolved(address: number | null): void {
    this.stopped ??= { reason: "cpu-timing-unresolved", address };
  }
  read(read: NesDataRead, role: NesCpuBusReadRole, io?: NesDmaIoRead): void {
    this.cycles.push({
      kind: "read",
      index: this.state.next_cycle_index++,
      role,
      read: structuredClone(read),
      ...(io === undefined ? {} : { dma_io: structuredClone(io) }),
    });
  }
  write(write: NesMapperWrite, index: number, role: NesCpuBusWriteRole): void {
    this.cycles.push({
      kind: "write",
      index: this.state.next_cycle_index++,
      role,
      write_index: index,
    });
    if (
      (write.address === 0x4014 && !this.modeledOam) ||
      (!this.modeledDmc &&
        write.address === 0x4015 &&
        (write.value === null
          ? !("known_bits" in write) ||
            (write.known_bits.mask & 16) === 0 ||
            (write.known_bits.value & 16) !== 0
          : (write.value & 16) !== 0))
    )
      this.state.dma_reads = "unobserved";
  }
}
