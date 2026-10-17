/** Independent trainer-bearing Irem 78 boards, with distinct old/new bus bytes. */
export const PRG = 528,
  CHR = PRG + 131072;
export const variants = ["cosmo-carrier", "holy-diver"];
export const initial = (variant, latch = 0x12) => ({
  mapper: 78,
  variant,
  latch,
});
export const write = (address, value) => ({
  kind: "cpu-write",
  address,
  value,
});
export const ppu = {
  model: "ppu-memory",
  register_writes_enabled: true,
  access_phase: "non-rendering",
  dma_reads: "absent",
  chr_ram_size: null,
  nametable_layout: "ciram-2k",
  control: 0,
  mask: 0,
};
export function fixture(variant = "cosmo-carrier") {
  const bytes = Buffer.alloc(CHR + 131072, 0xea);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 16, 0xe4, 0x48]);
  bytes[8] = variant === "cosmo-carrier" ? 0x10 : 0x30;
  bytes.fill(0x5a, 16, PRG);
  bytes.set(
    [
      0xa9, 0xff, 0x8d, 0x23, 0x81, 0x20, 0xff, 0xbf, 0xa9, 0xf7, 0x8d, 0x24,
      0x81, 0x20, 0, 0x81, 0x60,
    ],
    PRG + 7 * 16384 + 0x180,
  );
  bytes[PRG + 2 * 16384 + 0x123] = 0xad;
  bytes[PRG + 5 * 16384 + 0x123] = 0xf2;
  bytes[PRG + 5 * 16384 + 0x124] = 0x76;
  bytes[PRG + 6 * 16384 + 0x124] = 0xbd;
  for (let bank = 0; bank < 8; bank++) {
    bytes[PRG + bank * 16384 + 0x200] = bank % 2 === 0 ? 0xa5 : 0xad;
    bytes[PRG + bank * 16384 + 0x201] =
      bank === 0 ? 0xad : bank === 1 ? 0xa5 : 0;
  }
  bytes[PRG + 6 * 16384 - 1] = 0xa9;
  bytes.set([0x66, 0x4c, 0x40, 0xc2], PRG + 7 * 16384);
  bytes[PRG + 7 * 16384 + 0x240] = 0x60;
  bytes.set([0xa9, 0xd4, 0x60], PRG + 6 * 16384 + 0x100);
  bytes[PRG + 7 * 16384 + 0x300] = 0xff;
  bytes[PRG + 7 * 16384 + 0x320] = 0x5d;
  bytes.set([0xad, 7, 0x20, 0xad, 7, 0x20, 0x60], PRG + 7 * 16384 + 0x380);
  // ROM bytes differ only on D1/D6; CPU BD clears both uncertain positions.
  for (const [bank, value] of [
    [1, 0xa9],
    [3, 0xab],
    [5, 0xe9],
    [7, 0xeb],
  ])
    bytes[PRG + bank * 16384 + 0x340] = value;
  bytes.set(
    [0xa9, 0xbd, 0x8d, 0x40, 0x83, 0x4c, 0, 0x81],
    PRG + 7 * 16384 + 0x3c0,
  );
  bytes.set([0xa9, 0x66, 0x60], PRG + 16384 + 0x100);
  for (let bank = 0; bank < 16; bank++)
    bytes.fill(bank, CHR + bank * 8192, CHR + (bank + 1) * 8192);
  for (const delta of [6, 4, 2]) bytes.writeUInt16LE(0xc180, CHR - delta);
  return bytes;
}
