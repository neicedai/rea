/** Original Namco 163 ROM/CIRAM fixture, independent of mapper implementations. */
export const PRG = 528,
  CHR = PRG + 65536;
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
export const initial = (middle = 1) => ({
  mapper: 19,
  variant: "namco163",
  prg_banks: [0, middle, 2],
  chr_banks: [0xe1, 5, 0xe0, 9, 0xe0, 17, 0xe1, 23],
  nametable_banks: [0xe0, 0xe1, 47, 51],
});
export const write = (address, value) => ({
  kind: "cpu-write",
  address,
  value,
});
export function fixture() {
  const bytes = Buffer.alloc(CHR + 262144, 0xea);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 32, 0x34, 0x18]);
  bytes.fill(0x5a, 16, PRG);
  bytes.set(
    [
      0xad, 7, 0x20, 0xa9, 0x41, 0x8d, 0, 0xe8, 0xad, 7, 0x20, 0xa9, 1, 0x8d, 0,
      0xe8, 0xad, 7, 0x20, 0xa9, 0x44, 0x8d, 7, 0x20, 0xad, 7, 0x20, 0x60,
    ],
    PRG + 7 * 8192 + 0x180,
  );
  bytes.set([0xad, 7, 0x20, 0x60], PRG + 7 * 8192 + 0x240);
  for (let page = 0; page < 256; page++) {
    const value =
      page === 97 || page === 225 ? 0xa1 : page === 224 ? 0xb1 : page;
    bytes.fill(value, CHR + page * 1024, CHR + (page + 1) * 1024);
  }
  for (const delta of [6, 4, 2]) bytes.writeUInt16LE(0xe180, CHR - delta);
  return bytes;
}
export function graphicsPpu() {
  const nametable = {},
    palette = {},
    cells = {};
  for (let offset = 0; offset < 1024; offset++)
    nametable[offset] = offset < 960 ? 1 : 0x55;
  for (let tile = 0; tile < 64; tile++)
    for (let row = 0; row < 8; row++) {
      nametable[1024 + tile * 16 + row] = tile === 2 ? 0xf0 : 0xaa;
      nametable[1024 + tile * 16 + row + 8] = tile === 2 ? 0x0f : 0xcc;
    }
  for (let address = 0; address < 32; address++)
    if (![16, 20, 24, 28].includes(address))
      palette[address] = address === 0 ? 15 : (address * 3 + 1) & 63;
  for (let sprite = 0; sprite < 64; sprite++) {
    cells[sprite * 4] = sprite === 0 ? 9 : 255;
    cells[sprite * 4 + 1] = sprite === 0 ? 2 : 0;
    cells[sprite * 4 + 2] = 0;
    cells[sprite * 4 + 3] = sprite === 0 ? 16 : 0;
  }
  return {
    ...ppu,
    mask: 30,
    nametable,
    palette,
    v: { low: 0, high: 0 },
    read_buffer: { value: 73 },
    oam: {
      model: "oam-memory",
      retention: "stable",
      address_writes: "uncorrupted",
      dma_pending: { status: "none" },
      cells,
    },
  };
}
