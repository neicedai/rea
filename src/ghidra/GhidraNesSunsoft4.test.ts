import {
  fixtureNesLoadImage,
  fixtureNesPrgMappings,
} from "./GhidraNesLoadImage.fixture.js";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { attestGhidraNesLoadImage } from "./GhidraNesLoadImage.js";

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

it("attests distinct normal Sunsoft4 contexts when a single physical PRG bank aliases both windows", () => {
  const bytes = Buffer.alloc(528 + 16384 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 1, 1, 0x44, 0x48]);
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0x8008, 528 + 16384 - delta);
  const contexts = [
    { space: "NES_M68_NORMAL_P00", banks: [0, 0] },
    { space: "NES_M68_NORMAL_P0f", banks: [0, 0] },
  ];
  const image = fixtureNesLoadImage(
    bytes,
    "sunsoft4.nes",
    fixtureNesPrgMappings(bytes, {
      contexts,
      bankSize: 16384,
      prgOffset: 528,
      cpuBase: 0x8000,
    }),
    contexts.map(({ space }) => `${space}:0x8008`),
  );
  const views = [
    { mapper: 68, variant: "normal", prg_bank: 0 },
    { mapper: 68, variant: "normal", prg_bank: 15 },
  ] as const;
  const result = attestGhidraNesLoadImage(bytes, hash(bytes), image, views);
  if (!result.ok) throw new Error(result.error);
  expect(result.value).toMatchObject({
    status: "verified",
    mapper: 68,
    mapping_model: "complete-selected-prg-contexts",
  });
  const changed = structuredClone(image);
  changed.mappings[3]!.file_offset = 529;
  const rejected = attestGhidraNesLoadImage(bytes, hash(bytes), changed, views);
  if (!rejected.ok) throw new Error(rejected.error);
  expect(rejected.value.status).toBe("mismatch");
});
it("requires caller normal qualification for a legacy128KiB Sunsoft4 load without changing header identity", () => {
  const bytes = Buffer.alloc(528 + 131072 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 8, 1, 0x44, 0x40]);
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0x8008, 528 + 131072 - delta);
  const contexts = [{ space: "NES_M68_NORMAL_P05", banks: [5, 7] }];
  const image = fixtureNesLoadImage(
    bytes,
    "sunsoft4.nes",
    fixtureNesPrgMappings(bytes, {
      contexts,
      bankSize: 16384,
      prgOffset: 528,
      cpuBase: 0x8000,
    }),
    contexts.map(({ space }) => `${space}:0x8008`),
  );
  expect(attestGhidraNesLoadImage(bytes, hash(bytes), image).ok).toBe(false);
  const result = attestGhidraNesLoadImage(bytes, hash(bytes), image, [
    { mapper: 68, variant: "normal", prg_bank: 5 },
  ]);
  if (!result.ok) throw new Error(result.error);
  expect(result.value).toMatchObject({
    status: "verified",
    mapper: 68,
    target_sha256: hash(bytes),
  });
});
