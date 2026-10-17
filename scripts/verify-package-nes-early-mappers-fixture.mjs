/** Independent trainer-bearing Namco109/J87 fixtures; no domain imports. */
export const PRG = 528,
  CHR76 = PRG + 131072,
  CHR87 = PRG + 32768;
export const write = (address, value) => ({
  kind: "cpu-write",
  address,
  value,
});
const stores = (items) =>
  items.flatMap(([address, value]) => [
    0xa9,
    value,
    0x8d,
    address & 255,
    address >> 8,
  ]);
export const ppu = {
  model: "ppu-memory",
  register_writes_enabled: true,
  access_phase: "non-rendering",
  dma_reads: "absent",
  chr_ram_size: null,
  nametable_layout: "ciram-2k",
  control: 0,
  mask: 0,
};
export function fixture87() {
  const bytes = Buffer.alloc(CHR87 + 32768, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 2, 4, 0x75, 0x58]);
  bytes.fill(0x5a, 16, PRG);
  bytes.set(
    [
      ...stores([
        [0x6000, 1],
        [0x7fff, 2],
        [0x8000, 3],
      ]),
      0x60,
    ],
    PRG + 16384 + 0x180,
  );
  for (let bank = 0; bank < 4; bank++)
    bytes.fill(bank, CHR87 + bank * 8192, CHR87 + (bank + 1) * 8192);
  for (const delta of [6, 4, 2]) bytes.writeUInt16LE(0xc180, CHR87 - delta);
  return bytes;
}
export function fixture76() {
  const bytes = Buffer.alloc(CHR76 + 131072, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 16, 0xc4, 0x48]);
  bytes.fill(0x5a, 16, PRG);
  const banks = [
    [6, 0xf5],
    [7, 0xec],
    [2, 0xc3],
    [3, 0xd1],
    [4, 0xea],
    [5, 0xff],
    [0, 0xc9],
    [1, 0xc7],
  ];
  bytes.set(
    [
      ...stores(
        banks.flatMap(([index, value]) => [
          [0x9ffe, 0xc0 | index],
          [0x9fff, value],
        ]),
      ),
      0x20,
      0xff,
      0x9f,
      0x20,
      0xff,
      0xbf,
      ...stores([
        [0x8000, 6],
        [0x8001, 0xfd],
      ]),
      0x20,
      0,
      0x81,
      0x60,
    ],
    PRG + 15 * 8192 + 0x180,
  );
  bytes[PRG + 6 * 8192 - 1] = 0xa9;
  bytes.set([0x42, 0x4c, 0x20, 0xe2], PRG + 12 * 8192);
  bytes[PRG + 13 * 8192 - 1] = 0xa9;
  bytes.set([0x77, 0x4c, 0x20, 0xe2], PRG + 14 * 8192);
  bytes[PRG + 15 * 8192 + 0x220] = 0x60;
  bytes.set([0xa9, 0xb6, 0x60], PRG + 13 * 8192 + 0x100);
  for (let bank = 0; bank < 64; bank++)
    bytes.fill(bank, CHR76 + bank * 2048, CHR76 + (bank + 1) * 2048);
  for (const delta of [6, 4, 2]) bytes.writeUInt16LE(0xe180, CHR76 - delta);
  return bytes;
}
