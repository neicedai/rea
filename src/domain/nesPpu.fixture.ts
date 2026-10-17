import { nesPpuStateSchema } from "./nesPpuState.js";

/** Synthetic executable and pattern bytes; no commercial ROM data. */
export const nesPpuFixture = (
  program: readonly number[] = [0x60],
  {
    mapper = 0,
    chrSize = 0,
    trainer = true,
  }: {
    mapper?: 0 | 1 | 3 | 4 | 9 | 10;
    chrSize?: number;
    trainer?: boolean;
  } = {},
) => {
  const prgOffset = trainer ? 528 : 16;
  const prgSize = mapper === 0 || mapper === 3 ? 32768 : 65536;
  const chrOffset = prgOffset + prgSize;
  const entry =
    mapper === 0 || mapper === 1 || mapper === 3 || mapper === 10
      ? 0xc100
      : 0xe100;
  const programOffset = prgOffset + prgSize - 65536 + entry;
  const bytes = Buffer.alloc(chrOffset + chrSize, 0x02);
  bytes.fill(0, 0, 16);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    prgSize / 16384,
    chrSize / 8192,
    (mapper << 4) | (trainer ? 4 : 0),
    8,
  ]);
  if (chrSize === 0) bytes[11] = 7;
  bytes.set(program, programOffset);
  for (let offset = 0; offset < chrSize; offset++)
    bytes[chrOffset + offset] = (((offset >> 10) * 17) ^ offset) & 255;
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(entry, prgOffset + prgSize - delta);
  return { bytes, entry, prgOffset, prgSize, chrOffset, programOffset };
};

export const nesPpuFixtureState = (extra: Record<string, unknown> = {}) =>
  nesPpuStateSchema.parse({
    model: "ppu-memory",
    register_writes_enabled: true,
    access_phase: "non-rendering",
    dma_reads: "absent",
    palette_read_mode: "direct",
    chr_ram_size: 8192,
    nametable_layout: "ciram-2k",
    control: 0,
    mask: 0,
    write_toggle: 0,
    ...extra,
  });

/** Synthetic stable OAM: every sprite has Y=255 and three zero bytes. */
export const nesPpuFixtureOam = () => ({
  model: "oam-memory",
  retention: "stable",
  dma_pending: { status: "none" },
  cells: Object.fromEntries(
    Array.from({ length: 256 }, (_, address) => [
      address,
      address % 4 === 0 ? 255 : 0,
    ]),
  ),
});

export const nesPpuUploadFixture = () => {
  const values = [0xa5, 0x39, 0xe7, 0x12];
  const program = [
    0xa9,
    0,
    0x8d,
    6,
    0x20,
    0x8d,
    6,
    0x20,
    0xa2,
    0,
    0xbd,
    0,
    0x82,
    0x8d,
    7,
    0x20,
    0xe8,
    0xe0,
    values.length,
    0xd0,
    0xf5,
    0xad,
    2,
    0x20,
    0xa9,
    0,
    0x8d,
    6,
    0x20,
    0x8d,
    6,
    0x20,
    0xad,
    7,
    0x20,
    0xad,
    7,
    0x20,
    0x85,
    0x10,
    0xad,
    7,
    0x20,
    0x60,
  ];
  const fixture = nesPpuFixture(program);
  fixture.bytes.set(values, fixture.prgOffset + 0x200);
  return { ...fixture, values };
};

/** Writes tile IDs, one attribute byte and one background palette code through CPU ports. */
export const nesPpuNametableUploadFixture = () => {
  const fixture = nesPpuFixture([
    0xa9, 0x24, 0x8d, 6, 0x20, 0xa9, 0, 0x8d, 6, 0x20, 0xa9, 0x12, 0x8d, 7,
    0x20, 0xa9, 0x34, 0x8d, 7, 0x20, 0xa9, 0x27, 0x8d, 6, 0x20, 0xa9, 0xc0,
    0x8d, 6, 0x20, 0xa9, 0xe4, 0x8d, 7, 0x20, 0xa9, 0x3f, 0x8d, 6, 0x20, 0xa9,
    1, 0x8d, 6, 0x20, 0xa9, 0x29, 0x8d, 7, 0x20, 0x60,
  ]);
  return {
    ...fixture,
    initial_ppu: nesPpuFixtureState({
      next_event_index: 500,
      control: 16,
      chr_ram: { 4384: 128, 4392: 64 },
      palette: { 0: 15 },
    }),
  };
};

/** CPU RAM or direct ROM page upload; tests independently check byte provenance. */
export const nesOamUploadFixture = ({
  viaRam = true,
  startAddress = 0,
  tail = [0xea, 0xad, 4, 0x20, 0x60],
}: {
  viaRam?: boolean;
  startAddress?: number;
  tail?: readonly number[];
} = {}) => {
  const values = Array.from(
    { length: 256 },
    (_, offset) => (offset * 13 + 5) & 255,
  );
  const fixture = nesPpuFixture([
    ...(viaRam ? [0xa2, 0, 0xbd, 0, 0x82, 0x9d, 0, 2, 0xe8, 0xd0, 0xf7] : []),
    0xa9,
    startAddress,
    0x8d,
    3,
    0x20,
    0xa9,
    viaRam ? 2 : 0x82,
    0x8d,
    0x14,
    0x40,
    ...tail,
  ]);
  fixture.bytes.set(values, fixture.prgOffset + 0x200);
  return {
    ...fixture,
    values,
    initial_ppu: nesPpuFixtureState({
      next_event_index: 100,
      oam: {
        model: "oam-memory",
        retention: "stable",
        reads: "supported",
        dma_pending: { status: "none" },
      },
    }),
  };
};
