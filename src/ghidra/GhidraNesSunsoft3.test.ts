import {
  fixtureNesLoadImage,
  fixtureNesPrgMappings,
} from "./GhidraNesLoadImage.fixture.js";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";
import { attestGhidraNesLoadImage } from "./GhidraNesLoadImage.js";

const hash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
it("attests selected Sunsoft3 16KiB contexts and the common fixed upper bank against independent mappings", () => {
  const bytes = Buffer.alloc(528 + 262144 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 16, 1, 0x34, 0x48]);
  for (let bank = 0; bank < 16; bank++)
    bytes.fill(bank, 528 + bank * 16384, 528 + (bank + 1) * 16384);
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0x8008, 528 + 262144 - delta);
  const contexts = [
    { space: "NES_M67_P05", banks: [5, 15] },
    { space: "NES_M67_P0c", banks: [12, 15] },
  ];
  const observations: NativeLoadImageObservation = fixtureNesLoadImage(
    bytes,
    "sunsoft3.nes",
    fixtureNesPrgMappings(bytes, {
      contexts,
      bankSize: 16384,
      prgOffset: 528,
      cpuBase: 0x8000,
    }),
    contexts.map(({ space }) => `${space}:0x8008`),
  );
  const views = [
    { mapper: 67, prg_bank: 5 },
    { mapper: 67, prg_bank: 12 },
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
    mapper: 67,
    bank_size: 16384,
    mapping_model: "complete-selected-prg-contexts",
  });
  const changed = structuredClone(observations);
  changed.mappings[3]!.file_offset = 528 + 14 * 16384;
  const rejected = attestGhidraNesLoadImage(bytes, hash(bytes), changed, views);
  if (!rejected.ok) throw new Error(rejected.error);
  expect(rejected.value).toMatchObject({ status: "mismatch" });
});
