import assert from "node:assert/strict";

export const integer = (value, maximum, name) => {
  assert.ok(
    Number.isSafeInteger(value) && value >= 0 && value <= maximum,
    `Invalid ${name}`,
  );
  return value;
};

const knownByte = (value) => integer(value, 255, "complete byte");

export const emptyOrigins = (read) => {
  assert.deepEqual(
    read.mapper_origins,
    [],
    "nestest admits no mapper byte origins",
  );
  assert.ok(!("known_bits" in read), "nestest admits no partial byte proofs");
};

const writerEqual = (left, right) =>
  assert.deepEqual(
    left,
    right,
    "RAM source is not the current authenticated writer",
  );

export const initialLedger = (ram, input, startRow, segmentIndex) => {
  assert.ok(ram instanceof Map, "Prior committed RAM must be a Map");
  const entries = [...ram.entries()].sort(([a], [b]) => a - b);
  for (const [address, fact] of entries) {
    integer(address, 2047, "physical RAM address");
    knownByte(fact.value);
    assert.ok(
      typeof fact.writer.evidence_id === "string" &&
        fact.writer.evidence_id.length > 0,
      "RAM writer needs its prior Evidence identity",
    );
    integer(fact.writer.segment, segmentIndex - 1, "prior writer segment");
    integer(
      fact.writer.instruction_index,
      Number.MAX_SAFE_INTEGER,
      "prior local writer",
    );
    integer(
      fact.writer.absolute_instruction_index,
      startRow - 1,
      "prior global writer",
    );
    integer(fact.writer.write_index, 2, "prior write index");
  }
  assert.deepEqual(
    input.initial_ram ?? [],
    entries.map(([address, fact]) => ({ address, value: fact.value })),
    "initial_ram must equal sorted authenticated prior RAM",
  );
  return {
    carried: structuredClone(entries),
    ledger: new Map(structuredClone(entries)),
  };
};

const authenticateRam = (read, fact, context) => {
  assert.ok(fact, "Known RAM read has no committed writer");
  assert.equal(
    read.value,
    fact.value,
    "RAM read differs from committed physical storage",
  );
  assert.equal(
    read.ram_origins.length,
    1,
    "RAM byte needs exactly one physical source",
  );
  const origin = read.ram_origins[0];
  assert.equal(origin.byte_index, 0);
  assert.equal(origin.region, "internal-ram");
  assert.equal(origin.ram_address, read.address & 2047);
  const writer = fact.writer;
  assert.ok(
    writer.absolute_instruction_index <=
      context.startRow + context.instructionIndex,
    "RAM writer is in the future",
  );
  if ("initial_ram_index" in origin) {
    integer(
      origin.initial_ram_index,
      context.carried.length - 1,
      "initial RAM input index",
    );
    const [address, previous] = context.carried[origin.initial_ram_index];
    assert.equal(
      address,
      origin.ram_address,
      "RAM input index identifies a different physical cell",
    );
    assert.equal(previous.value, read.value);
    assert.ok(
      previous.writer.segment < context.segmentIndex &&
        previous.writer.absolute_instruction_index < context.startRow,
      "RAM input must bridge a prior segment writer",
    );
    writerEqual(writer, previous.writer);
  } else {
    integer(
      origin.instruction_index,
      context.instructionIndex,
      "local RAM writer",
    );
    integer(origin.write_index, 2, "local RAM write index");
    writerEqual(writer, {
      evidence_id: context.evidenceId,
      segment: context.segmentIndex,
      instruction_index: origin.instruction_index,
      absolute_instruction_index: context.startRow + origin.instruction_index,
      write_index: origin.write_index,
    });
  }
};

const authenticateRead = (read, context, count = true) => {
  emptyOrigins(read);
  assert.ok(Array.isArray(read.ram_origins), "RAM source array is required");
  if (read.address !== null) integer(read.address, 65535, "CPU read address");
  const romAddress = read.address !== null && read.address >= 0x8000;
  const ramAddress = read.address !== null && read.address < 0x2000;
  const fact = ramAddress ? context.ledger.get(read.address & 2047) : undefined;
  if (read.value === null) {
    assert.equal(
      read.file_offset,
      null,
      "Unknown bytes cannot invent ROM offsets",
    );
    assert.deepEqual(
      read.ram_origins,
      [],
      "Unknown bytes cannot invent RAM origins",
    );
    assert.ok(
      !romAddress && fact === undefined,
      "Unknown read discarded an authenticated ROM/RAM byte",
    );
    if (count) context.stats.unresolvedDataReads++;
    return;
  }
  knownByte(read.value);
  assert.notEqual(read.address, null, "Known read needs its CPU address");
  if (romAddress) {
    const offset = 16 + ((read.address - 0x8000) & 0x3fff);
    assert.equal(
      read.file_offset,
      offset,
      "ROM origin must use the physical NROM-128 alias",
    );
    assert.equal(
      context.rom[offset],
      read.value,
      "ROM source byte does not match the artifact",
    );
    assert.deepEqual(read.ram_origins, []);
  } else {
    assert.ok(
      ramAddress,
      "Known device/cartridge RAM bytes are outside this profile",
    );
    assert.equal(read.file_offset, null);
    authenticateRam(read, fact, context);
  }
  if (count) context.stats.verifiedDataReads++;
};

const applyWrite = (write, writeIndex, context) => {
  integer(write.address, 65535, "CPU write address");
  knownByte(write.value);
  assert.ok(
    !("known_bits" in write),
    "Committed nestest writes must be complete bytes",
  );
  if (write.address >= 0x2000) {
    assert.ok(
      [0x4004, 0x4005, 0x4006, 0x4007, 0x4015].includes(write.address),
      "Unexpected non-RAM write in nestest",
    );
    assert.ok(
      write.address !== 0x4015 || (write.value & 16) === 0,
      "nestest cannot enable unmodeled DMC DMA",
    );
    return;
  }
  context.ledger.set(write.address & 2047, {
    value: write.value,
    writer: {
      evidence_id: context.evidenceId,
      segment: context.segmentIndex,
      instruction_index: context.instructionIndex,
      absolute_instruction_index: context.startRow + context.instructionIndex,
      write_index: writeIndex,
    },
  });
};

export const verifyCycles = (cycles, writes, firstCycle, context) => {
  assert.ok(
    Array.isArray(cycles) && Array.isArray(writes),
    "Ordered bus actions and write list are required",
  );
  const seenWrites = new Set();
  for (const [offset, cycle] of cycles.entries()) {
    assert.equal(
      cycle.index,
      firstCycle + offset,
      "CPU bus cycles must be consecutive",
    );
    if (cycle.kind === "read") {
      assert.ok(
        [
          "opcode",
          "operand",
          "pointer",
          "data",
          "dummy",
          "stack",
          "vector",
        ].includes(cycle.role),
        "No DMA/device bus roles belong to nestest",
      );
      assert.ok(
        !("dma_io" in cycle),
        "nestest has no selected device bus state",
      );
      authenticateRead(cycle.read, context);
    } else {
      assert.equal(cycle.kind, "write");
      assert.ok(["data", "dummy", "stack"].includes(cycle.role));
      integer(cycle.write_index, writes.length - 1, "bus write index");
      assert.ok(
        !seenWrites.has(cycle.write_index),
        "Each write_index must occur exactly once on the bus",
      );
      assert.equal(
        cycle.write_index,
        seenWrites.size,
        "Bus write indices must preserve write-list order",
      );
      seenWrites.add(cycle.write_index);
      applyWrite(writes[cycle.write_index], cycle.write_index, context);
    }
  }
  assert.equal(
    seenWrites.size,
    writes.length,
    "Every committed write needs exactly one bus cycle",
  );
};
