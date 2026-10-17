import { mmc5Fixture } from "./nesMmc5.fixture.js";

/** Independent byte oracle for background addresses; no commercial game data. */
export const mmc5RenderingFixture = () => {
  const source = mmc5Fixture(0),
    chrOffset = source.prgOffset + source.prgSize;
  const bytes = Buffer.alloc(chrOffset + 1048576);
  source.bytes.copy(bytes, 0, 0, chrOffset);
  bytes[5] = 128;
  for (let offset = 0; offset < 1048576; offset++)
    bytes[chrOffset + offset] = ((offset >> 10) ^ (offset * 13)) & 255;
  return {
    bytes,
    chrOffset,
    prgOffset: source.prgOffset,
    prgSize: source.prgSize,
  };
};

export const mmc5ExtendedInput = {
  initial: {
    mapper: 5,
    ppu_mask: 24,
    ppu_control: 32,
    exram_mode: 1,
    exram_written: true,
    nametable_control: 255,
    fill_tile: 17,
    fill_attribute: 0,
    chr_upper: 0,
    split: [0, 235, 7],
    exram: { "37": 131 },
    ppu: { model: "mmc5-background", pin92_high: true, split_wiring: "cl" },
  },
  events: [
    { kind: "mmc5-render-frame" },
    {
      kind: "ppu-read",
      address: 0x2425,
      mmc5_fetch: "background",
      mmc5_tile: { column: 5, line: "current" },
    },
    { kind: "ppu-read", address: 0x27c1, mmc5_fetch: "background" },
    { kind: "cpu-write", address: 0x5130, value: 1 },
    { kind: "cpu-write", address: 0x5c25, value: 68 },
    { kind: "ppu-read", address: 0x1112, mmc5_fetch: "background" },
    { kind: "cpu-write", address: 0x5130, value: 2 },
    { kind: "cpu-write", address: 0x5101, value: 0 },
    { kind: "cpu-write", address: 0x512b, value: 99 },
    { kind: "ppu-read", address: 0x111a, mmc5_fetch: "background" },
  ],
};

export const mmc5SplitInput = {
  initial: {
    mapper: 5,
    ppu_mask: 24,
    ppu_control: 32,
    exram_mode: 1,
    exram_written: true,
    nametable_control: 255,
    fill_tile: 17,
    fill_attribute: 0,
    chr_upper: 3,
    split: [144, 235, 7],
    exram: { "933": 33, "1017": 109 },
    ppu: { model: "mmc5-background", pin92_high: true, split_wiring: "sl" },
  },
  events: [
    { kind: "mmc5-render-frame" },
    {
      kind: "ppu-read",
      address: 0x2425,
      mmc5_fetch: "background",
      mmc5_tile: { column: 5, line: "current" },
    },
    { kind: "cpu-write", address: 0x5201, value: 17 },
    { kind: "ppu-read", address: 0x27c1, mmc5_fetch: "background" },
    { kind: "ppu-read", address: 0x1211, mmc5_fetch: "background" },
    { kind: "cpu-write", address: 0x5202, value: 9 },
    { kind: "ppu-read", address: 0x1219, mmc5_fetch: "background" },
    { kind: "mmc5-render-line" },
  ],
};
