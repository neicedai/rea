import type { NesVrcWiring } from "./nesVrcBoard.js";

/** Independent physical-wiring oracle shared by the source and public workflows. */
export const vrcWiringCases = [
  [22, 0, "vrc2a", 1, 0],
  [23, 3, "vrc2b", 0, 1],
  [25, 3, "vrc2c", 1, 0],
  [21, 1, "vrc4a", 1, 2],
  [25, 1, "vrc4b", 1, 0],
  [21, 2, "vrc4c", 6, 7],
  [25, 2, "vrc4d", 3, 2],
  [23, 2, "vrc4e", 2, 3],
  [23, 1, "vrc4f", 0, 1],
] as const satisfies readonly (readonly [
  number,
  number,
  NesVrcWiring,
  number,
  number,
])[];

export const vrcWiringFixture = (
  [mapper, submapper, wiring, a0, a1]: readonly [
    number,
    number,
    NesVrcWiring,
    number,
    number,
  ],
  version: "ines" | "nes2-zero" | "nes2-explicit",
) => {
  const vrc4 = wiring.startsWith("vrc4");
  const chr = vrc4 ? 524288 : mapper === 22 ? 131072 : 262144;
  const bytes = Buffer.alloc(528 + 65536 + chr, 2);
  bytes.fill(0, 0, 16);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    4,
    chr / 8192,
    ((mapper & 15) << 4) | 4,
    0x10 | (version === "ines" ? 0 : 8),
    version === "nes2-explicit" ? submapper << 4 : 0,
  ]);
  const port = (base: number, p: number) =>
    base | ((p & 1) << a0) | ((p >> 1) << a1);
  const writes = [
    { address: 0x8000, value: 2 },
    { address: 0xa000, value: 5 },
    { address: port(0x9000, 2), value: 0 },
    { address: port(0x9000, 0), value: 3 },
    { address: port(0xb000, 0), value: 15 },
    { address: port(0xb000, 1), value: vrc4 ? 31 : 15 },
  ];
  const program = writes.flatMap(({ address, value }) => [
    0xa9,
    value,
    0x8d,
    address & 255,
    address >> 8,
  ]);
  bytes.set([...program, 0x4c, 0xff, 0x9f], 528 + 7 * 8192 + 0x100);
  bytes[528 + 3 * 8192 - 1] = 0xa9;
  const mode = port(0x9000, 2);
  bytes.set(
    vrc4
      ? [0x5a, 0xa9, 2, 0x8d, mode & 255, mode >> 8, 0x4c, 0x10, 0x80]
      : [0x5a, 0x4c, 0x10, 0x80],
    528 + 5 * 8192,
  );
  if (vrc4) bytes.set([0x4c, 0x10, 0xc0], 528 + 6 * 8192 + 16);
  bytes.set([0xa9, 0x77, 0x60], 528 + 2 * 8192 + 16);
  bytes.writeUInt16LE(0xe100, 528 + 65536 - 4);
  const initial = vrc4
    ? { mapper, variant: "vrc4", wiring }
    : { mapper, wiring };
  return {
    bytes,
    initial,
    writes,
    vrc4,
    chrBank: vrc4 ? 511 : mapper === 22 ? 127 : 255,
  };
};
