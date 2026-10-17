/** Literal source corpus for current-SP-relative bytes; no mapper/decoder imports. */
export const PRG = 528,
  PRG_SIZE = 65536,
  CHR = PRG + PRG_SIZE;

export const initial = () => ({
  mapper: 4,
  bank_select: 6,
  banks: [0, 2, 4, 5, 6, 7, 1, 3],
  mirroring: 0,
  ram_protect: 0,
  irq_latch: 0,
  last_irq_command: "disable-acknowledge",
});

export const entries = {
  direct: 0xe000,
  caller: 0xe040,
  callee: 0xe080,
  partialCopy: 0xe100,
  handler: 0xe200,
  nested: 0xe240,
  outer: 0xe280,
  inner: 0xe2c0,
  joined: 0xe340,
  wrap: 0xe400,
  wrapCaller: 0xe540,
  physical: 0xe580,
  lost: 0xe600,
  knownToLost: 0xe640,
  unknownAlias: 0xe680,
  nonstack: 0xe6c0,
  stackAlias: 0xe700,
  knownRebase: 0xe740,
  status: 0xe780,
  partialTarget: 0xe7c0,
};

const pushedTarget = [0xa9, 0xe1, 0x48, 0xa9, 0xff, 0x48];

export function fixture() {
  const bytes = Buffer.alloc(CHR + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0x44, 8]);
  bytes.fill(0x5a, 16, PRG);
  bytes.fill(0x69, CHR);
  const put = (bank, offset, code) =>
      bytes.set(code, PRG + bank * 8192 + offset),
    fixed = (address, code) => put(7, address - 0xe000, code),
    stop = (address) => [0x4c, address & 255, address >> 8];

  fixed(entries.direct, [...pushedTarget, 0x60]);
  fixed(entries.caller, [0x20, 0x80, 0xe0, 0x85, 0x10, ...stop(0xe045)]);
  fixed(entries.callee, [...pushedTarget, 0x60]);
  fixed(entries.handler, [0xa9, 0x53, 0x60]);
  fixed(
    entries.partialCopy,
    [
      0xa5, 0x10, 0x29, 1, 0x09, 0x80, 0x48, 0xa9, 0, 0x68, 0xaa, 0x8a, 0x29,
      0xfe, 0x8d, 1, 0x80, 0x4c, 0, 0x80,
    ],
  );
  put(0, 0, stop(0x8000));

  fixed(entries.nested, [0x20, 0x80, 0xe2, 0x85, 0x10, ...stop(0xe245)]);
  fixed(entries.outer, [0xa9, 0x42, 0x48, 0x20, 0xc0, 0xe2, 0x68, 0x60]);
  fixed(entries.inner, [0xa9, 0x99, 0x48, 0xa9, 0, 0x68, 0x60]);
  fixed(entries.joined, [
    0xa5,
    0x10,
    0xf0,
    6,
    0xa9,
    0x42,
    0x48,
    0x4c,
    0x4d,
    0xe3,
    0xa9,
    0x43,
    0x48,
    0x68,
    0x29,
    0xfe,
    0x85,
    0x10,
    ...stop(0xe352),
  ]);

  // One complete physical stack ring overwrites both caller token slots.
  fixed(entries.wrap, [0xa9, 0xaa, ...Array(256).fill(0x48), 0x60]);
  fixed(entries.wrapCaller, [0x20, 0, 0xe4, ...stop(0xe543)]);
  put(3, 0x0aab, stop(0xaaab));

  fixed(entries.physical, [
    0xa2,
    0,
    0x9a,
    0x20,
    0x80,
    0xe0,
    0x85,
    0x10,
    ...stop(0xe588),
  ]);
  fixed(entries.lost, [...pushedTarget, 0xa5, 0x10, 0xaa, 0x9a, 0x60]);
  fixed(entries.knownToLost, [
    0xa2,
    0xfd,
    0x9a,
    ...pushedTarget,
    0xa5,
    0x10,
    0xaa,
    0x9a,
    0x60,
  ]);
  fixed(entries.unknownAlias, [
    ...pushedTarget,
    0xa0,
    0,
    0xa5,
    0x10,
    0x91,
    0x20,
    0x60,
  ]);
  fixed(entries.nonstack, [...pushedTarget, 0xa5, 0x10, 0x85, 0x20, 0x60]);
  fixed(entries.stackAlias, [...pushedTarget, 0xa9, 0, 0x8d, 0, 1, 0x60]);
  fixed(entries.knownRebase, [
    0xa2,
    0xfd,
    0x9a,
    0xa9,
    0x53,
    0x48,
    0xba,
    0xe8,
    0x9a,
    0xca,
    0x9a,
    0x68,
    0x85,
    0x10,
    ...stop(0xe74e),
  ]);
  fixed(entries.status, [
    0x38,
    0x08,
    0x18,
    0x28,
    0xb0,
    2,
    2,
    2,
    0xa9,
    0x77,
    ...stop(0xe78a),
  ]);
  fixed(
    entries.partialTarget,
    [0xa9, 0xea, 0x48, 0xa5, 0x10, 0x09, 0xfe, 0x48, 0x60],
  );
  for (const distance of [6, 4, 2])
    bytes.writeUInt16LE(entries.caller, CHR - distance);
  return bytes;
}
