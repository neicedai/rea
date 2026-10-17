/** Synthetic iNES source with an asymmetric tile and distinct CHR pages. */
export const nesCartridgeFixture = (
  options: {
    readonly chrRam?: boolean;
    readonly mapper?: number;
    readonly trainer?: boolean;
  } = {},
): Buffer => {
  const trainerSize = options.trainer ? 512 : 0;
  const chrSize = options.chrRam ? 0 : 8192;
  const bytes = Buffer.alloc(16 + trainerSize + 32768 + chrSize);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    2,
    chrSize / 8192,
    ((options.mapper ?? 0) << 4) | (options.trainer ? 4 : 0),
  ]);
  bytes[7] = (options.mapper ?? 0) & 0xf0;
  if (chrSize) {
    const start = 16 + trainerSize + 32768;
    // Rows 0/1 exercise plane ordering, horizontal direction and row order.
    bytes.set(
      [0xaa, 0x80, 0, 0, 0, 0, 0, 0, 0xcc, 0x01, 0, 0, 0, 0, 0, 0],
      start,
    );
    bytes.fill(0xff, start + 4096, start + 8192);
  }
  return bytes;
};
