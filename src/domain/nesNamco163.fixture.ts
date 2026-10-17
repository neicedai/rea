/** Independent synthetic N163 program: all PRG windows, mixed PPU sources and four RAM protection regions. */
export const namco163Fixture = (storage = 7, submapper = 3) => {
  const prgOffset = 528,
    prgSize = 131072,
    chrSize = 262144;
  const bytes = Buffer.alloc(prgOffset + prgSize + chrSize, 2);
  bytes.fill(0, 0, 16);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    8,
    32,
    0x34 | (storage & 0xf0 ? 2 : 0),
    0x18,
    submapper << 4,
    0,
    storage,
  ]);
  const stores: { address: number; value: number }[] = [];
  const store = (address: number, value: number) =>
    stores.push({ address, value });
  store(0xe7ff, 0x42);
  store(0xefff, 0x45);
  store(0xf7ff, 0x83);
  const chr = [0, 31, 224, 255, 128, 225, 32, 239];
  chr.forEach((value, i) => store(0x87ff + i * 2048, value));
  [224, 225, 7, 255].forEach((value, i) => store(0xc7ff + i * 2048, value));
  store(0xffff, 0x40);
  const routine = [0xa9, 0x66, 0x60];
  routine.forEach((value, i) => store(0x6000 + i, value));
  const addresses = [0x6500, 0x6d00, 0x7500, 0x7d00];
  addresses.forEach((address, i) => store(address, 0xa0 + i));
  store(0xf800, 0x4b); // Protect routine and regions 1/3; region 2 remains writable.
  addresses.forEach((address, i) => store(address, 0xb0 + i));
  store(0x4fff, 0x55);
  store(0x57ff, 0xfe);
  store(0x5fff, 0xff);
  const program = stores.flatMap(({ address, value }) => [
    0xa9,
    value,
    0x8d,
    address & 255,
    address >> 8,
  ]);
  program.push(0xee, 1, 0x60, 0x20, 0, 0x60);
  addresses.forEach((address, i) =>
    program.push(0xad, address & 255, address >> 8, 0x85, 0x10 + i),
  );
  program.push(0x4c, 0xff, 0x9f);
  bytes.set(program, prgOffset + 15 * 8192 + 0x100);
  bytes[prgOffset + 3 * 8192 - 1] = 0xa9;
  bytes.set([0x5a, 0x4c, 0xff, 0xbf], prgOffset + 5 * 8192);
  bytes[prgOffset + 6 * 8192 - 1] = 0xa9;
  bytes.set([0x33, 0x4c, 0x10, 0xc0], prgOffset + 3 * 8192);
  bytes.set(
    [0xa9, 6, 0x8d, 0xff, 0xef, 0x4c, 0x10, 0xa0],
    prgOffset + 3 * 8192 + 16,
  );
  bytes.set([0xa9, 0x77, 0x60], prgOffset + 6 * 8192 + 16);
  bytes.writeUInt16LE(0xe100, prgOffset + prgSize - 4);
  bytes.writeUInt16LE(0xe100, prgOffset + prgSize - 6);
  bytes.writeUInt16LE(0xe100, prgOffset + prgSize - 2);
  return {
    bytes,
    prgOffset,
    prgSize,
    chrSize,
    chr,
    addresses,
    routine,
    initial: { mapper: 19 as const, variant: "namco163" as const },
    cpu: { sp: 255 },
  };
};
