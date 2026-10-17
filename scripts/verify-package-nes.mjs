import assert from "node:assert/strict";
import { verifyPackageNesDiscovery } from "./verify-package-nes-discovery.mjs";
import { verifyPackageNesDiscoveryReturns } from "./verify-package-nes-discovery-returns.mjs";
import { verifyPackageNesDiscoveryTables } from "./verify-package-nes-discovery-tables.mjs";
import { verifyPackageNesDiscoveryRelativeStack } from "./verify-package-nes-discovery-relative-stack.mjs";
import { verifyPackageNesDiscoveryBranches } from "./verify-package-nes-discovery-branches.mjs";
import { verifyPackageNesDiscoveryDomains } from "./verify-package-nes-discovery-domains.mjs";
import { verifyPackageNesDiscoveryValues } from "./verify-package-nes-discovery-values.mjs";
import { verifyPackageNesReviewFixes } from "./verify-package-nes-review-fixes.mjs";
import { verifyPackageNesEvents } from "./verify-package-nes-events.mjs";
import { verifyPackageVrc4 } from "./verify-package-nes-vrc4.mjs";
import { verifyPackageNesVrc3 } from "./verify-package-nes-vrc3.mjs";
import { verifyPackageNesIrem78 } from "./verify-package-nes-irem78.mjs";
import { verifyPackageVrc6 } from "./verify-package-nes-vrc6.mjs";
import { verifyPackageNesVrc6PpuMemory } from "./verify-package-nes-vrc6-ppu-memory.mjs";
import { verifyPackageBandai } from "./verify-package-nes-bandai.mjs";
import { verifyPackageNesSunsoft3 } from "./verify-package-nes-sunsoft3.mjs";
import { verifyPackageNesSunsoft4 } from "./verify-package-nes-sunsoft4.mjs";
import { verifyPackageNesH3001 } from "./verify-package-nes-h3001.mjs";
import { verifyPackageNesEarlyMappers } from "./verify-package-nes-early-mappers.mjs";
import { verifyPackageFme7 } from "./verify-package-nes-fme7.mjs";
import { verifyPackageNamco163 } from "./verify-package-nes-namco163.mjs";
import { verifyPackageNamco163Ram } from "./verify-package-nes-namco163-ram.mjs";
import { verifyPackageNesNamco163PpuMemory } from "./verify-package-nes-namco163-ppu-memory.mjs";
import { verifyPackageMmc5 } from "./verify-package-nes-mmc5.mjs";
import { verifyPackageMmc5Cpu } from "./verify-package-nes-mmc5-cpu.mjs";
import { verifyPackageMmc5Ppu } from "./verify-package-nes-mmc5-ppu.mjs";
import { verifyPackageMmc5Rendering } from "./verify-package-nes-mmc5-rendering.mjs";
import { verifyPackageNesMmc5PpuMemory } from "./verify-package-nes-mmc5-ppu-memory.mjs";
import { verifyPackageNesMmc5FrozenBackground } from "./verify-package-nes-mmc5-frozen-background.mjs";
import { verifyPackageMmc5Irq } from "./verify-package-nes-mmc5-irq.mjs";
import { verifyPackageNesPpu } from "./verify-package-nes-ppu.mjs";
import { verifyPackageNesViewport } from "./verify-package-nes-viewport.mjs";
import { verifyPackageNesApu } from "./verify-package-nes-apu.mjs";
import { verifyPackageNesApuFrame } from "./verify-package-nes-apu-frame.mjs";
import { verifyPackageNesCpuBus } from "./verify-package-nes-cpu-bus.mjs";
import { verifyPackageNesSourceIrq } from "./verify-package-nes-source-irq.mjs";
import { verifyPackageNesInterrupts } from "./verify-package-nes-interrupts.mjs";
import { verifyPackageNesDma } from "./verify-package-nes-dma.mjs";
import { verifyPackageNesCpuIo } from "./verify-package-nes-cpu-io.mjs";
import { verifyPackageNesDmc } from "./verify-package-nes-dmc.mjs";
import { verifyPackageNesDmcSource } from "./verify-package-nes-dmc-source.mjs";
import { verifyPackageNesDmcPhase } from "./verify-package-nes-dmc-phase.mjs";
import { verifyPackageNesControllers } from "./verify-package-nes-controllers.mjs";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { json, run } from "./lib/verify-package-core.mjs";

/** Verify installed source analysis, not just catalog presence, with an AND-conflict board. */
export async function verifyPackageNes({ cli, workspace, environment }) {
  const bytes = Buffer.alloc(16 + 16384 + 32768);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 1, 4, 0x30, 8, 0x20]);
  bytes.set([0xa9, 3, 0x8d, 0, 0xc1, 0x60], 16);
  bytes[272] = 2;
  bytes.writeUInt16LE(0x8000, 16396);
  const path = join(workspace, "packaged-cnrom.nes");
  await writeFile(path, bytes);
  const input = { path, initial: { mapper: 3 } };
  const invoke = async (command, parameters) =>
    json(
      await run(
        cli,
        [command, JSON.stringify(parameters), "--json"],
        environment,
        // Complete loop-state witnesses can exceed the stdio response budget.
        // CLI capture is independent; the default SDK receive limit stays unchanged.
        { maxBuffer: 64 * 1024 * 1024 },
      ),
    );
  const code = await invoke("trace-nes-code", input);
  assert.equal(
    code.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = code.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.deepEqual(
    trace.instructions.map((instruction) => instruction.file_offsets),
    [
      [16, 17],
      [18, 19, 20],
    ],
  );
  assert.deepEqual(trace.mapper_trace.final, { mapper: 3, chr_bank: 2 });
  assert.deepEqual(
    trace.mapper_trace.final_mapping.chr_windows.map(
      (window) => window.file_offset,
    ),
    [32784, 36880],
  );
  const writes = await invoke("trace-nes-mapper-writes", {
    ...input,
    writes: [{ address: 0xc100, value: 3, preceded_by_cpu_write: false }],
  });
  assert.deepEqual(writes.normalized_result.trace, trace.mapper_trace);
  const explored = await invoke("explore-nes-code", input);
  assert.equal(explored.normalized_result.code_exploration.status, "derived");
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  assert.deepEqual(await readFile(path), bytes);
  await verifyPackageNesReviewFixes(async (command, parameters) => {
    const requestPath = join(workspace, `review-${command}.json`);
    await writeFile(requestPath, JSON.stringify(parameters));
    return json(
      await run(cli, [command, requestPath, "--json"], environment, {
        maxBuffer: 64 * 1024 * 1024,
      }),
    );
  }, workspace);
  await verifyPartialMapperSelectors(invoke, workspace);
  await verifyPackageNesDiscovery(invoke, workspace);
  await verifyPackageNesDiscoveryReturns(invoke, workspace);
  await verifyPackageNesDiscoveryTables(invoke, workspace);
  await verifyPackageNesDiscoveryRelativeStack(invoke, workspace);
  await verifyPackageNesDiscoveryBranches(invoke, workspace);
  await verifyPackageNesDiscoveryDomains(invoke, workspace);
  await verifyPackageNesDiscoveryValues(invoke, workspace);
  await verifyPackageNesInterrupts(invoke, workspace);
  await verifyPackageNesDma(invoke, workspace);
  await verifyPackageNesCpuIo(invoke, workspace);
  await verifyPackageNesDmc(invoke, workspace);
  await verifyPackageNesDmcSource(invoke, workspace);
  await verifyPackageNesDmcPhase(invoke, workspace);
  await verifyPartialRmwBankExecution(invoke, workspace);
  await verifyColorDreams(invoke, workspace);
  await verifyCamerica(invoke, workspace);
  await verifyQuattro(invoke, workspace);
  await verifyNamco108(invoke, workspace);
  await verifyG101(invoke, workspace);
  await verifyPackageNesH3001(invoke, workspace);
  await verifyPackageNesSunsoft3(invoke, workspace);
  await verifyPackageNesSunsoft4(invoke, workspace);
  await verifyPackageNesEarlyMappers(invoke, workspace);
  await verifyTaito33(invoke, workspace);
  await verifyVrc1(invoke, workspace);
  await verifyVrc2Prg(invoke, workspace);
  await verifyVrc2Latch(invoke, workspace);
  await verifyVrc2cRam(invoke, workspace);
  await verifyPackageVrc4(invoke, workspace);
  await verifyPackageNesVrc3(invoke, workspace);
  await verifyPackageNesIrem78(invoke, workspace);
  await verifyPackageVrc6(invoke, workspace);
  await verifyPackageNesVrc6PpuMemory(invoke, workspace);
  await verifyPackageBandai(invoke, workspace);
  await verifyPackageFme7(invoke, workspace);
  await verifyPackageNamco163(invoke, workspace);
  await verifyPackageNamco163Ram(invoke, workspace);
  await verifyPackageNesNamco163PpuMemory(invoke, workspace);
  await verifyPackageMmc5(invoke, workspace);
  await verifyPackageMmc5Cpu(invoke, workspace);
  await verifyPackageMmc5Ppu(invoke, workspace);
  await verifyPackageMmc5Rendering(invoke, workspace);
  await verifyPackageNesMmc5PpuMemory(invoke, workspace);
  await verifyPackageNesMmc5FrozenBackground(invoke, workspace);
  await verifyPackageMmc5Irq(invoke, workspace);
  await verifyPackageNesPpu(invoke, workspace);
  await verifyPackageNesApu(invoke, workspace);
  await verifyPackageNesApuFrame(invoke, workspace);
  await verifyPackageNesCpuBus(invoke, workspace);
  await verifyPackageNesSourceIrq(invoke, workspace);
  await verifyPackageNesViewport(invoke, workspace);
  await verifyPackageNesControllers(invoke, workspace);
  await verifyVrc4Ram(invoke, workspace);
  await verifyQuattroPartial(invoke, workspace);
  await verifyMapper34(invoke, workspace);
  await verifyMmc3InterruptRam(invoke, workspace);
  await verifyVectorEntries(invoke, workspace);
  await verifyAcceptedInterrupt(invoke, workspace);
  await verifyInitialRamPaths(invoke, workspace);
  await verifyInitialPrgRam(invoke, workspace);
  await verifyMmc1BankedRam(invoke, workspace);
  await verifyMmc1OuterRom(invoke, workspace);
  await verifyMmc1Fixed(invoke, workspace);
  await verifyMmc6(invoke, workspace);
  await verifyMmc3Hardwired(invoke, workspace);
  await verifyNromRam(invoke, workspace);
  await verifyPackageNesEvents(invoke, workspace);
}

async function verifyColorDreams(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 131072 + 131072);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 16, 0xb0, 0]);
  bytes.set([0xa9, 0xf3, 0x8d, 0, 0x81], 16);
  bytes[272] = 0xa2;
  bytes.set([0xa9, 0x77, 0x60], 16 + 65536 + 5);
  const path = join(workspace, "packaged-color-dreams.nes");
  await writeFile(path, bytes);
  const initial = {
    mapper: 11,
    prg_bank: 0,
    chr_bank: 0,
    bus_conflicts: "and",
  };
  const evidence = await invoke("trace-nes-code", {
    path,
    entry: 0x8000,
    initial,
  });
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.final_cpu.a, 0x77);
  assert.deepEqual(trace.instructions[2].file_offsets, [65557, 65558]);
  assert.deepEqual(trace.mapper_trace.final, {
    ...initial,
    prg_bank: 2,
    chr_bank: 10,
  });
  assert.deepEqual(trace.mapper_trace.nes_prg_views, [
    { mapper: 11, prg_bank: 0 },
    { mapper: 11, prg_bank: 2 },
  ]);
  const replay = await invoke("trace-nes-mapper-writes", {
    path,
    initial,
    writes: [{ address: 0x8100, value: 0xf3, preceded_by_cpu_write: false }],
  });
  assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
  const uncertain = await invoke("trace-nes-code", {
    path,
    entry: 0x8000,
    initial: { mapper: 11, prg_bank: 0 },
  });
  assert.equal(
    uncertain.normalized_result.code_trace.stop.reason,
    "unmapped-instruction",
  );
  assert.deepEqual(uncertain.normalized_result.code_trace.mapper_trace.final, {
    mapper: 11,
    prg_bank: null,
    chr_bank: null,
    bus_conflicts: "unknown",
  });
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyCamerica(invoke, workspace) {
  for (const submapper of [null, 0, 1]) {
    const bytes = Buffer.alloc(16 + 131072);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      8,
      0,
      0x70,
      submapper === null ? 0x40 : 0x48,
      (submapper ?? 0) << 4,
    ]);
    if (submapper !== null) bytes[11] = 7;
    bytes.set(
      [0xa9, 0x10, 0x8d, 0, 0x80, 0xa9, 3, 0x8d, 0, 0xc1, 0x4c, 0, 0x80],
      16 + 7 * 16384,
    );
    bytes.set([0xa9, 0x55, 0x60], 16 + 3 * 16384);
    const path = join(workspace, `packaged-camerica-${submapper}.nes`);
    await writeFile(path, bytes);
    const initial = { mapper: 71 };
    const evidence = await invoke("trace-nes-code", {
      path,
      entry: 0xc000,
      initial,
    });
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.final_cpu.a, 0x55);
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [49168, 49169]);
    assert.deepEqual(trace.mapper_trace.final, {
      mapper: 71,
      prg_bank: 3,
      mirroring: submapper === 1 ? 1 : null,
    });
    assert.equal(
      trace.mapper_trace.final_mapping.mirroring,
      submapper === 1
        ? "one-screen-b"
        : submapper === 0
          ? "horizontal"
          : "unknown",
    );
    assert.deepEqual(
      trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
      [3, 7],
    );
    const replay = await invoke("trace-nes-mapper-writes", {
      path,
      initial,
      writes: trace.instructions.flatMap((instruction) => instruction.writes),
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    assert.deepEqual(await readFile(path), bytes);
  }
}

function verifyCodeSources(trace, bytes, initialRam = [], initialPrgRam = []) {
  const nes2 = (bytes[7] & 12) === 8;
  const mapper =
    (bytes[6] >>> 4) | (bytes[7] & 240) | (nes2 ? (bytes[8] & 15) << 8 : 0);
  const mmc6 = nes2 && mapper === 4 && bytes[8] >>> 4 === 1;
  const canonicalRam = (address) => {
    if (
      nes2 &&
      [21, 23, 25].includes(mapper) &&
      [1, 2].includes(bytes[8] >>> 4)
    ) {
      const wiring = trace.mapper_trace.initial.prg_ram_wiring;
      assert.ok(["internal-2k", "external-8k"].includes(wiring));
      const shift = wiring === "internal-2k" ? 5 : 7;
      assert.ok([shift, shift << 4].includes(bytes[10]));
      assert.ok(
        address >= 0x6000 &&
          address < (wiring === "internal-2k" ? 0x7000 : 0x8000),
      );
      return wiring === "internal-2k" ? 0x6000 + (address & 2047) : address;
    }
    if (nes2 && mapper === 0) {
      const ramShift = bytes[10] & 15;
      const nvramShift = bytes[10] >>> 4;
      assert.ok(ramShift === 0 || nvramShift === 0);
      const size = 64 * 2 ** (ramShift || nvramShift);
      assert.ok([2048, 4096, 8192].includes(size));
      assert.ok(address >= 0x6000 && address <= 0x7fff);
      return 0x6000 + ((address - 0x6000) % size);
    }
    if (!mmc6) return address;
    assert.ok(address >= 0x7000 && address <= 0x7fff);
    return 0x7000 | (address & 1023);
  };
  for (const [index, instruction] of [
    ...trace.instructions,
    trace.stop,
  ].entries()) {
    const sources = [instruction];
    for (const read of instruction.data_reads) {
      if (read.value === null) {
        if (
          read.mapper_origins.some(
            (origin) => origin.kind === "vrc2-microwire-latch",
          )
        ) {
          verifyVrc2LatchReadSource(trace, index, read, bytes);
          continue;
        }
        assert.deepEqual(read.mapper_origins, []);
        if (read.known_bits === undefined) {
          assert.deepEqual(read.ram_origins, []);
        } else {
          assert.equal(read.file_offset, null);
          assert.ok(read.known_bits.mask > 0 && read.known_bits.mask < 255);
          assert.equal(read.known_bits.value & ~read.known_bits.mask, 0);
          assert.equal(read.ram_origins.length, 1);
          const origin = read.ram_origins[0];
          assert.equal(origin.byte_index, 0);
          assert.equal(origin.region, "internal-ram");
          assert.ok(read.address !== null && read.address < 8192);
          assert.equal(read.address & 2047, origin.ram_address);
          let write;
          if ("entry_interrupt_write_index" in origin) {
            assert.ok(trace.entry_interrupt);
            write =
              trace.entry_interrupt.writes[origin.entry_interrupt_write_index];
          } else {
            assert.ok(origin.instruction_index < index);
            write =
              trace.instructions[origin.instruction_index].writes[
                origin.write_index
              ];
          }
          assert.ok(write);
          assert.equal(write.value, null);
          assert.equal(write.address & 2047, origin.ram_address);
          assert.deepEqual(write.known_bits, read.known_bits);
        }
        continue;
      }
      assert.notEqual(read.address, null);
      sources.push({
        address: read.address,
        bytes_hex: read.value.toString(16).padStart(2, "0"),
        file_offsets: [read.file_offset],
        ram_origins: read.ram_origins,
        mapper_origins: read.mapper_origins,
      });
    }
    for (const source of sources) {
      const code = Buffer.from(source.bytes_hex, "hex");
      assert.equal(source.file_offsets.length, code.length);
      for (const [byteIndex, value] of code.entries()) {
        const offset = source.file_offsets[byteIndex];
        const origins = source.ram_origins.filter(
          (item) => item.byte_index === byteIndex,
        );
        const mapperOrigins = source.mapper_origins.filter(
          (item) => item.byte_index === byteIndex,
        );
        if (offset !== null) {
          assert.equal(origins.length, 0);
          assert.equal(mapperOrigins.length, 0);
          assert.equal(bytes[offset], value);
          continue;
        }
        if (mapperOrigins.length > 0) {
          assert.ok(mmc6);
          assert.equal(origins.length, 0);
          assert.equal(mapperOrigins.length, 1);
          const origin = mapperOrigins[0];
          assert.equal(origin.kind, "mmc6-disabled-half");
          assert.equal(value, 0);
          assert.equal(
            origin.ram_address,
            canonicalRam((source.address + byteIndex) & 65535),
          );
          if (typeof origin.bank_select === "number")
            assert.notEqual(origin.bank_select & 32, 0);
          else {
            assert.notEqual(origin.bank_select.mask & 32, 0);
            assert.notEqual(origin.bank_select.value & 32, 0);
            assert.equal(
              origin.bank_select.value & ~origin.bank_select.mask,
              0,
            );
          }
          const readBit = (origin.ram_address & 512) === 0 ? 32 : 128;
          const protection =
            typeof origin.ram_protect === "number"
              ? { mask: 255, value: origin.ram_protect }
              : origin.ram_protect;
          const otherReadBit = readBit === 32 ? 128 : 32;
          assert.equal(protection.value & ~protection.mask, 0);
          assert.equal(protection.mask & readBit, readBit);
          assert.equal(protection.value & readBit, 0);
          assert.equal(protection.mask & otherReadBit, otherReadBit);
          assert.equal(protection.value & otherReadBit, otherReadBit);
          continue;
        }
        assert.ok(origins.length > 0);
        const identities = new Set();
        for (const origin of origins) {
          const identity = `${origin.region}:${origin.bank ?? 0}:${origin.ram_address}`;
          assert.ok(!identities.has(identity));
          identities.add(identity);
          if ("initial_ram_index" in origin) {
            assert.equal(origin.region, "internal-ram");
            assert.equal("instruction_index" in origin, false);
            assert.equal("write_index" in origin, false);
            const assumption = initialRam[origin.initial_ram_index];
            assert.ok(assumption);
            assert.equal(assumption.address, origin.ram_address);
            assert.equal(assumption.value, value);
            const address = (source.address + byteIndex) & 65535;
            assert.ok(address < 8192);
            assert.equal(address & 2047, origin.ram_address);
            continue;
          }
          if ("initial_prg_ram_index" in origin) {
            assert.equal(origin.region, "prg-ram");
            assert.equal("instruction_index" in origin, false);
            assert.equal("write_index" in origin, false);
            const assumption = initialPrgRam[origin.initial_prg_ram_index];
            assert.ok(assumption);
            assert.equal(assumption.bank, origin.bank);
            assert.equal(assumption.address, origin.ram_address);
            assert.equal(assumption.value, value);
            assert.equal(
              canonicalRam((source.address + byteIndex) & 65535),
              origin.ram_address,
            );
            continue;
          }
          if ("entry_interrupt_write_index" in origin) {
            assert.equal(origin.region, "internal-ram");
            assert.equal("instruction_index" in origin, false);
            assert.equal("write_index" in origin, false);
            assert.ok(trace.entry_interrupt);
            const write =
              trace.entry_interrupt.writes[origin.entry_interrupt_write_index];
            assert.ok(write);
            assert.ok(write.address >= 256 && write.address <= 511);
            assert.equal(write.address, origin.ram_address);
            assert.equal(write.value, value);
            const address = (source.address + byteIndex) & 65535;
            assert.ok(address < 8192);
            assert.equal(address & 2047, origin.ram_address);
            continue;
          }
          assert.ok(origin.instruction_index < index);
          const write =
            trace.instructions[origin.instruction_index].writes[
              origin.write_index
            ];
          assert.equal(write.value, value);
          const address = (source.address + byteIndex) & 65535;
          if (origin.region === "internal-ram") {
            assert.equal(write.address & 2047, origin.ram_address);
            assert.equal(address & 2047, origin.ram_address);
          } else {
            assert.equal(origin.region, "prg-ram");
            assert.ok(
              Number.isInteger(origin.bank) &&
                origin.bank >= 0 &&
                origin.bank <= 3,
            );
            assert.equal(canonicalRam(write.address), origin.ram_address);
            assert.equal(canonicalRam(address), origin.ram_address);
          }
        }
      }
    }
    for (const vectorByte of instruction.interrupt_vector ?? []) {
      assert.notEqual(vectorByte.file_offset, null);
      assert.equal(bytes[vectorByte.file_offset], vectorByte.value);
    }
  }
}

async function verifyMapper34(invoke, workspace) {
  for (const submapper of [1, 2]) {
    const nina = submapper === 1;
    const prgSize = nina ? 65536 : 131072;
    const bytes = Buffer.alloc(16 + prgSize + (nina ? 16384 : 0));
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      prgSize / 16384,
      nina ? 2 : 0,
      0x20,
      8 | 0x20,
      submapper << 4,
    ]);
    bytes[nina ? 10 : 11] = 7;
    bytes.set(
      [0xa9, nina ? 0xf1 : 3, 0x8d, nina ? 0xfd : 0, nina ? 0x7f : 0x81],
      16,
    );
    bytes[272] = 2;
    const bank = nina ? 1 : 2;
    bytes.set(
      nina
        ? [
            0xa9, 0xfe, 0x8d, 0xfe, 0x7f, 0xad, 0xfe, 0x7f, 0x85, 0x10, 0xa9,
            0xa9, 0x8d, 0xff, 0x7f, 0x4c, 0xff, 0x7f,
          ]
        : [0xa9, 0x77, 0x60],
      16 + bank * 32768 + 5,
    );
    if (nina) bytes.set([0x55, 0x60], 32784);
    const path = join(workspace, `packaged-mapper34-${submapper}.nes`);
    await writeFile(path, bytes);
    const initial = { mapper: 34, prg_bank: 0 };
    const evidence = await invoke("trace-nes-code", {
      path,
      entry: 0x8000,
      initial,
    });
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.final_cpu.a, nina ? 0x55 : 0x77);
    assert.deepEqual(trace.mapper_trace.final, {
      mapper: 34,
      prg_bank: bank,
      chr_bank_0: nina ? 14 : null,
      chr_bank_1: nina ? 9 : null,
    });
    if (nina) {
      assert.deepEqual(trace.instructions[5].writes, [
        { address: 16, value: 0xfe, preceded_by_cpu_write: false },
      ]);
      assert.deepEqual(trace.instructions.at(-1).file_offsets, [null, 32784]);
    }
    verifyCodeSources(trace, bytes);
    const replay = await invoke("trace-nes-mapper-writes", {
      path,
      initial,
      writes: trace.instructions
        .flatMap((instruction) => instruction.writes)
        .filter((write) => write.address >= (nina ? 0x7ffd : 0x8000)),
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyMmc3InterruptRam(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 65536 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x40, 8]);
  bytes[10] = 7;
  const fixed = 16 + 7 * 8192;
  bytes.set([0xa2, 0xfd, 0x9a, 0, 2, 0x4c, 0, 0x60], fixed);
  bytes.set(
    [
      0xa9, 0x80, 0x8d, 1, 0xa0, 0xa9, 0xa9, 0x8d, 0, 0x60, 0xa9, 0x55, 0x8d, 1,
      0x60, 0xa9, 0x60, 0x8d, 2, 0x60, 0xa9, 0xc0, 0x8d, 1, 0xa0, 0xee, 1, 0x60,
      0x40,
    ],
    fixed + 256,
  );
  bytes.writeUInt16LE(0xe000, 16 + 65536 - 4);
  bytes.writeUInt16LE(0xe100, 16 + 65536 - 2);
  const path = join(workspace, "packaged-mmc3-brk-ram.nes");
  await writeFile(path, bytes);
  const input = { path, initial: { mapper: 4 } };
  const evidence = await invoke("trace-nes-code", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.stop.address, 0x6002);
  assert.equal(trace.final_cpu.a, 0x55);
  assert.equal(trace.final_cpu.sp, 253);
  const brk = trace.instructions.find(
    (instruction) => instruction.mnemonic === "BRK",
  );
  assert.equal(brk.next_address, 0xe100);
  assert.deepEqual(
    brk.writes.map((write) => write.value),
    [0xe0, 5, null],
  );
  assert.equal(
    trace.instructions.find((instruction) => instruction.mnemonic === "RTI")
      .next_address,
    0xe005,
  );
  assert.deepEqual(
    trace.instructions
      .find((instruction) => instruction.mnemonic === "INC")
      .writes.map((write) => write.value),
    [0x55, 0x56],
  );
  assert.equal(trace.mapper_trace.final.ram_protect, 0xc0);
  assert.deepEqual(trace.instructions.at(-1).file_offsets, [null, null]);
  verifyCodeSources(trace, bytes);
  const explored = await invoke("explore-nes-code", input);
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyMmc1BankedRam(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 65536);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 0, 0x10, 8, 0, 0, 9, 7]);
  const program = [];
  for (let bank = 0; bank < 4; bank++) {
    for (let bit = 0; bit < 5; bit++)
      program.push(0xa9, ((bank << 2) >> bit) & 1, 0x8d, 0, 0xa0);
    for (const [offset, value] of [0xad, 0, 0x60, 0x60].entries())
      program.push(0xa9, value, 0x8d, offset, 0x60);
  }
  program.push(0xad, 2, 0x20);
  for (let bit = 0; bit < 5; bit++) program.push(0x8d, 0, 0xa0);
  program.push(0x4c, 0, 0x60);
  bytes.set(program, 16 + 49152);
  bytes.writeUInt16LE(0xc000, 16 + 65536 - 4);
  const path = join(workspace, "packaged-sxrom-ram.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    initial: {
      mapper: 1,
      prg_mode: 3,
      prg_bank: 0,
      prg_ram_disable_bit: 0,
      chr_mode: 0,
      chr_bank_0: 0,
      chr_bank_1: 0,
      shift_bits: [],
    },
  };
  const evidence = await invoke("trace-nes-code", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.final_cpu.a, 0xad);
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.stop.address, 0x6003);
  const instruction = trace.instructions.at(-1);
  assert.equal(instruction.address, 0x6000);
  assert.equal(instruction.ram_origins.length, 12);
  for (let byte = 0; byte < 3; byte++)
    assert.deepEqual(
      instruction.ram_origins
        .filter((origin) => origin.byte_index === byte)
        .map((origin) => origin.bank),
      [0, 1, 2, 3],
    );
  verifyCodeSources(trace, bytes);
  const explored = await invoke("explore-nes-code", input);
  assert.equal(explored.normalized_result.code_exploration.status, "derived");
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyMmc1OuterRom(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 0x80000, 2);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 32, 0, 0x10, 8, 0, 0, 7, 7]);
  const trampoline = [];
  for (const bit of [0, 0, 0, 0, 1]) trampoline.push(0xa9, bit, 0x8d, 0, 0xa0);
  trampoline.push(0x4c, 0, 0x80);
  const program = [];
  for (const [offset, value] of trampoline.entries())
    program.push(0xa9, value, 0x8d, offset, 0x60);
  program.push(0x4c, 0, 0x60);
  bytes.set(program, 16 + 15 * 16384);
  bytes.writeUInt16LE(0xc000, 16 + 0x40000 - 4);
  bytes.set([0xa9, 0x66, 0x60], 16 + 0x40000);
  const path = join(workspace, "packaged-surom-outer.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    initial: {
      mapper: 1,
      prg_mode: 3,
      prg_bank: 0,
      chr_mode: 0,
      chr_bank_0: 0,
      chr_bank_1: 0,
      prg_ram_disable_bit: 0,
      shift_bits: [],
    },
  };
  const evidence = await invoke("trace-nes-code", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.final_cpu.a, 0x66);
  assert.equal(trace.stop.reason, "return");
  assert.equal(trace.stop.address, 0x8002);
  assert.deepEqual(trace.instructions.at(-1).file_offsets, [0x40010, 0x40011]);
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
    [16, 31],
  );
  assert.deepEqual(trace.mapper_trace.nes_prg_views, [
    { mapper: 1, prg_mode: 3, prg_bank: 0, prg_outer_bank: 0 },
    { mapper: 1, prg_mode: 3, prg_bank: 0, prg_outer_bank: 1 },
  ]);
  verifyCodeSources(trace, bytes);
  const replay = await invoke("trace-nes-mapper-writes", {
    ...input,
    writes: trace.instructions
      .flatMap((instruction) => instruction.writes)
      .filter((write) => write.address >= 0x8000),
  });
  assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
  const explored = await invoke("explore-nes-code", input);
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  const unknown = await invoke("trace-nes-code", {
    ...input,
    initial: { ...input.initial, chr_mode: 1, chr_bank_1: 16 },
  });
  const unresolved = unknown.normalized_result.code_trace;
  assert.equal(unresolved.status, "derived");
  assert.equal(unresolved.stop.reason, "unresolved-vector");
  assert.deepEqual(
    unresolved.mapper_trace.final_mapping.prg_windows.map(
      (window) => window.file_offset,
    ),
    [null, null],
  );
  assert.deepEqual(unresolved.mapper_trace.nes_prg_views, []);
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyMmc1Fixed(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 32768 + 32768, 2);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 4, 0x10, 8, 0x50]);
  const program = [];
  for (const [address, value] of [
    [0xe000, 1],
    [0x8000, 12],
    [0xa000, 2],
  ])
    for (let bit = 0; bit < 5; bit++)
      program.push(0xa9, (value >> bit) & 1, 0x8d, address & 255, address >> 8);
  program.push(0xa9, 0x66, 0x60);
  bytes.set(program, 16);
  bytes.writeUInt16LE(0x8000, 16 + 32768 - 4);
  const path = join(workspace, "packaged-mmc1-fixed.nes");
  await writeFile(path, bytes);
  const input = { path, initial: { mapper: 1, shift_bits: [] } };
  const evidence = await invoke("trace-nes-code", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.final_cpu.a, 0x66);
  assert.equal(trace.stop.reason, "return");
  assert.deepEqual(trace.mapper_trace.nes_prg_views, []);
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
    [0, 1],
  );
  assert.deepEqual(
    trace.mapper_trace.final_mapping.chr_windows.map((window) => window.bank),
    [2, 3],
  );
  for (const instruction of trace.instructions)
    assert.deepEqual(
      instruction.file_offsets,
      Array.from(
        { length: instruction.bytes_hex.length / 2 },
        (_, byte) => 16 + instruction.address - 0x8000 + byte,
      ),
    );
  verifyCodeSources(trace, bytes);
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyMmc6(invoke, workspace) {
  for (const zero of [false, true]) {
    const bytes = Buffer.alloc(16 + 65536 + 8192, 2);
    bytes.fill(0, 0, 16);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x40, 8, 0x10, 0, 4]);
    const store = (address, value) => [
      0xa9,
      value,
      0x8d,
      address & 255,
      address >> 8,
    ];
    bytes.set(
      [
        ...store(0x8000, 32),
        ...store(0xa001, 240),
        ...(zero
          ? [...store(0x71ff, 0xa9), ...store(0xa001, 48), 0x4c, 0xff, 0x71]
          : [
              ...store(0x7c00, 0xa9),
              ...store(0x7401, 0x55),
              ...store(0x7802, 0x60),
              ...store(0xa001, 160),
              0xee,
              1,
              0x74,
              ...store(0x8000, 96),
              0x4c,
              0,
              0x74,
            ]),
      ],
      16 + 7 * 8192,
    );
    bytes.writeUInt16LE(0xe000, 16 + 65536 - 4);
    const path = join(workspace, `packaged-mmc6-${zero}.nes`);
    await writeFile(path, bytes);
    const input = {
      path,
      initial: zero
        ? {
            mapper: 4,
            bank_select: { mask: 32, value: 32 },
            ram_protect: { mask: 160, value: 32 },
          }
        : { mapper: 4 },
      ...(zero
        ? {
            entry: 0xe014,
            initial_prg_ram: [{ bank: 0, address: 0x71ff, value: 0xa9 }],
          }
        : {}),
    };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.final_cpu.a, zero ? 0 : 0x55);
    assert.equal(trace.stop.reason, zero ? "unknown-stack" : "return");
    assert.equal(trace.instructions.at(-1).address, zero ? 0x71ff : 0x7400);
    if (zero) {
      assert.equal(trace.instructions.at(-1).mapper_origins.length, 1);
      assert.deepEqual(
        trace.instructions.at(-1).mapper_origins[0].bank_select,
        { mask: 32, value: 32 },
      );
      assert.equal(trace.stop.mapper_origins.length, 1);
    } else {
      assert.equal(trace.instructions.at(-1).ram_origins.length, 2);
      assert.deepEqual(
        trace.instructions
          .find((item) => item.mnemonic === "INC")
          .writes.map((write) => write.value),
        [0x55, 0x56],
      );
    }
    verifyCodeSources(trace, bytes, [], input.initial_prg_ram ?? []);
    const replay = await invoke("trace-nes-mapper-writes", {
      path,
      initial: input.initial,
      writes: trace.instructions
        .flatMap((item) => item.writes)
        .filter((write) => write.address >= 0x8000),
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyMmc3Hardwired(invoke, workspace) {
  for (const [flags, mirroring] of [
    [0, "horizontal"],
    [1, "vertical"],
    [8, "four-screen"],
  ]) {
    const bytes = Buffer.alloc(16 + 65536 + 8192, 2);
    bytes.fill(0, 0, 16);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x40 | flags, 8, 0x20]);
    bytes.set(
      [
        0xa9, 1, 0x8d, 0, 0xa0, 0xa9, 0, 0x8d, 0xfe, 0xbf, 0xad, 2, 0x20, 0x8d,
        0, 0xa0, 0xa9, 6, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 1, 0x80, 0x4c, 0, 0x80,
      ],
      16 + 7 * 8192,
    );
    bytes.set([0xa9, 0x66, 0x60], 16 + 2 * 8192);
    bytes.writeUInt16LE(0xe000, 16 + 65536 - 4);
    const path = join(workspace, `packaged-mmc3-hardwired-${flags}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper: 4 } };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.final_cpu.a, 0x66);
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.instructions.at(-1).address, 0x8000);
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [16400, 16401]);
    assert.equal(trace.mapper_trace.final.mirroring, null);
    assert.equal(trace.mapper_trace.final_mapping.mirroring, mirroring);
    verifyCodeSources(trace, bytes);
    const replay = await invoke("trace-nes-mapper-writes", {
      ...input,
      writes: trace.instructions.flatMap((item) => item.writes),
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyNromRam(invoke, workspace) {
  for (const [declaration, size] of [
    [5, 2048],
    [0x60, 4096],
    [7, 8192],
  ]) {
    const bytes = Buffer.alloc(16 + 32768 + 8192, 2);
    bytes.fill(0, 0, 16);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0, 8, 0, 0, declaration]);
    const boundary = 0x6000 + size - 1;
    bytes.set([0x55, 0x60], 16);
    const program = [0xa9, 0xa9, 0x8d, 0xff, 0x7f];
    if (size < 8192)
      program.push(
        0xa9,
        0x54,
        0x8d,
        0,
        0x60,
        0xee,
        0,
        (0x8000 - size) >> 8,
        0xa9,
        0x60,
        0x8d,
        1,
        0x60,
      );
    program.push(0x4c, boundary & 255, boundary >> 8);
    bytes.set(program, 272);
    bytes.writeUInt16LE(0x8100, 16 + 32768 - 4);
    const path = join(workspace, `packaged-nrom-ram-${declaration}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper: 0, prg_ram_write_enabled: true } };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.final_cpu.a, 0x55);
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.instructions.at(-1).address, boundary);
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [
      null,
      size === 8192 ? 16 : null,
    ]);
    verifyCodeSources(trace, bytes);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    for (const initial of [
      { mapper: 0 },
      { mapper: 0, prg_ram_write_enabled: false },
    ]) {
      const unknown = (await invoke("trace-nes-code", { path, initial }))
        .normalized_result.code_trace;
      assert.equal(unknown.status, "derived");
      assert.equal(unknown.stop.address, boundary);
      assert.equal(unknown.stop.bytes_hex, "");
      assert.deepEqual(unknown.stop.ram_origins, []);
    }
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyVectorEntries(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 65536 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x40, 0]);
  const fixed = 16 + 7 * 8192;
  const path = join(workspace, "packaged-vector-entries.nes");
  for (const [offset, value] of [
    [0, 0x11],
    [32, 0x22],
    [64, 0x33],
  ])
    bytes.set([0xa9, value, 0x40], fixed + offset);
  bytes.writeUInt16LE(0xe020, 16 + 65536 - 6);
  bytes.writeUInt16LE(0xe000, 16 + 65536 - 4);
  bytes.writeUInt16LE(0xe040, 16 + 65536 - 2);
  await writeFile(path, bytes);
  for (const [entry, target, value, tail] of [
    ["reset", 0xe000, 0x11, 4],
    ["nmi", 0xe020, 0x22, 6],
    ["irq", 0xe040, 0x33, 2],
  ]) {
    const input = {
      path,
      initial: { mapper: 4 },
      entry,
      cpu: { sp: 255, i: false },
    };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.resolved_entry, target);
    assert.equal(trace.final_cpu.a, value);
    assert.equal(trace.final_cpu.sp, 255);
    assert.equal(trace.final_cpu.i, false);
    assert.equal(trace.stop.reason, "unknown-control-target");
    assert.equal(trace.stop.address, target + 2);
    assert.deepEqual(
      trace.entry_vector,
      [0, 1].map((index) => ({
        address: 65536 - tail + index,
        value: bytes[16 + 65536 - tail + index],
        file_offset: 16 + 65536 - tail + index,
      })),
    );
    assert.equal(trace.instructions.length, 1);
    assert.deepEqual(trace.instructions[0].writes, []);
    verifyCodeSources(trace, bytes);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
  }
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyInitialRamPaths(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 65536 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x40, 0]);
  const fixed = 16 + 7 * 8192;
  // Only the fall-through branch overwrites the supplied RAM immediate through a mirror.
  bytes.set(
    [0xd0, 8, 0xa9, 0x22, 0x8d, 1, 0x0a, 0x4c, 0, 2, 0x4c, 0, 2],
    fixed,
  );
  bytes.writeUInt16LE(0xe000, 16 + 65536 - 4);
  const path = join(workspace, "packaged-initial-ram-paths.nes");
  await writeFile(path, bytes);
  const initial_ram = [0xa9, 0x11, 0x60].map((value, index) => ({
    address: 0x200 + index,
    value,
  }));
  const input = { path, initial: { mapper: 4 }, initial_ram };
  const evidence = await invoke("explore-nes-code", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const result = evidence.normalized_result.code_exploration;
  assert.equal(result.status, "derived");
  assert.equal(result.termination, "queue-exhausted");
  assert.deepEqual(result.pending_paths, []);
  assert.equal(result.paths.length, 3);
  assert.equal(result.paths[0].trace.stop.reason, "unknown-branch");
  for (const [index, taken, expected] of [
    [1, false, 0x22],
    [2, true, 0x11],
  ]) {
    const { trace, branch_choices } = result.paths[index];
    assert.deepEqual(branch_choices, [{ address: 0xe000, taken }]);
    assert.equal(trace.final_cpu.a, expected);
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.stop.address, 0x202);
    verifyCodeSources(trace, bytes, initial_ram);
    const instruction = trace.instructions.at(-1);
    assert.equal(instruction.address, 0x200);
    assert.deepEqual(instruction.ram_origins, [
      {
        byte_index: 0,
        region: "internal-ram",
        ram_address: 0x200,
        initial_ram_index: 0,
      },
      taken
        ? {
            byte_index: 1,
            region: "internal-ram",
            ram_address: 0x201,
            initial_ram_index: 1,
          }
        : {
            byte_index: 1,
            region: "internal-ram",
            ram_address: 0x201,
            instruction_index: 2,
            write_index: 0,
          },
    ]);
    const replay = await invoke("trace-nes-code", { ...input, branch_choices });
    assert.deepEqual(replay.normalized_result.code_trace, trace);
  }
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyInitialPrgRam(invoke, workspace) {
  for (const mapper of [1, 4]) {
    const bytes = Buffer.alloc(16 + 65536 + (mapper === 4 ? 8192 : 0));
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      4,
      mapper === 4 ? 1 : 0,
      mapper << 4,
      8,
      0,
      0,
      mapper === 4 ? 7 : 9,
      mapper === 4 ? 0 : 7,
    ]);
    const entry = mapper === 1 ? 0xc000 : 0xe000;
    const program = [];
    if (mapper === 1) {
      for (let bit = 0; bit < 5; bit++)
        program.push(0xa9, (12 >> bit) & 1, 0x8d, 0, 0xa0);
    } else {
      // This attempted overwrite is blocked by write protection.
      program.push(0xa9, 2, 0x8d, 1, 0x60);
    }
    program.push(0x4c, 0, 0x60);
    bytes.set(program, 16 + 65536 - (65536 - entry));
    bytes.writeUInt16LE(entry, 16 + 65536 - 4);
    const path = join(workspace, `packaged-initial-prg-ram-${mapper}.nes`);
    await writeFile(path, bytes);
    const bank = mapper === 1 ? 3 : 0;
    const initial_prg_ram = [0xa9, 0x55, 0x60].map((value, index) => ({
      bank,
      address: 0x6000 + index,
      value,
    }));
    const input = {
      path,
      initial:
        mapper === 1
          ? {
              mapper,
              prg_mode: 3,
              prg_bank: 0,
              prg_ram_disable_bit: 0,
              chr_mode: 0,
              chr_bank_0: 0,
              shift_bits: [],
            }
          : { mapper, ram_protect: 0xc0 },
      initial_prg_ram,
    };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.stop.address, 0x6002);
    assert.equal(trace.final_cpu.a, 0x55);
    assert.deepEqual(
      trace.instructions.at(-1).ram_origins,
      [0, 1].map((byte_index) => ({
        byte_index,
        region: "prg-ram",
        bank,
        ram_address: 0x6000 + byte_index,
        initial_prg_ram_index: byte_index,
      })),
    );
    verifyCodeSources(trace, bytes, [], initial_prg_ram);
    if (mapper === 1) assert.equal(trace.mapper_trace.final.chr_bank_0, 12);
    else assert.equal(trace.mapper_trace.final.ram_protect, 0xc0);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyAcceptedInterrupt(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 65536 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x40, 0]);
  bytes.set(
    [0xa9, 6, 0x8d, 0, 0x80, 0xa9, 3, 0x8d, 1, 0x80, 0x40],
    16 + 7 * 8192,
  );
  bytes.set([0xa9, 0x55, 0x60], 16 + 3 * 8192);
  bytes.writeUInt16LE(0xe000, 16 + 65536 - 6);
  bytes.writeUInt16LE(0xe000, 16 + 65536 - 2);
  const path = join(workspace, "packaged-accepted-interrupt.nes");
  await writeFile(path, bytes);
  for (const kind of ["nmi", "irq"]) {
    const sp = kind === "nmi" ? 0 : 255;
    const i = kind === "nmi";
    const cpu = { sp, c: true, z: false, i, d: true, v: true, n: true };
    const input = {
      path,
      initial: { mapper: 4 },
      cpu,
      entry: { accepted_interrupt: kind, return_address: 0x8000 },
    };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.resolved_entry, 0xe000);
    assert.equal(trace.entry_interrupt.kind, kind);
    assert.equal(trace.entry_interrupt.return_address, 0x8000);
    assert.equal(trace.entry_interrupt.cpu_after.sp, (sp - 3) & 255);
    assert.equal(trace.entry_interrupt.cpu_after.i, true);
    assert.deepEqual(
      trace.entry_interrupt.writes,
      [0x80, 0, i ? 0xed : 0xe9].map((value, index) => ({
        address: 256 + ((sp - index) & 255),
        value,
        preceded_by_cpu_write: index !== 0,
      })),
    );
    const rti = trace.instructions.find(
      (instruction) => instruction.mnemonic === "RTI",
    );
    assert.ok(rti);
    assert.equal(rti.next_address, 0x8000);
    assert.equal(rti.cpu_after.sp, sp);
    for (const flag of ["c", "z", "i", "d", "v", "n"])
      assert.equal(rti.cpu_after[flag], cpu[flag]);
    assert.deepEqual(
      rti.data_reads.map(
        (read) => read.ram_origins[0].entry_interrupt_write_index,
      ),
      [2, 1, 0],
    );
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [
      16 + 3 * 8192,
      17 + 3 * 8192,
    ]);
    assert.equal(trace.final_cpu.a, 0x55);
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.stop.address, 0x8002);
    verifyCodeSources(trace, bytes);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
  }
  assert.deepEqual(await readFile(path), bytes);
}

/** Independent installed fixtures: partial selector evidence survives artifact packaging. */
async function verifyPartialMapperSelectors(invoke, workspace) {
  for (const scenario of [
    {
      mapper: 2,
      submapper: 1,
      chr: 0,
      address: 0x8000,
      mask: 15,
      value: 1,
      expected: { prg_bank: 1 },
    },
    {
      mapper: 3,
      submapper: 1,
      prg: 2,
      chr: 4,
      address: 0x8000,
      mask: 3,
      value: 1,
      expected: { chr_bank: 1 },
    },
    {
      mapper: 7,
      submapper: 1,
      chr: 0,
      address: 0x8000,
      mask: 23,
      value: 17,
      expected: { prg_bank: 1, mirroring: 1 },
    },
    {
      mapper: 9,
      chr: 4,
      address: 0xa000,
      mask: 15,
      value: 1,
      expected: { prg_bank: 1 },
    },
    {
      mapper: 10,
      chr: 4,
      address: 0xa000,
      mask: 15,
      value: 1,
      expected: { prg_bank: 1 },
    },
    {
      mapper: 11,
      chr: 4,
      address: 0x8000,
      mask: 243,
      value: 17,
      expected: { prg_bank: 1, chr_bank: 1 },
    },
    {
      mapper: 34,
      prg: 4,
      submapper: 1,
      chr: 4,
      address: 0x7ffd,
      mask: 1,
      value: 1,
      expected: { prg_bank: 1 },
    },
    {
      mapper: 66,
      chr: 4,
      address: 0x8000,
      mask: 51,
      value: 17,
      expected: { prg_bank: 1, chr_bank: 1 },
    },
    {
      mapper: 71,
      submapper: 1,
      chr: 0,
      address: 0xc000,
      mask: 7,
      value: 1,
      expected: { prg_bank: 1 },
    },
    {
      mapper: 180,
      chr: 0,
      address: 0x8000,
      mask: 7,
      value: 1,
      expected: { prg_bank: 1 },
    },
  ]) {
    const {
      mapper,
      submapper = 0,
      prg = 8,
      chr,
      address,
      mask,
      value,
      expected,
    } = scenario;
    const bytes = Buffer.alloc(16 + prg * 16384 + chr * 8192);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      prg,
      chr,
      (mapper & 15) << 4,
      (mapper & 240) | 8,
      submapper << 4,
    ]);
    bytes.fill(255, 16, 16 + prg * 16384);
    const path = join(workspace, `packaged-partial-selector-${mapper}.nes`);
    await writeFile(path, bytes);
    const initial =
      mapper === 3
        ? { mapper, chr_bank: 0 }
        : {
            mapper,
            prg_bank: 0,
            ...(mapper === 11 ? { bus_conflicts: "and" } : {}),
          };
    const write = {
      address,
      value: null,
      known_bits: { mask, value },
      preceded_by_cpu_write: false,
    };
    const evidence = await invoke("trace-nes-mapper-writes", {
      path,
      initial,
      writes: [write],
    });
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.trace;
    assert.equal(
      trace.status,
      "derived",
      `Mapper ${mapper}: ${trace.reason ?? ""}`,
    );
    assert.deepEqual(trace.steps[0].write, write);
    for (const [field, bank] of Object.entries(expected))
      assert.equal(trace.final[field], bank, `Mapper ${mapper} ${field}`);
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyPartialRmwBankExecution(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 65536 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x40, 0]);
  bytes.set(
    [
      0x08, 0xce, 0xff, 0x09, 0xa9, 0x60, 0x2d, 0xff, 0x09, 0x09, 6, 0x8d, 0,
      0x80, 0xa9, 2, 0x8d, 1, 0x80, 0x4c, 0, 0xc0,
    ],
    16 + 7 * 8192,
  );
  bytes.set([0xa9, 0x55, 0x60], 16 + 2 * 8192);
  bytes.writeUInt16LE(0xe000, 16 + 65536 - 4);
  const path = join(workspace, "packaged-partial-rmw-bank.nes");
  await writeFile(path, bytes);
  const input = {
    path,
    initial: { mapper: 4 },
    cpu: { sp: 255, n: false, v: true },
  };
  const evidence = await invoke("trace-nes-code", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.deepEqual(trace.instructions[1].writes, [
    {
      address: 0x09ff,
      value: null,
      known_bits: { mask: 240, value: 112 },
      preceded_by_cpu_write: false,
    },
    {
      address: 0x09ff,
      value: null,
      known_bits: { mask: 224, value: 96 },
      preceded_by_cpu_write: true,
    },
  ]);
  assert.equal(trace.instructions[3].cpu_after.a, 96);
  assert.equal(trace.instructions[4].cpu_after.a, 102);
  assert.equal(trace.mapper_trace.final.bank_select, 102);
  assert.equal(trace.mapper_trace.final.banks[6], 2);
  assert.equal(trace.instructions.at(-1).address, 0xc000);
  assert.deepEqual(trace.instructions.at(-1).file_offsets, [
    16 + 2 * 8192,
    17 + 2 * 8192,
  ]);
  assert.equal(trace.final_cpu.a, 0x55);
  verifyCodeSources(trace, bytes);
  const replay = await invoke("trace-nes-mapper-writes", {
    path,
    initial: input.initial,
    writes: trace.instructions
      .flatMap((item) => item.writes)
      .filter((write) => write.address >= 0x8000),
  });
  assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
  const exploration = await invoke("explore-nes-code", input);
  assert.deepEqual(
    exploration.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyQuattro(invoke, workspace) {
  for (const submapper of [0, 1]) {
    const bytes = Buffer.alloc(16 + 262144);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      16,
      0,
      0x80,
      0xe8,
      submapper << 4,
      0,
      0,
      7,
    ]);
    bytes.set([0xa9, 8, 0x8d, 0, 0x80], 16 + 3 * 16384);
    const group = submapper === 0 ? 1 : 2;
    const next = 16 + (group * 4 + 3) * 16384 + 5;
    bytes.set([0xa9, 2, 0x8d, 0, 0xc0, 0x4c, 0, 0x80], next);
    const target = 16 + (group * 4 + 2) * 16384;
    bytes.set([0xa9, 0x55, 0x60], target);
    const path = join(workspace, `packaged-quattro-${submapper}.nes`);
    await writeFile(path, bytes);
    const input = {
      path,
      entry: 0xc000,
      initial: { mapper: 232, prg_outer_bank: 0, prg_bank: 0 },
    };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.deepEqual(trace.instructions[2].file_offsets, [next, next + 1]);
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [
      target,
      target + 1,
    ]);
    assert.equal(trace.final_cpu.a, 0x55);
    assert.deepEqual(trace.mapper_trace.final, {
      mapper: 232,
      prg_outer_bank: group,
      prg_bank: 2,
    });
    assert.deepEqual(
      trace.mapper_trace.final_mapping.prg_windows.map((w) => w.file_offset),
      [target, next - 5],
    );
    verifyCodeSources(trace, bytes);
    const replay = await invoke("trace-nes-mapper-writes", {
      path,
      initial: input.initial,
      writes: trace.instructions.flatMap((i) => i.writes),
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    const exploration = await invoke("explore-nes-code", input);
    assert.deepEqual(
      exploration.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    const unknown = await invoke("trace-nes-code", {
      path,
      initial: { mapper: 232 },
    });
    assert.equal(
      unknown.normalized_result.code_trace.stop.reason,
      "unresolved-vector",
    );
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyNamco108(invoke, workspace) {
  for (const submapper of [0, 1]) {
    const prgSize = submapper === 0 ? 131072 : 32768;
    const bytes = Buffer.alloc(16 + prgSize + 8192);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      prgSize / 16384,
      1,
      0xe0,
      0xc8,
      submapper << 4,
    ]);
    bytes.set(
      [0xa9, 0xc7, 0x8d, 0xfe, 0x9f, 0xa9, 5, 0x8d, 0xff, 0x9f, 0x4c, 0, 0xa0],
      16 + prgSize - 8192,
    );
    const target = 16 + (submapper === 0 ? 5 : 1) * 8192;
    bytes.set([0xa9, 0x77, 0x60], target);
    bytes.writeUInt16LE(0xe000, 16 + prgSize - 4);
    const path = join(workspace, `packaged-namco108-${submapper}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper: 206 } };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.final_cpu.a, 0x77);
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [
      target,
      target + 1,
    ]);
    assert.equal(trace.mapper_trace.final.bank_select, 0xc7);
    assert.equal(trace.mapper_trace.final.banks[7], 5);
    assert.ok(
      evidence.normalized_result.limitations.some((text) =>
        text.includes("spurious writes"),
      ),
    );
    verifyCodeSources(trace, bytes);
    const replay = await invoke("trace-nes-mapper-writes", {
      ...input,
      writes: trace.instructions.flatMap((i) => i.writes),
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyQuattroPartial(invoke, workspace) {
  for (const submapper of [0, 1]) {
    const bytes = Buffer.alloc(16 + 131072);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      8,
      0,
      0x80,
      0xe8,
      submapper << 4,
      0,
      0,
      7,
    ]);
    bytes.set([0xa9, 0x66, 0x60], 16 + 7 * 16384);
    const path = join(workspace, `packaged-quattro-partial-${submapper}.nes`);
    await writeFile(path, bytes);
    const mask = submapper === 0 ? 8 : 16;
    const replay = await invoke("trace-nes-mapper-writes", {
      path,
      initial: { mapper: 232, prg_bank: 2 },
      writes: [
        { address: 0x8000, value: null, known_bits: { mask, value: mask } },
      ],
    });
    const initial = replay.normalized_result.trace.final;
    assert.deepEqual(initial, {
      mapper: 232,
      prg_outer_bank: { mask: 1, value: 1 },
      prg_bank: 2,
    });
    const input = { path, initial, entry: 0xc000 };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.final_cpu.a, 0x66);
    assert.deepEqual(trace.instructions[0].file_offsets, [
      16 + 7 * 16384,
      17 + 7 * 16384,
    ]);
    assert.deepEqual(trace.mapper_trace.final, initial);
    assert.deepEqual(trace.mapper_trace.nes_prg_views, []);
    verifyCodeSources(trace, bytes);
    const explored = await invoke("explore-nes-code", input);
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyG101(invoke, workspace) {
  for (const declaration of [7, 0x70]) {
    const bytes = Buffer.alloc(528 + 65536 + 8192);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 6, 0x28]);
    bytes[10] = declaration;
    bytes.fill(0xff, 16, 528);
    const routine = [
      0xa9, 2, 0x8d, 0, 0x80, 0xa9, 2, 0x8d, 0, 0x90, 0x4c, 0, 0xc0,
    ];
    const program = routine.flatMap((byte, index) => [
      0xa9,
      byte,
      0x8d,
      index,
      0x60,
    ]);
    program.push(0x4c, 0, 0x60);
    bytes.set(program, 528 + 7 * 8192);
    bytes.set([0xa9, 0x77, 0x60], 528 + 2 * 8192);
    bytes.writeUInt16LE(0xe000, 528 + 65536 - 4);
    const path = join(workspace, `packaged-g101-ram-${declaration}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper: 32 } };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.final_cpu.a, 0x77);
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [
      528 + 2 * 8192,
      529 + 2 * 8192,
    ]);
    assert.equal(
      trace.instructions.filter(
        (instruction) =>
          instruction.address >= 0x6000 && instruction.address < 0x8000,
      ).length,
      5,
    );
    assert.deepEqual(
      trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
      [6, null, 2, 7],
    );
    verifyCodeSources(trace, bytes);
    const replay = await invoke("trace-nes-mapper-writes", {
      ...input,
      writes: trace.instructions.flatMap((instruction) => instruction.writes),
    });
    const replayTrace = replay.normalized_result.trace;
    assert.equal(replayTrace.status, "derived");
    assert.deepEqual(replayTrace.final, trace.mapper_trace.final);
    assert.deepEqual(
      replayTrace.final_mapping,
      trace.mapper_trace.final_mapping,
    );
    assert.deepEqual(
      replayTrace.nes_prg_views,
      trace.mapper_trace.nes_prg_views,
    );
    assert.equal(replayTrace.steps.length, routine.length + 2);
    assert.ok(
      replayTrace.steps
        .slice(0, routine.length)
        .every((step) => step.effect === "outside-mapper"),
    );
    const explored = await invoke("explore-nes-code", input);
    assert.equal(explored.normalized_result.code_exploration.status, "derived");
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    // An alternate entry uses the same routine as explicit caller RAM evidence.
    const initial_prg_ram = routine.map((value, index) => ({
      address: 0x6000 + index,
      bank: 0,
      value,
    }));
    const seeded = await invoke("trace-nes-code", {
      ...input,
      entry: 0x6000,
      initial_prg_ram,
    });
    const seededTrace = seeded.normalized_result.code_trace;
    assert.equal(seededTrace.status, "derived");
    assert.equal(seededTrace.final_cpu.a, 0x77);
    verifyCodeSources(seededTrace, bytes, [], initial_prg_ram);
    assert.deepEqual(await readFile(path), bytes);
  }
  const bytes = Buffer.alloc(16 + 65536 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0, 0x28, 0x10]);
  bytes.set(
    [0xa9, 2, 0x8d, 0, 0x80, 0xa9, 3, 0x8d, 0, 0x90, 0x4c, 0, 0xc0],
    16 + 7 * 8192,
  );
  bytes.set([0xa9, 0x55, 0x60], 16 + 6 * 8192);
  const path = join(workspace, "packaged-g101-hardwired.nes");
  await writeFile(path, bytes);
  const evidence = await invoke("trace-nes-code", {
    path,
    initial: { mapper: 32 },
    entry: 0xe000,
  });
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.final_cpu.a, 0x55);
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
    [2, null, 6, 7],
  );
  assert.equal(trace.mapper_trace.final_mapping.mirroring, "one-screen-b");
  verifyCodeSources(trace, bytes);
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyTaito33(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 131072 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 1, 0x10, 0x28]);
  bytes.set(
    [0xa9, 0xc2, 0x8d, 0xfc, 0x9f, 0xa9, 0xe5, 0x8d, 0xfd, 0x9f, 0x4c, 0, 0xa0],
    16 + 15 * 8192,
  );
  bytes.set([0xa9, 0x77, 0x60], 16 + 5 * 8192);
  bytes.writeUInt16LE(0xe000, 16 + 131072 - 4);
  const path = join(workspace, "packaged-taito33.nes");
  await writeFile(path, bytes);
  const input = { path, initial: { mapper: 33 } };
  const evidence = await invoke("trace-nes-code", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.final_cpu.a, 0x77);
  assert.deepEqual(trace.instructions.at(-1).file_offsets, [
    16 + 5 * 8192,
    17 + 5 * 8192,
  ]);
  assert.deepEqual(trace.mapper_trace.final.prg_banks, [194, 229]);
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
    [2, 5, 14, 15],
  );
  assert.equal(trace.mapper_trace.final_mapping.mirroring, "horizontal");
  assert.deepEqual(trace.mapper_trace.nes_prg_views, [
    { mapper: 33, prg_bank_0: 2, prg_bank_1: 37 },
  ]);
  verifyCodeSources(trace, bytes);
  const replay = await invoke("trace-nes-mapper-writes", {
    ...input,
    writes: trace.instructions.flatMap((instruction) => instruction.writes),
  });
  assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
  const explored = await invoke("explore-nes-code", input);
  assert.equal(explored.normalized_result.code_exploration.status, "derived");
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  assert.deepEqual(await readFile(path), bytes);
}

async function verifyVrc1(invoke, workspace) {
  const bytes = Buffer.alloc(16 + 131072 + 8192);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 1, 0xb0, 0x48]);
  bytes.set(
    [
      0xa9, 0xe2, 0x8d, 0xff, 0x8f, 0xa9, 0xe5, 0x8d, 0xff, 0xaf, 0xa9, 0xe7,
      0x8d, 0xff, 0xcf, 0x4c, 0, 0x80,
    ],
    16 + 15 * 8192 + 256,
  );
  bytes.set([0x4c, 0, 0xa0], 16 + 2 * 8192);
  bytes.set([0x4c, 0, 0xc0], 16 + 5 * 8192);
  bytes.set([0xa9, 0x77, 0x60], 16 + 7 * 8192);
  bytes.writeUInt16LE(0xe100, 16 + 131072 - 4);
  const path = join(workspace, "packaged-vrc1.nes");
  await writeFile(path, bytes);
  const input = { path, initial: { mapper: 75 } };
  const evidence = await invoke("trace-nes-code", input);
  assert.equal(
    evidence.normalized_result.artifact.sha256,
    createHash("sha256").update(bytes).digest("hex"),
  );
  const trace = evidence.normalized_result.code_trace;
  assert.equal(trace.status, "derived");
  assert.equal(trace.final_cpu.a, 0x77);
  assert.deepEqual(
    trace.instructions.slice(-3).map((instruction) => instruction.address),
    [0x8000, 0xa000, 0xc000],
  );
  assert.deepEqual(trace.instructions.at(-1).file_offsets, [
    16 + 7 * 8192,
    17 + 7 * 8192,
  ]);
  assert.deepEqual(trace.mapper_trace.final.prg_banks, [226, 229, 231]);
  assert.deepEqual(
    trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
    [2, 5, 7, 15],
  );
  assert.deepEqual(trace.mapper_trace.nes_prg_views, [
    { mapper: 75, prg_bank_0: 2, prg_bank_1: 5, prg_bank_2: 7 },
  ]);
  verifyCodeSources(trace, bytes);
  const replay = await invoke("trace-nes-mapper-writes", {
    ...input,
    writes: trace.instructions.flatMap((instruction) => instruction.writes),
  });
  assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
  const explored = await invoke("explore-nes-code", input);
  assert.equal(explored.normalized_result.code_exploration.status, "derived");
  assert.deepEqual(
    explored.normalized_result.code_exploration.paths[0].trace,
    trace,
  );
  assert.deepEqual(await readFile(path), bytes);
}

function verifyVrc2LatchReadSource(trace, index, read, bytes) {
  assert.equal((bytes[6] >>> 4) | (bytes[7] & 240), 23);
  assert.equal(bytes[7] & 12, 8);
  assert.equal(bytes[8] >>> 4, 3);
  assert.equal(bytes[10], 0);
  assert.ok(read.address >= 0x6000 && read.address <= 0x6fff);
  assert.equal(read.file_offset, null);
  assert.deepEqual(read.ram_origins, []);
  assert.equal(read.mapper_origins.length, 1);
  const origin = read.mapper_origins[0];
  assert.equal(origin.byte_index, 0);
  assert.equal(read.known_bits.mask, 1);
  assert.equal(read.known_bits.value, origin.latch_value);
  assert.equal(trace.mapper_trace.status, "derived");
  assert.equal(trace.mapper_trace.initial.latch_present, true);
  const writes = trace.instructions
    .slice(0, index)
    .flatMap((instruction, instruction_index) =>
      instruction.writes.map((write, write_index) => ({
        write,
        instruction_index,
        write_index,
      })),
    )
    .filter(({ write }) => write.address >= 0x6000 && write.address <= 0x6fff);
  if (origin.source.kind === "initial-state") {
    assert.equal(writes.length, 0);
    assert.equal(origin.latch_value, trace.mapper_trace.initial.latch_value);
  } else {
    const last = writes.at(-1);
    assert.ok(last);
    assert.equal(origin.source.instruction_index, last.instruction_index);
    assert.equal(origin.source.write_index, last.write_index);
    if (last.write.value === null)
      assert.equal(last.write.known_bits.mask & 1, 1);
    const value = last.write.value ?? last.write.known_bits.value;
    assert.equal(origin.latch_value, value & 1);
  }
}

async function verifyVrc2Prg(invoke, workspace) {
  for (const mapper of [22, 23, 25]) {
    const bytes = Buffer.alloc(16 + 131072 + 8192);
    bytes.set([
      0x4e,
      0x45,
      0x53,
      0x1a,
      8,
      1,
      (mapper & 15) << 4,
      0x18,
      mapper === 22 ? 0 : 0x30,
    ]);
    bytes.set(
      [
        0xa9, 0xe2, 0x8d, 0xff, 0x8f, 0xa9, 0xe5, 0x8d, 0xff, 0xaf, 0xa9, 255,
        0x8d, 3, 0x90, 0x4c, 0, 0xa0,
      ],
      16 + 15 * 8192,
    );
    bytes.set([0xa9, 0x77, 0x60], 16 + 5 * 8192);
    bytes.writeUInt16LE(0xe000, 16 + 131072 - 4);
    const path = join(workspace, `packaged-vrc2-${mapper}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper } };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.final_cpu.a, 0x77);
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [
      16 + 5 * 8192,
      17 + 5 * 8192,
    ]);
    assert.deepEqual(trace.mapper_trace.final.prg_banks, [226, 229]);
    assert.deepEqual(
      trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
      [2, 5, 14, 15],
    );
    assert.equal(trace.mapper_trace.final_mapping.mirroring, "horizontal");
    assert.deepEqual(trace.mapper_trace.nes_prg_views, [
      { mapper, prg_bank_0: 2, prg_bank_1: 5 },
    ]);
    verifyCodeSources(trace, bytes);
    const replay = await invoke("trace-nes-mapper-writes", {
      ...input,
      writes: trace.instructions.flatMap((instruction) => instruction.writes),
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    const explored = await invoke("explore-nes-code", input);
    assert.equal(explored.normalized_result.code_exploration.status, "derived");
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    assert.deepEqual(await readFile(path), bytes);
    if (mapper !== 22) {
      const legacy = Buffer.from(bytes);
      legacy[7] = 0x10;
      legacy[8] = 0;
      const legacyPath = join(workspace, `packaged-vrc2-legacy-${mapper}.nes`);
      await writeFile(legacyPath, legacy);
      const rejected = await invoke("trace-nes-code", {
        path: legacyPath,
        initial: { mapper },
      });
      assert.equal(
        rejected.normalized_result.artifact.sha256,
        createHash("sha256").update(legacy).digest("hex"),
      );
      assert.equal(rejected.normalized_result.code_trace.status, "unsupported");
      assert.match(
        rejected.normalized_result.code_trace.reason,
        /explicit NES 2.0 submapper/,
      );
      assert.deepEqual(await readFile(legacyPath), legacy);
    }
  }
}

async function verifyVrc2Latch(invoke, workspace) {
  const branchProgram = (bit) => [
    0xa9,
    bit,
    0x8d,
    0xff,
    0x6f,
    0xa9,
    1,
    0x2d,
    0,
    0x60,
    0xf0,
    8,
    0xa9,
    2,
    0x8d,
    0,
    0x80,
    0x4c,
    0,
    0x80,
    0xa9,
    0xee,
    0x60,
  ];
  const cases = [
    {
      program: branchProgram(1),
      initial: { mapper: 23, latch_present: true },
      expected: 0x77,
    },
    {
      program: branchProgram(0),
      initial: { mapper: 23, latch_present: true },
      expected: 0xee,
    },
    { program: branchProgram(1), initial: { mapper: 23 }, expected: null },
    {
      program: branchProgram(1),
      initial: { mapper: 23, latch_present: false },
      expected: null,
    },
    {
      program: [0x0e, 0, 0x60, 0xa9, 1, 0x2d, 0, 0x61, 0x60],
      initial: { mapper: 23, latch_present: true, latch_value: 1 },
      expected: 0,
    },
  ];
  for (const [index, scenario] of cases.entries()) {
    const bytes = Buffer.alloc(16 + 131072 + 8192);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 8, 1, 0x70, 0x18, 0x30]);
    bytes.set(scenario.program, 16 + 15 * 8192);
    bytes.set([0xa9, 0x77, 0x60], 16 + 2 * 8192);
    const path = join(workspace, `packaged-vrc2-latch-${index}.nes`);
    await writeFile(path, bytes);
    const input = { path, entry: 0xe000, initial: scenario.initial };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.final_cpu.a, scenario.expected);
    assert.equal(
      trace.stop.reason,
      scenario.expected === null ? "unknown-branch" : "return",
    );
    verifyCodeSources(trace, bytes);
    const replay = await invoke("trace-nes-mapper-writes", {
      path,
      initial: input.initial,
      writes: trace.instructions.flatMap((instruction) => instruction.writes),
    });
    assert.deepEqual(replay.normalized_result.trace, trace.mapper_trace);
    if (index === 0) {
      const explored = await invoke("explore-nes-code", input);
      assert.equal(
        explored.normalized_result.code_exploration.status,
        "derived",
      );
      assert.deepEqual(
        explored.normalized_result.code_exploration.paths[0].trace,
        trace,
      );
    }
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyVrc2cRam(invoke, workspace) {
  const routine = [
    0xad, 0, 0x70, 0xa9, 255, 0x8d, 2, 0x90, 0xa9, 15, 0x8d, 2, 0xb0, 0xa9, 7,
    0x8d, 0, 0xb0, 0xa9, 2, 0x8d, 0, 0x80, 0x4c, 0, 0x80,
  ];
  for (const declaration of [7, 0x70]) {
    const bytes = Buffer.alloc(528 + 65536 + 262144);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 32, 0x96, 0x18, 0x30]);
    bytes[10] = declaration;
    bytes.fill(0xff, 16, 528);
    const program = routine.flatMap((byte, index) => [
      0xa9,
      byte,
      0x8d,
      index,
      0x60,
    ]);
    program.push(0x4c, 0, 0x60);
    bytes.set(program, 528 + 7 * 8192);
    bytes.set([0xa9, 0x77, 0x60], 528 + 2 * 8192);
    bytes.writeUInt16LE(0xe000, 528 + 65536 - 4);
    const path = join(workspace, `packaged-vrc2c-ram-${declaration}.nes`);
    await writeFile(path, bytes);
    const input = { path, initial: { mapper: 25 } };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.final_cpu.a, 0x77);
    assert.deepEqual(trace.instructions.at(-1).file_offsets, [
      528 + 2 * 8192,
      529 + 2 * 8192,
    ]);
    const ram = trace.instructions.filter(
      (instruction) =>
        instruction.address >= 0x6000 && instruction.address < 0x8000,
    );
    assert.equal(ram.length, 10);
    assert.deepEqual(ram[0].data_reads, [
      {
        address: 0x7000,
        value: null,
        file_offset: null,
        ram_origins: [],
        mapper_origins: [],
      },
    ]);
    assert.deepEqual(
      trace.mapper_trace.final_mapping.prg_windows.map((window) => window.bank),
      [2, null, 6, 7],
    );
    assert.equal(trace.mapper_trace.final_mapping.chr_windows[0].bank, 247);
    assert.equal(trace.mapper_trace.final_mapping.mirroring, "horizontal");
    verifyCodeSources(trace, bytes);
    const replay = await invoke("trace-nes-mapper-writes", {
      ...input,
      writes: trace.instructions.flatMap((instruction) => instruction.writes),
    });
    assert.equal(replay.normalized_result.trace.status, "derived");
    assert.deepEqual(
      replay.normalized_result.trace.final,
      trace.mapper_trace.final,
    );
    assert.deepEqual(
      replay.normalized_result.trace.final_mapping,
      trace.mapper_trace.final_mapping,
    );
    assert.deepEqual(
      replay.normalized_result.trace.nes_prg_views,
      trace.mapper_trace.nes_prg_views,
    );
    assert.ok(
      replay.normalized_result.trace.steps
        .slice(0, routine.length)
        .every((step) => step.effect === "outside-mapper"),
    );
    const explored = await invoke("explore-nes-code", input);
    assert.equal(explored.normalized_result.code_exploration.status, "derived");
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    const initial_prg_ram = routine.map((value, index) => ({
      bank: 0,
      address: 0x6000 + index,
      value,
    }));
    const seeded = await invoke("trace-nes-code", {
      ...input,
      entry: 0x6000,
      initial_prg_ram,
    });
    const seededTrace = seeded.normalized_result.code_trace;
    assert.equal(seededTrace.status, "derived");
    assert.equal(seededTrace.final_cpu.a, 0x77);
    verifyCodeSources(seededTrace, bytes, [], initial_prg_ram);
    assert.deepEqual(await readFile(path), bytes);
  }
}

async function verifyVrc4Ram(invoke, workspace) {
  for (const [wiring, declaration] of [
    ["internal-2k", 5],
    ["internal-2k", 0x50],
    ["external-8k", 7],
    ["external-8k", 0x70],
  ]) {
    const bytes = Buffer.alloc(528 + 65536 + 8192, 0x02);
    bytes.fill(0, 0, 16);
    bytes.set([0x4e, 0x45, 0x53, 0x1a, 4, 1, 0x96, 0x18, 0x20]);
    bytes[10] = declaration;
    bytes.fill(0xa5, 16, 528);
    // VRC4d: chip port 2 is selected by CPU A2.
    const write = (address, value) => [
      0xa9,
      value,
      0x8d,
      address & 255,
      address >> 8,
    ];
    const routine = [
      0xad,
      0,
      0x67,
      0xad,
      0,
      0x70,
      ...write(0x9004, 3),
      ...write(0x8000, 2),
      0x4c,
      0,
      0xc0,
    ];
    const program = [
      ...write(0x9004, 1),
      ...write(0xa000, 1),
      ...write(0x6700, 0x44),
      ...write(0x6f00, 0x55),
      ...write(0x7000, 0x66),
      ...routine.flatMap((value, index) => write(0x6800 + index, value)),
      ...write(0x9004, 0),
      ...write(0x6f00, 0x99),
      ...write(0x9004, 1),
      0xad,
      0,
      0x6f,
      0xee,
      0,
      0x6f,
      0x4c,
      0,
      0x68,
    ];
    bytes.set(program, 528 + 7 * 8192);
    bytes.set([0xa9, 0x77, 0x60], 528 + 2 * 8192);
    bytes.writeUInt16LE(0xe000, 528 + 65536 - 4);
    const path = join(workspace, `packaged-vrc4-ram-${declaration}.nes`);
    await writeFile(path, bytes);
    const input = {
      path,
      initial: { mapper: 25, variant: "vrc4", prg_ram_wiring: wiring },
    };
    const evidence = await invoke("trace-nes-code", input);
    assert.equal(
      evidence.normalized_result.artifact.sha256,
      createHash("sha256").update(bytes).digest("hex"),
    );
    const trace = evidence.normalized_result.code_trace;
    assert.equal(trace.status, "derived");
    assert.equal(trace.stop.reason, "return");
    assert.equal(trace.final_cpu.a, 0x77);
    const ram = trace.instructions.filter(
      (i) => i.address >= 0x6800 && i.address < 0x6800 + routine.length,
    );
    assert.equal(ram.length, 7);
    assert.equal(
      ram[0].data_reads[0].value,
      wiring === "internal-2k" ? 0x56 : 0x44,
    );
    assert.equal(
      ram[1].data_reads[0].value,
      wiring === "internal-2k" ? null : 0x66,
    );
    assert.equal(trace.instructions[54].data_reads[0].value, 0x55);
    assert.deepEqual(
      trace.instructions[55].writes.map((w) => w.value),
      [0x55, 0x56],
    );
    assert.deepEqual(
      trace.mapper_trace.final_mapping.prg_windows.map((w) => w.bank),
      [6, 1, 2, 7],
    );
    verifyCodeSources(trace, bytes);
    const replay = await invoke("trace-nes-mapper-writes", {
      ...input,
      writes: trace.instructions.flatMap((i) => i.writes),
    });
    assert.equal(replay.normalized_result.trace.status, "derived");
    assert.deepEqual(
      replay.normalized_result.trace.final,
      trace.mapper_trace.final,
    );
    assert.deepEqual(
      replay.normalized_result.trace.final_mapping,
      trace.mapper_trace.final_mapping,
    );
    const explored = await invoke("explore-nes-code", input);
    assert.equal(explored.normalized_result.code_exploration.status, "derived");
    assert.deepEqual(
      explored.normalized_result.code_exploration.paths[0].trace,
      trace,
    );
    const initial_prg_ram = routine.map((value, index) => ({
      bank: 0,
      address: (wiring === "internal-2k" ? 0x6000 : 0x6800) + index,
      value,
    }));
    const seeded = await invoke("trace-nes-code", {
      path,
      initial: {
        ...input.initial,
        prg_control: { mask: 1, value: 1 },
        prg_banks: [0, 1],
      },
      entry: 0x6800,
      initial_prg_ram,
    });
    assert.equal(seeded.normalized_result.code_trace.status, "derived");
    assert.equal(seeded.normalized_result.code_trace.final_cpu.a, 0x77);
    verifyCodeSources(
      seeded.normalized_result.code_trace,
      bytes,
      [],
      initial_prg_ram,
    );
    assert.deepEqual(await readFile(path), bytes);
  }
}
