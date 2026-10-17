import { describe, expect, it } from "vitest";
import type { Nes6502Opcode } from "./nes6502Opcodes.js";
import { nesCpuStateSchema } from "./nesCodeTrace.js";
import {
  isNesRegisterRelations,
  joinNesRegisterRelations,
  nesRegisterEquals,
  nesRegisterRelationMasks,
  transferNesRegisterRelations,
} from "./nesCodeDiscoveryRegisterRelations.js";

const unknown = nesCpuStateSchema.parse({});
const transfer = (
  relations: number,
  mnemonic: Nes6502Opcode["mnemonic"],
  mode: Nes6502Opcode["mode"] = "imp",
) =>
  transferNesRegisterRelations(relations, { mnemonic, mode }, unknown, unknown);

describe("discovery register equivalence", () => {
  it("admits exactly the 15 canonical relations and intersects every pair", () => {
    expect(
      Array.from({ length: 64 }, (_, value) => value).filter(
        isNesRegisterRelations,
      ),
    ).toEqual(nesRegisterRelationMasks);
    for (const invalid of [null, undefined, true, -1, 64, 1.5, NaN, "1"])
      expect(isNesRegisterRelations(invalid)).toBe(false);
    for (const left of nesRegisterRelationMasks)
      for (const right of nesRegisterRelationMasks) {
        const common = joinNesRegisterRelations(left, right);
        expect(isNesRegisterRelations(common)).toBe(true);
        expect(common & ~left).toBe(0);
        expect(common & ~right).toBe(0);
      }
    expect(joinNesRegisterRelations(11, 21)).toBe(1);
    expect(joinNesRegisterRelations(3, 63)).toBe(0);
  });

  it("copies the source group while replacing the destination's old aliases", () => {
    expect(transfer(12, "TAX")).toBe(21);
    expect(transfer(21, "TAY")).toBe(63);
    expect(transfer(18, "TXA")).toBe(21);
    expect(nesRegisterEquals(21, "a")).toEqual(["a", "x", "sp"]);
    expect(nesRegisterEquals(21, "y")).toEqual(["y"]);
    for (const [mnemonic, expected] of [
      ["TAX", 1],
      ["TAY", 2],
      ["TXA", 1],
      ["TYA", 2],
      ["TSX", 16],
      ["TXS", 16],
    ] as const)
      expect(transfer(0, mnemonic)).toBe(expected);
  });

  it("kills only the register written by ordinary and unofficial ALU instructions", () => {
    for (const mnemonic of [
      "LDA",
      "ADC",
      "SBC",
      "AND",
      "ORA",
      "EOR",
      "ANC",
      "ALR",
      "ARR",
      "SLO",
      "RLA",
      "SRE",
      "RRA",
      "ISC",
    ] as const)
      expect(transfer(63, mnemonic)).toBe(56);
    for (const mnemonic of ["LDX", "INX", "DEX", "AXS"] as const)
      expect(transfer(63, mnemonic)).toBe(38);
    for (const mnemonic of ["LDY", "INY", "DEY"] as const)
      expect(transfer(63, mnemonic)).toBe(21);
  });

  it("distinguishes accumulator shifts from memory and preserves flag/store flow", () => {
    for (const mnemonic of ["ASL", "LSR", "ROL", "ROR"] as const) {
      expect(transfer(63, mnemonic, "acc")).toBe(56);
      expect(transfer(63, mnemonic, "abs")).toBe(63);
    }
    for (const mnemonic of [
      "INC",
      "DEC",
      "DCP",
      "CMP",
      "CPX",
      "CPY",
      "BIT",
      "CLC",
      "SEC",
      "CLD",
      "SED",
      "CLI",
      "SEI",
      "CLV",
      "STA",
      "STX",
      "STY",
      "SAX",
      "JMP",
      "NOP",
      "BCC",
      "BCS",
      "BEQ",
      "BMI",
      "BNE",
      "BPL",
      "BVC",
      "BVS",
    ] as const)
      expect(transfer(63, mnemonic)).toBe(63);
  });

  it("invalidates SP on every stack movement and A on PLA", () => {
    for (const mnemonic of [
      "PHA",
      "PHP",
      "PLP",
      "JSR",
      "RTS",
      "RTI",
      "BRK",
    ] as const)
      expect(transfer(63, mnemonic)).toBe(11);
    expect(transfer(63, "PLA")).toBe(8);
  });

  it("establishes only the loaded LAX and LAS alias groups", () => {
    expect(transfer(63, "LAX")).toBe(33);
    expect(transfer(63, "LAS")).toBe(21);
    expect(nesRegisterEquals(transfer(0, "LAS"), "sp")).toEqual([
      "a",
      "x",
      "sp",
    ]);
  });
});

describe("discovery relation facts and convergence", () => {
  it("checks partial-byte compatibility without deriving equality from envelopes", () => {
    const complementary = nesCpuStateSchema.parse({
      register_bits: { a: { mask: 240, value: 32 }, x: { mask: 15, value: 5 } },
    });
    expect(
      transferNesRegisterRelations(
        1,
        { mnemonic: "NOP", mode: "imp" },
        complementary,
        complementary,
      ),
    ).toBe(1);
    const equalNumbers = nesCpuStateSchema.parse({ a: 7, x: 7 });
    expect(
      transferNesRegisterRelations(
        0,
        { mnemonic: "NOP", mode: "imp" },
        equalNumbers,
        equalNumbers,
      ),
    ).toBe(0);
    const contradictory = nesCpuStateSchema.parse({ a: 7, x: 7, y: 8 });
    expect(
      transferNesRegisterRelations(
        11,
        { mnemonic: "NOP", mode: "imp" },
        contradictory,
        contradictory,
      ),
    ).toBe(0);
    const after = nesCpuStateSchema.parse({ a: 1, x: 2 });
    expect(
      transferNesRegisterRelations(
        1,
        { mnemonic: "NOP", mode: "imp" },
        unknown,
        after,
      ),
    ).toBe(0);
  });

  it("reaches a finite loop fixed point with no history IDs and clears unknown opcodes", () => {
    let relations = 63;
    const seen = new Set<number>();
    for (let iteration = 0; iteration < 1024; iteration++) {
      relations = joinNesRegisterRelations(
        relations,
        transfer(transfer(relations, "TAX"), "INX"),
      );
      expect(isNesRegisterRelations(relations)).toBe(true);
      seen.add(relations);
    }
    expect([...seen]).toEqual([38]);
    expect(transfer(63, "KIL" as Nes6502Opcode["mnemonic"])).toBe(0);
  });
});
