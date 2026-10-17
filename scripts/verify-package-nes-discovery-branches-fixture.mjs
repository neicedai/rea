/** Independent literal 6502 bytes; no production decoder, ALU or mapper imports. */
export const branchKinds = [
  { mnemonic: "BCC", opcode: 0x90, flag: "c", when: false },
  { mnemonic: "BCS", opcode: 0xb0, flag: "c", when: true },
  { mnemonic: "BEQ", opcode: 0xf0, flag: "z", when: true },
  { mnemonic: "BNE", opcode: 0xd0, flag: "z", when: false },
  { mnemonic: "BMI", opcode: 0x30, flag: "n", when: true },
  { mnemonic: "BPL", opcode: 0x10, flag: "n", when: false },
  { mnemonic: "BVC", opcode: 0x50, flag: "v", when: false },
  { mnemonic: "BVS", opcode: 0x70, flag: "v", when: true },
];
const flagPrefixes = {
  c: [[0x18], [0x38], [0xa5, 0x10, 0x4a]],
  z: [
    [0xa9, 1],
    [0xa9, 0],
    [0xa5, 0x10],
  ],
  n: [
    [0xa9, 0x7f],
    [0xa9, 0x80],
    [0xa5, 0x10],
  ],
  v: [[0xb8], [0xa9, 0x40, 0x85, 0x10, 0x24, 0x10], [0xa9, 0, 0x24, 0x11]],
};
export const matrix = branchKinds.flatMap((branch, branchIndex) =>
  [false, true, null].map((source, index) => {
    const prefix = flagPrefixes[branch.flag][index],
      entry = 0x8000 + 32 * (branchIndex * 3 + index);
    return { ...branch, source, prefix, entry, address: entry + prefix.length };
  }),
);

const vector = (entry, prefix, mnemonic, source) => {
  const branch = branchKinds.find((item) => item.mnemonic === mnemonic);
  return { ...branch, entry, prefix, source, address: entry + prefix.length };
};
export const partial = [
  vector(0x9000, [0xa5, 0x10, 0x29, 0x7f], "BMI", false),
  vector(0x9040, [0xa5, 0x10, 0x09, 1], "BEQ", false),
  vector(0x9080, [0xa5, 0x10, 0x09, 0x80], "BPL", true),
  vector(0x90c0, [0xa5, 0x10, 0x29, 0], "BNE", true),
  vector(0x9100, [0x38, 0xa5, 0x10, 0x69, 0], "BCS", null),
  vector(0x9140, [0xa9, 0, 0xa5, 0x10], "BEQ", null),
  vector(0x9180, [0x18, 0xa5, 0x10], "BCC", false),
  vector(0x91c0, [0xb8, 0xa5, 0x10], "BVC", false),
  vector(0x9200, [0xa9, 4, 0xc9, 5], "BCC", false),
  vector(0x9240, [0xa2, 5, 0xe0, 5], "BEQ", true),
  vector(0x9280, [0xa0, 6, 0xc0, 5], "BCS", true),
  vector(0x92c0, [0xa5, 0x10, 0xc9, 0], "BCC", true),
];
export const stack = [
  vector(0x9400, [0x38, 0x08, 0x18, 0x28], "BCS", true),
  vector(
    0x9440,
    [0xa5, 0x10, 0x29, 0x7f, 0x48, 0xa9, 0x80, 0x68],
    "BMI",
    false,
  ),
  vector(0x9480, [0x38, 0x08, 0xa0, 0, 0xa9, 0, 0x91, 0x20, 0x28], "BCS", null),
  vector(0x94c0, [0x38, 0x08, 0xa9, 0, 0x85, 0x20, 0x18, 0x28], "BCS", true),
  vector(0x9500, [0x18, 0xa0, 0, 0xa9, 0, 0x91, 0x20], "BCC", false),
  vector(0x9540, [0x38, 0x08, 0xa9, 0, 0x8d, 0, 1, 0x28], "BCS", null),
];
export const entries = {
  join: 0x9600,
  zero: 0x9660,
  wrapTaken: 0x9700,
  wrapFall: 0x9740,
  repeated: 0x9800,
};
const jump = (address) => [0x4c, address & 255, address >> 8];
const body = (item) => [
  ...item.prefix,
  item.opcode,
  3,
  0xa9,
  0x11,
  0x60,
  0xa9,
  0x22,
  0x60,
];

export function fixture() {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 2),
    put = (address, code) => bytes.set(code, 16 + address - 0x8000);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 1, 0, 8]);
  for (const item of [...matrix, ...partial, ...stack])
    put(item.entry, body(item));
  put(0x9600, [0x18, ...jump(0x9610)]);
  put(0x9610, [0x90, 6, 0xa9, 0x11, ...jump(0x9640)]);
  put(0x9618, [0xa5, 0x10, 0x4a, ...jump(0x9610)]);
  put(0x9640, jump(0x9640));
  put(0x9660, [0xa5, 0x10, 0x4a, 0x90, 0, ...jump(0x9665)]);
  put(0x9700, [0x18, ...jump(0xfffe)]);
  put(0x9740, [0x38, ...jump(0xfffe)]);
  put(0xfff8, jump(0xfff8));
  put(0xfffe, [0x90, 0xf8]);
  put(0x9800, [0xa5, 0x10, 0x4a, 0x90, 0x0b, 0x90, 0x19, ...jump(0x9830)]);
  put(0x9810, [0xb0, 0x0e, ...jump(0x9830)]);
  put(0x9830, jump(0x9830));
  return bytes;
}

export const MMC3_PRG = 528;
export const mmc3Initial = (r7 = 3) => ({
  mapper: 4,
  bank_select: 6,
  banks: [0, 2, 4, 5, 6, 7, 1, r7],
  mirroring: 0,
  ram_protect: 0,
  irq_latch: 0,
  last_irq_command: "disable-acknowledge",
});
export const calls = [
  {
    entry: 0xe000,
    call: 0xe000,
    branch: 0xe003,
    calleeRts: 0xe10b,
    flag: "c",
    when: true,
    source: true,
    bank: 5,
    target: 0x8200,
    a: 0x22,
  },
  {
    entry: 0xe040,
    call: 0xe041,
    branch: 0xe044,
    calleeRts: 0xe142,
    flag: "c",
    when: false,
    source: false,
    bank: 1,
    target: 0x8300,
    a: 0x33,
  },
  {
    entry: 0xe080,
    call: 0xe081,
    branch: 0xe084,
    calleeRts: 0xe186,
    flag: "c",
    when: true,
    source: true,
    bank: 1,
    target: 0x8300,
    a: 0x33,
  },
  {
    entry: 0xe200,
    call: 0xe201,
    branch: 0xe204,
    calleeRts: 0xe282,
    flag: "c",
    when: false,
    source: false,
    bank: 1,
    target: 0x8300,
    a: 0x33,
  },
  {
    entry: 0xe240,
    call: 0xe241,
    branch: 0xe244,
    calleeRts: 0xe282,
    flag: "c",
    when: true,
    source: true,
    bank: 1,
    target: 0x8300,
    a: 0x33,
  },
];
export function mmc3Fixture() {
  const bytes = Buffer.alloc(MMC3_PRG + 65536 + 8192, 2),
    put = (bank, offset, code) =>
      bytes.set(code, MMC3_PRG + bank * 8192 + offset),
    fixed = (address, code) => put(7, address - 0xe000, code),
    branchJumps = (opcode, target) => [
      opcode,
      3,
      ...jump(0x8100),
      ...jump(target),
    ];
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0x44, 8]);
  bytes.fill(0x5a, 16, MMC3_PRG);
  fixed(0xe000, [0x20, 0, 0xe1, ...branchJumps(0xb0, 0x8200)]);
  fixed(0xe100, [0xa9, 6, 0x8d, 0, 0x80, 0xa9, 5, 0x8d, 1, 0x80, 0x38, 0x60]);
  fixed(0xe040, [0x18, 0x20, 0x40, 0xe1, ...branchJumps(0x90, 0x8300)]);
  fixed(0xe140, [0xa9, 0x7f, 0x60]);
  fixed(0xe080, [0x38, 0x20, 0x80, 0xe1, ...branchJumps(0xb0, 0x8300)]);
  fixed(0xe180, [0x08, 0x18, 0x20, 0xc0, 0xe1, 0x28, 0x60]);
  fixed(0xe1c0, [0x38, 0x60]);
  fixed(0xe200, [0x18, 0x20, 0x80, 0xe2, ...branchJumps(0x90, 0x8300)]);
  fixed(0xe240, [0x38, 0x20, 0x80, 0xe2, ...branchJumps(0xb0, 0x8300)]);
  fixed(0xe280, [0xa9, 0x55, 0x60]);
  fixed(0xe300, [0x18, ...jump(0xbfff)]);
  put(1, 0x300, [0xa9, 0x33, 0x60]);
  put(5, 0x200, [0xa9, 0x22, 0x60]);
  put(3, 0x1ffd, [0xa9, 0x43, 0x90]);
  put(5, 0x1ffd, [0xa9, 0x55, 0x90]);
  put(6, 0, [0xfc]);
  return bytes;
}

export const mmc1Initial = (bit) => ({
  mapper: 1,
  prg_mode: 3,
  prg_bank: 0,
  chr_mode: 0,
  mirroring: 0,
  prg_ram_disable_bit: 0,
  chr_bank_0: 0,
  chr_bank_1: 0,
  shift_bits: [bit],
});
export function mmc1Fixture() {
  const bytes = Buffer.alloc(16 + 65536 + 8192, 2),
    fixed = (address, code) => bytes.set(code, 16 + 49152 + address - 0xc000);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0x10, 8]);
  fixed(0xc000, [
    0x18,
    0xb0,
    0x3d,
    ...Array.from({ length: 4 }, () => [0xa9, 0, 0x8d, 0, 0xe0]).flat(),
    ...jump(0x8000),
  ]);
  fixed(0xc040, [0xa9, 0x80, 0x8d, 0, 0x80, 0x60]);
  bytes.set([0xa9, 0x11, ...jump(0x8002)], 16);
  bytes.set([0xa9, 0x22, ...jump(0x8002)], 16 + 16384);
  return bytes;
}
