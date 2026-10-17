/** Independent trainer-bearing H3001 byte fixture; no domain mapper imports. */
export const PRG = 528,
  CHR = PRG + 262144;
export const banks = [31, 7, 63, 255, 4, 128, 9, 67];
const stores = (items) =>
  items.flatMap(([address, value]) => [
    0xa9,
    value,
    0x8d,
    address & 255,
    address >> 8,
  ]);
export function fixture() {
  const bytes = Buffer.alloc(CHR + 262144, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 16, 32, 0x14, 0x48, 0, 0, 7]);
  bytes.fill(0x5a, 16, PRG);
  const setup = [
    [0x8007, 5],
    [0xa005, 19],
    [0x9000, 0],
    [0x9001, 0],
    [0xc007, 4],
    ...banks.map((bank, index) => [0xb000 + index, bank]),
    ...[0xa9, 0x88, 0x60].map((value, index) => [0x6000 + index, value]),
    [0x6500, 0x11],
  ];
  bytes.set(
    [
      ...stores(setup),
      0x20,
      0,
      0x60,
      0xee,
      0,
      0x65,
      0x20,
      0xff,
      0x9f,
      0x20,
      0xff,
      0xbf,
      ...stores([[0x9000, 128]]),
      0x20,
      0xff,
      0xbf,
      0x4c,
      0,
      0xc1,
    ],
    PRG + 31 * 8192 + 0x180,
  );
  bytes.set([0x66, 0x4c, 0x20, 0xe2], PRG + 5 * 8192);
  bytes[PRG + 6 * 8192 - 1] = 0xa9;
  bytes.set([0x42, 0x4c, 0x20, 0xe2], PRG + 19 * 8192);
  bytes[PRG + 20 * 8192 - 1] = 0xa9;
  bytes.set([0x77, 0x4c, 0x20, 0xe2], PRG + 30 * 8192);
  bytes.set([0xa9, 0xb6, 0x60], PRG + 5 * 8192 + 0x100);
  bytes[PRG + 31 * 8192 + 0x220] = 0x60;
  bytes.set(
    [
      ...stores([
        [0x9005, 0],
        [0x9006, 3],
      ]),
      0x8d,
      4,
      0x90,
      ...stores([[0x9003, 128]]),
      0xea,
      0xea,
      2,
    ],
    PRG + 31 * 8192 + 0x380,
  );
  for (let bank = 0; bank < 256; bank++)
    bytes.fill(bank, CHR + bank * 1024, CHR + (bank + 1) * 1024);
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0xe180, PRG + 262144 - delta);
  return bytes;
}
