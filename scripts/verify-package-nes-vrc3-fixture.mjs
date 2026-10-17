/** Independent VRC3 trainer ROM and byte-authored CPU/CHR-RAM programs. */
export const PRG = 528;
export const initial = { mapper: 73 };
export const write = (address, value) => ({
  kind: "cpu-write",
  address,
  value,
});
export const ppu = {
  model: "ppu-memory",
  register_writes_enabled: true,
  access_phase: "non-rendering",
  dma_reads: "absent",
  chr_ram_size: 8192,
  nametable_layout: "ciram-2k",
  control: 0,
  mask: 0,
  write_toggle: 0,
};
const stores = (items) =>
  items.flatMap(([address, value]) => [
    0xa9,
    value,
    0x8d,
    address & 255,
    address >> 8,
  ]);
export function fixture() {
  const bytes = Buffer.alloc(PRG + 131072, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 0, 0x94, 0x48, 0, 0, 7, 7]);
  bytes.fill(0x5a, 16, PRG);
  bytes.set(
    [
      ...stores([
        [0xffff, 0xe5],
        [0x6000, 0xa9],
        [0x6001, 0xb6],
        [0x6002, 0x60],
        [0x6500, 0x11],
      ]),
      0x20,
      0,
      0x60,
      0xee,
      0,
      0x65,
      0x20,
      0xff,
      0xbf,
      ...stores([[0xf000, 0xf6]]),
      0x20,
      0,
      0x81,
      0x60,
    ],
    PRG + 7 * 16384 + 0x180,
  );
  bytes[PRG + 6 * 16384 - 1] = 0xa9;
  bytes.set([0x66, 0x4c, 0x20, 0xc2], PRG + 7 * 16384);
  bytes[PRG + 7 * 16384 + 0x220] = 0x60;
  bytes.set([0xa9, 0xd4, 0x60], PRG + 6 * 16384 + 0x100);
  bytes.set(
    [
      ...stores([
        [0x2006, 0],
        [0x2006, 0],
        ...Array.from({ length: 16 }, (_, index) => [
          0x2007,
          index < 8 ? 0xaa : 0xcc,
        ]),
        [0x2006, 0],
        [0x2006, 0],
      ]),
      0xad,
      7,
      0x20,
      0xad,
      7,
      0x20,
      0x60,
    ],
    PRG + 7 * 16384 + 0x380,
  );
  bytes.set(
    [
      ...stores([
        [0x8fff, 0xad],
        [0x9fff, 0xef],
        [0xafff, 0xc3],
        [0xbfff, 0xb2],
        [0xcfff, 0xf7],
      ]),
      0xea,
      0xea,
      ...stores([[0xdfff, 255]]),
      0xea,
      2,
    ],
    PRG + 7 * 16384 + 0x500,
  );
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0xc180, PRG + 131072 - delta);
  return bytes;
}
