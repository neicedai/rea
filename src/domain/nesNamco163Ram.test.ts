import { expect, it } from "vitest";
import {
  nesNamco163ChipRamSchema,
  namco163ChipAddresses,
  readNamco163ChipRam,
  writeNamco163ChipRam,
  invalidateNamco163Phase,
  applyNamco163OamDma,
} from "./nesNamco163Ram.js";
import { namco163RamFixture } from "./nesNamco163Ram.fixture.js";
import { parseNesHeader } from "./nes.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";

it.each(["saturate", "wrap"] as const)(
  "follows %s port effects through NMOS indexed/RMW/NOP reads and an indirect control transfer",
  async (model) => {
    const fixture = namco163RamFixture(model),
      parsed = parseNesHeader(fixture.bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const trace = nesCodeTraceSchema.parse(
      await deriveNesCode(
        parsed.value,
        fixture.bytes.subarray(
          fixture.prgOffset,
          fixture.prgOffset + fixture.prgSize,
        ),
        traceNesCodeInputSchema.parse({
          path: "/n163-ram.nes",
          initial: fixture.initial,
          initial_ram: fixture.initial_ram,
        }),
      ),
    );
    if (trace.status !== "derived" || trace.mapper_trace.status !== "derived")
      throw new Error(JSON.stringify(trace));
    expect(trace.stop.reason).toBe("return");
    expect(trace.final_cpu.a).toBe(0x77);
    expect(trace.mapper_trace.final).toMatchObject({
      ram_control: 0x91,
      chip_ram: { address_port: 0x93 },
      prg_banks: [0x42, 1, 2],
    });
    const stores = trace.instructions
      .flatMap((i) => i.writes)
      .filter((w) => w.address < 0x20);
    expect(stores.map((w) => [w.address, w.value])).toEqual([
      [0x10, 0x11],
      [0x11, 0x22],
      [0x15, 0x44],
      [0x16, 0x45],
      [0x12, 0x88],
      [0x13, 0xee],
      [0x14, model === "wrap" ? 0x11 : 0xa7],
    ]);
  },
);
it("joins partial pointers, uncertain writes and post-increment facts without inventing a selected cell", () => {
  const ram = nesNamco163ChipRamSchema.parse({
    address_port: { mask: 254, value: 128 },
    dma_reads: "absent",
    increment_model: "saturate",
  });
  ram.bytes[0] = 0xa5;
  ram.bytes[1] = 0xa7;
  const read = readNamco163ChipRam(ram, 0x4fff);
  expect(read).toMatchObject({
    value: null,
    known_bits: { mask: 253, value: 165 },
    source: {
      cells: [
        { address: 0, value: 0xa5 },
        { address: 1, value: 0xa7 },
      ],
    },
  });
  expect(ram.address_port).toEqual({ mask: 252, value: 128 });
  ram.address_port = { mask: 254, value: 128 };
  writeNamco163ChipRam(ram, 0xa7);
  expect(ram.bytes.slice(0, 2)).toEqual([{ mask: 253, value: 165 }, 0xa7]);
});
it("preserves unknown DMA, missing bytes, auto-increment mode and asynchronous phase writes", () => {
  const ram = nesNamco163ChipRamSchema.parse({
    address_port: 0xff,
    increment_model: "saturate",
  });
  ram.bytes[127] = 0xa7;
  expect(readNamco163ChipRam(ram, 0x4800)).toMatchObject({ value: 0xa7 });
  expect(ram.address_port).toBe(255);
  ram.increment_model = "wrap";
  expect(readNamco163ChipRam(ram, 0x4800)).toMatchObject({ value: null });
  expect(ram.address_port).toEqual({ mask: 128, value: 128 });
  ram.address_port = 3;
  ram.bytes[3] = 0x55;
  expect(readNamco163ChipRam(ram, 0x4800).value).toBe(0x55);
  expect(ram.address_port).toBe(3);
  ram.bytes.fill(0xa5);
  ram.bytes[127] = 0;
  invalidateNamco163Phase(ram, 0);
  expect([
    ram.bytes[65],
    ram.bytes[121],
    ram.bytes[123],
    ram.bytes[125],
    ram.bytes[127],
  ]).toEqual([0xa5, null, null, null, 0]);
});
it("covers all raw pointers and both known increment models independently", () => {
  for (const increment_model of ["wrap", "saturate"] as const)
    for (let pointer = 0; pointer < 256; pointer++) {
      const ram = nesNamco163ChipRamSchema.parse({
        address_port: pointer,
        increment_model,
        dma_reads: "absent",
        bytes: Array.from({ length: 128 }, (_, n) => n),
      });
      expect(namco163ChipAddresses(ram)).toEqual([pointer & 127]);
      expect(readNamco163ChipRam(ram, 0x4800).value).toBe(pointer & 127);
      expect(ram.address_port).toBe(
        pointer < 128
          ? pointer
          : 128 |
              (increment_model === "wrap"
                ? (pointer + 1) & 127
                : Math.min((pointer & 127) + 1, 127)),
      );
    }
});

it("joins unknown-address access/no-access and unknown increment interpretations explicitly", () => {
  const ram = nesNamco163ChipRamSchema.parse({
    address_port: 128,
    increment_model: "wrap",
    dma_reads: "absent",
  });
  ram.bytes[0] = 0xa5;
  ram.bytes[1] = 0xa7;
  expect(readNamco163ChipRam(ram, null)).toEqual({
    address: null,
    value: null,
    source: null,
  });
  expect(ram.address_port).toEqual({ mask: 254, value: 128 });
  expect(readNamco163ChipRam(ram, 0x4800)).toMatchObject({
    value: null,
    known_bits: { mask: 253, value: 165 },
  });
  expect(ram.address_port).toEqual({ mask: 252, value: 128 });
  ram.address_port = 255;
  ram.increment_model = null;
  ram.bytes[127] = 0x33;
  expect(readNamco163ChipRam(ram, 0x4800).value).toBe(0x33);
  expect(ram.address_port).toEqual({ mask: 128, value: 128 });
});

it("keeps attempted port reads at an unapplied indirect-jump frontier out of the committed event trace", async () => {
  const fixture = namco163RamFixture("saturate");
  fixture.bytes.set([0x6c, 0, 0x48], fixture.prgOffset + 15 * 8192 + 0x100);
  fixture.initial.chip_ram.bytes.fill(null);
  const parsed = parseNesHeader(fixture.bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const trace = nesCodeTraceSchema.parse(
    await deriveNesCode(
      parsed.value,
      fixture.bytes.subarray(
        fixture.prgOffset,
        fixture.prgOffset + fixture.prgSize,
      ),
      traceNesCodeInputSchema.parse({
        path: "/frontier.nes",
        initial: fixture.initial,
      }),
    ),
  );
  expect(trace).toMatchObject({
    status: "derived",
    instructions: [],
    stop: {
      reason: "unknown-control-target",
      data_reads: [
        { address: 0x4800, value: null },
        { address: 0x4801, value: null },
      ],
    },
    mapper_trace: { steps: [], final: { chip_ram: { address_port: 128 } } },
  });
});

it.each(["saturate", "wrap"] as const)(
  "applies a visible OAM-DMA trigger through %s source/event semantics",
  async (model) => {
    const fixture = namco163RamFixture(model);
    fixture.bytes.set(
      [0xa9, 0x48, 0x8d, 0x14, 0x40, 0xad, 0, 0x48, 0x60],
      fixture.prgOffset + 15 * 8192 + 0x100,
    );
    const header = parseNesHeader(fixture.bytes);
    if (!header.ok) throw new Error(header.error);
    const trace = nesCodeTraceSchema.parse(
      await deriveNesCode(
        header.value,
        fixture.bytes.subarray(
          fixture.prgOffset,
          fixture.prgOffset + fixture.prgSize,
        ),
        traceNesCodeInputSchema.parse({
          path: "/dma.nes",
          initial: fixture.initial,
        }),
      ),
    );
    expect(trace).toMatchObject({
      status: "derived",
      stop: { reason: "return" },
      final_cpu: { a: model === "wrap" ? 0x11 : 0xa7 },
      mapper_trace: {
        steps: [
          { write_effect: "oam-dma-request" },
          { event: { kind: "cpu-read", address: 0xe105 } },
          { cpu_read: { value: model === "wrap" ? 0x11 : 0xa7 } },
        ],
        final: { chip_ram: { address_port: model === "wrap" ? 129 : 255 } },
      },
    });
    const prefix = await deriveNesCode(
      header.value,
      fixture.bytes.subarray(
        fixture.prgOffset,
        fixture.prgOffset + fixture.prgSize,
      ),
      traceNesCodeInputSchema.parse({
        path: "/dma.nes",
        initial: fixture.initial,
        max_instructions: 2,
      }),
    );
    expect(prefix).toMatchObject({
      status: "derived",
      stop: { reason: "instruction-budget" },
      mapper_trace: {
        steps: [{ write_effect: "oam-dma-request" }],
        final: { chip_ram: { address_port: 128, oam_dma_pending: 72 } },
      },
    });
  },
);
it("joins uncertain DMA source pages and repeated reads without changing RAM cells", () => {
  const ram = nesNamco163ChipRamSchema.parse({
    address_port: 144,
    increment_model: "saturate",
    dma_reads: "absent",
  });
  applyNamco163OamDma(ram, { mask: 248, value: 72 });
  expect(ram.address_port).toBe(255);
  ram.address_port = 144;
  applyNamco163OamDma(ram, null);
  expect(ram.address_port).toEqual({ mask: 144, value: 144 });
  ram.address_port = 144;
  ram.increment_model = "wrap";
  ram.dma_reads = "unobserved";
  applyNamco163OamDma(ram, 79);
  expect(ram.address_port).toEqual({ mask: 128, value: 128 });
  expect(ram.bytes.every((v) => v === null)).toBe(true);
});
