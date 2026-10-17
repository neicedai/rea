/** Byte-authored original VRC6a/b CHR-ROM/CIRAM fixtures; no domain imports. */
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
export const initial = (mapper, control = 0x30) => ({
  mapper,
  prg_bank_16k: 1,
  prg_bank_8k: 4,
  control,
  chr_banks: [5, 9, 18, 27, 36, 39, 46, 51],
});
export const write = (address, value) => ({
  kind: "cpu-write",
  address,
  value,
});
export function fixture(mapper) {
  const bytes = Buffer.alloc(CHR + 262144, 0xea);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 32, mapper === 24 ? 0x84 : 0xa4, 0x18]);
  bytes.fill(0x5a, 16, PRG);
  // Internal E002/R6 is physical E002 on 24 and E001 on 26.
  bytes.set(
    [
      0xad,
      7,
      0x20,
      0xa9,
      62,
      0x8d,
      mapper === 24 ? 2 : 1,
      0xe0,
      0xad,
      7,
      0x20,
      0xa9,
      0x20,
      0x8d,
      3,
      0xb0,
      0xad,
      7,
      0x20,
      0xa9,
      0x44,
      0x8d,
      7,
      0x20,
      0xad,
      7,
      0x20,
      0x60,
    ],
    PRG + 7 * 8192 + 0x180,
  );
  bytes.set([0xad, 7, 0x20, 0x60], PRG + 7 * 8192 + 0x240);
  for (let page = 0; page < 256; page++)
    bytes.fill(
      page === 47 ? 0xa1 : page,
      CHR + page * 1024,
      CHR + (page + 1) * 1024,
    );
  for (const delta of [6, 4, 2]) bytes.writeUInt16LE(0xe180, CHR - delta);
  return bytes;
}
export function graphicsPpu() {
  const palette = {},
    cells = {};
  for (let address = 0; address < 32; address++)
    if (![16, 20, 24, 28].includes(address))
      palette[address] = address === 0 ? 15 : (address * 3 + 1) & 63;
  for (let sprite = 0; sprite < 64; sprite++) {
    cells[sprite * 4] = sprite === 0 ? 9 : 255;
    cells[sprite * 4 + 1] = 0;
    cells[sprite * 4 + 2] = 0;
    cells[sprite * 4 + 3] = sprite === 0 ? 16 : 0;
  }
  return {
    ...ppu,
    mask: 30,
    palette,
    v: { low: 0, high: 36 },
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
