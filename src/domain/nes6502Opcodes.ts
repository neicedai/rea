/** Official NMOS 6502 encodings, followed by explicitly supported stable aliases. */
const encodings = {
  ADC: {
    imm: 0x69,
    zp: 0x65,
    zpx: 0x75,
    abs: 0x6d,
    abx: 0x7d,
    aby: 0x79,
    izx: 0x61,
    izy: 0x71,
  },
  AND: {
    imm: 0x29,
    zp: 0x25,
    zpx: 0x35,
    abs: 0x2d,
    abx: 0x3d,
    aby: 0x39,
    izx: 0x21,
    izy: 0x31,
  },
  ASL: { acc: 0x0a, zp: 0x06, zpx: 0x16, abs: 0x0e, abx: 0x1e },
  BCC: { rel: 0x90 },
  BCS: { rel: 0xb0 },
  BEQ: { rel: 0xf0 },
  BIT: { zp: 0x24, abs: 0x2c },
  BMI: { rel: 0x30 },
  BNE: { rel: 0xd0 },
  BPL: { rel: 0x10 },
  BRK: { imp: 0x00 },
  BVC: { rel: 0x50 },
  BVS: { rel: 0x70 },
  CLC: { imp: 0x18 },
  CLD: { imp: 0xd8 },
  CLI: { imp: 0x58 },
  CLV: { imp: 0xb8 },
  CMP: {
    imm: 0xc9,
    zp: 0xc5,
    zpx: 0xd5,
    abs: 0xcd,
    abx: 0xdd,
    aby: 0xd9,
    izx: 0xc1,
    izy: 0xd1,
  },
  CPX: { imm: 0xe0, zp: 0xe4, abs: 0xec },
  CPY: { imm: 0xc0, zp: 0xc4, abs: 0xcc },
  DEC: { zp: 0xc6, zpx: 0xd6, abs: 0xce, abx: 0xde },
  DEX: { imp: 0xca },
  DEY: { imp: 0x88 },
  EOR: {
    imm: 0x49,
    zp: 0x45,
    zpx: 0x55,
    abs: 0x4d,
    abx: 0x5d,
    aby: 0x59,
    izx: 0x41,
    izy: 0x51,
  },
  INC: { zp: 0xe6, zpx: 0xf6, abs: 0xee, abx: 0xfe },
  INX: { imp: 0xe8 },
  INY: { imp: 0xc8 },
  JMP: { abs: 0x4c, ind: 0x6c },
  JSR: { abs: 0x20 },
  LDA: {
    imm: 0xa9,
    zp: 0xa5,
    zpx: 0xb5,
    abs: 0xad,
    abx: 0xbd,
    aby: 0xb9,
    izx: 0xa1,
    izy: 0xb1,
  },
  LDX: { imm: 0xa2, zp: 0xa6, zpy: 0xb6, abs: 0xae, aby: 0xbe },
  LDY: { imm: 0xa0, zp: 0xa4, zpx: 0xb4, abs: 0xac, abx: 0xbc },
  LSR: { acc: 0x4a, zp: 0x46, zpx: 0x56, abs: 0x4e, abx: 0x5e },
  NOP: { imp: 0xea },
  ORA: {
    imm: 0x09,
    zp: 0x05,
    zpx: 0x15,
    abs: 0x0d,
    abx: 0x1d,
    aby: 0x19,
    izx: 0x01,
    izy: 0x11,
  },
  PHA: { imp: 0x48 },
  PHP: { imp: 0x08 },
  PLA: { imp: 0x68 },
  PLP: { imp: 0x28 },
  ROL: { acc: 0x2a, zp: 0x26, zpx: 0x36, abs: 0x2e, abx: 0x3e },
  ROR: { acc: 0x6a, zp: 0x66, zpx: 0x76, abs: 0x6e, abx: 0x7e },
  RTI: { imp: 0x40 },
  RTS: { imp: 0x60 },
  SBC: {
    imm: 0xe9,
    zp: 0xe5,
    zpx: 0xf5,
    abs: 0xed,
    abx: 0xfd,
    aby: 0xf9,
    izx: 0xe1,
    izy: 0xf1,
  },
  SEC: { imp: 0x38 },
  SED: { imp: 0xf8 },
  SEI: { imp: 0x78 },
  STA: {
    zp: 0x85,
    zpx: 0x95,
    abs: 0x8d,
    abx: 0x9d,
    aby: 0x99,
    izx: 0x81,
    izy: 0x91,
  },
  STX: { zp: 0x86, zpy: 0x96, abs: 0x8e },
  STY: { zp: 0x84, zpx: 0x94, abs: 0x8c },
  TAX: { imp: 0xaa },
  TAY: { imp: 0xa8 },
  TSX: { imp: 0xba },
  TXA: { imp: 0x8a },
  TXS: { imp: 0x9a },
  TYA: { imp: 0x98 },
} as const;
const lengths = {
  imp: 1,
  acc: 1,
  imm: 2,
  zp: 2,
  zpx: 2,
  zpy: 2,
  izx: 2,
  izy: 2,
  rel: 2,
  abs: 3,
  abx: 3,
  aby: 3,
  ind: 3,
} as const;
export interface Nes6502Opcode {
  readonly encoding: "official" | "unofficial";
  readonly mnemonic:
    | keyof typeof encodings
    | "LAX"
    | "SAX"
    | "ANC"
    | "ALR"
    | "AXS"
    | "DCP"
    | "ISC"
    | "SLO"
    | "RLA"
    | "SRE"
    | "RRA"
    | "ARR"
    | "LAS";
  readonly mode: keyof typeof lengths;
  readonly length: 1 | 2 | 3;
}
const table = new Map<number, Nes6502Opcode>();
for (const mnemonic of Object.keys(encodings) as (keyof typeof encodings)[])
  for (const [name, opcode] of Object.entries(encodings[mnemonic])) {
    const mode = name as keyof typeof lengths;
    table.set(opcode, {
      mnemonic,
      mode,
      length: lengths[mode],
      encoding: "official",
    });
  }
// NESdev: Programming with unofficial opcodes. Memory NOP read side effects,
// like other hardware reads in this conditional tracer, are not simulated.
const unofficialNops = {
  imp: [0x1a, 0x3a, 0x5a, 0x7a, 0xda, 0xfa],
  imm: [0x80, 0x82, 0x89, 0xc2, 0xe2],
  zp: [0x04, 0x44, 0x64],
  zpx: [0x14, 0x34, 0x54, 0x74, 0xd4, 0xf4],
  abs: [0x0c],
  abx: [0x1c, 0x3c, 0x5c, 0x7c, 0xdc, 0xfc],
} as const;
for (const mode of Object.keys(
  unofficialNops,
) as (keyof typeof unofficialNops)[])
  for (const opcode of unofficialNops[mode])
    table.set(opcode, {
      mnemonic: "NOP",
      mode,
      length: lengths[mode],
      encoding: "unofficial",
    });
table.set(0xeb, {
  mnemonic: "SBC",
  mode: "imm",
  length: 2,
  encoding: "unofficial",
});
const unofficialMemory = {
  SLO: {
    izx: 0x3,
    zp: 0x7,
    abs: 0xf,
    izy: 0x13,
    zpx: 0x17,
    aby: 0x1b,
    abx: 0x1f,
  },
  RLA: {
    izx: 0x23,
    zp: 0x27,
    abs: 0x2f,
    izy: 0x33,
    zpx: 0x37,
    aby: 0x3b,
    abx: 0x3f,
  },
  SRE: {
    izx: 0x43,
    zp: 0x47,
    abs: 0x4f,
    izy: 0x53,
    zpx: 0x57,
    aby: 0x5b,
    abx: 0x5f,
  },
  RRA: {
    izx: 0x63,
    zp: 0x67,
    abs: 0x6f,
    izy: 0x73,
    zpx: 0x77,
    aby: 0x7b,
    abx: 0x7f,
  },

  DCP: {
    izx: 0xc3,
    zp: 0xc7,
    abs: 0xcf,
    izy: 0xd3,
    zpx: 0xd7,
    aby: 0xdb,
    abx: 0xdf,
  },
  ISC: {
    izx: 0xe3,
    zp: 0xe7,
    abs: 0xef,
    izy: 0xf3,
    zpx: 0xf7,
    aby: 0xfb,
    abx: 0xff,
  },
  LAS: { aby: 0xbb },
  LAX: { izx: 0xa3, zp: 0xa7, abs: 0xaf, izy: 0xb3, zpy: 0xb7, aby: 0xbf },
  SAX: { izx: 0x83, zp: 0x87, abs: 0x8f, zpy: 0x97 },
} as const;
for (const mnemonic of Object.keys(
  unofficialMemory,
) as (keyof typeof unofficialMemory)[])
  for (const [name, opcode] of Object.entries(unofficialMemory[mnemonic])) {
    const mode = name as keyof typeof lengths;
    table.set(opcode, {
      mnemonic,
      mode,
      length: lengths[mode],
      encoding: "unofficial",
    });
  }
for (const [opcode, mnemonic] of [
  [0x0b, "ANC"],
  [0x2b, "ANC"],
  [0x4b, "ALR"],
  [0xcb, "AXS"],
  [0x6b, "ARR"],
] as const)
  table.set(opcode, {
    mnemonic,
    mode: "imm",
    length: 2,
    encoding: "unofficial",
  });
export const decodeNes6502Opcode = (
  opcode: number,
): Nes6502Opcode | undefined => table.get(opcode);
