import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { invertedUnromCodeFixture } from "./nesCode.fixture.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";

it("maps inverted UNROM candidates and complete contexts without assuming vector state", () => {
  const fixture = invertedUnromCodeFixture();
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const result = resolveNesMapperLayout(header.value);
  if (!result.ok) throw new Error(result.error);
  expect(result.value.mappings[0]).toMatchObject({
    start: 0x8000,
    bank: 0,
    role: "fixed",
    fileOffset: 16,
  });
  expect(
    result.value.mappings.slice(1).map((m) => [m.start, m.bank, m.fileOffset]),
  ).toEqual([0, 1, 2, 3].map((bank) => [0xc000, bank, 16 + bank * 16384]));
  const selected = resolveNesMapperLayout(header.value, [
    { mapper: 180, prg_bank: 7 },
  ]);
  if (!selected.ok) throw new Error(selected.error);
  expect(selected.value.mappings.map((m) => [m.start, m.bank, m.role])).toEqual(
    [
      [0x8000, 0, "fixed"],
      [0xc000, 3, "switchable"],
    ],
  );
  expect(resolveNesMapperLayout({ ...header.value, submapper: 1 }).ok).toBe(
    false,
  );
  expect(
    resolveNesMapperLayout({
      ...header.value,
      prgRom: { ...header.value.prgRom, size: 262144 },
    }).ok,
  ).toBe(false);
});

it("uses the pre-write ROM bank for AND conflicts before fetching the next instruction", async () => {
  const fixture = invertedUnromCodeFixture();
  const header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const result = await deriveNesCode(
    header.value,
    fixture.bytes.subarray(16),
    traceNesCodeInputSchema.parse({
      path: "/inverted.nes",
      entry: 0x8000,
      initial: { mapper: 180 },
    }),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.final_cpu.a).toBe(0x66);
  expect(result.stop.reason).toBe("return");
  expect(
    result.instructions.find((i) => i.address === 0xc000)?.file_offsets,
  ).toEqual([32784, 32785]);
  expect(result.instructions.at(-1)?.file_offsets).toEqual([16405, 16406]);
  expect(result.mapper_trace).toMatchObject({
    final: { mapper: 180, prg_bank: 1 },
    nes_prg_views: [
      { mapper: 180, prg_bank: 1 },
      { mapper: 180, prg_bank: 2 },
    ],
  });
  const unknown = await deriveNesCode(
    header.value,
    fixture.bytes.subarray(16),
    traceNesCodeInputSchema.parse({
      path: "/inverted.nes",
      initial: { mapper: 180 },
    }),
  );
  expect(unknown).toMatchObject({
    status: "derived",
    stop: { reason: "unresolved-vector" },
  });
});
