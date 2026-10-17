import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { vrc4RamFixture } from "./nesVrc4Ram.fixture.js";

const run = async (
  fixture: ReturnType<typeof vrc4RamFixture>,
  extra: Record<string, unknown> = {},
) => {
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  return deriveNesCode(
    header.value,
    fixture.bytes.subarray(528, 528 + 65536),
    traceNesCodeInputSchema.parse({
      path: "/vrc4.nes",
      initial: fixture.initial,
      ...extra,
    }),
  );
};

it.each(["internal-2k", "external-8k"] as const)(
  "does not guess omitted %s RAM wiring or initialize bytes from a trainer",
  async (wiring) => {
    const fixture = vrc4RamFixture(wiring);
    const omitted = await run(fixture, {
      initial: { mapper: 21, variant: "vrc4" },
    });
    if (omitted.status !== "derived") throw new Error(omitted.reason);
    expect(omitted.stop).toMatchObject({
      reason: "unmapped-instruction",
      address: 0x6800,
    });
    const unprovided = await run(fixture, {
      initial: { ...fixture.initial, prg_control: 1 },
      entry: 0x6800,
    });
    if (unprovided.status !== "derived") throw new Error(unprovided.reason);
    expect(unprovided.stop).toMatchObject({
      reason: "unmapped-instruction",
      address: 0x6800,
      bytes_hex: "",
      ram_origins: [],
    });
  },
);

it.each([0, 4, 6, 7, 0x44, 0x77])(
  "rejects internal 2 KiB wiring with incompatible RAM declaration %i",
  async (declaration) => {
    const result = await run(vrc4RamFixture("internal-2k", declaration));
    expect(result.status).toBe("unsupported");
    if (result.status !== "unsupported")
      throw new Error("Expected wiring rejection");
    expect(result.reason).toContain("prg_ram_wiring");
  },
);

it.each([0, 5, 6, 8, 0x66, 0x77])(
  "rejects external 8 KiB wiring with incompatible RAM declaration %i",
  async (declaration) => {
    expect((await run(vrc4RamFixture("external-8k", declaration))).status).toBe(
      "unsupported",
    );
  },
);

it.each([0, null, { mask: 2, value: 2 }])(
  "does not bypass disabled or unknown RAM permission %j for caller-seeded code",
  async (prg_control) => {
    const result = await run(vrc4RamFixture("internal-2k"), {
      initial: {
        mapper: 21,
        variant: "vrc4",
        prg_ram_wiring: "internal-2k",
        prg_control,
      },
      entry: 0x6800,
      initial_prg_ram: [0xa9, 0x77, 0x60].map((value, index) => ({
        bank: 0,
        address: 0x6000 + index,
        value,
      })),
    });
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.stop).toMatchObject({
      reason: "unmapped-instruction",
      address: 0x6800,
      ram_origins: [],
    });
  },
);

it.each([0x6800, 0x7000, 0x7fff])(
  "requires canonical initial 2 KiB RAM addresses instead of %i",
  async (address) => {
    expect(
      (
        await run(vrc4RamFixture("internal-2k"), {
          initial_prg_ram: [{ bank: 0, address, value: 0x60 }],
        })
      ).status,
    ).toBe("unsupported");
  },
);

it.each([0x33, 0x44])(
  "preserves common bit facts after an uncertain-permission write of %i",
  async (value) => {
    const fixture = vrc4RamFixture("internal-2k");
    fixture.bytes.set(
      [
        0xa9,
        value,
        0x8d,
        0,
        0x60,
        0xa9,
        1,
        0x8d,
        fixture.modeAddress & 255,
        fixture.modeAddress >> 8,
        0xad,
        0,
        0x60,
        0x60,
      ],
      528 + 7 * 8192,
    );
    const result = await run(fixture, {
      initial: { ...fixture.initial, prg_control: { mask: 2, value: 0 } },
      initial_prg_ram: [{ bank: 0, address: 0x6000, value: 0x33 }],
    });
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.final_cpu.a).toBe(value === 0x33 ? 0x33 : null);
    const read = result.instructions.at(-1)?.data_reads[0];
    expect(read?.ram_origins).toEqual([
      {
        byte_index: 0,
        region: "prg-ram",
        bank: 0,
        ram_address: 0x6000,
        initial_prg_ram_index: 0,
      },
    ]);
    expect(
      read !== undefined && "known_bits" in read ? read.known_bits : undefined,
    ).toEqual(value === 0x33 ? undefined : { mask: 136, value: 0 });
  },
);

it("stops the next RAM instruction after RAM code disables itself", async () => {
  const fixture = vrc4RamFixture("internal-2k");
  const routine = [
    0xa9,
    0,
    0x8d,
    fixture.modeAddress & 255,
    fixture.modeAddress >> 8,
    0x60,
  ];
  const result = await run(fixture, {
    initial: { ...fixture.initial, prg_control: 1 },
    entry: 0x6800,
    initial_prg_ram: routine.map((value, index) => ({
      bank: 0,
      address: 0x6000 + index,
      value,
    })),
  });
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.stop).toMatchObject({
    reason: "unmapped-instruction",
    address: 0x6805,
  });
  expect(result.instructions).toHaveLength(2);
});

it("fetches one instruction across the internal RAM mirror boundary with distinct physical origins", async () => {
  const fixture = vrc4RamFixture("internal-2k");
  const result = await run(fixture, {
    initial: { ...fixture.initial, prg_control: 1 },
    entry: 0x67ff,
    initial_prg_ram: [
      { bank: 0, address: 0x67ff, value: 0xa9 },
      { bank: 0, address: 0x6000, value: 0x77 },
      { bank: 0, address: 0x6001, value: 0x60 },
    ],
  });
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.final_cpu.a).toBe(0x77);
  expect(result.instructions[0]).toMatchObject({
    address: 0x67ff,
    bytes_hex: "a977",
    file_offsets: [null, null],
    ram_origins: [
      {
        byte_index: 0,
        region: "prg-ram",
        bank: 0,
        ram_address: 0x67ff,
        initial_prg_ram_index: 0,
      },
      {
        byte_index: 1,
        region: "prg-ram",
        bank: 0,
        ram_address: 0x6000,
        initial_prg_ram_index: 1,
      },
    ],
  });
  expect(result.stop).toMatchObject({ reason: "return", address: 0x6801 });
});

it("admits a matching single-chip declaration before mapper/event/source workflows", () => {
  for (const [wiring, declaration] of [
    ["internal-2k", 0x50],
    ["external-8k", 0x70],
  ] as const) {
    const fixture = vrc4RamFixture(wiring, declaration);
    const header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const state = nesMapperStateSchema.parse(fixture.initial);
    expect(deriveNesMapperTrace(header.value, state, []).status).toBe(
      "derived",
    );
  }
});
