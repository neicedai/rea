/** Source-owned VRC4 code copied through a RAM alias before PRG mode exchange. */
export const vrc4RamFixture = (
  wiring: "internal-2k" | "external-8k",
  declaration = wiring === "internal-2k" ? 5 : 7,
  mapper = 21,
  submapper = 1,
  a1 = 2,
) => {
  const bytes = Buffer.alloc(528 + 65536 + 8192, 0x02);
  bytes.fill(0, 0, 16);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    4,
    1,
    ((mapper & 15) << 4) | 6,
    0x18,
    submapper << 4,
  ]);
  bytes[10] = declaration;
  bytes.fill(0xa5, 16, 528);
  const modeAddress = 0x9000 | (1 << a1);
  const write = (address: number, value: number) => [
    0xa9,
    value,
    0x8d,
    address & 255,
    address >> 8,
  ];
  const routine = [
    0xad,
    0,
    0x67,
    0xad,
    0,
    0x70,
    ...write(modeAddress, 3),
    ...write(0x8000, 2),
    0x4c,
    0,
    0xc0,
  ];
  const program = [
    ...write(modeAddress, 1),
    ...write(0xa000, 1),
    ...write(0x6700, 0x44),
    ...write(0x6f00, 0x55),
    ...write(0x7000, 0x66),
    ...routine.flatMap((value, index) => write(0x6800 + index, value)),
    ...write(modeAddress, 0),
    ...write(0x6f00, 0x99),
    ...write(modeAddress, 1),
    0xad,
    0,
    0x6f,
    0xee,
    0,
    0x6f,
    0x4c,
    0,
    0x68,
  ];
  bytes.set(program, 528 + 7 * 8192);
  bytes.set([0xa9, 0x77, 0x60], 528 + 2 * 8192);
  bytes.writeUInt16LE(0xe000, 528 + 65536 - 4);
  return {
    bytes,
    routine,
    modeAddress,
    initial: { mapper, variant: "vrc4" as const, prg_ram_wiring: wiring },
  };
};
