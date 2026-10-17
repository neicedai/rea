import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { fme7Fixture } from "./nesFme7.fixture.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { nesCodeTraceSchema, traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import {
  nesMapperStateSchema,
  nesMapperWriteSchema,
} from "./nesMapperTrace.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import { nesPrgRamLayout } from "./nesPrgRamLayout.js";
import { nesPrgRamAccess } from "./nesPrgRam.js";

it.each(["fme7", "5a", "5b"] as const)(
  "traces %s ROM/RAM transitions and both lower/upper noncontiguous instruction boundaries",
  async (variant) => {
    const { bytes, initial, cpu, routine, chr } = fme7Fixture(variant),
      parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const input = traceNesCodeInputSchema.parse({
      path: "/sunsoft.nes",
      initial,
      cpu,
    });
    const trace = nesCodeTraceSchema.parse(
      await deriveNesCode(
        parsed.value,
        bytes.subarray(528, 528 + 65536),
        input,
      ),
    );
    if (trace.status !== "derived" || trace.mapper_trace.status !== "derived")
      throw new Error(JSON.stringify(trace));
    expect(trace.stop.reason).toBe("return");
    expect(trace.final_cpu.a).toBe(0x77);
    expect(trace.instructions.find((i) => i.address === 0x7fff)).toMatchObject({
      bytes_hex: "a95a",
      file_offsets: [528 + 4 * 8192 - 1, 528 + 8192],
    });
    expect(trace.instructions.find((i) => i.address === 0xbfff)).toMatchObject({
      bytes_hex: "a933",
      file_offsets: [528 + 5 * 8192 - 1, 528 + 2 * 8192],
    });
    for (const instruction of trace.instructions) {
      const code = Buffer.from(instruction.bytes_hex, "hex");
      for (const [index, offset] of instruction.file_offsets.entries()) {
        if (offset !== null) expect(bytes[offset]).toBe(code[index]);
        else {
          const origin = instruction.ram_origins.find(
            (o) => o.byte_index === index,
          )!;
          expect(origin).toMatchObject({ region: "prg-ram", bank: 0 });
          if (!("instruction_index" in origin))
            throw new Error("Expected RAM writer");
          expect(
            trace.instructions[origin.instruction_index]?.writes[
              origin.write_index
            ],
          ).toMatchObject({
            address: instruction.address + index,
            value: routine[instruction.address + index - 0x6000],
          });
        }
      }
    }
    const data = trace.instructions
      .flatMap((i) => i.data_reads)
      .filter((r) => r.address === 0x6500);
    expect(data.map((r) => r.value)).toEqual([0x44, 0x44]);
    expect(
      trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
    ).toEqual([3, 1, 4, 2, 7]);
    expect(
      trace.mapper_trace.final_mapping.chr_windows.map((w) => w.bank),
    ).toEqual(chr);
    expect(trace.mapper_trace.final_mapping.mirroring).toBe("horizontal");
    if (variant === "5b")
      expect(trace.mapper_trace.final).toMatchObject({
        audio_select: 0x18,
        audio_registers: [
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
          15,
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ],
      });
    const replay = deriveNesMapperTrace(
      parsed.value,
      input.initial,
      trace.instructions.flatMap((i) => i.writes),
    );
    if (replay.status !== "derived") throw new Error(replay.reason);
    expect(replay.final).toEqual(trace.mapper_trace.final);
    const layout = resolveNesMapperLayout(
      parsed.value,
      trace.mapper_trace.nes_prg_views,
    );
    if (!layout.ok) throw new Error(layout.error);
    expect(
      layout.value.contexts.every(
        (c) => "variant" in c.state && c.state.variant === variant,
      ),
    ).toBe(true);
    expect(layout.value.mappings.some((m) => m.start === 0x6000)).toBe(true);
  },
);

it("retains partial command destinations, fixed windows and disabled 5B audio address proofs", () => {
  const parsed = parseNesHeader(fme7Fixture("5b").bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  const initial = nesMapperStateSchema.parse({
    mapper: 69,
    variant: "5b",
    command: { mask: 14, value: 8 },
    prg_banks: [1, 2, 3],
    bank_6000: 1,
    audio_select: { mask: 16, value: 16 },
    audio_registers: Array.from({ length: 16 }, () => 7),
  });
  const result = deriveNesMapperTrace(parsed.value, initial, [
    nesMapperWriteSchema.parse({ address: 0xa000, value: 5 }),
    nesMapperWriteSchema.parse({ address: 0xe000, value: 12 }),
  ]);
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.final).toMatchObject({
    bank_6000: { mask: 251, value: 1 },
    prg_banks: [{ mask: 251, value: 1 }, 2, 3],
    audio_registers: Array.from({ length: 16 }, () => 7),
  });
  expect(result.final_mapping.prg_windows.at(-1)?.bank).toBe(7);
});

it("keeps RAM chip capacity separate from its explicit D7 gate and canonical mirrors", () => {
  for (const [shift, variant, enable, banks, size] of [
    [5, "5b", "ungated", 1, 2048],
    [9, "5a", "ungated", 4, 8192],
    [13, "fme7", "ungated", 64, 8192],
    [7, "5b", "register-bit7", 1, 8192],
  ] as const) {
    const { bytes } = fme7Fixture(variant, shift),
      parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const state = nesMapperStateSchema.parse({
      mapper: 69,
      variant,
      prg_ram_enable: enable,
      bank_6000: 0x43,
    });
    expect(nesPrgRamLayout(parsed.value, state)).toEqual({
      start: 0x6000,
      bank_size: size,
      bank_count: banks,
    });
    expect(nesPrgRamAccess(parsed.value, state, 0x6800)).toMatchObject({
      readable: enable === "ungated",
      writable: enable === "ungated",
      banks: [3 & (banks - 1)],
      ram_address: size === 2048 ? 0x6000 : 0x6800,
    });
  }
});

it("preserves complete source agreement and mixed ROM/RAM identity without selecting the mux", async () => {
  const { bytes } = fme7Fixture("fme7"),
    code = [0xa9, 0x77, 0x60];
  bytes.set(code, 528);
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  const raw = {
    path: "/sunsoft.nes",
    entry: 0x6000,
    initial: {
      mapper: 69,
      variant: "fme7",
      prg_ram_enable: "register-bit7",
      bank_6000: { mask: 191, value: 128 },
    },
    initial_prg_ram: code.map((value, i) => ({
      bank: 0,
      address: 0x6000 + i,
      value,
    })),
  };
  const input = traceNesCodeInputSchema.parse(raw);
  const result = nesCodeTraceSchema.parse(
    await deriveNesCode(header.value, bytes.subarray(528, 528 + 65536), input),
  );
  if (result.status !== "derived") throw new Error(result.reason);
  expect(result.final_cpu.a).toBe(0x77);
  expect(result.stop.reason).toBe("return");
  expect(result.instructions[0]?.file_offsets).toEqual([null, null]);
  expect(result.instructions[0]?.mapper_origins).toEqual(
    code.slice(0, 2).map((value, i) => ({
      byte_index: i,
      kind: "fme7-window",
      variant: "fme7",
      bank_control: { mask: 191, value: 128 },
      source_candidates: [
        { kind: "rom", file_offset: 528 + i, value },
        {
          kind: "ram",
          bank: 0,
          ram_address: 0x6000 + i,
          value,
          source: { kind: "initial-prg-ram", index: i },
        },
      ],
    })),
  );
  const different = traceNesCodeInputSchema.parse({
    ...raw,
    initial_prg_ram: [
      { bank: 0, address: 0x6000, value: 0xa9 },
      { bank: 0, address: 0x6001, value: 0x66 },
    ],
  });
  expect(
    await deriveNesCode(
      header.value,
      bytes.subarray(528, 528 + 65536),
      different,
    ),
  ).toMatchObject({
    stop: { reason: "unmapped-instruction" },
    final_cpu: { a: null },
  });
});

it("retains all 64 possible RAM input origins and canonical 2 KiB aliases", async () => {
  for (const [shift, entry, banks] of [
    [13, 0x6000, 64],
    [5, 0x6800, 1],
  ] as const) {
    const { bytes } = fme7Fixture("fme7", shift),
      header = parseNesHeader(bytes);
    if (!header.ok) throw new Error(header.error);
    const input = traceNesCodeInputSchema.parse({
      path: "/sunsoft.nes",
      entry,
      initial: {
        mapper: 69,
        variant: "fme7",
        prg_ram_enable: "ungated",
        bank_6000: { mask: 64, value: 64 },
      },
      initial_prg_ram: Array.from({ length: banks }, (_, bank) => ({
        bank,
        address: 0x6000,
        value: 0x60,
      })),
    });
    const result = nesCodeTraceSchema.parse(
      await deriveNesCode(
        header.value,
        bytes.subarray(528, 528 + 65536),
        input,
      ),
    );
    if (result.status !== "derived") throw new Error(result.reason);
    expect(result.stop.reason).toBe("return");
    expect(result.stop.ram_origins).toEqual(
      Array.from({ length: banks }, (_, bank) => ({
        byte_index: 0,
        region: "prg-ram",
        bank,
        ram_address: 0x6000,
        initial_prg_ram_index: bank,
      })),
    );
  }
});

it("preserves immutable chip views and rejects unsupported capacity, storage and mapper choices", () => {
  const { bytes } = fme7Fixture("fme7"),
    source = parseNesHeader(bytes);
  if (!source.ok) throw new Error(source.error);
  const lower_window = { source: "rom" as const, bank: 0 },
    view = {
      mapper: 69 as const,
      variant: "fme7" as const,
      lower_window,
      prg_bank_0: 1,
      prg_bank_1: 2,
      prg_bank_2: 3,
    };
  expect(
    resolveNesMapperLayout(source.value, [view, { ...view, variant: "5b" }]).ok,
  ).toBe(false);
  for (const [prg, chr, ram, variant] of [
    [32, 32, 0, "fme7"],
    [16, 32, 13, "5b"],
    [4, 32, 0x77, "fme7"],
    [4, 64, 0, "fme7"],
  ] as const) {
    const header = Buffer.from(bytes.subarray(0, 16));
    header[4] = prg;
    header[5] = chr;
    header[10] = ram;
    const parsed = parseNesHeader(header, 528 + prg * 16384 + chr * 8192);
    if (!parsed.ok) throw new Error(parsed.error);
    const result = resolveNesMapperLayout(parsed.value, [{ ...view, variant }]);
    expect(result.ok).toBe(prg === 32 && variant === "fme7");
  }
  expect(nesMapperStateSchema.safeParse({ mapper: 69 }).success).toBe(false);
});
