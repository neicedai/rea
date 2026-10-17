import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent supplied-grant/decoder oracle; no emulator or production imports. */
export async function verifyPackageNesDmc(invoke, workspace) {
  const rom = Buffer.alloc(16 + 32768, 2);
  rom.fill(0, 0, 16);
  rom.set([78, 69, 83, 26, 2, 0, 0, 8]);
  rom[16] = 0x2c;
  rom[rom.length - 1] = 0x81;
  const path = join(workspace, "dmc-reader-output.nes");
  await writeFile(path, rom);
  let workflows = 0;
  const call = async (command, input) => {
    workflows++;
    return invoke(command, input);
  };
  const base = { path, initial: { mapper: 0 }, initial_apu: apu() };
  const clocks = (count) =>
    Array.from({ length: count }, () => ({ kind: "apu-dmc-clock" }));
  const events = [
    { kind: "apu-dmc-read" },
    ...clocks(1),
    { kind: "apu-dmc-read" },
    ...clocks(8),
    { kind: "cpu-read", address: 0x4015 },
  ];
  const evidence = await call("trace-nes-mapper-events", { ...base, events });
  const full = evidence.normalized_result.trace;
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(rom).digest("hex"),
  );
  assert.equal(full.status, "derived");
  assert.deepEqual(
    full.steps
      .filter((step) => step.dmc_read)
      .map((step) => [
        step.dmc_read.address,
        step.dmc_read.value,
        step.dmc_read.file_offset,
      ]),
    [
      [65535, 129, 32783],
      [32768, 44, 16],
    ],
  );
  let expected = 64;
  const levels = [expected];
  for (let bit = 0; bit < 8; bit++) {
    expected += 0x81 & (1 << bit) ? 2 : -2;
    levels.push(expected);
  }
  let observedLevel = 64;
  assert.deepEqual(
    full.apu_trace.operations
      .filter((operation) => operation.kind === "apu-dmc-clock")
      .map((operation) => {
        const change = operation.changes.find(
          (change) => change.field === "dmc.level",
        );
        if (change !== undefined) observedLevel = change.after.value;
        return observedLevel;
      }),
    levels,
  );
  assert.equal(full.apu_trace.final.dmc.level, 56);
  assert.equal(full.apu_trace.final.dmc.shift, 44);
  assert.deepEqual(full.apu_trace.final.dmc.shift_origin, {
    kind: "dmc-read",
    index: 2,
  });
  assert.deepEqual(full.apu_trace.final.dmc_remaining.value, {
    min: 0,
    max: 0,
  });
  assert.equal(full.apu_trace.final.dmc_irq.value, true);
  assert.equal(full.apu_trace.dmc_read_ready, false);
  assert.equal(full.steps.at(-1).cpu_read.known_bits.value & 144, 128);
  const prefix = (
    await call("trace-nes-mapper-events", {
      ...base,
      events: events.slice(0, 3),
    })
  ).normalized_result.trace;
  const resumed = (
    await call("trace-nes-mapper-events", {
      ...base,
      initial_apu: prefix.apu_trace.final,
      events: events.slice(3),
    })
  ).normalized_result.trace;
  assert.deepEqual(resumed.apu_trace.final, full.apu_trace.final);
  const budget = (
    await call("trace-nes-mapper-events", {
      ...base,
      events: events.slice(0, 1),
      max_steps: 1,
    })
  ).normalized_result.trace;
  assert.equal(budget.coverage.processed_events, 1);
  assert.equal(budget.apu_trace.final.dmc.buffer.status, "full");
  for (const [input, reason] of [
    [
      { ...base, events: [{ kind: "apu-dmc-read" }, { kind: "apu-dmc-read" }] },
      /empty.*buffer/,
    ],
    [
      { ...base, initial_apu: null, events: [{ kind: "apu-dmc-read" }] },
      /initial_apu/,
    ],
    [
      { ...base, initial_apu: { ...base.initial_apu, dmc: null }, events: [] },
      /together/,
    ],
    [
      {
        ...base,
        initial_apu: {
          ...base.initial_apu,
          dmc: {
            ...base.initial_apu.dmc,
            buffer: {
              status: "full",
              value: 1,
              origin: { kind: "dmc-read", index: 0 },
            },
          },
        },
        events: [],
      },
      /origins.*precede/,
    ],
  ]) {
    const trace = (await call("trace-nes-mapper-events", input))
      .normalized_result.trace;
    assert.equal(trace.status, "unsupported");
    assert.match(trace.reason, reason);
  }
  const source = (
    await call("trace-nes-code", {
      ...base,
      initial_cpu_bus: { model: "nmos-6502-bus", dma_reads: "absent" },
    })
  ).normalized_result.code_trace;
  assert.equal(source.status, "unsupported");
  assert.match(source.reason, /DMC DMA requires initial_apu.dmc.cpu_timing/);
  const looping = apu();
  looping.registers[16400].value = 192;
  looping.dmc_remaining.value = { min: 1, max: 1 };
  const loop = (
    await call("trace-nes-mapper-events", {
      ...base,
      initial_apu: looping,
      events: [{ kind: "apu-dmc-read" }],
    })
  ).normalized_result.trace.apu_trace.final;
  assert.deepEqual(loop.dmc_remaining.value, { min: 17, max: 17 });
  assert.equal(loop.dmc.current_address, 0xc080);
  assert.equal(loop.dmc_irq.value, false);
  const partial = apu();
  partial.registers[16400].value = { mask: 128, value: 128 };
  partial.dmc_remaining.value = { min: 1, max: 2 };
  const joined = (
    await call("trace-nes-mapper-events", {
      ...base,
      initial_apu: partial,
      events: [{ kind: "apu-dmc-read" }],
    })
  ).normalized_result.trace.apu_trace.final;
  assert.deepEqual(joined.dmc_remaining.value, { min: 0, max: 17 });
  assert.equal(joined.dmc_irq.value, null);
  assert.equal(joined.dmc.current_address, null);
  const restarting = apu();
  restarting.registers[16405].value = 0;
  restarting.dmc_remaining.value = { min: 0, max: 0 };
  restarting.dmc.buffer = {
    status: "full",
    value: 129,
    origin: { kind: "initial-state" },
  };
  const restarted = (
    await call("trace-nes-mapper-events", {
      ...base,
      initial_apu: restarting,
      events: [
        {
          kind: "cpu-write",
          address: 16405,
          value: 16,
          preceded_by_cpu_write: null,
        },
        ...clocks(1),
        { kind: "apu-dmc-read" },
      ],
    })
  ).normalized_result.trace;
  assert.equal(restarted.steps[2].dmc_read.address, 0xc080);
  assert.equal(restarted.steps[2].dmc_read.file_offset, 16 + 0x4080);
  assert.equal(restarted.apu_trace.final.dmc.shift, 129);
  assert.equal(restarted.apu_trace.final.dmc.buffer.value, 2);
  assert.deepEqual(restarted.apu_trace.final.dmc_remaining.value, {
    min: 16,
    max: 16,
  });
  const stopped = apu();
  stopped.dmc.buffer = {
    status: "full",
    value: 0x81,
    origin: { kind: "initial-state" },
  };
  const stop = (
    await call("trace-nes-mapper-events", {
      ...base,
      initial_apu: stopped,
      events: [
        {
          kind: "cpu-write",
          address: 0x4015,
          value: 0,
          preceded_by_cpu_write: null,
        },
        ...clocks(9),
      ],
    })
  ).normalized_result.trace.apu_trace.final;
  assert.equal(stop.dmc.level, 56);
  assert.equal(stop.dmc.silence, true);
  assert.equal(stop.dmc_irq.value, false);
  assert.deepEqual(stop.dmc_remaining.value, { min: 0, max: 0 });
  const direct = (
    await call("trace-nes-mapper-events", {
      ...base,
      events: [
        {
          kind: "cpu-write",
          address: 0x4011,
          value: 254,
          preceded_by_cpu_write: null,
        },
      ],
    })
  ).normalized_result.trace;
  assert.equal(direct.apu_trace.final.dmc.level, 126);
  assert.equal(direct.apu_trace.dmc_read_ready, true);
  for (const [region, period] of [
    ["ntsc", 54],
    ["pal", 50],
  ]) {
    const clocked = clockApu(region);
    const trace = (
      await call("trace-nes-mapper-events", {
        ...base,
        initial_apu: clocked,
        events: Array.from({ length: period + 1 }, () => ({
          kind: "apu-cpu-cycle",
        })),
      })
    ).normalized_result.trace;
    assert.equal(trace.apu_trace.final.dmc.level, 68);
    assert.equal(trace.apu_trace.final.dmc.timer_remaining, period);
  }
  const banked = Buffer.alloc(16 + 65536, 2);
  banked.fill(0, 0, 16);
  banked.set([78, 69, 83, 26, 4, 0, 64, 8]);
  banked[16 + 6 * 8192] = 129;
  banked[16 + 8192 + 1] = 105;
  const bankedPath = join(workspace, "dmc-mmc3.nes");
  await writeFile(bankedPath, banked);
  const bankApu = apu();
  bankApu.dmc.current_address = 0xc000;
  const bankBase = {
    ...base,
    path: bankedPath,
    initial: { mapper: 4, bank_select: 0, banks: [0, 0, 0, 0, 0, 0, 1, 2] },
    initial_apu: bankApu,
  };
  const switched = (
    await call("trace-nes-mapper-events", {
      ...bankBase,
      events: [
        { kind: "apu-dmc-read" },
        ...clocks(1),
        {
          kind: "cpu-write",
          address: 0x8000,
          value: 70,
          preceded_by_cpu_write: null,
        },
        { kind: "apu-dmc-read" },
      ],
    })
  ).normalized_result.trace;
  assert.deepEqual(
    switched.steps
      .filter((step) => step.dmc_read)
      .map((step) => [
        step.dmc_read.value,
        step.dmc_read.file_offset,
        step.dmc_read.source.window.bank,
      ]),
    [
      [129, 16 + 6 * 8192, 6],
      [105, 16 + 8192 + 1, 1],
    ],
  );
  assert.equal(switched.apu_trace.final.dmc.shift, 129);
  assert.equal(switched.apu_trace.final.dmc.buffer.value, 105);
  const unknownBank = (
    await call("trace-nes-mapper-events", {
      ...bankBase,
      initial: {
        ...bankBase.initial,
        bank_select: 64,
        banks: [0, 0, 0, 0, 0, 0, null, 2],
      },
      events: [{ kind: "apu-dmc-read" }],
    })
  ).normalized_result.trace;
  assert.equal(unknownBank.steps[0].dmc_read.file_offset, null);
  assert.equal(
    unknownBank.steps[0].dmc_read.source.reason,
    "unresolved-prg-window",
  );
  assert.equal(unknownBank.apu_trace.final.dmc.buffer.value, null);
  const unknownAddress = apu();
  unknownAddress.dmc.current_address = null;
  const unknown = (
    await call("trace-nes-mapper-events", {
      ...base,
      initial_apu: unknownAddress,
      events: [{ kind: "apu-dmc-read" }],
    })
  ).normalized_result.trace;
  assert.equal(unknown.steps[0].dmc_read.source.reason, "unknown-address");
  assert.equal(unknown.apu_trace.final.dmc.current_address, null);
  const mixed = (
    await call("trace-nes-mapper-events", {
      ...base,
      initial_apu: clockApu("ntsc"),
      events: [{ kind: "apu-dmc-clock" }],
    })
  ).normalized_result.trace;
  assert.equal(mixed.status, "unsupported");
  assert.match(mixed.reason, /cannot mix/);
  assert.deepEqual(await readFile(path), rom);
  assert.deepEqual(await readFile(bankedPath), banked);
  assert.equal(workflows, 20);
  return {
    ok: true,
    workflows,
    regions: 2,
    mapper_sources: true,
    continuation: true,
    original_unchanged: true,
    scope:
      "Qualified supplied DMC grants/decoder/timer edges only; internal-register conflicts, source DMA halt/load/reload/OAM arbitration, silicon stop bugs, RAM sample reads, mixer, hardware and commercial-game compatibility remain unverified",
  };
}

function apu() {
  const origin = { kind: "initial-state" };
  return {
    model: "apu-registers",
    frame_clocks: "explicit",
    dmc_reads: "explicit",
    registers: Object.fromEntries(
      [
        [0x4010, 128],
        [0x4012, 2],
        [0x4013, 1],
        [0x4015, 16],
      ].map(([address, value]) => [address, { value, origin }]),
    ),
    dmc_remaining: { value: { min: 2, max: 2 }, origin },
    dmc_irq: { value: false, origin },
    frame_irq: { value: false, origin },
    dmc: {
      model: "dmc-reader-output",
      region: "ntsc",
      clocks: "explicit",
      current_address: 65535,
      buffer: { status: "empty" },
      shift: 0,
      bits_remaining: 1,
      silence: true,
      level: 64,
      timer_remaining: 1,
    },
  };
}
function clockApu(region) {
  const state = apu();
  state.frame_clocks = "cpu-ordered";
  state.frame_sequencer = {
    region,
    position: { min: 0, max: 0 },
    five_step: false,
    cpu_phase: "get",
    reset_delay: { min: 0, max: 0 },
    clock_block: 0,
  };
  state.registers[16407] = { value: 64, origin: { kind: "initial-state" } };
  state.registers[16400].value = 15;
  state.registers[16405].value = 0;
  state.dmc_remaining.value = { min: 0, max: 0 };
  Object.assign(state.dmc, {
    region,
    clocks: "cpu-ordered",
    shift: 255,
    silence: false,
    bits_remaining: 8,
  });
  return state;
}
