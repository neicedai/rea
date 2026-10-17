/** Original synthetic bytes and facts; no production mapper interpretation is imported. */
export const PRG = 16,
  PRG_SIZE = 32768,
  CHR = PRG + PRG_SIZE,
  CHR_SIZE = 1048576,
  ENTRY = 0xe000;

export const initial = () => ({
  mapper: 5,
  prg_mode: 3,
  prg_banks: [0, 128, 129, 130, 3],
  ram_wiring: "none",
  chr_mode: 3,
  chr_banks: Array(12).fill(1),
  chr_bank_upper: Array(12).fill(0),
  chr_bank_modes: Array(12).fill(3),
  last_chr_set: "background",
  chr_upper: 2,
  ppu_control: 0,
  ppu_mask: 8,
  exram_mode: 1,
  exram_written: true,
  exram: Object.fromEntries(
    Array.from({ length: 1024 }, (_, address) => [
      address,
      address >= 960
        ? 2
        : address === 37
          ? 0x82
          : address === 932
            ? 0x21
            : 0x41,
    ]),
  ),
  nametable_control: 0,
  fill_tile: 7,
  fill_attribute: 0,
  split: [5, 17, 7],
  ppu: {
    model: "mmc5-background",
    pin92_high: true,
    split_wiring: "sl",
    split_y: 99,
  },
});

export function ppu() {
  const palette = {},
    cells = {};
  for (let address = 0; address < 32; address++)
    if (![16, 20, 24, 28].includes(address)) palette[address] = address;
  for (let sprite = 0; sprite < 64; sprite++) {
    cells[sprite * 4] = 255;
    cells[sprite * 4 + 1] = 0;
    cells[sprite * 4 + 2] = 0;
    cells[sprite * 4 + 3] = 0;
  }
  return {
    model: "ppu-memory",
    register_writes_enabled: true,
    access_phase: "non-rendering",
    dma_reads: "absent",
    palette_read_mode: "direct",
    chr_ram_size: null,
    nametable_layout: "ciram-2k",
    control: 0,
    mask: 10,
    write_toggle: 0,
    nametable: Object.fromEntries(
      Array.from({ length: 2048 }, (_, address) => [
        address,
        (address & 1023) >= 960 ? 0 : (address & 1023) === 37 ? 8 : 7,
      ]),
    ),
    palette,
    oam: {
      model: "oam-memory",
      retention: "stable",
      address_writes: "uncorrupted",
      dma_pending: { status: "none" },
      cells,
    },
  };
}

export const geometry = (first_screen_column = 0, split_y_at_origin = 235) => ({
  first_screen_column,
  split_y_at_origin,
});
export const viewportInput = (path, overrides = {}) => ({
  path,
  initial: initial(),
  initial_ppu: ppu(),
  events: [],
  ppu_viewport: { model: "frozen-viewport", origin_x: 32, origin_y: 9 },
  ppu_mmc5_background: { viewport: geometry(4) },
  ...overrides,
});
export const nametableInput = (path, overrides = {}) => ({
  path,
  initial: initial(),
  initial_ppu: ppu(),
  events: [],
  ppu_nametable: 0,
  ppu_mmc5_background: { nametable: geometry() },
  ...overrides,
});

const paint = (bytes, address, pixel) => {
  const offset = CHR + address;
  bytes[offset] = pixel & 1 ? 255 : 0;
  bytes[offset + 8] = pixel & 2 ? 255 : 0;
};
export function fixture() {
  const bytes = Buffer.alloc(CHR + CHR_SIZE, 0xea);
  bytes.fill(0, 0, PRG);
  bytes.set([78, 69, 83, 26, 2, 128, 0x50, 8]);
  // Every unremarkable tile is opaque pixel 1. Specific original rows expose
  // bank/plane/row pairing rather than deriving expectations from a mapper.
  for (let offset = 0; offset < CHR_SIZE; offset++)
    bytes[CHR + offset] = (offset & 8) === 0 ? 255 : 0;
  for (let row = 0; row < 8; row++) {
    paint(bytes, 130 * 4096 + 8 * 16 + row, 2);
    paint(bytes, 130 * 4096 + 0x82 * 16 + row, 3);
    paint(bytes, 130 * 4096 + 0x83 * 16 + row, 2);
    paint(bytes, 131 * 4096 + 0x82 * 16 + row, 2);
    paint(bytes, 193 * 4096 + 7 * 16 + row, 2);
    paint(bytes, 7 * 4096 + 0x21 * 16 + row, row === 3 ? 2 : row === 4 ? 3 : 1);
  }
  // A real source trace changes the split bank/control, then stops before RTS.
  bytes.set(
    [0xa9, 7, 0x8d, 2, 0x52, 0xa9, 0x85, 0x8d, 0, 0x52, 0xea, 0x60],
    PRG + 3 * 8192,
  );
  for (const distance of [6, 4, 2]) bytes.writeUInt16LE(ENTRY, CHR - distance);
  return bytes;
}

export function nromFixture() {
  const bytes = Buffer.alloc(16 + 16384 + 8192);
  bytes.set([78, 69, 83, 26, 1, 1]);
  bytes.fill(0xea, 16, 16 + 16384);
  return bytes;
}
