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
it("attests both H3001 swapped contexts against independently authored ROM mappings", () => {
  const bytes = Buffer.alloc(528 + 262144 + 8192, 2);
  bytes.fill(0, 0, 16);
  bytes.set([78, 69, 83, 26, 16, 1, 0x14, 0x48]);
  for (let bank = 0; bank < 32; bank++)
    bytes.fill(bank, 528 + bank * 8192, 528 + (bank + 1) * 8192);
  for (const delta of [6, 4, 2])
    bytes.writeUInt16LE(0x8008, 528 + 262144 - delta);
  const contexts = [
    { space: "NES_M65_M0_P05_Q13", banks: [5, 19, 30, 31] },
    { space: "NES_M65_M1_P05_Q13", banks: [30, 19, 5, 31] },
  ];
  const observations: NativeLoadImageObservation = fixtureNesLoadImage(
    bytes,
    "h3001.nes",
    fixtureNesPrgMappings(bytes, {
      contexts,
      bankSize: 8192,
      prgOffset: 528,
      cpuBase: 0x8000,
    }),
    contexts.map(({ space }) => `${space}:0x8008`),
  );
  const views = [
    { mapper: 65, prg_mode: 0, prg_bank_0: 5, prg_bank_1: 19 },
    { mapper: 65, prg_mode: 1, prg_bank_0: 5, prg_bank_1: 19 },
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
    format: "nes",
    mapping_model: "complete-selected-prg-contexts",
  });
  const changed = structuredClone(observations);
  changed.mappings[4]!.file_offset = 528 + 5 * 8192;
  const rejected = attestGhidraNesLoadImage(bytes, hash(bytes), changed, views);
  if (!rejected.ok) throw new Error(rejected.error);
  expect(rejected.value).toMatchObject({ status: "mismatch" });
});
