export type Nes6502BranchFlag = "c" | "z" | "n" | "v";
export type Nes6502BranchCondition = Readonly<{
  flag: Nes6502BranchFlag;
  expected: boolean;
}>;
const branches = new Map<string, Nes6502BranchCondition>([
  ["BCC", Object.freeze({ flag: "c", expected: false })],
  ["BCS", Object.freeze({ flag: "c", expected: true })],
  ["BEQ", Object.freeze({ flag: "z", expected: true })],
  ["BNE", Object.freeze({ flag: "z", expected: false })],
  ["BMI", Object.freeze({ flag: "n", expected: true })],
  ["BPL", Object.freeze({ flag: "n", expected: false })],
  ["BVC", Object.freeze({ flag: "v", expected: false })],
  ["BVS", Object.freeze({ flag: "v", expected: true })],
]);

/** The tested flag and taken polarity are shared by tracing and static discovery. */
export const nes6502BranchCondition = (
  mnemonic: string,
): Nes6502BranchCondition | null => branches.get(mnemonic) ?? null;

/** Relative operands are signed bytes; instruction targets wrap at the CPU address boundary. */
export const nes6502BranchTarget = (
  next: number,
  displacement: number,
): number =>
  (next + (displacement < 128 ? displacement : displacement - 256)) & 65535;
