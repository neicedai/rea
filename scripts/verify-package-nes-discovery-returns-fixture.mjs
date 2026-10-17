/** Independent return-state corpus; no production decoder/mapper imports. */
export const PRG = 528,
  PRG_SIZE = 65536,
  CHR = PRG + PRG_SIZE;

export const initial = (r6 = 1) => ({
  mapper: 4,
  bank_select: 6,
  banks: [0, 2, 4, 5, 6, 7, r6, 3],
  mirroring: 0,
  ram_protect: 0,
  irq_latch: 0,
  last_irq_command: "disable-acknowledge",
});

export const addresses = {
  bankSwitch: {
    caller: 0x8010,
    callee: 0xe100,
    rts: 0xe10c,
    continuation: 0x8013,
  },
  preserved: {
    caller: 0x8040,
    callee: 0xe140,
    rts: 0xe142,
    continuation: 0x8043,
  },
  ramPointer: {
    caller: 0xe200,
    callee: 0xe240,
    rts: 0xe24a,
    continuation: 0xe203,
  },
  nested: {
    caller: 0x8080,
    outer: 0xe340,
    inner: 0xe380,
    innerRts: 0xe38a,
    outerContinuation: 0xe343,
    outerRts: 0xe345,
    continuation: 0x8083,
  },
  paired: {
    roots: [0xe400, 0xe420],
    calls: [0xe406, 0xe426],
    callee: 0xe480,
    rts: 0xe487,
    continuations: [0xe409, 0xe429],
    writer: 0xe480,
  },
  entryBanks: {
    caller: 0xeaa0,
    callee: 0xeac0,
    rts: 0xeac2,
    continuation: 0xeaa3,
    target: 0x8400,
  },
  recursive: {
    caller: 0xe520,
    callee: 0xe500,
    recursiveCall: 0xe505,
    recursiveRts: 0xe508,
    baseRts: 0xe50b,
    continuation: 0xe523,
  },
  nonReturn: {
    caller: 0xe620,
    callee: 0xe600,
    unreachableRts: 0xe603,
    continuation: 0xe623,
  },
  brokenStack: {
    caller: 0xe720,
    callee: 0xe700,
    rts: 0xe701,
    continuation: 0xe723,
  },
  unknownStore: {
    caller: 0xe900,
    callee: 0xe940,
    rts: 0xe942,
    continuation: 0xe903,
  },
  knownStack: {
    root: 0xe800,
    caller: 0xe803,
    callee: 0xe840,
    push: 0xe842,
    pull: 0xe845,
    rts: 0xe846,
    continuation: 0xe806,
  },
  opaqueStack: {
    caller: 0xea00,
    callee: 0xea40,
    push: 0xea42,
    pull: 0xea45,
    rts: 0xea46,
    continuation: 0xea03,
  },
  opaqueSimple: {
    caller: 0xeb00,
    callee: 0xeb40,
    rts: 0xeb42,
    continuation: 0xeb03,
  },
  physicalJump: {
    root: 0xec00,
    rts: 0xec09,
    target: 0xef00,
    writers: [0xec08, 0xec05],
  },
  done: 0xef00,
};

export const oracle = {
  switched: { bank: 5, file_offset: PRG + 40979, bytes: "a955", a_in: 0x77 },
  oldContinuationOffset: PRG + 8211,
  preserved: {
    bank: 1,
    file_offset: PRG + 8259,
    a_in: 0x33,
    ram_writer: 0x8043,
  },
  nested: { bank: 5, file_offset: PRG + 41091, a_in: 0x66 },
  pointerWriters: [0xe242, 0xe246],
  paired: [
    {
      caller: 0xe406,
      continuation: 0xe409,
      a_in: 0x81,
      bank: 1,
      target: 0x8100,
      file_offset: PRG + 8448,
    },
    {
      caller: 0xe426,
      continuation: 0xe429,
      a_in: 0x82,
      bank: 2,
      target: 0x8200,
      file_offset: PRG + 16896,
    },
  ],
  forbiddenPairedOffsets: [PRG + 8704, PRG + 16640],
  entryBankTargets: [
    { bank: 1, file_offset: PRG + 9216 },
    { bank: 5, file_offset: PRG + 41984 },
  ],
  knownStack: { sp: 0xfd, a: 0x42, pushed_address: 0x1fb },
  opaqueStack: { sp: null, a: 0x53 },
  opaqueSimple: { sp: null, a: 0x53 },
};

export function fixture() {
  const bytes = Buffer.alloc(CHR + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0x44, 8]);
  bytes.fill(0xa6, 16, PRG);
  bytes.fill(0x39, CHR);
  const put = (bank, offset, code) =>
    bytes.set(code, PRG + bank * 8192 + offset);
  const fixed = (address, code) => put(7, address - 0xe000, code);
  const done = [0x4c, 0, 0xef];

  put(1, 0x10, [0x20, 0, 0xe1]);
  put(5, 0x13, [0xa9, 0x55, ...done]);
  fixed(
    0xe100,
    [0xa9, 6, 0x8d, 0, 0x80, 0xa9, 5, 0x8d, 1, 0x80, 0xa9, 0x77, 0x60],
  );

  put(1, 0x40, [0x20, 0x40, 0xe1, 0x8d, 0x10, 0, 0xad, 0x10, 0, ...done]);
  fixed(0xe140, [0xa9, 0x33, 0x60]);

  fixed(0xe200, [0x20, 0x40, 0xe2, 0x6c, 2, 0]);
  fixed(0xe240, [0xa9, 0, 0x85, 2, 0xa9, 0x81, 0x85, 3, 0xa9, 0x44, 0x60]);
  put(1, 0x100, done);
  put(2, 0x200, done);

  put(1, 0x80, [0x20, 0x40, 0xe3]);
  put(5, 0x83, [0xa9, 0xaa, ...done]);
  fixed(0xe340, [0x20, 0x80, 0xe3, 0xa9, 0x66, 0x60]);
  fixed(0xe380, [0xa9, 6, 0x8d, 0, 0x80, 0xa9, 5, 0x8d, 1, 0x80, 0x60]);

  // Both callers enter the same callee/mapper with different A/RAM inputs.
  // The callee's one STA $03 and STA $8001 must keep their input witnesses.
  fixed(0xe400, [0xa9, 0, 0x85, 2, 0xa9, 0x81, 0x20, 0x80, 0xe4, 0x6c, 2, 0]);
  fixed(0xe420, [0xa9, 0, 0x85, 2, 0xa9, 0x82, 0x20, 0x80, 0xe4, 0x6c, 2, 0]);
  fixed(0xe480, [0x85, 3, 0x8d, 1, 0x80, 0xa9, 0x77, 0x60]);

  fixed(0xeaa0, [0x20, 0xc0, 0xea, 0x4c, 0, 0x84]);
  fixed(0xeac0, [0xa9, 0x64, 0x60]);
  put(1, 0x400, done);
  put(5, 0x400, done);

  // The recursive branch and base branch are static alternatives, not a
  // feasibility or guaranteed-termination claim. A finite returning summary
  // carries $7C; retained relative byte values consume the explicit work budget.
  fixed(0xe500, [0xad, 0, 0, 0xf0, 4, 0x20, 0, 0xe5, 0x60, 0xa9, 0x7c, 0x60]);
  fixed(0xe520, [0x20, 0, 0xe5, 0x85, 0x20, ...done]);

  fixed(0xe600, [0x4c, 0, 0xe6, 0x60]);
  fixed(0xe620, [0x20, 0, 0xe6, 0xa9, 0xba, ...done]);
  fixed(0xe700, [0x68, 0x60]);
  fixed(0xe720, [0x20, 0, 0xe7, 0xa9, 0xdb, ...done]);
  fixed(0xe900, [0x20, 0x40, 0xe9, 0xa9, 0x99, ...done]);
  fixed(0xe940, [0x91, 0, 0x60]);

  // Known SP is established by original instructions, never by an extra API
  // assumption. The second root retains unknown SP and relative stack proof.
  fixed(0xe800, [0xa2, 0xfd, 0x9a, 0x20, 0x40, 0xe8, 0x85, 0x11, ...done]);
  fixed(0xe840, [0xa9, 0x42, 0x48, 0xa9, 0, 0x68, 0x60]);
  fixed(0xea00, [0x20, 0x40, 0xea, 0x85, 0x12, ...done]);
  fixed(0xea40, [0xa9, 0x53, 0x48, 0xa9, 0, 0x68, 0x60]);
  fixed(0xeb00, [0x20, 0x40, 0xeb, 0x85, 0x13, ...done]);
  fixed(0xeb40, [0xa9, 0x53, 0x60]);
  // Actual RAM return address EEFF is pushed into slots1FD/1FC, then incremented.
  fixed(0xec00, [0xa2, 0xfd, 0x9a, 0xa9, 0xee, 0x48, 0xa9, 0xff, 0x48, 0x60]);
  fixed(0xef00, done);
  for (const distance of [6, 4, 2]) bytes.writeUInt16LE(0xe200, CHR - distance);
  return bytes;
}
