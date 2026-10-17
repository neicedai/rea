import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Independent installed source-clock and counter-read oracle; no domain models/fixtures. */
export async function verifyPackageNesSourceIrq(invoke, workspace) {
  const bytes = cartridge(19),
    path = join(workspace, "installed-source-irq.nes"),
    entry = 0xe234;
  bytes.set(
    [173, 255, 87, 41, 3, 141, 255, 231, 76, 48, 128],
    16 + 15 * 8192 + 0x234,
  );
  bytes.set([173, 255, 95, 141, 15, 80, 173, 0, 80, 2], 16 + 3 * 8192 + 0x30);
  bytes.set([234, 2], 16 + 3 * 8192 + 0x50);
  await writeFile(path, bytes);
  const origin = { kind: "initial-state" },
    input = {
      path,
      entry,
      initial: {
        mapper: 19,
        variant: "namco163",
        prg_banks: [2, 6, 7],
        irq_high: 128,
        irq_low: 0,
      },
      initial_irq: {
        model: "namco163",
        counter_low: 248,
        counter_high: 127,
        asserted: false,
      },
      initial_cpu_bus: {
        model: "nmos-6502-bus",
        dma_reads: "absent",
        next_cycle_index: 400,
      },
      initial_apu: {
        model: "apu-registers",
        frame_clocks: "cpu-ordered",
        dmc_reads: "absent",
        next_event_index: 2200,
        registers: { 16407: { value: 0, origin } },
        frame_irq: { value: false, origin },
        frame_sequencer: {
          region: "pal",
          position: { min: 100, max: 100 },
          five_step: false,
          cpu_phase: "put",
          reset_delay: { min: 0, max: 0 },
          clock_block: 0,
        },
      },
    };
  const evidence = await invoke("trace-nes-code", input),
    trace = evidence.normalized_result.code_trace,
    mapped = trace.mapper_trace;
  assert.equal(trace.status, "derived");
  assert.equal(mapped.status, "derived");
  assert.deepEqual(
    trace.instructions.map((i) => i.address),
    [0xe234, 0xe237, 0xe239, 0xe23c, 0x8030, 0x8033, 0x8036],
  );
  assert.deepEqual(
    trace.instructions.flatMap((i) => i.data_reads.map((read) => read.value)),
    [251, 255, 255],
  );
  assert.deepEqual(mapped.final_irq, {
    model: "namco163",
    counter_low: 255,
    counter_high: 127,
    asserted: false,
  });
  assert.equal(mapped.final.irq_low, 255);
  assert.equal(mapped.steps.length, 55);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 425);
  assert.equal(mapped.apu_trace.final.next_event_index, 2255);
  assert.deepEqual(mapped.apu_trace.final.frame_sequencer.position, {
    min: 125,
    max: 125,
  });
  verifySources(trace, bytes);
  const replay = await invoke("trace-nes-mapper-events", {
    path,
    initial: input.initial,
    initial_irq: input.initial_irq,
    initial_apu: input.initial_apu,
    events: mapped.steps.map((step) => step.event),
  });
  assert.deepEqual(replay.normalized_result.trace.final_irq, mapped.final_irq);
  assert.deepEqual(
    replay.normalized_result.trace.apu_trace.final,
    mapped.apu_trace.final,
  );
  assert.deepEqual(
    (await invoke("explore-nes-code", input)).normalized_result.code_exploration
      .paths[0].trace,
    trace,
  );
  const resumed = (
    await invoke("trace-nes-code", {
      ...input,
      entry: 0x8050,
      max_instructions: 1,
      initial: mapped.final,
      initial_irq: mapped.final_irq,
      initial_apu: mapped.apu_trace.final,
      initial_cpu_bus: trace.cpu_bus.final,
    })
  ).normalized_result.code_trace;
  assert.equal(resumed.mapper_trace.final_irq.asserted, false);
  assert.equal(resumed.cpu_bus.final.next_cycle_index, 427);
  assert.equal(resumed.mapper_trace.apu_trace.final.next_event_index, 2259);
  assert.equal(
    evidence.subject.digest.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  await verifyFamilies(invoke, workspace);
  await verifyFrontier(invoke, path, input.initial);
  assert.deepEqual(await readFile(path), bytes);
  return {
    ok: true,
    workflows: 11,
    cpu_clocked_models: 6,
    namco_live_read_bank: 3,
    source_and_replay: true,
    original_unchanged: true,
    scope:
      "Installed conditional nominal source timing; no PPU-driven source IRQs, asynchronous acceptance, DMA stalls or physical hardware verification",
  };
}

function cartridge(mapper, submapper = 0) {
  const bytes = Buffer.alloc(16 + 131072 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([
    78,
    69,
    83,
    26,
    8,
    1,
    (mapper & 15) << 4,
    (mapper & 240) | 8,
    submapper << 4,
  ]);
  if (mapper === 159) {
    bytes[6] |= 2;
    bytes[10] = 16;
  }
  return bytes;
}
function verifySources(trace, bytes) {
  let cycleIndex = 400;
  for (const instruction of trace.instructions)
    for (const cycle of instruction.cpu_bus_cycles) {
      assert.equal(cycle.index, cycleIndex++);
      if (cycle.kind !== "read") continue;
      const read = cycle.read;
      if (read.file_offset !== null) {
        const address = read.address,
          bank =
            address >= 0xe000
              ? 15
              : address >= 0xc000
                ? 7
                : address >= 0xa000
                  ? 6
                  : 3;
        assert.equal(read.file_offset, 16 + bank * 8192 + (address & 8191));
        assert.equal(read.value, bytes[read.file_offset]);
      } else {
        const source = read.mapper_origins[0];
        assert.equal(source.kind, "namco163-irq-counter");
        const { byte_index, mapper_event_index, ...proof } = source;
        assert.equal(byte_index, 0);
        const event = trace.mapper_trace.steps[mapper_event_index];
        assert.deepEqual(event.event, {
          kind: "cpu-read",
          address: read.address,
        });
        assert.deepEqual(event.cpu_read.source, proof);
        assert.equal(event.cpu_read.value, read.value);
      }
    }
}

async function verifyFamilies(invoke, workspace) {
  const samples = [
    {
      mapper: 25,
      submapper: 2,
      initial: {
        mapper: 25,
        variant: "vrc4",
        irq_control: 0,
        irq_enabled: false,
        irq_latch_low: 13,
        irq_latch_high: 15,
      },
      irq: { model: "vrc4", counter: 18, asserted: false },
      address: 0xf004,
      value: 7,
      final: { counter: 253, asserted: true },
    },
    {
      mapper: 26,
      initial: {
        mapper: 26,
        irq_control: 0,
        irq_enabled: false,
        irq_latch: 253,
      },
      irq: { model: "vrc6", counter: 18, asserted: false },
      address: 0xf002,
      value: 7,
      final: { counter: 253, asserted: true },
    },
    {
      mapper: 16,
      submapper: 4,
      initial: { mapper: 16, variant: "fcg", irq_control: 0 },
      irq: {
        model: "bandai-fcg",
        counter_low: 0,
        counter_high: 0,
        asserted: false,
      },
      address: 0x600a,
      value: 1,
      final: { counter_low: 253, counter_high: 255, asserted: true },
    },
    {
      mapper: 159,
      initial: { mapper: 159, irq_control: 0, irq_low: 1, irq_high: 0 },
      irq: {
        model: "bandai-lz93d50",
        counter_low: 57,
        counter_high: 0,
        asserted: false,
      },
      address: 0x800a,
      value: 1,
      final: { counter_low: 254, counter_high: 255, asserted: true },
    },
    {
      mapper: 69,
      initial: { mapper: 69, variant: "5b", command: 13, irq_control: 0 },
      irq: { model: "fme7", counter_low: 1, counter_high: 0, asserted: false },
      address: 0xa000,
      value: 129,
      final: { counter_low: 254, counter_high: 255, asserted: true },
    },
    {
      mapper: 19,
      initial: { mapper: 19, variant: "namco163", irq_high: 0 },
      irq: {
        model: "namco163",
        counter_low: 253,
        counter_high: 0,
        asserted: false,
      },
      address: 0x5800,
      value: 255,
      final: { counter_low: 255, counter_high: 255, asserted: true },
    },
  ];
  for (const sample of samples) {
    const bytes = cartridge(sample.mapper, sample.submapper),
      path = join(workspace, `installed-source-irq-${sample.mapper}.nes`);
    await writeFile(path, bytes);
    const program = [
      169,
      sample.value,
      141,
      sample.address & 255,
      sample.address >> 8,
      234,
    ];
    const input = {
      path,
      initial: sample.initial,
      initial_irq: sample.irq,
      initial_cpu_bus: { model: "nmos-6502-bus", dma_reads: "absent" },
      entry: 0x345,
      max_instructions: 3,
      initial_ram: program.map((value, index) => ({
        address: 0x345 + index,
        value,
      })),
    };
    const trace = (await invoke("trace-nes-code", input)).normalized_result
      .code_trace;
    assert.equal(
      trace.status,
      "derived",
      JSON.stringify({ mapper: sample.mapper, result: trace }),
    );
    for (const [key, value] of Object.entries(sample.final))
      assert.equal(
        trace.mapper_trace.final_irq[key],
        value,
        `${sample.mapper} ${key}`,
      );
    assert.equal(trace.cpu_bus.final.next_cycle_index, 8);
    for (const instruction of trace.instructions)
      for (const [index, origin] of instruction.ram_origins.entries()) {
        assert.equal(
          origin.initial_ram_index,
          instruction.address - 0x345 + index,
        );
        assert.equal(
          input.initial_ram[origin.initial_ram_index].value,
          Buffer.from(instruction.bytes_hex, "hex")[index],
        );
      }
    const replay = await invoke("trace-nes-mapper-events", {
      path,
      initial: input.initial,
      initial_irq: input.initial_irq,
      events: trace.mapper_trace.steps.map((step) => step.event),
    });
    assert.deepEqual(
      replay.normalized_result.trace.final_irq,
      trace.mapper_trace.final_irq,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyFrontier(invoke, path, initial) {
  const initial_irq = {
    model: "namco163",
    counter_low: { mask: 254, value: 248 },
    counter_high: 127,
    asserted: false,
  };
  const trace = (
    await invoke("trace-nes-code", {
      path,
      initial,
      initial_irq,
      initial_cpu_bus: { model: "nmos-6502-bus", dma_reads: "absent" },
      entry: 0x345,
      initial_ram: [108, 255, 87].map((value, index) => ({
        address: 0x345 + index,
        value,
      })),
    })
  ).normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "unknown-control-target");
  assert.deepEqual(trace.instructions, []);
  assert.deepEqual(trace.mapper_trace.final_irq, initial_irq);
  assert.equal(trace.cpu_bus.final.next_cycle_index, 0);
  const events = trace.stop.cpu_bus_frontier.mapper_events;
  assert.equal(events.length, 7);
  const replay = (
    await invoke("trace-nes-mapper-events", {
      path,
      initial,
      initial_irq,
      events,
    })
  ).normalized_result.trace;
  let counters = [0x7ff8, 0x7ff9];
  for (const step of replay.steps) {
    if (step.event.kind === "namco163-cpu-cycle")
      counters = counters.map((counter) => Math.min(counter + 1, 0x7fff));
    if (step.cpu_read) {
      const read = step.cpu_read;
      for (const counter of counters)
        if (read.value !== null) assert.equal(read.value, counter & 255);
        else if (read.known_bits)
          assert.equal(
            counter & 255 & read.known_bits.mask,
            read.known_bits.value,
          );
    }
  }
}
