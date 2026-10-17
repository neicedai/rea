import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema, nesCodeTraceSchema } from "./nesCodeTrace.js";
import { nesMapperStateSchema } from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";

const fixture = (program: readonly number[], ram = 0) => {
  const bytes = Buffer.alloc(16 + 131072 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 1, 0x70, 0x18, 0x30]);
  bytes[10] = ram;
  bytes.set(program, 16 + 15 * 8192);
  bytes.set([0xa9, 0x77, 0x60], 16 + 2 * 8192);
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  return { bytes, header: parsed.value };
};
const trace = async (
  program: readonly number[],
  fields: Record<string, unknown> = {},
  ram = 0,
) => {
  const { bytes, header } = fixture(program, ram);
  const result = nesCodeTraceSchema.parse(
    await deriveNesCode(
      header,
      bytes.subarray(16, 16 + 131072),
      traceNesCodeInputSchema.parse({
        path: "/vrc2-latch.nes",
        initial: { mapper: 23, ...fields },
        entry: 0xe000,
      }),
    ),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  return result;
};

it("retains explicit initial latch provenance and ignores the 7000–7FFF region", async () => {
  const result = await trace(
    [0xa9, 0, 0x8d, 0, 0x70, 0xa9, 1, 0x2d, 0xff, 0x6f, 0x60],
    { latch_present: true, latch_value: 1 },
  );
  expect(result.final_cpu.a).toBe(1);
  expect(result.instructions[3]?.data_reads[0]).toMatchObject({
    address: 0x6fff,
    known_bits: { mask: 1, value: 1 },
    mapper_origins: [
      { kind: "vrc2-microwire-latch", source: { kind: "initial-state" } },
    ],
  });
  const unmodeled = await trace([0xa9, 1, 0x2d, 0, 0x70, 0x60], {
    latch_present: true,
    latch_value: 1,
  });
  expect(unmodeled.final_cpu.a).toBeNull();
  expect(unmodeled.instructions[1]?.data_reads[0]?.mapper_origins).toEqual([]);
});

it("invalidates latch provenance after an unknown source write", async () => {
  const result = await trace(
    [0xad, 2, 0x20, 0x8d, 0, 0x60, 0xa9, 1, 0x2d, 0, 0x61, 0x60],
    { latch_present: true, latch_value: 1 },
  );
  expect(result.final_cpu.a).toBeNull();
  expect(result.instructions[3]?.data_reads[0]?.mapper_origins).toEqual([]);
  expect(result.mapper_trace).toMatchObject({ final: { latch_value: null } });
});

it("orders RMW dummy/final latch writes and attributes the final D0 proof", async () => {
  const result = await trace([0x0e, 0, 0x60, 0xa9, 1, 0x2d, 0, 0x60, 0x60], {
    latch_present: true,
    latch_value: 1,
  });
  expect(result.final_cpu.a).toBe(0);
  expect(result.instructions[0]?.writes).toEqual([
    {
      address: 0x6000,
      value: null,
      known_bits: { mask: 1, value: 1 },
      preceded_by_cpu_write: false,
    },
    {
      address: 0x6000,
      value: null,
      known_bits: { mask: 3, value: 2 },
      preceded_by_cpu_write: true,
    },
  ]);
  expect(result.instructions[2]?.data_reads[0]?.mapper_origins).toEqual([
    {
      byte_index: 0,
      kind: "vrc2-microwire-latch",
      latch_value: 0,
      source: { kind: "cpu-write", instruction_index: 0, write_index: 1 },
    },
  ]);
});

it("rejects one-bit wiring assumptions with declared cartridge RAM", async () => {
  const { header } = fixture([0x60], 7);
  const result = deriveNesMapperTrace(
    header,
    nesMapperStateSchema.parse({ mapper: 23, latch_present: true }),
    [],
  );
  expect(result).toMatchObject({
    status: "unsupported",
    reason: expect.stringContaining("declared PRG RAM"),
  });
});

it("does not infer a VRC2b latch power-on value from explicit wiring", async () => {
  const result = await trace([0xa9, 1, 0x2d, 0, 0x60, 0x60], {
    latch_present: true,
  });
  expect(result.final_cpu.a).toBeNull();
  expect(result.instructions[1]?.data_reads[0]).not.toHaveProperty(
    "known_bits",
  );
  expect(result.instructions[1]?.data_reads[0]?.mapper_origins).toEqual([]);
  expect(result.mapper_trace).toMatchObject({ initial: { latch_value: null } });
});
