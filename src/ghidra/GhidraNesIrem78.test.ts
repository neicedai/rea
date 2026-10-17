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
it.each([
  {
    variant: "cosmo-carrier" as const,
    submapper: 1,
    prefix: "NES_M78_COSMO_CARRIER",
  },
  {
    variant: "holy-diver" as const,
    submapper: 3,
    prefix: "NES_M78_HOLY_DIVER",
  },
])(
  "attests $variant logical PRG contexts, physical aliases and unchanged header identity",
  ({ variant, submapper, prefix }) => {
    for (const prgBanks of [1, 8]) {
      const bytes = Buffer.alloc(528 + prgBanks * 16384 + 8192, 2);
      bytes.fill(0, 0, 16);
      bytes.set([78, 69, 83, 26, prgBanks, 1, 0xe4, 0x48, submapper << 4]);
      for (let bank = 0; bank < prgBanks; bank++)
        bytes.fill(bank, 528 + bank * 16384, 528 + (bank + 1) * 16384);
      for (const delta of [6, 4, 2])
        bytes.writeUInt16LE(0x8008, 528 + prgBanks * 16384 - delta);
      const contexts =
        prgBanks === 1
          ? [
              { space: `${prefix}_P00`, selector: 0, banks: [0, 0] },
              { space: `${prefix}_P07`, selector: 7, banks: [0, 0] },
            ]
          : [
              { space: `${prefix}_P05`, selector: 5, banks: [5, 7] },
              { space: `${prefix}_P07`, selector: 7, banks: [7, 7] },
            ];
      const image: NativeLoadImageObservation = fixtureNesLoadImage(
        bytes,
        "irem78.nes",
        fixtureNesPrgMappings(bytes, {
          contexts,
          bankSize: 16384,
          prgOffset: 528,
          cpuBase: 0x8000,
        }),
        contexts.map(({ space }) => `${space}:0x8008`),
      );
      const views = contexts.map(({ selector }) => ({
        mapper: 78 as const,
        variant,
        prg_bank: selector,
      }));
      const result = attestGhidraNesLoadImage(bytes, hash(bytes), image, views);
      if (!result.ok) throw new Error(result.error);
      expect(result.value).toMatchObject({
        status: "verified",
        mapper: 78,
        mapping_model: "complete-selected-prg-contexts",
      });
      const changed = structuredClone(image);
      changed.mappings[3]!.file_offset = 529;
      const rejected = attestGhidraNesLoadImage(
        bytes,
        hash(bytes),
        changed,
        views,
      );
      if (!rejected.ok) throw new Error(rejected.error);
      expect(rejected.value.status).toBe("mismatch");
    }
  },
);
