import type {
  NesCpuInterruptState,
  NesCpuInterruptSample,
  NesCpuInterruptPoll,
} from "./nesCpuInterrupts.js";

const any = (values: (boolean | null)[]): boolean | null =>
  values.includes(true) ? true : values.includes(null) ? null : false;

/** Owns boundary decisions, independent of the CPU's subsequently changed I flag. */
export class Nes6502Interrupts {
  readonly initial: NesCpuInterruptState;
  readonly state: NesCpuInterruptState;
  readonly polls: NesCpuInterruptPoll[] = [];
  private samples: NesCpuInterruptSample[] = [];
  private preceding: (NesCpuInterruptSample | null)[] = [];
  private physical: NesCpuInterruptSample | null = null;
  constructor(initial: NesCpuInterruptState) {
    this.initial = structuredClone(initial);
    this.state = structuredClone(initial);
  }
  begin(): void {
    this.samples = [];
    this.preceding = [];
    this.physical = null;
  }
  sample(
    sample: Omit<NesCpuInterruptSample, "external_irq" | "requested_irq">,
    dma = false,
  ): void {
    const irq = any([
      this.state.external_irq,
      sample.cartridge_irq,
      sample.apu_frame_irq,
      sample.apu_dmc_irq,
    ]);
    const captured = {
      ...sample,
      external_irq: this.state.external_irq,
      requested_irq:
        sample.i === true || irq === false
          ? false
          : sample.i === false && irq === true
            ? true
            : null,
    };
    if (!dma) {
      this.samples.push(captured);
      this.preceding.push(this.physical);
    }
    this.physical = captured;
  }
  poll(index: number, mnemonic: string, branch: boolean): void {
    const samples =
      mnemonic === "BRK"
        ? []
        : branch
          ? [
              this.preceding[1]!,
              ...(this.samples.length === 4 ? [this.preceding[3]!] : []),
            ]
          : [this.preceding.at(-1)!];
    this.state.pending_irq = any(samples.map((sample) => sample.requested_irq));
    this.polls.push({
      after_instruction_index: index,
      samples,
      pending_irq: this.state.pending_irq,
      pending_nmi: this.state.pending_nmi,
    });
  }
  decision(): "nmi" | "irq" | "unknown" | null {
    if (this.state.nmi_edges !== "absent") return "unknown";
    if (this.state.pending_nmi === true) return "nmi";
    if (this.state.pending_nmi === null) return "unknown";
    if (this.state.pending_irq === null) return "unknown";
    return this.state.pending_irq ? "irq" : null;
  }
  accepted(): void {
    this.state.pending_irq = false;
    this.state.pending_nmi = false;
  }
}
