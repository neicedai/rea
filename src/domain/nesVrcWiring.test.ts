import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import { resolveNesMapperLayout } from "./nesMapper.js";
import {
  nesMapperStateSchema,
  nesMapperWriteSchema,
} from "./nesMapperTrace.js";
import { deriveNesMapperTrace } from "./nesMapperTraceDerivation.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { nesPrgViewsSchema } from "./nesPrgViews.js";
import { vrcWiringCases, vrcWiringFixture } from "./nesVrcWiring.fixture.js";

it.each(vrcWiringCases)(
  "retains Mapper %i.%i wiring %s with CPU A%i/A%i through legacy and submapper-zero tracing",
  async (...board) => {
    for (const version of ["ines", "nes2-zero", "nes2-explicit"] as const) {
      const { bytes, initial, vrc4, chrBank } = vrcWiringFixture(
        board,
        version,
      );
      const parsed = parseNesHeader(bytes);
      if (!parsed.ok) throw new Error(parsed.error);
      const header = structuredClone(parsed.value);
      const trace = await deriveNesCode(
        header,
        bytes.subarray(528, 528 + 65536),
        traceNesCodeInputSchema.parse({ path: "/source.nes", initial }),
      );
      if (trace.status !== "derived" || trace.mapper_trace.status !== "derived")
        throw new Error(JSON.stringify(trace));
      expect(trace.stop.reason).toBe("return");
      expect(trace.final_cpu.a).toBe(0x77);
      expect(
        trace.instructions.find((i) => i.address === 0x9fff),
      ).toMatchObject({
        bytes_hex: "a95a",
        file_offsets: [528 + 3 * 8192 - 1, 528 + 5 * 8192],
      });
      expect(trace.mapper_trace.final).toMatchObject({ wiring: board[2] });
      expect(trace.mapper_trace.final_mapping.chr_windows[0]?.bank).toBe(
        chrBank,
      );
      const views = trace.mapper_trace.nes_prg_views;
      expect(views.every((v) => "wiring" in v && v.wiring === board[2])).toBe(
        true,
      );
      const layout = resolveNesMapperLayout(header, views);
      if (!layout.ok) throw new Error(layout.error);
      expect(
        layout.value.contexts.every((c) =>
          c.addressSpace.endsWith(board[2].toUpperCase()),
        ),
      ).toBe(true);
      expect(layout.value.mappings.slice(-4).map((w) => w.bank)).toEqual(
        vrc4 ? [6, 5, 2, 7] : [2, 5, 6, 7],
      );
      expect(header).toEqual(parsed.value);
      expect(header.header).toEqual([...bytes.subarray(0, 16)]);
      const replay = deriveNesMapperTrace(
        header,
        nesMapperStateSchema.parse(initial),
        trace.instructions.flatMap((i) => i.writes),
      );
      expect(replay).toEqual(trace.mapper_trace);
    }
  },
);

it.each(vrcWiringCases)(
  "rejects conflicting Mapper %i.%i wiring assumptions for %s",
  (...board) => {
    const { bytes } = vrcWiringFixture(board, "nes2-explicit");
    const parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    for (const other of vrcWiringCases.filter(
      (candidate) => candidate[2] !== board[2],
    )) {
      const state = nesMapperStateSchema.parse({
        mapper: other[0],
        wiring: other[2],
        ...(other[2].startsWith("vrc4") ? { variant: "vrc4" } : {}),
      });
      expect(deriveNesMapperTrace(parsed.value, state, []).status).toBe(
        "unsupported",
      );
    }
  },
);

it("does not admit ambiguous source headers without a wiring choice or hide mixed static assumptions", () => {
  const { bytes, initial } = vrcWiringFixture(vrcWiringCases[3], "ines");
  const parsed = parseNesHeader(bytes);
  if (!parsed.ok) throw new Error(parsed.error);
  expect(
    deriveNesMapperTrace(
      parsed.value,
      nesMapperStateSchema.parse({ mapper: 21, variant: "vrc4" }),
      [],
    ).status,
  ).toBe("unsupported");
  const first = {
    mapper: 21,
    variant: "vrc4",
    prg_mode: 0,
    prg_bank_0: 2,
    prg_bank_1: 5,
    wiring: "vrc4a",
  } as const;
  const second = { ...first, wiring: "vrc4c" } as const;
  expect(nesPrgViewsSchema.safeParse([first, second]).success).toBe(true);
  expect(resolveNesMapperLayout(parsed.value, [first, second]).ok).toBe(false);
  const { wiring: _, ...omitted } = first;
  expect(resolveNesMapperLayout(parsed.value, [first, omitted]).ok).toBe(false);
  const retained = deriveNesMapperTrace(
    parsed.value,
    nesMapperStateSchema.parse(initial),
    [nesMapperWriteSchema.parse({ address: 0x9004, value: 2 })],
  );
  expect(retained.status).toBe("derived");
});
