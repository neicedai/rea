import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";

const fixture = (declaration: number, mapper: 23 | 25 = 25) => {
  const bytes = Buffer.alloc(528 + 65536 + 8192);
  bytes.set([
    0x4e,
    0x45,
    0x53,
    0x1a,
    4,
    1,
    ((mapper & 15) << 4) | 6,
    0x18,
    0x30,
  ]);
  bytes[10] = declaration;
  bytes.fill(0x55, 16, 528);
  bytes.set([0xa9, 0x66, 0x8d, 0, 0x60, 0xad, 0, 0x60, 0x60], 528 + 7 * 8192);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return { bytes, header: parsed.value };
};

it.each([0, 6, 8, 0x66, 0x77])(
  "keeps VRC2c cartridge RAM unknown for declaration %i",
  async (declaration) => {
    const { bytes, header } = fixture(declaration);
    const result = await deriveNesCode(
      header,
      bytes.subarray(528, 528 + 65536),
      traceNesCodeInputSchema.parse({
        path: "/vrc2c.nes",
        initial: { mapper: 25 },
        entry: 0xe000,
      }),
    );
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.final_cpu.a).toBeNull();
    expect(result.instructions[2]?.data_reads[0]?.ram_origins).toEqual([]);
  },
);

it("does not apply VRC2c external RAM wiring to VRC2b with a matching declaration", async () => {
  const { bytes, header } = fixture(7, 23);
  const result = await deriveNesCode(
    header,
    bytes.subarray(528, 528 + 65536),
    traceNesCodeInputSchema.parse({
      path: "/vrc2b.nes",
      initial: { mapper: 23 },
      entry: 0xe000,
    }),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.final_cpu.a).toBeNull();
  expect(result.instructions[2]?.data_reads[0]?.ram_origins).toEqual([]);
});

it("does not seed unprovided VRC2c RAM from the trainer or persistence flag", async () => {
  const { bytes, header } = fixture(0x70);
  bytes.set([0xad, 0, 0x70, 0x60], 528 + 7 * 8192);
  const result = await deriveNesCode(
    header,
    bytes.subarray(528, 528 + 65536),
    traceNesCodeInputSchema.parse({
      path: "/vrc2c.nes",
      initial: { mapper: 25 },
      entry: 0xe000,
    }),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.final_cpu.a).toBeNull();
  expect(result.instructions[0]?.data_reads[0]?.ram_origins).toEqual([]);
});
