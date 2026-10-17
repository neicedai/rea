/** Independent trainer-bearing Sunsoft 3 fixture; no domain mapper imports. */
export const PRG = 528,
  CHR = PRG + 262144;
export const selectors = [0xc3, 0xd1, 0xea, 0xff];
export const chrBanks = [3, 17, 42, 63];
export const stores = (items) =>
  items.flatMap(([address, value]) => [
    0xa9,
    value,
    0x8d,
    address & 255,
    address >> 8,
  ]);
export function fixture() {
  const bytes = Buffer.alloc(CHR + 131072, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 16, 16, 0x34, 0x48, 0, 0, 7]);
  bytes.fill(0x5a, 16, PRG);
  bytes.set(
    [
      ...stores([
        [0xffff, 0xf5],
        ...selectors.map((bank, index) => [0x8fff + index * 4096, bank]),
        [0xefff, 0],
        ...[0xa9, 0xb6, 0x60].map((value, index) => [0x6000 + index, value]),
        [0x6500, 0x11],
      ]),
      0xee,
      0,
      0x65,
      0x20,
      0xff,
      0xbf,
      ...stores([[0xf800, 0xec]]),
      0x20,
      0,
      0x81,
      0x20,
      0,
      0x60,
      0x60,
    ],
    PRG + 15 * 16384 + 0x180,
  );
  bytes[PRG + 6 * 16384 - 1] = 0xa9;
  bytes.set([0x66, 0x4c, 0x20, 0xc2], PRG + 15 * 16384);
  bytes[PRG + 15 * 16384 + 0x220] = 0x60;
  bytes.set([0xa9, 0xd4, 0x60], PRG + 12 * 16384 + 0x100);
  bytes.set(
    [
      ...stores([
        [0xdfff, 0],
        [0xcfff, 0],
        [0xc801, 2],
        [0xd800, 16],
      ]),
      0xea,
      0xea,
      2,
    ],
    PRG + 15 * 16384 + 0x380,
  );
  for (let bank = 0; bank < 64; bank++)
    bytes.fill(bank, CHR + bank * 2048, CHR + (bank + 1) * 2048);
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0xc180, PRG + 262144 - delta);
  return bytes;
}
