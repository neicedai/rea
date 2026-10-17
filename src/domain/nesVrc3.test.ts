import { expect, it } from "vitest";
import {
  applyVrc3Write,
  isVrc3State,
  nesVrc3StateSchema,
  vrc3Register,
} from "./nesVrc3.js";

const initial = () => nesVrc3StateSchema.parse({ mapper: 73 });
const write = (address: number, value: number | null) => ({
  address,
  value,
  preceded_by_cpu_write: false,
});

it("keeps missing raw VRC3 facts unknown without inventing IRQ history or other VRC registers", () => {
  expect(initial()).toEqual({
    mapper: 73,
    prg_bank: null,
    irq_latch_nibbles: [null, null, null, null],
    irq_control: null,
  });
  expect(isVrc3State(initial())).toBe(true);
  expect(isVrc3State({ mapper: 75 })).toBe(false);
  for (const invalid of [
    { mapper: 75 },
    { mapper: 73, variant: "vrc4" },
    { mapper: 73, mirroring: 0 },
    { mapper: 73, irq_latch_nibbles: [1, 2, 3] },
    { mapper: 73, irq_latch_nibbles: [1, 2, 3, 4, 5] },
    { mapper: 73, irq_latch_nibbles: [1, 2, 3, 256] },
    { mapper: 73, irq_control: { mask: 7, value: 8 } },
    { mapper: 73, prg_bank: { mask: 255, value: 7 } },
  ])
    expect(nesVrc3StateSchema.safeParse(invalid).success).toBe(false);
});

it("decodes every CPU alias from its upper address nibble", () => {
  const ports = [
    0x8000, 0x9000, 0xa000, 0xb000, 0xc000, 0xd000, 0xe000, 0xf000,
  ];
  for (let address = 0; address < 65536; address++)
    expect(vrc3Register(address)).toBe(
      address < 32768 ? null : ports[Math.floor((address - 32768) / 4096)],
    );
});

it("retains four independent full-byte latch writes from low to high and all ignored raw bits", () => {
  for (const offset of [0, 1, 0x7ff, 0xfff]) {
    const state = initial();
    for (const [index, value] of [0xf1, 0xe2, 0xd3, 0xc4].entries()) {
      const result = applyVrc3Write(
        state,
        write(0x8000 + index * 4096 + offset, value),
      );
      expect(result.effect).toBe("irq-latch");
      expect(result.state).toBe(state);
    }
    expect(applyVrc3Write(state, write(0xc000 + offset, 0xff)).effect).toBe(
      "irq-control",
    );
    expect(applyVrc3Write(state, write(0xf000 + offset, 0xfe)).effect).toBe(
      "prg-bank",
    );
    expect(state).toEqual({
      mapper: 73,
      prg_bank: 0xfe,
      irq_latch_nibbles: [0xf1, 0xe2, 0xd3, 0xc4],
      irq_control: 0xff,
    });
  }
});

it("preserves partial proof bits independently and replaces only the targeted port on an unknown write", () => {
  const state = initial();
  const proofs = [
    { mask: 15, value: 9 },
    { mask: 240, value: 160 },
    { mask: 5, value: 4 },
    { mask: 136, value: 128 },
  ];
  for (const [index, known_bits] of proofs.entries())
    applyVrc3Write(state, {
      ...write(0x8fff + index * 4096, null),
      known_bits,
    });
  applyVrc3Write(state, {
    ...write(0xcfff, null),
    known_bits: { mask: 5, value: 5 },
  });
  applyVrc3Write(state, {
    ...write(0xffff, null),
    known_bits: { mask: 7, value: 6 },
  });
  expect(state).toEqual({
    mapper: 73,
    prg_bank: { mask: 7, value: 6 },
    irq_latch_nibbles: proofs,
    irq_control: { mask: 5, value: 5 },
  });
  applyVrc3Write(state, write(0x9abc, null));
  expect(state.irq_latch_nibbles).toEqual([
    proofs[0],
    null,
    proofs[2],
    proofs[3],
  ]);
  applyVrc3Write(state, write(0xc123, null));
  expect(state.irq_control).toBeNull();
  expect(state.prg_bank).toEqual({ mask: 7, value: 6 });
});

it("acknowledges without rewriting raw control or reload ports and ignores E000 and lower writes", () => {
  const state = nesVrc3StateSchema.parse({
      mapper: 73,
      prg_bank: 249,
      irq_latch_nibbles: [129, 146, 163, 180],
      irq_control: 5,
    }),
    before = structuredClone(state);
  for (const address of [0xd000, 0xd001, 0xd7ff, 0xdfff])
    expect(applyVrc3Write(state, write(address, 255))).toEqual({
      state: before,
      effect: "irq-acknowledge",
    });
  for (const address of [0, 0x2000, 0x4015, 0x6000, 0x7fff, 0xe000, 0xefff])
    expect(applyVrc3Write(state, write(address, null))).toEqual({
      state: before,
      effect: "outside-mapper",
    });
  expect(state).toEqual(before);
});
