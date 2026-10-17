import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";
import { attestGhidraNesLoadImage } from "./GhidraNesLoadImage.js";
import { attestGhidraNativeLoadImage } from "./GhidraLoadImageAttest.js";
import { parseNesHeader } from "../domain/nes.js";
import { ok } from "../domain/result.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { jsonValueSchema } from "../domain/jsonValue.js";

const sha = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const hex = (value: number): string => `0x${value.toString(16)}`;

const fixture = (banks: 1 | 2 = 1) => {
  const bytes = Buffer.alloc(16 + banks * 0x4000 + 0x2000);
  Buffer.from([0x4e, 0x45, 0x53, 0x1a, banks, 1]).copy(bytes);
  const prg = bytes.subarray(16, 16 + banks * 0x4000);
  prg.fill(0xea);
  prg.writeUInt16LE(0xc010, prg.length - 6);
  prg.writeUInt16LE(0xc000, prg.length - 4);
  prg.writeUInt16LE(0xc020, prg.length - 2);
  const observations: NativeLoadImageObservation = {
    executable_format: "Raw Binary",
    language_id: "6502:LE:16:default",
    compiler_spec_id: "default",
    image_base: "0x0",
    default_address_space: "RAM",
    source_files: [
      {
        name: "fixture.nes",
        size: bytes.length,
        original_sha256: sha(bytes),
        modified_sha256: sha(bytes),
      },
    ],
    mappings: (banks === 1 ? [0x8000, 0xc000] : [0x8000]).map((start) => ({
      block: start === 0xc000 ? "NES_PRG_ROM_MIRROR" : "NES_PRG_ROM",
      start: hex(start),
      end: hex(start + prg.length - 1),
      address_space: "RAM",
      initialized: true,
      loaded: true,
      overlay: false,
      length: prg.length,
      source_file_index: 0,
      file_offset: 16,
      sha256: sha(prg),
    })),
    relocations: [],
    entry_points: ["0xc000", "0xc010", "0xc020"],
    entry_context: [],
  };
  return { bytes, observations };
};

/** Independent observations of two physical banks, including an unresolved UxROM vector. */
const bankedFixture = (mapper: 2 | 7 | 66) => {
  const bankSize = mapper === 2 ? 0x4000 : 0x8000;
  const chrSize = mapper === 66 ? 0x2000 : 0;
  const bytes = Buffer.alloc(16 + 2 * bankSize + chrSize);
  Buffer.from([
    0x4e,
    0x45,
    0x53,
    0x1a,
    (2 * bankSize) / 0x4000,
    chrSize / 0x2000,
    (mapper & 15) << 4,
    mapper & 0xf0,
  ]).copy(bytes);
  for (let bank = 0; bank < 2; bank++) {
    const prg = bytes.subarray(
      16 + bank * bankSize,
      16 + (bank + 1) * bankSize,
    );
    prg.fill(bank === 0 ? 0xea : 0x60);
    prg.writeUInt16LE(mapper === 2 ? 0xc010 : 0x8010, bankSize - 6);
    prg.writeUInt16LE(0x8000, bankSize - 4);
    prg.writeUInt16LE(mapper === 2 ? 0xc020 : 0x8020, bankSize - 2);
  }
  const mapping = (
    bank: number,
    start: number,
    space: string,
    name: string,
  ) => {
    const fileOffset = 16 + bank * bankSize;
    const at = (offset: number) =>
      space === "RAM" ? hex(offset) : `${space}:${hex(offset)}`;
    return {
      block: name,
      start: at(start),
      end: at(start + bankSize - 1),
      address_space: space,
      initialized: true,
      loaded: true,
      overlay: space !== "RAM",
      length: bankSize,
      source_file_index: 0,
      file_offset: fileOffset,
      sha256: sha(bytes.subarray(fileOffset, fileOffset + bankSize)),
    };
  };
  const observations: NativeLoadImageObservation = {
    executable_format: "Raw Binary",
    language_id: "6502:LE:16:default",
    compiler_spec_id: "default",
    image_base: "0x0",
    default_address_space: "RAM",
    source_files: [
      {
        name: "banks.nes",
        size: bytes.length,
        original_sha256: sha(bytes),
        modified_sha256: sha(bytes),
      },
    ],
    mappings: [
      mapping(0, 0x8000, "NES_PRG_B000", "NES_PRG_B000"),
      mapping(1, 0x8000, "NES_PRG_B001", "NES_PRG_B001"),
      ...(mapper === 2 ? [mapping(1, 0xc000, "RAM", "NES_PRG_FIXED")] : []),
    ],
    relocations: [],
    entry_points:
      mapper === 2
        ? ["0xc010", "0xc020"]
        : ["NES_PRG_B000", "NES_PRG_B001"].flatMap((space) =>
            [0x8000, 0x8010, 0x8020].map((offset) => `${space}:${hex(offset)}`),
          ),
    entry_context: [],
  };
  return { bytes, observations };
};

describe("NES load-image verification", () => {
  it("bounds snapshot reads by the admitted cartridge extent and honors cancellation during the read", async () => {
    const { bytes, observations } = fixture();
    const parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const controller = new AbortController();
    const result = await attestGhidraNativeLoadImage({
      target: {
        path: "/fixture.nes",
        sha256: sha(bytes),
        kind: "executable",
        format: "nes",
        architecture: "6502",
        availableArchitectures: ["6502"],
        nes: parsed.value,
      },
      operation: "inspect_native_load_image",
      measured: jsonValueSchema.parse(observations),
      signal: controller.signal,
      client: {
        readTargetSnapshot: async (maximumBytes, signal) => {
          expect(maximumBytes).toBe(bytes.length);
          expect(signal).toBe(controller.signal);
          controller.abort();
          return ok({ kind: "captured", bytes });
        },
      },
      mapSessionError: () =>
        new ProviderAdapterError("ghidra", "inspect_native_load_image"),
    });
    expect(result).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
  });
  it.each([1, 2] as const)(
    "verifies %i PRG bank(s) and preserves source/vector coordinates",
    (banks) => {
      const { bytes, observations } = fixture(banks);
      const result = attestGhidraNesLoadImage(bytes, sha(bytes), observations);
      if (!result.ok) throw new Error(result.error);
      expect(result.value).toMatchObject({
        status: "verified",
        format: "nes",
        mapper: 0,
        prg_rom: { file_offset: 16, bytes: banks * 0x4000 },
        chr_rom: { file_offset: 16 + banks * 0x4000, bytes: 0x2000 },
        vectors: [
          {
            name: "NMI",
            address: "0xfffa",
            target: "0xc010",
            file_offset: 16 + banks * 0x4000 - 6,
          },
          { name: "RESET", address: "0xfffc", target: "0xc000" },
          { name: "IRQ", address: "0xfffe", target: "0xc020" },
        ],
      });
    },
  );

  const damage: Array<[string, (value: NativeLoadImageObservation) => void]> = [
    [
      "wrong mirror source offset",
      (x) => {
        x.mappings[1]!.file_offset = 16 + 0x4000;
      },
    ],
    [
      "wrong mirror address",
      (x) => {
        x.mappings[1]!.start = "0xc001";
      },
    ],
    [
      "missing mirror",
      (x) => {
        x.mappings.pop();
      },
    ],
    [
      "modified PRG memory",
      (x) => {
        x.mappings[0]!.sha256 = "f".repeat(64);
      },
    ],
    [
      "modified source bytes",
      (x) => {
        x.source_files[0]!.modified_sha256 = "f".repeat(64);
      },
    ],
    [
      "missing reset entry",
      (x) => {
        x.entry_points.shift();
      },
    ],
    [
      "wrong processor",
      (x) => {
        x.language_id = "65C02:LE:16:default";
      },
    ],
    [
      "extra initialized CHR block",
      (x) => {
        x.mappings.push({
          ...x.mappings[0]!,
          start: "0x6000",
          source_file_index: null,
          file_offset: null,
        });
      },
    ],
  ];
  it.each(damage)("reports mismatches for %s", (_name, mutate) => {
    const { bytes, observations } = fixture();
    mutate(observations);
    const result = attestGhidraNesLoadImage(bytes, sha(bytes), observations);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.status).toBe("mismatch");
    if (result.value.status === "unsupported")
      throw new Error(result.value.reason);
    expect(result.value.checks.some((check) => !check.matched)).toBe(true);
  });

  it("rejects snapshot identity drift before trusting provider mappings", () => {
    const { bytes, observations } = fixture();
    const original = sha(bytes);
    bytes[16] = 0x60;
    expect(
      attestGhidraNesLoadImage(bytes, original, observations),
    ).toMatchObject({ ok: false });
  });

  it("allows caller entry seeds while requiring every valid vector target", () => {
    const { bytes, observations } = fixture();
    observations.entry_points.push("0xc100");
    const result = attestGhidraNesLoadImage(bytes, sha(bytes), observations);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.status).toBe("verified");
  });
});

describe("NES independent PRG bank verification", () => {
  it.each([2, 7, 66] as const)(
    "verifies Mapper %i bank identities and per-view vectors",
    (mapper) => {
      const { bytes, observations } = bankedFixture(mapper);
      const result = attestGhidraNesLoadImage(bytes, sha(bytes), observations);
      if (!result.ok) throw new Error(result.error);
      expect(result.value.status).toBe("verified");
      if (
        result.value.status === "unsupported" ||
        result.value.format !== "nes"
      )
        throw new Error("expected NES result");
      expect(result.value.prg_banks).toBe(2);
      expect(
        result.value.prg_mappings.filter(
          (mapping) => mapping.role === "switchable",
        ),
      ).toHaveLength(2);
      const reset = result.value.vectors.filter(
        (vector) => vector.name === "RESET",
      );
      if (mapper === 2) {
        expect(reset).toMatchObject([
          {
            address: "0xfffc",
            target: "0x8000",
            resolved_target: null,
            resolution: "bank-state-required",
            file_offset: 16 + 0x8000 - 4,
          },
        ]);
      } else {
        expect(reset.map((vector) => vector.resolved_target)).toEqual([
          "NES_PRG_B000:0x8000",
          "NES_PRG_B001:0x8000",
        ]);
        expect(reset.map((vector) => vector.file_offset)).toEqual([
          16 + 0x8000 - 4,
          16 + 0x10000 - 4,
        ]);
      }
    },
  );

  it("rejects bank identities collapsed onto the same CPU offset", () => {
    const { bytes, observations } = bankedFixture(7);
    observations.entry_points = ["0x8000", "0x8010", "0x8020"];
    observations.mappings[1] = {
      ...observations.mappings[0]!,
      file_offset: 16 + 0x8000,
    };
    const result = attestGhidraNesLoadImage(bytes, sha(bytes), observations);
    if (!result.ok) throw new Error(result.error);
    expect(result.value.status).toBe("mismatch");
  });

  it("rejects an invented default UxROM bank while preserving explicit bank seeds", () => {
    const { bytes, observations } = bankedFixture(2);
    observations.entry_points.push("NES_PRG_B000:0x8000");
    const seeded = attestGhidraNesLoadImage(bytes, sha(bytes), observations);
    if (!seeded.ok) throw new Error(seeded.error);
    expect(seeded.value.status).toBe("verified");
    observations.mappings.push({
      ...observations.mappings[0]!,
      block: "UNSAFE_DEFAULT",
      start: "0x8000",
      end: "0xbfff",
      address_space: "RAM",
      overlay: false,
    });
    const shadow = attestGhidraNesLoadImage(bytes, sha(bytes), observations);
    if (!shadow.ok) throw new Error(shadow.error);
    expect(shadow.value.status).toBe("mismatch");
  });
});
