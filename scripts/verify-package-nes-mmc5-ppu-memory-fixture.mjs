/** Authored synthetic MMC5 ROM and input facts; independent of production mappers. */
export const PRG = 16,
  PRG_SIZE = 32768,
  CHR = PRG + PRG_SIZE,
  CHR_SIZE = 1048576,
  SOURCE_ENTRY = 0xe000,
  FRONTIER_ENTRY = 0xe100;

export const ppu = {
  model: "ppu-memory",
  register_writes_enabled: true,
  access_phase: "non-rendering",
  dma_reads: "absent",
  palette_read_mode: "direct",
  chr_ram_size: null,
  nametable_layout: "ciram-2k",
  control: 0,
  mask: 0,
  write_toggle: 0,
};
export const initial = () => ({
  mapper: 5,
  prg_mode: 3,
  prg_banks: [0, 128, 129, 130, 3],
  ram_wiring: "none",
  chr_mode: 3,
  chr_banks: [5, 6, 7, 8, 13, 14, 15, 16, 9, 10, 11, 12],
  chr_bank_upper: Array(12).fill(0),
  chr_bank_modes: Array(12).fill(3),
  last_chr_set: "background",
  chr_upper: 0,
  ppu_control: 0,
  ppu_mask: 0,
  exram_mode: 0,
  exram_written: true,
  exram: { 0: 0xc0, 1: 0xc1, 2: 0xc2 },
  nametable_control: 0xe4,
  fill_tile: 0x15,
  fill_attribute: 0xfd,
  split: [0, 235, 7],
});
export const write = (address, value) => ({
  kind: "cpu-write",
  address,
  value,
});
export const read = (address, mmc5_fetch = "ppudata") => ({
  kind: "ppu-read",
  address,
  mmc5_fetch,
});
export const irq = (in_frame) => ({
  model: "mmc5",
  counter: 0,
  in_frame,
  pending: false,
  enabled: false,
  asserted: false,
  last_ppu_address: null,
  matching_reads: [0],
  idle_cycles: [0],
  ppu_read_since_cycle: false,
});

// Different high 1 KiB bank bits contribute independently, detecting lost 5130 bits.
export const chrByte = (offset) => {
  const page = offset >>> 10;
  if (page === 1) return (offset & 8) === 0 ? 255 : 0;
  if (page === 5) return (offset & 8) === 0 ? 0 : 255;
  return (page * 37 + (offset & 1023) * 13 + (offset >>> 18) * 17) & 255;
};

export const graphicsInitial = () => ({
  ...initial(),
  ppu_control: 32,
  ppu_mask: 24,
  nametable_control: 0xaa,
  chr_banks: [...Array(8).fill(1), ...Array(4).fill(5)],
  exram: Object.fromEntries(
    Array.from({ length: 1024 }, (_, address) => [address, 0]),
  ),
});
export function graphicsPpu() {
  const palette = {},
    cells = {};
  for (let address = 0; address < 32; address++)
    if (![16, 20, 24, 28].includes(address)) palette[address] = address;
  for (let sprite = 0; sprite < 64; sprite++) {
    cells[sprite * 4] = sprite === 0 ? 9 : 255;
    cells[sprite * 4 + 1] = sprite === 0 ? 2 : 0;
    cells[sprite * 4 + 2] = 0;
    cells[sprite * 4 + 3] = sprite === 0 ? 16 : 0;
  }
  return {
    ...ppu,
    control: 32,
    mask: 30,
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

export function fixture() {
  const bytes = Buffer.alloc(CHR + CHR_SIZE, 0xea);
  bytes.fill(0, 0, PRG);
  bytes.set([78, 69, 83, 26, 2, 128, 0x50, 8]);
  for (let offset = 0; offset < CHR_SIZE; offset++)
    bytes[CHR + offset] = chrByte(offset);
  // Read two buffered bytes, overwrite the captured ExRAM cell in CPU RAM mode,
  // remap to CIRAM and prove both the historical and subsequent buffer values.
  bytes.set(
    [
      0xad, 7, 0x20, 0xad, 7, 0x20, 0xa9, 2, 0x8d, 4, 0x51, 0xa9, 0xaa, 0x8d, 1,
      0x5c, 0xa9, 0, 0x8d, 5, 0x51, 0xad, 7, 0x20, 0xa9, 0, 0x8d, 4, 0x51, 0xad,
      7, 0x20, 0x60,
    ],
    PRG + 3 * 8192,
  );
  // Unknown old PPUDATA buffer makes the indirect target unresolved. Attempted
  // device accesses must remain hypothetical, including their ExRAM refill.
  bytes.set([0x6c, 7, 0x20], PRG + 3 * 8192 + 0x100);
  for (const distance of [6, 4, 2])
    bytes.writeUInt16LE(SOURCE_ENTRY, CHR - distance);
  return bytes;
}

export function extendedInput(path) {
  return {
    path,
    initial: {
      ...initial(),
      ppu_mask: 24,
      ppu_control: 32,
      exram_mode: 1,
      nametable_control: 255,
      fill_tile: 17,
      fill_attribute: 0,
      exram: { 37: 131 },
      ppu: { model: "mmc5-background", pin92_high: true, split_wiring: "cl" },
    },
    initial_ppu: { ...ppu, control: 32, mask: 24 },
    events: [
      { kind: "mmc5-render-frame" },
      {
        ...read(0x2425, "background"),
        mmc5_tile: { column: 5, line: "current" },
      },
      read(0x27c1, "background"),
      write(0x5130, 1),
      write(0x5c25, 68),
      read(0x1112, "background"),
      write(0x5130, 2),
      write(0x5101, 0),
      write(0x512b, 99),
      read(0x111a, "background"),
    ],
  };
}

export function splitInput(path) {
  return {
    path,
    initial: {
      ...initial(),
      ppu_mask: 24,
      ppu_control: 32,
      exram_mode: 1,
      nametable_control: 255,
      fill_tile: 17,
      fill_attribute: 0,
      chr_upper: 3,
      split: [144, 235, 7],
      exram: { 933: 33, 1017: 109 },
      ppu: { model: "mmc5-background", pin92_high: true, split_wiring: "sl" },
    },
    initial_ppu: { ...ppu, control: 32, mask: 24 },
    events: [
      { kind: "mmc5-render-frame" },
      {
        ...read(0x2425, "background"),
        mmc5_tile: { column: 5, line: "current" },
      },
      write(0x5201, 17),
      read(0x27c1, "background"),
      read(0x1211, "background"),
      write(0x5202, 9),
      read(0x1219, "background"),
      { kind: "mmc5-render-line" },
    ],
  };
}
