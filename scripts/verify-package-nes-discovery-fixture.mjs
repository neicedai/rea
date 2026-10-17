/** Hand-authored static-discovery corpus; no production decoder or mapper imports. */
export const PRG = 528,
  PRG_SIZE = 65536,
  CHR = PRG + PRG_SIZE,
  CHR_SIZE = 8192;

export const initial = (bankSelect = 6, r6 = 1, r7 = 3) => ({
  mapper: 4,
  bank_select: bankSelect,
  banks: [0, 2, 4, 5, 6, 7, r6, r7],
  mirroring: 0,
  ram_protect: 0,
  irq_latch: 0,
  last_irq_command: "disable-acknowledge",
});

export const contexts = {
  a: () => initial(6, 1, 3),
  b: () => initial(0x46, 5, 3),
  selectR6: () => initial(6, 1, 3),
  selectR7: () => initial(7, 1, 3),
};

export const entries = {
  reset: 0xe000,
  dispatch: 0xe120,
  unknownPointer: 0xe160,
  knownPointer: 0xe180,
  wrappedPointer: 0xe1a0,
  hiddenSelect: 0xe300,
  unknownStore: 0xe3f0,
  ramPointer: 0xe400,
  joinedLoop: 0xe500,
  fixedLoop: 0xe080,
  crossing: 0xbfff,
};

/** Constants below are the independently calculated CPU/source relationships. */
export const oracle = {
  vectorOffsets: [CHR - 6, CHR - 4, CHR - 2],
  vectorTargets: [0xe160, 0xe000, 0xe120],
  windowsA: [1, 3, 6, 7],
  windowsB: [6, 3, 5, 7],
  crossingA: {
    bytes: "2040e0",
    offsets: [PRG + 32767, PRG + 49152, PRG + 49153],
    target: 0xe040,
  },
  crossingB: {
    bytes: "2050e0",
    offsets: [PRG + 32767, PRG + 40960, PRG + 40961],
    target: 0xe050,
  },
  dispatchPairs: [
    { bank: 1, address: 0x8100, file_offset: PRG + 8448 },
    { bank: 5, address: 0x8200, file_offset: PRG + 41472 },
  ],
  forbiddenDispatchPairs: [
    { bank: 1, address: 0x8200, file_offset: PRG + 8704 },
    { bank: 5, address: 0x8100, file_offset: PRG + 41216 },
  ],
  dispatchPointerOffsets: [
    [PRG + 57888, PRG + 57889],
    [PRG + 57890, PRG + 57891],
  ],
  wrappedPointerOffsets: [PRG + 58111, PRG + 57856],
  wrappedPointerTarget: 0x8300,
  hiddenSelectTargets: [
    {
      selected_register: 6,
      bank: 5,
      address: 0x8400,
      file_offset: PRG + 41984,
    },
    { selected_register: 7, bank: 1, address: 0x8400, file_offset: PRG + 9216 },
  ],
  dataA: { address: 0x9000, file_offset: PRG + 12288 },
  dataB: { address: 0xc180, file_offset: PRG + 41344 },
};

export function fixture() {
  // Every unclaimed PRG byte is unsupported $02, exposing invented roots and
  // bank/target combinations instead of accidentally admitting NOP padding.
  const bytes = Buffer.alloc(CHR + CHR_SIZE, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0x44, 8]);
  bytes.fill(0x5a, 16, PRG);
  bytes.fill(0x3c, CHR);
  const put = (bank, offset, values) =>
    bytes.set(values, PRG + bank * 8192 + offset);
  const fixed = (address, values) => put(7, address - 0xe000, values);

  fixed(0xe000, [0x20, 0xff, 0xbf, 0xad, 0, 0x90, 0x4c, 0x10, 0xc0]);
  fixed(0xe040, [0xad, 0, 0x90, 0x60]);
  fixed(0xe050, [0xad, 0x80, 0xc1, 0x60]);
  fixed(0xe080, [0x4c, 0x80, 0xe0]);

  // The same opcode in bank3 crosses into bank6 or bank5. Both callees and
  // fallthrough roots stay qualified by the originating raw mapper state.
  put(3, 8191, [0x20]);
  put(6, 0, [0x40, 0xe0, 0x4c, 0x10, 0xc0]);
  put(5, 0, [0x50, 0xe0, 0x4c, 0x10, 0xc0]);
  put(6, 0x10, [0x4c, 0x10, 0xc0]);
  put(5, 0x10, [0x4c, 0x10, 0xc0]);

  // Unknown RAM condition: fallthrough selects R6=1 and pointer E220;
  // taken selects R6=5 and pointer E222. Joining them independently invents
  // two poisoned (bank,target) pairs that contain $02 instead of code.
  fixed(
    0xe120,
    [
      0xad, 0, 0, 0xf0, 0x0d, 0xa9, 6, 0x8d, 0, 0x80, 0xa9, 1, 0x8d, 1, 0x80,
      0x6c, 0x20, 0xe2, 0xa9, 6, 0x8d, 0, 0x80, 0xa9, 5, 0x8d, 1, 0x80, 0x6c,
      0x22, 0xe2,
    ],
  );
  fixed(0xe160, [0x6c, 2, 0]);
  fixed(0xe180, [0x6c, 0x20, 0xe2]);
  fixed(0xe1a0, [0x6c, 0xff, 0xe2]);
  fixed(0xe200, [0x83]);
  fixed(0xe220, [0, 0x81, 0, 0x82]);
  fixed(0xe280, [0x24, 0xea]);
  fixed(0xe2ff, [0]);

  // Equal visible PRG views conceal different selected-register latches.
  // E300's A9 is deliberately also the *wrong* indirect-JMP high byte for
  // E1A0: NMOS page wrapping reads E200, not E300.
  fixed(0xe300, [0xa9, 5, 0x8d, 1, 0x80, 0x4c, 0, 0x84]);
  fixed(0xe3f0, [0x8d, 1, 0x80, 0x4c, 0, 0x80]);
  // ROM pointer bytes copied to zero page must retain separate writer-node
  // identities through the later indirect jump; there is no caller RAM input.
  fixed(
    0xe400,
    [0xad, 0x20, 0xe2, 0x85, 2, 0xad, 0x21, 0xe2, 0x85, 3, 0x6c, 2, 0],
  );
  put(1, 0, [0xa9, 0x31, 0x60]);
  // The initial exact ROM read remains evidence under its own X=0 witness,
  // while the finite analysis loop widens the node's final X envelope.
  fixed(0xe500, [0xa2, 0, 0xbd, 0x80, 0xe2, 0xe8, 0x4c, 2, 0xe5]);
  put(1, 0x100, [0xa9, 0x11, 0x60]);
  put(5, 0x200, [0xa9, 0x55, 0x60]);
  put(6, 0x100, [0xa9, 0x66, 0x60]);
  put(1, 0x300, [0x60]);
  put(6, 0x300, [0x60]);
  put(1, 0x400, [0xa9, 0x31, 0x60]);
  put(5, 0x400, [0xa9, 0x75, 0x60]);

  // Only actual operand/pointer reads make these data references. Their
  // plausible opcode bytes are never independent evidence of code.
  put(1, 0x1000, [0x20, 0x80, 0xe0, 0x4c, 0, 0x80]);
  put(5, 0x180, [0x4c, 0, 0x80]);
  put(6, 0x1000, [0xa9, 0x99, 0x60]);
  for (const [index, target] of oracle.vectorTargets.entries())
    bytes.writeUInt16LE(target, oracle.vectorOffsets[index]);
  return bytes;
}

/** NROM-128 gives two logical CPU roots one immutable physical byte range. */
export function aliasFixture() {
  const bytes = Buffer.alloc(16 + 16384 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 1, 1, 0, 8]);
  bytes.set([0x4c, 0, 0x80], 16);
  bytes.fill(0, 16 + 16384);
  for (const distance of [6, 4, 2])
    bytes.writeUInt16LE(0x8000, 16 + 16384 - distance);
  return bytes;
}

export const mmc1Initial = (firstBit) => ({
  mapper: 1,
  prg_mode: 3,
  prg_bank: 0,
  chr_mode: 0,
  mirroring: 0,
  prg_ram_disable_bit: 0,
  chr_bank_0: 0,
  chr_bank_1: 0,
  shift_bits: [firstBit],
});

/** Four separated accepted zero writes complete two distinct serial prefixes. */
export function mmc1SerialFixture() {
  const bytes = Buffer.alloc(16 + 65536 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0x10, 8]);
  bytes.set(
    [
      0xa9, 0, 0x8d, 0, 0xe0, 0xa9, 0, 0x8d, 0, 0xe0, 0xa9, 0, 0x8d, 0, 0xe0,
      0xa9, 0, 0x8d, 0, 0xe0, 0x4c, 0, 0x80,
    ],
    16 + 49152,
  );
  bytes.set([0xa9, 0x11, 0x60], 16);
  bytes.set([0xa9, 0x22, 0x60], 16 + 16384);
  bytes.fill(0x69, 16 + 65536);
  for (const distance of [6, 4, 2])
    bytes.writeUInt16LE(0xc000, 16 + 65536 - distance);
  return bytes;
}
