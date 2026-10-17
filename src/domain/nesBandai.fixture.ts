import type { NesBandaiVariant } from "./nesBandai.js";

export const bandaiCases = [
  { mapper: 16, variant: "fcg", submapper: 4 },
  { mapper: 16, variant: "lz93d50", submapper: 5 },
  { mapper: 159, variant: "lz93d50", submapper: 0 },
] as const;

/** Distinct source banks and physical port windows, independent of the mapper planner. */
export const bandaiFixture = (
  board: { mapper: 16 | 159; variant: NesBandaiVariant; submapper: number },
  version: "nes2" | "ines" | "nes2-zero" = "nes2",
) => {
  const bytes = Buffer.alloc(528 + 65536 + 262144, 2);
  bytes.fill(0, 0, 16);
  const nvram =
    board.variant === "fcg" ? 0 : board.mapper === 159 ? 0x10 : 0x20;
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    4,
    32,
    ((board.mapper & 15) << 4) | 4 | (nvram ? 2 : 0),
    (board.mapper & 0xf0) | (version === "ines" ? 0 : 8),
    version === "nes2" ? board.submapper << 4 : 0,
    0,
    version === "ines" ? 0 : nvram,
  ]);
  const base = board.variant === "fcg" ? 0x6000 : 0x8000,
    other = board.variant === "fcg" ? 0x8000 : 0x6000;
  const chr = [128, 145, 162, 179, 196, 213, 230, 255];
  const writes = [
    { address: other + 8, value: 3 },
    { address: base + 8, value: 0xf1 },
    ...chr.map((value, index) => ({ address: base + index, value })),
    { address: base + 9, value: 3 },
    { address: base + 11, value: 0 },
    { address: base + 12, value: 1 },
    { address: base + 10, value: 1 },
    { address: base + 13, value: 0x60 },
  ];
  bytes.set(
    [
      ...writes.flatMap(({ address, value }) => [
        0xa9,
        value,
        0x8d,
        address & 255,
        address >> 8,
      ]),
      0x4c,
      0xff,
      0xbf,
    ],
    528 + 3 * 16384 + 0x100,
  );
  bytes[528 + 2 * 16384 - 1] = 0xa9;
  bytes.set([0x5a, 0x4c, 0x10, 0x80], 528 + 3 * 16384);
  bytes.set([0xa9, 0x77, 0x60], 528 + 16384 + 16);
  bytes.writeUInt16LE(0xc100, 528 + 65536 - 4);
  const initial =
    board.mapper === 16
      ? { mapper: 16 as const, variant: board.variant }
      : { mapper: 159 as const };
  return { bytes, initial, writes, base, other, chr };
};
