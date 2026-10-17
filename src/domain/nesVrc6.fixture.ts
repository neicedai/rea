/** Source-owned ROM/RAM flow with a 16 KiB switch, 8 KiB switch and split instruction. */
export const vrc6Fixture = (mapper: 24 | 26, ramDeclaration = 7) => {
  const bytes = Buffer.alloc(528 + 65536 + 262144, 2);
  bytes.fill(0, 0, 16);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    4,
    32,
    ((mapper & 15) << 4) | 6,
    0x18,
    0,
    0,
    ramDeclaration,
  ]);
  const port = (base: number, p: number) =>
    base | (mapper === 24 ? p : ((p & 1) << 1) | (p >> 1));
  const routine = [
    0xa9, 2, 0x8d, 0, 0x80, 0xa9, 4, 0x8d, 0, 0xc0, 0x4c, 0xff, 0xbf,
  ];
  const registers = [
    [0x8000, 1],
    [0xc000, 5],
    [port(0x9000, 3), 7],
    [port(0xa000, 2), 128],
    ...[255, 3, 5, 7, 9, 11, 13, 15].map((value, index) => [
      port(index < 4 ? 0xd000 : 0xe000, index & 3),
      value,
    ]),
    [port(0xb000, 3), 0xa0],
    [0x6700, 0x44],
    ...routine.map((value, index) => [0x6000 + index, value]),
    [port(0xb000, 3), 0x20],
    [0x6700, 0x99],
    [port(0xb000, 3), 0xa0],
  ];
  const program = registers.flatMap(([address, value]) => [
    0xa9,
    value!,
    0x8d,
    address! & 255,
    address! >> 8,
  ]);
  bytes.set(
    [...program, 0xad, 0, 0x67, 0xee, 0, 0x67, 0x4c, 0, 0x60],
    528 + 7 * 8192 + 0x100,
  );
  bytes[528 + 6 * 8192 - 1] = 0xa9;
  bytes.set([0x5a, 0x4c, 0x10, 0x80], 528 + 4 * 8192);
  bytes.set([0xa9, 0x77, 0x60], 528 + 4 * 8192 + 16);
  bytes.writeUInt16LE(0xe100, 528 + 65536 - 4);
  return {
    bytes,
    initial: { mapper },
    routine,
    port,
    ramCopyFirstWriter: 29,
    ramReadIndex: 60,
    ramRmwIndex: 61,
  };
};
