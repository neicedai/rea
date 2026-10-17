/** Authored literal bytes. No production CPU, alias, domain or mapper imports. */
export const ALL_BYTES = Object.freeze(
  Array.from({ length: 256 }, (_, v) => v),
);
export const TABLE = 0xf000;
export const entries = Object.freeze({
  recursive: 0xe000,
  mirror: 0xe040,
  ramCarrier: 0xe080,
  storedSet: 0xe0c0,
  equalConstants: 0xe100,
  relativeSet: 0xe140,
  physicalSet: 0xe180,
  io: 0xe1c0,
  preservedCall: 0xe200,
  changedCall: 0xe240,
  unknownStore: 0xe280,
  joined: 0xe2c0,
  recursiveCallee: 0xe500,
  preservedCallee: 0xe700,
  changedCallee: 0xe740,
});
export const sites = Object.freeze({
  mirrorBranch: 0xe044,
  mirrorRead: 0xe047,
  mirrorTable: 0xe04a,
  carrierBranch: 0xe086,
  carrierRead: 0xe089,
  carrierTable: 0xe08b,
  storedWrite: 0xe0c9,
  storedRead: 0xe0cd,
  storedTable: 0xe0cf,
  constantsFinal: 0xe106,
  relativePush: 0xe149,
  relativePop: 0xe14c,
  relativeTable: 0xe14e,
  physicalPush: 0xe189,
  physicalPop: 0xe192,
  physicalTable: 0xe194,
  ioSecond: 0xe1c8,
  ioTable: 0xe1cc,
  preservedRead: 0xe20a,
  preservedTable: 0xe20c,
  changedRead: 0xe24a,
  changedTable: 0xe24c,
  unknownWrite: 0xe28b,
  unknownRead: 0xe28d,
  unknownTable: 0xe28f,
  joinedWrite: 0xe2c8,
  joinedRead: 0xe2cd,
  joinedBranch: 0xe2d1,
  joinedOtherRead: 0xe2d4,
  joinedTable: 0xe2d6,
});
const jump = (address) => [0x4c, address & 255, address >> 8];
const readX = [0xbd, 0, 0xf0, 2];
const joinedA = (start) => [0x90, 5, 0xa9, 1, ...jump(start + 9), 0xa9, 128];

function writeBasicPrograms(put) {
  put(entries.recursive, [0x20, 0, 0xe5, 2]);
  put(
    entries.recursiveCallee,
    [0xa5, 0x20, 0xf0, 4, 0x20, 0, 0xe5, 0x60, 0x60],
  );
  put(entries.mirror, [
    0xa5,
    0x20,
    0xc9,
    10,
    0x90,
    1,
    2,
    0xae,
    0x20,
    8,
    ...readX,
  ]);
  put(entries.ramCarrier, [
    0xa5,
    0x20,
    0xc9,
    10,
    0xa9,
    0x77,
    0x90,
    1,
    2,
    0xa6,
    0x20,
    ...readX,
  ]);
  put(entries.storedSet, [
    ...joinedA(entries.storedSet),
    0x85,
    0x20,
    0xa9,
    0,
    0xa6,
    0x20,
    ...readX,
  ]);
  put(entries.equalConstants, [0xa9, 7, 0x85, 0x20, 0xa9, 7, 0x85, 0x21, 2]);
  put(entries.relativeSet, [
    ...joinedA(entries.relativeSet),
    0x48,
    0xa9,
    0,
    0x68,
    0xaa,
    ...readX,
  ]);
  put(entries.physicalSet, [
    ...joinedA(entries.physicalSet),
    0x48,
    0xba,
    0xe0,
    0xfc,
    0xf0,
    1,
    2,
    0xa9,
    0,
    0x68,
    0xaa,
    ...readX,
  ]);
  put(entries.io, [
    0xad,
    2,
    0x20,
    0xc9,
    10,
    0x90,
    1,
    2,
    0xad,
    2,
    0x20,
    0xaa,
    ...readX,
  ]);
}

function writeCallAndJoinPrograms(put) {
  for (const [entry, callee] of [
    [entries.preservedCall, entries.preservedCallee],
    [entries.changedCall, entries.changedCallee],
  ])
    put(entry, [
      0xa5,
      0x20,
      0xc9,
      10,
      0x90,
      1,
      2,
      0x20,
      callee & 255,
      callee >> 8,
      0xa6,
      0x20,
      ...readX,
    ]);
  put(entries.preservedCallee, [0xa9, 0x66, 0x60]);
  put(entries.changedCallee, [0xa9, 42, 0x8d, 0x20, 8, 0x60]);
  put(entries.unknownStore, [
    0xa5,
    0x20,
    0xc9,
    10,
    0x90,
    1,
    2,
    0xa9,
    0x77,
    0xa0,
    0,
    0x91,
    0x40,
    0xa6,
    0x20,
    ...readX,
  ]);
  put(entries.joined, [
    0xa5,
    0x20,
    0x85,
    0x21,
    0x90,
    7,
    0xa9,
    1,
    0x85,
    0x20,
    ...jump(sites.joinedRead),
    0xa5,
    0x20,
    0xc9,
    5,
    0x90,
    1,
    2,
    0xa6,
    0x21,
    ...readX,
  ]);
}

export function fixture() {
  const bytes = Buffer.alloc(16 + 32768 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([0x4e, 0x45, 0x53, 0x1a, 2, 1, 0, 8]);
  const put = (address, code) => bytes.set(code, 16 + address - 0x8000);
  put(TABLE, ALL_BYTES);
  writeBasicPrograms(put);
  writeCallAndJoinPrograms(put);
  return bytes;
}
