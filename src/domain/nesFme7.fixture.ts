import type { NesFme7Variant } from "./nesFme7.js";

export const fme7Fixture = (variant: NesFme7Variant, storage = 7) => {
  const bytes = Buffer.alloc(528 + 65536 + 262144, 2);
  bytes.fill(0, 0, 16);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    4,
    32,
    0x54 | (storage & 0xf0 ? 2 : 0),
    0x48,
    0,
    0,
    storage,
  ]);
  const writes: { address: number; value: number }[] = [];
  const register = (command: number, value: number) =>
    writes.push(
      { address: 0x9fff, value: 0xf0 | command },
      { address: 0xbfff, value },
    );
  register(9, 1);
  register(10, 4);
  register(11, 2);
  register(8, 3);
  const chr = [128, 145, 162, 179, 196, 213, 230, 255];
  chr.forEach((value, index) => register(index, value));
  register(12, 1);
  register(14, 1);
  register(15, 0);
  register(13, 0x81);
  if (variant === "5b")
    writes.push(
      { address: 0xc123, value: 8 },
      { address: 0xe321, value: 15 },
      { address: 0xc123, value: 0x18 },
      { address: 0xe321, value: 0xaa },
    );
  register(8, 0xc0);
  const routine = [0xa9, 0x66, 0x60];
  writes.push(...routine.map((value, i) => ({ address: 0x6000 + i, value })), {
    address: 0x6500,
    value: 0x44,
  });
  const program = writes.flatMap(({ address, value }) => [
    0xa9,
    value,
    0x8d,
    address & 255,
    address >> 8,
  ]);
  program.push(
    0x20,
    0,
    0x60,
    0xa9,
    8,
    0x8d,
    0,
    0x80,
    0xa9,
    0x40,
    0x8d,
    0,
    0xa0,
    0xa9,
    0xaa,
    0x8d,
    0,
    0x65,
    0xa9,
    0xc0,
    0x8d,
    0,
    0xa0,
    0xad,
    0,
    0x65,
    0xee,
    0,
    0x65,
    0xa9,
    3,
    0x8d,
    0,
    0xa0,
    0x20,
    0,
    0x60,
    0x4c,
    0xff,
    0x7f,
  );
  bytes.set(program, 528 + 7 * 8192 + 0x100);
  bytes.set([0xa9, 0x55, 0x60], 528 + 3 * 8192);
  bytes[528 + 4 * 8192 - 1] = 0xa9;
  bytes.set([0x5a, 0x4c, 0xff, 0xbf], 528 + 8192);
  bytes[528 + 5 * 8192 - 1] = 0xa9;
  bytes.set([0x33, 0x4c, 0x10, 0x80], 528 + 2 * 8192);
  bytes.set([0xa9, 0x77, 0x60], 528 + 8192 + 16);
  bytes.writeUInt16LE(0xe100, 528 + 65536 - 4);
  return {
    bytes,
    initial: {
      mapper: 69 as const,
      variant,
      prg_ram_enable: "register-bit7" as const,
    },
    cpu: { sp: 255 },
    routine,
    chr,
  };
};
