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
    prgBanks: 1,
    contexts: [
      { space: "NES_M73_P00", selector: 0, banks: [0, 0] },
      { space: "NES_M73_P07", selector: 7, banks: [0, 0] },
    ],
  },
  {
    prgBanks: 8,
    contexts: [
      { space: "NES_M73_P05", selector: 5, banks: [5, 7] },
      { space: "NES_M73_P07", selector: 7, banks: [7, 7] },
    ],
  },
])(
  "attests VRC3 source contexts with $prgBanks physical PRG banks and fixed CHR RAM",
  ({ prgBanks, contexts }) => {
    const bytes = Buffer.alloc(528 + prgBanks * 16384, 2);
    bytes.fill(0, 0, 16);
    bytes.set([78, 69, 83, 26, prgBanks, 0, 0x94, 0x48, 0, 0, 0, 7]);
    for (let bank = 0; bank < prgBanks; bank++)
      bytes.fill(bank, 528 + bank * 16384, 528 + (bank + 1) * 16384);
    for (const delta of [6, 4, 2])
      bytes.writeUInt16LE(0x8008, bytes.length - delta);
    const observations: NativeLoadImageObservation = fixtureNesLoadImage(
      bytes,
      "vrc3.nes",
      fixtureNesPrgMappings(bytes, {
        contexts,
        bankSize: 16384,
        prgOffset: 528,
        cpuBase: 0x8000,
      }),
      contexts.map(({ space }) => `${space}:0x8008`),
    );
    const views = contexts.map(({ selector }) => ({
      mapper: 73 as const,
      prg_bank: selector,
    }));
    const result = attestGhidraNesLoadImage(
      bytes,
      hash(bytes),
      observations,
      views,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({
      status: "verified",
      mapper: 73,
      chr_banks: 0,
      mapping_model: "complete-selected-prg-contexts",
    });
    const changed = structuredClone(observations);
    changed.mappings[3]!.file_offset = 529;
    const rejected = attestGhidraNesLoadImage(
      bytes,
      hash(bytes),
      changed,
      views,
    );
    if (!rejected.ok) throw new Error(rejected.error);
    expect(rejected.value.status).toBe("mismatch");
  },
);
