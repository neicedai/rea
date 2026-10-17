import {
  fixtureNesLoadImage,
  fixtureNesPrgMappings,
} from "./GhidraNesLoadImage.fixture.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { NativeLoadImageObservation } from "../domain/native/nativeLoadImage.js";
import type { NesPrgView } from "../domain/nesPrgViews.js";
import { parseNesHeader } from "../domain/nes.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { ok } from "../domain/result.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { attestGhidraNesLoadImage } from "./GhidraNesLoadImage.js";
import { attestGhidraNativeLoadImage } from "./GhidraLoadImageAttest.js";

const hash = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const hex = (value: number): string => `0x${value.toString(16)}`;

type ExpectedContext = {
  space: string;
  banks: readonly number[];
  starts?: readonly number[];
};

/** Manually specified CPU windows, independent of the production mapper planner. */
const fixture = (
  mapper: 1 | 4 | 5 | 9 | 10 | 19 | 69,
  contexts: readonly ExpectedContext[],
) => {
  const bankSize = mapper === 1 || mapper === 10 ? 0x4000 : 0x2000;
  const bytes = Buffer.alloc(16 + 0x10000 + 0x2000);
  Buffer.from([0x4e, 0x45, 0x53, 0x1a, 4, 1, mapper << 4]).copy(bytes);
  bytes[7] = mapper & 0xf0;
  for (let bank = 0; bank < 0x10000 / bankSize; bank++) {
    const data = bytes.subarray(
      16 + bank * bankSize,
      16 + (bank + 1) * bankSize,
    );
    data.fill(bank + 1);
    data.writeUInt16LE(mapper === 69 ? 0x6040 : 0x8008, bankSize - 6);
    data.writeUInt16LE(0x8000, bankSize - 4);
    data.writeUInt16LE(0xc020, bankSize - 2);
  }
  const observations: NativeLoadImageObservation = fixtureNesLoadImage(
    bytes,
    "contexts.nes",
    fixtureNesPrgMappings(bytes, {
      contexts,
      bankSize: bankSize,
      prgOffset: 16,
      cpuBase: 0x8000,
    }),
    contexts.flatMap(({ space, starts, banks }) =>
      (mapper === 69
        ? [0x8000, 0xc020, ...(starts?.includes(0x6000) ? [0x6040] : [])]
        : [0x8000, 0x8008, 0xc020]
      )
        .filter(
          (value) =>
            mapper !== 5 ||
            banks.some((_, slot) => {
              const start = starts?.[slot] ?? 0x8000 + slot * bankSize;
              return value >= start && value < start + bankSize;
            }),
        )
        .map((value) => `${space}:${hex(value)}`),
    ),
  );
  return { bytes, observations };
};

describe("MMC complete context attestation", () => {
  it("attests independently selected Namco 163 banks and all vector aliases", () => {
    const contexts = [{ space: "NES_M19_P02_Q05_R03", banks: [2, 5, 3, 7] }];
    const { bytes, observations } = fixture(19, contexts);
    const result = attestGhidraNesLoadImage(bytes, hash(bytes), observations, [
      {
        mapper: 19,
        variant: "namco163",
        prg_bank_0: 2,
        prg_bank_1: 5,
        prg_bank_2: 3,
      },
    ]);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({
      status: "verified",
      prg_views: [
        {
          address_space: "NES_M19_P02_Q05_R03",
          state: { variant: "namco163" },
        },
      ],
    });
  });
  it("binds MMC1 vectors to both windows of the selected mode and keeps raw ignored bank bits", () => {
    const views: NesPrgView[] = [
      { mapper: 1, prg_mode: 2, prg_bank: 1 },
      { mapper: 1, prg_mode: 0, prg_bank: 3 },
    ];
    const { bytes, observations } = fixture(1, [
      { space: "NES_M1_M0_P03", banks: [2, 3] },
      { space: "NES_M1_M2_P01", banks: [0, 1] },
    ]);
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
      prg_views: [
        {
          address_space: "NES_M1_M0_P03",
          state: { prg_bank: 3 },
          selection: "caller-selected",
        },
        {
          address_space: "NES_M1_M2_P01",
          state: { prg_mode: 2 },
          selection: "caller-selected",
        },
      ],
    });
    if (result.value.status === "unsupported" || result.value.format !== "nes")
      throw new Error("NES result required");
    expect(
      result.value.vectors
        .filter((v) => v.name === "RESET")
        .map((v) => [v.file_offset, v.resolved_target]),
    ).toEqual([
      [16 + 0x10000 - 4, "NES_M1_M0_P03:0x8000"],
      [16 + 0x8000 - 4, "NES_M1_M2_P01:0x8000"],
    ]);
  });
});

it("attests sparse MMC5 ROM contexts without classifying RAM vector destinations as ROM", () => {
  const views: NesPrgView[] = [
    { mapper: 5, prg_mode: 0, bank_e000: 7 },
    {
      mapper: 5,
      prg_mode: 3,
      bank_8000: 0,
      bank_a000: 129,
      bank_c000: 2,
      bank_e000: 7,
    },
  ];
  const { bytes, observations } = fixture(5, [
    { space: "NES_M5_M0_E07", banks: [4, 5, 6, 7] },
    {
      space: "NES_M5_M3_P00_Q81_R02_E07",
      banks: [1, 7],
      starts: [0xa000, 0xe000],
    },
  ]);
  const result = attestGhidraNesLoadImage(
    bytes,
    hash(bytes),
    observations,
    views,
  );
  if (!result.ok) throw new Error(result.error);
  expect(result.value.status).toBe("verified");
  if (!("format" in result.value) || result.value.format !== "nes")
    throw new Error("Expected NES image");
  expect(
    result.value.vectors.filter(
      (v) => v.address_space === "NES_M5_M3_P00_Q81_R02_E07",
    ),
  ).toMatchObject([
    { in_prg_rom: false, resolved_target: null, resolution: "outside-prg-rom" },
    { in_prg_rom: false, resolved_target: null, resolution: "outside-prg-rom" },
    { in_prg_rom: false, resolved_target: null, resolution: "outside-prg-rom" },
  ]);
});

describe("MMC3 complete context attestation", () => {
  it("verifies MMC3 mode swap and ROM address-line masking without merging equal source banks", () => {
    const views: NesPrgView[] = [
      { mapper: 4, prg_mode: 0, r6: 58, r7: 61 },
      { mapper: 4, prg_mode: 1, r6: 1, r7: 3 },
    ];
    const { bytes, observations } = fixture(4, [
      { space: "NES_M4_M0_R3a_S3d", banks: [2, 5, 6, 7] },
      { space: "NES_M4_M1_R01_S03", banks: [6, 3, 1, 7] },
    ]);
    const result = attestGhidraNesLoadImage(
      bytes,
      hash(bytes),
      observations,
      views,
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.value.status).toBe("verified");
    if (result.value.status === "unsupported" || result.value.format !== "nes")
      throw new Error("NES result required");
    expect(result.value.prg_mappings.map((mapping) => mapping.bank)).toEqual([
      2, 5, 6, 7, 6, 3, 1, 7,
    ]);
    expect(
      result.value.vectors
        .filter((v) => v.name === "RESET")
        .map((v) => v.resolved_target),
    ).toEqual(["NES_M4_M0_R3a_S3d:0x8000", "NES_M4_M1_R01_S03:0x8000"]);
    observations.mappings[6]!.file_offset = 16 + 6 * 0x2000;
    const wrongMode = attestGhidraNesLoadImage(
      bytes,
      hash(bytes),
      observations,
      views,
    );
    if (!wrongMode.ok) throw new Error(wrongMode.error);
    expect(wrongMode.value.status).toBe("mismatch");
  });

  it("reports the omitted MMC3 state as an assumption instead of caller evidence", () => {
    const { bytes, observations } = fixture(4, [
      { space: "NES_M4_M0_R00_S01", banks: [0, 1, 6, 7] },
    ]);
    const result = attestGhidraNesLoadImage(bytes, hash(bytes), observations);
    if (!result.ok) throw new Error(result.error);
    expect(result.value).toMatchObject({
      status: "verified",
      prg_views: [
        {
          selection: "default-assumption",
          state: { mapper: 4, prg_mode: 0, r6: 0, r7: 1 },
        },
      ],
    });
  });
});

describe("selected context attestation boundary", () => {
  it("preserves selected views through the provider snapshot attestation boundary", async () => {
    const views: NesPrgView[] = [{ mapper: 4, prg_mode: 1, r6: 2, r7: 2 }];
    const { bytes, observations } = fixture(4, [
      { space: "NES_M4_M1_R02_S02", banks: [6, 2, 2, 7] },
    ]);
    const parsed = parseNesHeader(bytes);
    if (!parsed.ok) throw new Error(parsed.error);
    const result = await attestGhidraNativeLoadImage({
      target: {
        path: "/contexts.nes",
        sha256: hash(bytes),
        kind: "executable",
        format: "nes",
        architecture: "6502",
        availableArchitectures: ["6502"],
        nes: parsed.value,
        nesPrgViews: views,
      },
      operation: "inspect_native_load_image",
      measured: jsonValueSchema.parse(observations),
      client: {
        readTargetSnapshot: async () => ok({ kind: "captured", bytes }),
      },
      mapSessionError: () =>
        new ProviderAdapterError("ghidra", "inspect_native_load_image"),
    });
    if (!result.ok) throw result.error;
    expect(result.value).toMatchObject({
      status: "verified",
      prg_views: [
        { address_space: "NES_M4_M1_R02_S02", selection: "caller-selected" },
      ],
    });
  });
});

describe("MMC2/MMC4 source and vector attestation", () => {
  it.each([9, 10] as const)(
    "keeps every fixed window in its selected Mapper %i context",
    (mapper) => {
      const views: NesPrgView[] = [
        { mapper, prg_bank: 2 },
        { mapper, prg_bank: 15 },
      ];
      const { bytes, observations } = fixture(mapper, [
        {
          space: `NES_M${mapper}_P02`,
          banks: mapper === 9 ? [2, 5, 6, 7] : [2, 3],
        },
        {
          space: `NES_M${mapper}_P0f`,
          banks: mapper === 9 ? [7, 5, 6, 7] : [3, 3],
        },
      ]);
      const result = attestGhidraNesLoadImage(
        bytes,
        hash(bytes),
        observations,
        views,
      );
      if (!result.ok) throw new Error(result.error);
      expect(result.value.status).toBe("verified");
      if (
        result.value.status === "unsupported" ||
        result.value.format !== "nes"
      )
        throw new Error("NES required");
      expect(
        result.value.vectors
          .filter((v) => v.name === "RESET")
          .map((v) => [v.file_offset, v.resolved_target]),
      ).toEqual([
        [16 + 0x10000 - 4, `NES_M${mapper}_P02:0x8000`],
        [16 + 0x10000 - 4, `NES_M${mapper}_P0f:0x8000`],
      ]);
      const corrupted = structuredClone(observations);
      corrupted.mappings[1]!.file_offset = 16;
      const rejected = attestGhidraNesLoadImage(
        bytes,
        hash(bytes),
        corrupted,
        views,
      );
      if (!rejected.ok) throw new Error(rejected.error);
      expect(rejected.value.status).toBe("mismatch");
    },
  );
});

it("classifies Mapper 69 low-window vectors from mapped ROM identity, not CPU address alone", () => {
  const views: NesPrgView[] = [
    {
      mapper: 69,
      variant: "fme7",
      lower_window: { source: "rom", bank: 3 },
      prg_bank_0: 1,
      prg_bank_1: 4,
      prg_bank_2: 2,
    },
    {
      mapper: 69,
      variant: "fme7",
      lower_window: { source: "ram" },
      prg_bank_0: 1,
      prg_bank_1: 4,
      prg_bank_2: 2,
    },
  ];
  const contexts = [
    {
      space: "NES_M69_FME7_LR03_P01_Q04_R02",
      banks: [3, 1, 4, 2, 7],
      starts: [0x6000, 0x8000, 0xa000, 0xc000, 0xe000],
    },
    { space: "NES_M69_FME7_LRAM_P01_Q04_R02", banks: [1, 4, 2, 7] },
  ];
  const { bytes, observations } = fixture(69, contexts);
  const result = attestGhidraNesLoadImage(
    bytes,
    hash(bytes),
    observations,
    views,
  );
  if (
    !result.ok ||
    result.value.status === "unsupported" ||
    result.value.format !== "nes"
  )
    throw new Error(JSON.stringify(result));
  expect(result.value.status).toBe("verified");
  const vectors = result.value.vectors.filter((v) => v.name === "NMI");
  expect(vectors.find((v) => v.address_space.includes("LR03"))).toMatchObject({
    target: "0x6040",
    in_prg_rom: true,
    resolution: "mapped-in-view",
  });
  expect(vectors.find((v) => v.address_space.includes("LRAM"))).toMatchObject({
    target: "0x6040",
    in_prg_rom: false,
    resolution: "outside-prg-rom",
    resolved_target: null,
  });
});
