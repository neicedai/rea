import type { Nes6502Context } from "./nes6502Context.js";
import type { NesDataRead } from "./nesCodeTrace.js";

/** Each operand owns its actual read, including JSR's late, possibly self-modified high byte. */
export class Nes6502InstructionFetch {
  private readonly reads: NesDataRead[] = [];
  constructor(
    private readonly context: Nes6502Context,
    private readonly pc: number,
  ) {}
  read(index: number): number | null {
    const address = (this.pc + index) & 65535;
    const read =
      this.context.bus === null
        ? this.context.peekInstruction(address)
        : this.context.readBus(address, index === 0 ? "opcode" : "operand");
    this.reads[index] = read;
    return read.value;
  }
  get bytes(): number[] {
    const bytes: number[] = [];
    for (const read of this.reads) {
      if (read.value === null) break;
      bytes.push(read.value);
    }
    return bytes;
  }
  fields() {
    const known = this.reads.slice(0, this.bytes.length);
    return {
      bytes_hex: Buffer.from(this.bytes).toString("hex"),
      file_offsets: known.map((read) => read.file_offset),
      ram_origins: known.flatMap((read, byte_index) =>
        read.ram_origins.map((origin) => ({ ...origin, byte_index })),
      ),
      mapper_origins: known.flatMap((read, byte_index) =>
        read.mapper_origins.map((origin) => ({ ...origin, byte_index })),
      ),
    };
  }
}
