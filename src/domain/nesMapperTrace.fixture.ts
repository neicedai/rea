/** Synthetic source banks with distinct contents; no commercial ROM bytes. */
export const mapperTraceFixture = (
  mapper:
    | 0
    | 1
    | 2
    | 3
    | 4
    | 5
    | 7
    | 9
    | 10
    | 11
    | 16
    | 19
    | 159
    | 21
    | 22
    | 23
    | 24
    | 26
    | 25
    | 75
    | 33
    | 32
    | 34
    | 65
    | 67
    | 68
    | 73
    | 78
    | 76
    | 87
    | 66
    | 69
    | 71
    | 180
    | 232
    | 206,
  chrRam = false,
): Buffer => {
  if (mapper === 71 || mapper === 232) {
    const bytes = Buffer.alloc(16 + 131072);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      8,
      0,
      (mapper & 15) << 4,
      mapper & 0xf0,
    ]);
    return bytes;
  }
  if (mapper === 0 || mapper === 3) {
    const bytes = Buffer.alloc(16 + 32768 + (chrRam ? 0 : 8192));
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, chrRam ? 0 : 1, mapper << 4]);
    return bytes;
  }
  const chrBanks =
    chrRam || mapper === 180 || mapper === 2 || mapper === 7 ? 0 : 4;
  const bytes = Buffer.alloc(16 + 512 + 65536 + chrBanks * 8192);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    4,
    chrBanks,
    ((mapper & 15) << 4) | 4,
    mapper & 0xf0,
  ]);
  if (mapper === 21 || mapper === 23 || mapper === 25) {
    bytes[7] = (mapper & 0xf0) | 8;
    bytes[8] = mapper === 21 ? 0x10 : 0x30;
  }
  for (let bank = 0; bank < 8; bank++)
    bytes.fill(bank, 528 + bank * 8192, 528 + (bank + 1) * 8192);
  if (chrBanks > 0)
    for (let bank = 0; bank < 32; bank++)
      bytes.fill(bank, 66064 + bank * 1024, 66064 + (bank + 1) * 1024);
  return bytes;
};
