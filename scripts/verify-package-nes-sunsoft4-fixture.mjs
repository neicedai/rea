/** Independent maximum-capacity normal Sunsoft 4 board; no domain imports. */
export const PRG = 528,
  CHR = PRG + 262144;
export const initial = { mapper: 68, variant: "normal" };
export const mapped = {
  ...initial,
  prg_bank: 0x15,
  chr_banks: [0x83, 0x91, 0xaa, 0xff],
  nametable_banks: [5, 0x86],
  control: 16,
};
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
export function fixture() {
  const bytes = Buffer.alloc(CHR + 262144, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 16, 32, 0x44, 0x48, 0, 0, 7]);
  bytes.fill(0x5a, 16, PRG);
  bytes.set(
    [
      ...stores([
        [0xffff, 0xf5],
        [0x8fff, 0x83],
        [0x9fff, 0x91],
        [0xafff, 0xaa],
        [0xbfff, 0xff],
        [0xcfff, 5],
        [0xdfff, 0x86],
        [0xefff, 16],
        [0x6000, 0xa9],
        [0x6001, 0xb6],
        [0x6002, 0x60],
        [0xf000, 0xe5],
        [0x6001, 0x55],
        [0xffff, 0xf5],
      ]),
      0x20,
      0,
      0x60,
      0x20,
      0xff,
      0xbf,
      ...stores([[0xffff, 0xfc]]),
      0x20,
      0,
      0x81,
      0x60,
    ],
    PRG + 15 * 16384 + 0x180,
  );
  bytes[PRG + 6 * 16384 - 1] = 0xa9;
  bytes.set([0x66, 0x4c, 0x20, 0xc2], PRG + 15 * 16384);
  bytes[PRG + 15 * 16384 + 0x220] = 0x60;
  bytes.set([0xea, 0x60], PRG + 15 * 16384 + 0x240);
  bytes.set([0xa9, 0xd4, 0x60], PRG + 12 * 16384 + 0x100);
  bytes.set(
    [0xad, 7, 0x20, 0xad, 7, 0x20, 0xad, 7, 0x20, 0x60],
    PRG + 15 * 16384 + 0x380,
  );
  bytes.set([0xad, 7, 0x20, 0x60], PRG + 15 * 16384 + 0x3c0);
  for (let page = 0; page < 256; page++)
    bytes.fill(page, CHR + page * 1024, CHR + (page + 1) * 1024);
  for (const delta of [6, 4, 2]) bytes.writeUInt16LE(0xc180, CHR - delta);
  return bytes;
}
