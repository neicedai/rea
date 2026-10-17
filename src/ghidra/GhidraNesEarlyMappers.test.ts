import {
  fixtureNesLoadImage,
  fixtureNesPrgMappings,
} from "./GhidraNesLoadImage.fixture.js";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { attestGhidraNesLoadImage } from "./GhidraNesLoadImage.js";

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

it("attests distinct Namco76 logical contexts with identical physical banks and rejects a wrong fixed source", () => {
  const bytes = Buffer.alloc(528 + 65536 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 4, 1, 0xc4, 0x48]);
  for (let bank = 0; bank < 8; bank++)
    bytes.fill(bank, 528 + bank * 8192, 528 + (bank + 1) * 8192);
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0x8008, 528 + 65536 - delta);
  const observations = fixtureNesLoadImage(bytes, "early.nes", [], []);
  for (const space of ["NES_M76_R05_S0c", "NES_M76_R0d_S0c"]) {
    observations.mappings.push(
      ...fixtureNesPrgMappings(bytes, {
        contexts: [{ space, banks: [5, 4, 6, 7] }],
        bankSize: 8192,
        prgOffset: 528,
        cpuBase: 0x8000,
      }),
    );
    observations.entry_points.push(`${space}:0x8008`);
  }
  const views = [
    { mapper: 76, r6: 5, r7: 12 },
    { mapper: 76, r6: 13, r7: 12 },
  ] as const;
  const result = attestGhidraNesLoadImage(
    bytes,
    hash(bytes),
    observations,
    views,
  );
  if (!result.ok) throw new Error(result.error);
  expect(result.value).toMatchObject({
    status: "verified",
    mapper: 76,
    bank_size: 8192,
    mapping_model: "complete-selected-prg-contexts",
  });
  const changed = structuredClone(observations);
  changed.mappings[3]!.file_offset = 528 + 6 * 8192;
  const rejected = attestGhidraNesLoadImage(bytes, hash(bytes), changed, views);
  if (!rejected.ok) throw new Error(rejected.error);
  expect(rejected.value.status).toBe("mismatch");
});
it("attests both J87 fixed PRG aliases without inventing a banked context", () => {
  const bytes = Buffer.alloc(528 + 16384 + 16384, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 1, 2, 0x74, 0x58]);
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0xc008, 528 + 16384 - delta);
  const observations = fixtureNesLoadImage(bytes, "early.nes", [], []);
  observations.mappings = [0x8000, 0xc000].map((start) => ({
    block: start === 0x8000 ? "NES_PRG_ROM" : "NES_PRG_ROM_MIRROR",
    start: `0x${start.toString(16)}`,
    end: `0x${(start + 16383).toString(16)}`,
    address_space: "RAM",
    initialized: true,
    loaded: true,
    overlay: false,
    length: 16384,
    source_file_index: 0,
    file_offset: 528,
    sha256: hash(bytes.subarray(528, 528 + 16384)),
  }));
  observations.entry_points = ["0xc008"];
  const result = attestGhidraNesLoadImage(bytes, hash(bytes), observations);
  if (!result.ok) throw new Error(result.error);
  expect(result.value).toMatchObject({
    status: "verified",
    mapper: 87,
    mapping_model: "independent-static-bank-views",
    prg_views: [],
  });
});
