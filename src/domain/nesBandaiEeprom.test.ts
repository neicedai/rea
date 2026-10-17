import { expect, it } from "vitest";
import { parseNesHeader } from "./nes.js";
import {
  eepromCases,
  eepromFixture,
  EepromBusFixture,
} from "./nesBandaiEeprom.fixture.js";
import { deriveNesMapperEvents } from "./nesMapperEventsDerivation.js";
import {
  traceNesMapperEventsInputSchema,
  type NesMapperCpuRead,
} from "./nesMapperEvents.js";
import { deriveNesCode } from "./nesCodeDerivation.js";
import { nesCodeTraceSchema, traceNesCodeInputSchema } from "./nesCodeTrace.js";
import {
  nesBandaiEepromStateSchema,
  nesBandaiEepromReadSchema,
} from "./nesBandaiEepromState.js";
import { isBandaiState } from "./nesBandai.js";

const bits = (read: NesMapperCpuRead | undefined) => {
  if (read === undefined) return undefined;
  const eeprom = nesBandaiEepromReadSchema.parse(read);
  return "known_bits" in eeprom ? eeprom.known_bits.value : undefined;
};

async function trace(
  board: (typeof eepromCases)[number],
  bus: EepromBusFixture,
  extra: Record<string, unknown> = {},
) {
  const fixture = eepromFixture(board),
    header = parseNesHeader(fixture.bytes);
  if (!header.ok) throw new Error(header.error);
  const input = traceNesMapperEventsInputSchema.parse({
    path: "/eeprom.nes",
    initial: { ...fixture.initial, ...extra },
    events: bus.events,
  });
  const result = await deriveNesMapperEvents(
    header.value,
    input.initial,
    input.events,
  );
  if (result.status !== "derived") throw new Error(result.reason);
  if (!isBandaiState(result.final) || !("eeprom" in result.final))
    throw new Error("Expected EEPROM state");
  return { result, eeprom: result.final.eeprom, header: header.value, input };
}

it.each(eepromCases)(
  "reads $model/$page_size MSB-first with sequential whole-chip wrap and exact continuation",
  async (board) => {
    const { bus } = eepromFixture(board),
      { result, eeprom, header, input } = await trace(board, bus);
    const reads = result.steps.flatMap((s) =>
      "cpu_read" in s ? [s.cpu_read] : [],
    );
    expect(
      reads.filter((s) => s.address === 0x7fff).map((s) => bits(s)),
    ).toEqual(board.model === "x24c01" ? [0] : [0, 0, 0]);
    expect(
      reads.filter((s) => s.address === 0x6000).map((s) => bits(s)),
    ).toEqual([16, 0, 0, 16, 0, 16, 16, 0, 16, 0, 16, 0, 0, 16, 0, 16]);
    expect(eeprom).toMatchObject({ phase: "idle", address: 1, busy: false });
    const split = Math.floor(input.events.length / 2);
    const first = await deriveNesMapperEvents(
      header,
      input.initial,
      input.events.slice(0, split),
    );
    if (first.status !== "derived") throw new Error(first.reason);
    const rest = await deriveNesMapperEvents(
      header,
      first.final,
      input.events.slice(split),
    );
    if (rest.status !== "derived") throw new Error(rest.reason);
    expect(rest.final).toEqual(result.final);
    expect(rest.steps.map(({ index: _index, ...s }) => s)).toEqual(
      result.steps.slice(split).map(({ index: _index, ...s }) => s),
    );
  },
);

it.each(eepromCases)(
  "stages $model/$page_size page rollover and busy NACK before explicit completion",
  async (board) => {
    const bus = new EepromBusFixture();
    bus.address(board.model, board.page_size - 1, false);
    for (let i = 0; i < board.page_size + 2; i++) bus.send(i + 16);
    bus.stop();
    const { result, eeprom, header, input } = await trace(board, bus);
    expect(eeprom.bytes).toEqual(
      input.initial.mapper === 16 || input.initial.mapper === 159
        ? "eeprom" in input.initial
          ? input.initial.eeprom.bytes
          : []
        : [],
    );
    expect(eeprom.busy).toBe(true);
    expect(eeprom.pending).toHaveLength(board.page_size);
    const poll = new EepromBusFixture();
    poll.start();
    poll.send(board.model === "x24c01" ? 0 : 0xa0);
    poll.stop();
    const polling = await deriveNesMapperEvents(
      header,
      result.final,
      poll.events,
    );
    if (polling.status !== "derived") throw new Error(polling.reason);
    expect(
      bits(
        polling.steps.flatMap((s) => ("cpu_read" in s ? [s.cpu_read] : []))[0],
      ),
    ).toBe(16);
    expect(polling.final).toEqual({
      ...result.final,
      eeprom_control: 0x60,
      eeprom: expect.objectContaining({ busy: true }),
    });
    const complete = await deriveNesMapperEvents(header, polling.final, [
      { kind: "eeprom-write-complete" },
    ]);
    if (
      complete.status !== "derived" ||
      !isBandaiState(complete.final) ||
      !("eeprom" in complete.final)
    )
      throw new Error("Expected completion");
    const committed = complete.final.eeprom!;
    expect(committed.busy).toBe(false);
    expect(committed.pending).toEqual([]);
    for (let i = 0; i < board.page_size; i++) {
      const last = i < 2 ? board.page_size + i : i;
      const address = (board.page_size - 1 + i) % board.page_size;
      expect(committed.bytes.find((b) => b.address === address)?.value).toBe(
        last + 16,
      );
    }
  },
);

it.each(eepromCases)(
  "uses $model serial D4 proofs to choose PRG banks with exact source provenance",
  async (board) => {
    const { bytes, initial } = eepromFixture(board),
      header = parseNesHeader(bytes);
    if (!header.ok) throw new Error(header.error);
    const input = traceNesCodeInputSchema.parse({
      path: "/eeprom.nes",
      initial,
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
    expect(result.final_cpu.a).toBe(0x77);
    expect(
      result.instructions.find((i) => i.address === 0xbfff)?.file_offsets,
    ).toEqual([528 + 2 * 16384 - 1, 528 + 3 * 16384]);
    const reads = result.instructions.flatMap((i) => i.data_reads);
    for (const read of reads) {
      expect(read.value).toBeNull();
      expect(read).toHaveProperty("known_bits.mask", 16);
      const origin = read.mapper_origins[0];
      if (
        origin?.kind !== "bandai-eeprom" ||
        origin.control_source.kind !== "cpu-write"
      )
        throw new Error("Expected a serial control writer");
      expect(
        result.instructions[origin.control_source.instruction_index]?.writes[
          origin.control_source.write_index
        ],
      ).toMatchObject({ address: 0x800d });
      expect(origin.initial_eeprom_byte_indices).toEqual(
        origin.line_source.kind === "device-data"
          ? [origin.line_source.pointer === board.capacity - 1 ? 0 : 1]
          : [],
      );
    }
  },
);

it("retains partial data bytes, uncertain addresses and the EEPROM open-bus boundary", async () => {
  const board = eepromCases[0],
    bus = new EepromBusFixture();
  bus.address(board.model, 3, false);
  const dataStart = bus.events.length;
  bus.send(0xa5);
  bus.stop();
  // Remove only one data bit proof, preserving all known SCL/D7/D6 facts on the other bits.
  const dataRising = bus.events[dataStart + 1];
  if (dataRising?.kind !== "cpu-write")
    throw new Error("Expected rising data clock");
  const index = bus.events.indexOf(dataRising);
  bus.events[index] = {
    kind: "cpu-write",
    address: 0x800d,
    value: null,
    known_bits: { mask: 0xbf, value: 0x20 },
    preceded_by_cpu_write: false,
  };
  const { result, header } = await trace(board, bus);
  const completed = await deriveNesMapperEvents(header, result.final, [
    { kind: "eeprom-write-complete" },
    { kind: "cpu-read", address: 0x6000 },
    { kind: "cpu-read", address: 0x8000 },
  ]);
  if (
    completed.status !== "derived" ||
    !isBandaiState(completed.final) ||
    !("eeprom" in completed.final)
  )
    throw new Error("Expected completion");
  expect(
    completed.final.eeprom?.bytes.find((b) => b.address === 3)?.value,
  ).toEqual({ mask: 127, value: 0x25 });
  expect(
    "cpu_read" in completed.steps[1]!
      ? completed.steps[1].cpu_read.value
      : undefined,
  ).toBeNull();
  expect(
    "cpu_read" in completed.steps[2]! ? completed.steps[2].cpu_read : undefined,
  ).toEqual({
    address: 0x8000,
    value: null,
    source: null,
  });
  expect(
    nesBandaiEepromStateSchema.safeParse({ model: "x24c02" }).success,
  ).toBe(false);
  expect(
    nesBandaiEepromStateSchema.safeParse({
      model: "x24c01",
      bytes: [{ address: 128, value: 1 }],
    }).success,
  ).toBe(false);
  expect(
    nesBandaiEepromStateSchema.safeParse({
      model: "x24c01",
      bytes: [
        { address: 1, value: 1 },
        { address: 1, value: 2 },
      ],
    }).success,
  ).toBe(false);
});

it("joins partial-address stores with retained bytes, rather than choosing an EEPROM location", async () => {
  const board = eepromCases[0],
    bus = new EepromBusFixture();
  bus.address(board.model, 3, false);
  bus.events[4] = {
    kind: "cpu-write",
    address: 0x800d,
    value: null,
    known_bits: { mask: 0xbf, value: 0x20 },
    preceded_by_cpu_write: false,
  };
  bus.send(0x25);
  bus.stop();
  const { result, header } = await trace(board, bus, {
    eeprom: {
      model: "x24c01",
      phase: "idle",
      busy: false,
      bytes: [
        { address: 3, value: 0xa5 },
        { address: 67, value: 0xa5 },
        { address: 5, value: 0x77 },
      ],
    },
  });
  const complete = await deriveNesMapperEvents(header, result.final, [
    { kind: "eeprom-write-complete" },
  ]);
  if (
    complete.status !== "derived" ||
    !isBandaiState(complete.final) ||
    !("eeprom" in complete.final)
  )
    throw new Error("Expected EEPROM");
  expect(complete.final.eeprom.bytes).toEqual([
    { address: 3, value: { mask: 127, value: 0x25 } },
    { address: 67, value: { mask: 127, value: 0x25 } },
    { address: 5, value: 0x77 },
  ]);
});

it("keeps readiness, missing bytes, wrong addresses and lost serial history unknown", async () => {
  const board = eepromCases[1],
    { bus } = eepromFixture(board);
  const missing = await trace(board, bus, {
    eeprom: { model: "x24c02", page_size: 4, phase: "idle", busy: false },
  });
  expect(missing.result.coverage).toMatchObject({ unknown_cpu_reads: 16 });
  expect(
    missing.result.steps.flatMap((s) =>
      "cpu_read" in s && s.cpu_read.source?.kind === "device-data"
        ? [s.cpu_read]
        : [],
    ),
  ).toEqual([]);
  const notReady = await trace(board, bus, {
    eeprom: { model: "x24c02", page_size: 4, phase: "idle" },
  });
  expect(
    notReady.result.steps
      .flatMap((s) => ("cpu_read" in s ? [bits(s.cpu_read)] : []))
      .every((b) => b === undefined),
  ).toBe(true);
  const wrong = new EepromBusFixture();
  wrong.start();
  wrong.send(0xa2);
  wrong.stop();
  expect(
    bits(
      (await trace(board, wrong)).result.steps.flatMap((s) =>
        "cpu_read" in s ? [s.cpu_read] : [],
      )[0],
    ),
  ).toBe(16);
  const lost = new EepromBusFixture();
  lost.address(board.model, 1, false);
  lost.send(0x55);
  lost.stop();
  lost.events.push({
    kind: "cpu-write",
    address: 0x800d,
    value: null,
    known_bits: { mask: 0xdf, value: 0x40 },
    preceded_by_cpu_write: false,
  });
  lost.events.push({ kind: "eeprom-write-complete" });
  const retained = (await trace(board, lost)).eeprom;
  expect(retained.bytes.find((b) => b.address === 1)?.value).toBe(0x55);
  expect(retained.bytes.find((b) => b.address === 0)?.value).toBe(0xa5);
  const unknownCycle = new EepromBusFixture();
  unknownCycle.events.push({ kind: "eeprom-write-complete" });
  expect(
    (
      await trace(board, unknownCycle, {
        eeprom: {
          model: "x24c02",
          page_size: 4,
          busy: true,
          bytes: [{ address: 0, value: 0x77 }],
        },
      })
    ).eeprom.bytes,
  ).toEqual([{ address: 0, value: null }]);
});

it("rejects completion without a pending cycle and chip/capacity conflicts", async () => {
  for (const board of eepromCases) {
    const { bytes, initial } = eepromFixture(board),
      header = parseNesHeader(bytes);
    if (!header.ok) throw new Error(header.error);
    const input = traceNesMapperEventsInputSchema.parse({
      path: "/eeprom.nes",
      initial,
      events: [{ kind: "eeprom-write-complete" }],
    });
    expect(
      (await deriveNesMapperEvents(header.value, input.initial, input.events))
        .status,
    ).toBe("unsupported");
    const mismatch = traceNesMapperEventsInputSchema.parse({
      path: "/eeprom.nes",
      initial: {
        ...initial,
        eeprom: {
          model: board.model === "x24c01" ? "x24c02" : "x24c01",
          page_size: 4,
        },
      },
      events: [],
    });
    expect(
      (
        await deriveNesMapperEvents(
          header.value,
          mismatch.initial,
          mismatch.events,
        )
      ).status,
    ).toBe("unsupported");
  }
});

it("rejects incompatible serial frontiers without overflowing the public bit counter", async () => {
  const board = eepromCases[0],
    { bytes, initial } = eepromFixture(board),
    header = parseNesHeader(bytes);
  if (!header.ok) throw new Error(header.error);
  for (const fields of [
    { phase: "command", bit_index: 8 },
    { phase: "read", bit_index: 0 },
    { phase: "ack", ack_stage: 1 },
    { phase: "master-ack", ack_stage: 0 },
  ]) {
    const input = traceNesMapperEventsInputSchema.parse({
      path: "/eeprom.nes",
      initial: { ...initial, eeprom: { ...initial.eeprom, ...fields } },
      events: [{ kind: "cpu-write", address: 0x800d, value: 0xa0 }],
    });
    expect(
      (await deriveNesMapperEvents(header.value, input.initial, input.events))
        .status,
    ).toBe("unsupported");
  }
});
