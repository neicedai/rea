/** Authored literal 6502 bytes, independent of production decoding and domains. */
export const ALL_BYTES = Object.freeze(
  Array.from({ length: 256 }, (_, v) => v),
);
export const TABLE = 0xf000;
export const PAIR_TABLE = 0xf100;
export const entries = Object.freeze({
  range: 0xe000,
  negative: 0xe040,
  zero: 0xe080,
  nonzero: 0xe0c0,
  independent: 0xe100,
  increment: 0xe140,
  clc: 0xe180,
  unknownOperand: 0xe1c0,
  copies: 0xe200,
  joined: 0xe280,
  persisted: 0xe2c0,
  call: 0xe300,
  changedCall: 0xe340,
});
export const sites = Object.freeze({
  range: entries.range + 5,
  negative: entries.negative + 5,
  zero: entries.zero + 4,
  nonzero: entries.nonzero + 4,
  independent: entries.independent + 7,
  increment: entries.increment + 6,
  copies: entries.copies + 7,
  copiedPair: entries.copies + 10,
  joined: entries.joined + 9,
  persisted: entries.persisted + 7,
  callTable: 0xe500,
  callContinuation: entries.call + 8,
  changedContinuation: entries.changedCall + 8,
});
export const rotations = Object.freeze([
  { entry: 0xe600, mnemonic: "ROL", opcode: [0x2a], read: 0xe60d },
  { entry: 0xe640, mnemonic: "ROR", opcode: [0x6a], read: 0xe64d },
  { entry: 0xe680, mnemonic: "ARR", opcode: [0x6b, 255], read: 0xe68e },
]);
const readX = [0xbd, 0, 0xf0, 2];
const jump = (address) => [0x4c, address & 255, address >> 8];

function image(mapper = 0) {
  const prgSize = mapper === 0 ? 32768 : 65536;
  const bytes = Buffer.alloc(16 + prgSize + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, prgSize / 16384, 1, mapper << 4, 8]);
  const fixedOffset = (address) => 16 + prgSize - 8192 + address - 0xe000;
  const put = (address, code) => bytes.set(code, fixedOffset(address));
  put(TABLE, ALL_BYTES);
  put(
    PAIR_TABLE,
    ALL_BYTES.map((v) => v ^ 0xa5),
  );
  return { bytes, prgSize, fixedOffset, put };
}

export function fixture() {
  const { bytes, put } = image();
  put(entries.range, [0xe0, 10, 0x90, 1, 2, ...readX]);
  put(entries.negative, [0xe0, 5, 0x30, 1, 2, ...readX]);
  put(entries.zero, [0xe8, 0xf0, 1, 2, ...readX]);
  put(entries.nonzero, [0xe8, 0xd0, 1, 2, ...readX]);
  put(entries.independent, [0xe0, 8, 0xa9, 0, 0x90, 1, 2, ...readX]);
  put(entries.increment, [0xe0, 5, 0xe8, 0x90, 1, 2, ...readX]);
  put(entries.clc, [0xe0, 8, 0x18, 0x90, 1, 2, 2]);
  put(entries.unknownOperand, [0xe0, 8, 0xe4, 0x20, 0x90, 1, 2, 2]);
  put(
    entries.copies,
    [0xe0, 10, 0x8a, 0xa8, 0x90, 1, 2, 0xbd, 0, 0xf0, 0xb9, 0, 0xf1, 2],
  );
  put(entries.joined, [
    0x90,
    5,
    0xa2,
    0,
    ...jump(sites.joined),
    0xa2,
    10,
    ...readX,
  ]);
  put(entries.persisted, [0xe8, 0xd0, 1, 2, 0xa9, 0, 0x18, ...readX]);
  for (const [entry, callee] of [
    [entries.call, 0xe500],
    [entries.changedCall, 0xe540],
  ])
    put(entry, [
      0xe0,
      10,
      0x90,
      1,
      2,
      0x20,
      callee & 255,
      callee >> 8,
      ...readX,
    ]);
  put(0xe500, [0xbd, 0, 0xf0, 0x60]);
  put(0xe540, [0xa2, 20, 0x60]);
  for (const spec of rotations)
    put(spec.entry, [
      0x90,
      5,
      0xa9,
      1,
      ...jump(spec.entry + 9),
      0xa9,
      128,
      0xc9,
      128,
      ...spec.opcode,
      0xaa,
      ...readX,
    ]);
  return bytes;
}

export const mmc3Initial = () => ({
  mapper: 4,
  bank_select: 6,
  banks: [0, 2, 4, 5, 6, 7, 0, 1],
});
export const mmc1Initial = () => ({
  mapper: 1,
  prg_mode: 3,
  prg_bank: 0,
  chr_mode: 0,
  mirroring: 0,
  prg_ram_disable_bit: 0,
  chr_bank_0: 0,
  chr_bank_1: 0,
  shift_bits: [],
});

export function bankFixture(mapper) {
  const { bytes, put } = image(mapper);
  const prefix = [0xe0, 3, 0x90, 1, 2, 0xbd, 0, 0xf0];
  const bankWrite =
    mapper === 4
      ? [0x8d, 1, 0x80]
      : [
          0x85,
          0x30,
          0xa9,
          0x80,
          0x8d,
          0,
          0xe0,
          0xa5,
          0x30,
          0x8d,
          0,
          0xe0,
          ...Array.from({ length: 4 }, () => [0x4a, 0x8d, 0, 0xe0]).flat(),
        ];
  const call = 0xe000 + prefix.length + bankWrite.length;
  put(0xe000, [
    ...prefix,
    ...bankWrite,
    0x20,
    0,
    0x80,
    0x85,
    0x20,
    0xa5,
    0x20,
    2,
  ]);
  for (let bank = 0; bank < 3; bank++)
    bytes.set(
      [0xa9, 0x40 + bank, 0x60],
      16 + bank * (mapper === 4 ? 8192 : 16384),
    );
  return { bytes, call, continuation: call + 3, read: call + 5 };
}

/** Literal 6502 compare flags; this deliberately imports no production ALU. */
export function compareCandidates(operand, flag, value) {
  return ALL_BYTES.filter((v) => {
    const flags = {
      c: v >= operand,
      z: v === operand,
      n: ((v - operand) & 255 & 128) !== 0,
    };
    return flags[flag] === value;
  });
}
