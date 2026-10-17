import { parseNesHeader } from "./nes.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import { nesCodeTraceSchema, traceNesCodeInputSchema } from "./nesCodeTrace.js";
import { expect } from "vitest";

/** Admit a literal ROM/PRG selection and retain its parsed request for replay checks. */
export async function deriveNesFixtureTrace(
  bytes: Buffer,
  prg: Uint8Array,
  rawInput: unknown,
  options?: Parameters<typeof deriveNesCode>[3],
) {
  const header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesCodeInputSchema.parse(rawInput);
  const trace = nesCodeTraceSchema.parse(
    await deriveNesCode(header.value, prg, input, options),
  );
  if (trace.status !== "derived") throw new Error(trace.reason);
  return { header: header.value, prg, input, trace };
}

type FixtureTrace = Awaited<ReturnType<typeof deriveNesFixtureTrace>>;

/** Committed APU/PPU events replay without the source trace's pending device frontiers. */
export async function expectNesFixtureMapperReplay(
  source: Pick<FixtureTrace, "header" | "prg" | "input"> & {
    chr: Uint8Array;
    mapped: FixtureTrace["trace"]["mapper_trace"];
  },
) {
  const mapped = source.mapped;
  if (mapped.status !== "derived" || !("apu_trace" in mapped))
    throw new Error("Expected a committed source APU trace");
  const expected = structuredClone(mapped);
  expected.apu_trace.frontier = [];
  if (
    "ppu_trace" in expected &&
    expected.ppu_trace !== null &&
    typeof expected.ppu_trace === "object" &&
    "frontier" in expected.ppu_trace
  )
    expected.ppu_trace.frontier = [];
  expect(
    await deriveNesMapperEvents(
      source.header,
      source.input.initial,
      mapped.steps.map((step) => step.event),
      {
        prg: source.prg,
        chr: source.chr,
        initialApu: source.input.initial_apu,
        initialPpu: source.input.initial_ppu,
      },
    ),
  ).toEqual(expected);
}
